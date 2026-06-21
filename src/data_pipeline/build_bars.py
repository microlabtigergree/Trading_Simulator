"""把期交所每日逐筆 zip 清洗、聚合成 1 分鐘 K 棒，輸出 parquet。

清洗步驟（對應計畫）：
1. 篩商品（預設 TX 大台）
2. 只取月合約、選當日成交量最大的到期月份（= 最活躍的近月）
3. 篩日盤時段 08:45–13:45
4. 成交量 ÷2（原始 B+S 雙邊重複計算）
5. 聚合 1 分 K（OHLCV）
6. 輸出 data/bars/<PRODUCT>_<YYYY-MM-DD>_1m.parquet

輸出欄位：time(epoch 秒), open, high, low, close, volume
  注意：time 以「台北牆鐘時間當作 UTC」存放，方便 Lightweight Charts 直接顯示 08:45。

用法：
  python -m src.data_pipeline.build_bars --date 2026-06-13 --product TX
"""
from __future__ import annotations

import argparse
import datetime as dt
import io
import re
import sys
import zipfile
from pathlib import Path

import pandas as pd

from src.config import (
    BARS_DIR,
    DAY_SESSION_END,
    DAY_SESSION_START,
    DEFAULT_PRODUCT,
    RAW_DIR,
)

# 期交所逐筆檔欄位（去除空白後）
COL_DATE = "成交日期"
COL_PRODUCT = "商品代號"
COL_EXPIRY = "到期月份(週別)"
COL_TIME = "成交時間"
COL_PRICE = "成交價格"
COL_QTY = "成交數量(B+S)"

_MONTHLY_RE = re.compile(r"^\d{6}$")  # 純月合約 YYYYMM，排除週別/價差


def _read_raw_csv(date: dt.date) -> pd.DataFrame:
    """從 data/raw 的 zip 讀出當日逐筆 DataFrame。"""
    zip_path = RAW_DIR / f"Daily_{date:%Y_%m_%d}.zip"
    if not zip_path.exists():
        raise FileNotFoundError(f"找不到原始檔 {zip_path}，請先執行 downloader。")

    with zipfile.ZipFile(zip_path) as zf:
        csv_name = next(n for n in zf.namelist() if n.lower().endswith(".csv"))
        raw = zf.read(csv_name)

    # 期交所檔為 Big5/MS950 編碼
    df = pd.read_csv(io.BytesIO(raw), encoding="ms950", low_memory=False)
    df.columns = [c.strip() for c in df.columns]
    # 字串欄去除固定寬度的前後空白
    for col in (COL_PRODUCT, COL_EXPIRY):
        if col in df.columns:
            df[col] = df[col].astype(str).str.strip()
    return df


def _parse_time(series: pd.Series, date: dt.date) -> pd.Series:
    """成交時間 'HHMMSS' (+次秒) → tz-naive datetime（台北牆鐘）。"""
    s = series.astype(str).str.strip().str.replace(r"\D", "", regex=True)
    s = s.str.zfill(6)
    hh = s.str[0:2].astype(int)
    mm = s.str[2:4].astype(int)
    ss = s.str[4:6].astype(int)
    base = pd.Timestamp(date)
    return base + pd.to_timedelta(hh, "h") + pd.to_timedelta(mm, "m") + pd.to_timedelta(ss, "s")


_EPOCH = pd.Timestamp("1970-01-01")


def _to_epoch_sec(ts: pd.Series) -> pd.Series:
    """把台北牆鐘當 UTC 換成 epoch 秒（Lightweight Charts 直接顯示 08:45）。"""
    return ((ts - _EPOCH) // pd.Timedelta(seconds=1)).astype("int64")


def clean_ticks(date: dt.date, product: str = DEFAULT_PRODUCT) -> pd.DataFrame:
    """共用清洗：篩 TX 近月、日盤、量÷2。

    回傳逐筆 DataFrame（依時間排序），欄位：time(epoch秒), price, volume。
    """
    df = _read_raw_csv(date)

    # 1. 篩商品
    df = df[df[COL_PRODUCT] == product].copy()
    if df.empty:
        raise ValueError(f"{date} 找不到商品 {product} 的逐筆資料")

    # 2. 只取月合約，選當日成交量最大的到期月份（最活躍近月）
    df = df[df[COL_EXPIRY].str.match(_MONTHLY_RE)]
    front = df.groupby(COL_EXPIRY)[COL_QTY].sum().idxmax()
    df = df[df[COL_EXPIRY] == front].copy()

    # 3. 時間解析 + 篩日盤時段
    df["ts"] = _parse_time(df[COL_TIME], date)
    start = pd.Timestamp(f"{date} {DAY_SESSION_START}")
    end = pd.Timestamp(f"{date} {DAY_SESSION_END}")
    df = df[(df["ts"] >= start) & (df["ts"] <= end)]
    if df.empty:
        raise ValueError(f"{date} {product} 日盤時段內無成交")

    # 4. 量 ÷2（B+S 雙邊）
    df[COL_PRICE] = pd.to_numeric(df[COL_PRICE], errors="coerce")
    df[COL_QTY] = pd.to_numeric(df[COL_QTY], errors="coerce")
    df = df.dropna(subset=[COL_PRICE, COL_QTY])

    ticks = pd.DataFrame({
        "time": _to_epoch_sec(df["ts"]),
        "price": df[COL_PRICE].astype(float),
        "volume": df[COL_QTY].astype(float) / 2.0,
    })
    return ticks.sort_values("time", kind="stable").reset_index(drop=True)


def aggregate_1m(ticks: pd.DataFrame) -> pd.DataFrame:
    """把逐筆 DataFrame（time epoch秒, price, volume）聚合成 1 分 K。

    可被期交所與券商 API 兩種來源共用。
    """
    t = ticks.copy()
    t["minute"] = (t["time"] // 60) * 60   # 分鐘 floor，即該根 K 的 epoch 秒
    grouped = t.groupby("minute")
    bars = pd.DataFrame({
        "time": grouped["time"].first().index,
        "open": grouped["price"].first().values,
        "high": grouped["price"].max().values,
        "low": grouped["price"].min().values,
        "close": grouped["price"].last().values,
        "volume": grouped["volume"].sum().round().astype("int64").values,
    })
    return bars.sort_values("time").reset_index(drop=True)


def build_bars(date: dt.date, product: str = DEFAULT_PRODUCT) -> pd.DataFrame:
    """回傳當日 1 分 K DataFrame（含 time/open/high/low/close/volume）。"""
    return aggregate_1m(clean_ticks(date, product))


def bars_path(date: dt.date, product: str) -> Path:
    return BARS_DIR / f"{product}_{date:%Y-%m-%d}_1m.parquet"


def ticks_path(date: dt.date, product: str) -> Path:
    return BARS_DIR / f"{product}_{date:%Y-%m-%d}_ticks.parquet"


def _parse_date(s: str) -> dt.date:
    return dt.datetime.strptime(s, "%Y-%m-%d").date()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="tick → 1分K")
    ap.add_argument("--date", type=_parse_date, required=True, help="交易日 YYYY-MM-DD")
    ap.add_argument("--product", default=DEFAULT_PRODUCT, help="商品代號 (TX 大台 / MTX 小台)")
    args = ap.parse_args(argv)

    ticks = clean_ticks(args.date, args.product)
    bars = build_bars(args.date, args.product)

    tp = ticks_path(args.date, args.product)
    bp = bars_path(args.date, args.product)
    ticks.to_parquet(tp, index=False)
    bars.to_parquet(bp, index=False)
    print(f"[ok] {tp.name}：{len(ticks):,} 筆 tick")
    print(f"[ok] {bp.name}：{len(bars)} 根 K，量合計 {int(bars['volume'].sum()):,} 口")
    return 0


if __name__ == "__main__":
    sys.exit(main())

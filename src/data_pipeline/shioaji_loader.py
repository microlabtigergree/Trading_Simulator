"""用永豐 Shioaji API 回補台指期歷史逐筆，存成與本專案相容的 tick / 1分K parquet。

需求：
  pip install shioaji
  永豐證券帳戶 + 已申請開通 API（行情）。下載行情只需 api_key/secret_key 登入，
  不需 CA 憑證、不需完成「下單測試」。

與期交所來源的差異（已在本檔處理）：
  - Shioaji 期貨 tick 的 volume 是「單邊量」→ 不需 ÷2（期交所原始是 B+S 雙邊）。
  - 時間沿用本專案慣例：把台北牆鐘當 UTC 存成 epoch 秒。

用法：
  # 1) 連線/權限自我檢查（抓一天看通不通、印出流量配額）
  python -m src.data_pipeline.shioaji_loader --check --date 2026-06-12

  # 2) 回補日期區間（含頭尾），輸出 TX_YYYY-MM-DD_ticks.parquet 與 _1m.parquet
  python -m src.data_pipeline.shioaji_loader --start 2026-01-01 --end 2026-03-31

金鑰來源（擇一）：
  --api-key / --secret-key 參數，或環境變數 SHIOAJI_API_KEY / SHIOAJI_SECRET_KEY
"""
from __future__ import annotations

import argparse
import datetime as dt
import os
import sys

import pandas as pd

from src.config import DAY_SESSION_END, DAY_SESSION_START
from src.data_pipeline.build_bars import aggregate_1m, bars_path, ticks_path, _to_epoch_sec

# 各商品對應的「近月連續」合約（自動換月）
CONTRACT_MAP = {"TX": "TXFR1", "MTX": "MXFR1", "TMF": "TMFR1"}

# 流量低於此值（bytes）就停止，避免被永豐暫停使用權
MIN_REMAINING_BYTES = 5 * 1024 * 1024


def _login(api_key: str, secret_key: str, simulation: bool = False):
    import shioaji as sj
    api = sj.Shioaji(simulation=simulation)
    api.login(api_key=api_key, secret_key=secret_key)
    return api


def _get_contract(api, product: str):
    code = CONTRACT_MAP.get(product, product)
    futures = api.Contracts.Futures
    try:
        return getattr(futures, code)
    except AttributeError:
        return futures[code]


def _ticks_to_df(raw, date: dt.date) -> pd.DataFrame:
    """Shioaji ticks 物件 → 本專案 tick DataFrame（time/price/volume），只留日盤。"""
    ts = pd.to_datetime(pd.Series(raw.ts))   # naive datetime
    df = pd.DataFrame({"ts": ts,
                       "price": pd.Series(raw.close, dtype="float64"),
                       "volume": pd.Series(raw.volume, dtype="float64")})
    if df.empty:
        return df.assign(time=pd.Series(dtype="int64"))[["time", "price", "volume"]]

    # Shioaji ts 通常已是台北牆鐘；若偵測到像 UTC（多落在 0–5 時）則 +8 修正
    if (df["ts"].dt.hour < 6).mean() > 0.5:
        df["ts"] = df["ts"] + pd.Timedelta(hours=8)

    start = pd.Timestamp(f"{date} {DAY_SESSION_START}")
    end = pd.Timestamp(f"{date} {DAY_SESSION_END}")
    df = df[(df["ts"] >= start) & (df["ts"] <= end)]

    out = pd.DataFrame({
        "time": _to_epoch_sec(df["ts"]),
        "price": df["price"].values,
        "volume": df["volume"].values,   # 單邊量，不 ÷2
    })
    return out.sort_values("time").reset_index(drop=True)


def _print_usage(api) -> int:
    """印出流量配額，回傳剩餘 bytes（查詢失敗回傳一個大數以免誤停）。"""
    try:
        u = api.usage()
        mb = lambda b: f"{b / 1024 / 1024:.1f}MB"
        print(f"  流量：已用 {mb(u.bytes)} / 上限 {mb(u.limit_bytes)}（剩 {mb(u.remaining_bytes)}）")
        return u.remaining_bytes
    except Exception as e:  # noqa: BLE001
        print(f"  (查詢流量失敗：{e})")
        return 1 << 40


def self_check(api, date: dt.date, product: str) -> bool:
    print(f"[檢查] 嘗試抓 {product}（{CONTRACT_MAP.get(product, product)}）{date} 的逐筆…")
    raw = api.ticks(_get_contract(api, product), date.strftime("%Y-%m-%d"))
    n = len(raw.ts)
    print(f"[檢查] 回傳 {n:,} 筆原始 tick")
    _print_usage(api)
    if n == 0:
        print("[檢查] 抓到 0 筆：可能是假日，或行情權限尚未開通（換個交易日再試）。")
        return False
    df = _ticks_to_df(raw, date)
    print(f"[檢查] 篩日盤後 {len(df):,} 筆 → 權限正常，可以下載！")
    return True


def fetch_day(api, date: dt.date, product: str, *, overwrite: bool) -> str:
    tp = ticks_path(date, product)
    if tp.exists() and not overwrite:
        return "skip"
    raw = api.ticks(_get_contract(api, product), date.strftime("%Y-%m-%d"))
    if len(raw.ts) == 0:
        return "empty"
    df = _ticks_to_df(raw, date)
    if df.empty:
        return "empty"
    df.to_parquet(tp, index=False)
    aggregate_1m(df).to_parquet(bars_path(date, product), index=False)
    print(f"[ok] {tp.name}：{len(df):,} 筆 tick")
    return "ok"


def _daterange(start: dt.date, end: dt.date):
    d = start
    while d <= end:
        if d.weekday() < 5:        # 跳過週末
            yield d
        d += dt.timedelta(days=1)


def _creds(args) -> tuple[str, str]:
    key = args.api_key or os.environ.get("SHIOAJI_API_KEY")
    sec = args.secret_key or os.environ.get("SHIOAJI_SECRET_KEY")
    if not key or not sec:
        sys.exit("缺少金鑰：請用 --api-key/--secret-key 或環境變數 "
                 "SHIOAJI_API_KEY / SHIOAJI_SECRET_KEY")
    return key, sec


def _parse_date(s: str) -> dt.date:
    return dt.datetime.strptime(s, "%Y-%m-%d").date()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="用 Shioaji 回補台指期歷史逐筆")
    ap.add_argument("--check", action="store_true", help="只做連線/權限自我檢查")
    ap.add_argument("--date", type=_parse_date, help="檢查用的交易日")
    ap.add_argument("--start", type=_parse_date, help="回補起日 YYYY-MM-DD")
    ap.add_argument("--end", type=_parse_date, help="回補迄日 YYYY-MM-DD")
    ap.add_argument("--product", default="TX", help="TX 大台 / MTX 小台 / TMF 微台")
    ap.add_argument("--overwrite", action="store_true", help="覆寫已存在的檔")
    ap.add_argument("--api-key")
    ap.add_argument("--secret-key")
    ap.add_argument("--simulation", action="store_true",
                    help="連測試環境（token 無正式權限時可試，但多半沒有歷史行情）")
    args = ap.parse_args(argv)

    key, sec = _creds(args)
    api = _login(key, sec, simulation=args.simulation)
    try:
        if args.check:
            date = args.date or (dt.date.today() - dt.timedelta(days=1))
            ok = self_check(api, date, args.product)
            return 0 if ok else 1

        if not (args.start and args.end):
            sys.exit("請提供 --start 與 --end（或用 --check 做檢查）")

        n_ok = n_skip = n_empty = 0
        for d in _daterange(args.start, args.end):
            status = fetch_day(api, d, args.product, overwrite=args.overwrite)
            n_ok += status == "ok"
            n_skip += status == "skip"
            n_empty += status == "empty"
            if status == "ok" and _print_usage(api) < MIN_REMAINING_BYTES:
                print("[停止] 當日流量配額快用完，明天再續跑。")
                break
        print(f"\n完成：新增 {n_ok}、略過 {n_skip}、無資料 {n_empty}")
        return 0
    finally:
        try:
            api.logout()
        except Exception:  # noqa: BLE001
            pass


if __name__ == "__main__":
    sys.exit(main())

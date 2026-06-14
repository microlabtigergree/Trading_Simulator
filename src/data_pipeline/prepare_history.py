"""一次備妥過去 N 個交易日的資料：下載期交所逐筆 zip + 建 tick/1分K parquet。

從今天往回逐日嘗試下載；週末與假日沒有檔案會自動跳過，
直到湊滿 N 個交易日或回溯超過上限。已存在的檔案會略過（可重複執行）。

用法：
  python -m src.data_pipeline.prepare_history              # 過去 30 個交易日 TX
  python -m src.data_pipeline.prepare_history --days 30 --product TX
"""
from __future__ import annotations

import argparse
import datetime as dt
import sys
import time

from src.data_pipeline import build_bars
from src.data_pipeline.downloader import download


def prepare(days: int, product: str, *, max_lookback: int = 60) -> list[dt.date]:
    done: list[dt.date] = []
    day = dt.date.today()
    looked = 0

    while len(done) < days and looked < max_lookback:
        looked += 1
        # 週末直接跳過（期交所無資料）
        if day.weekday() < 5:
            zip_path = download(day)            # 假日/未開放回傳 None
            if zip_path:
                _build_if_needed(day, product)
                done.append(day)
                time.sleep(0.5)                  # 對期交所客氣一點
        day -= dt.timedelta(days=1)

    return done


def _build_if_needed(date: dt.date, product: str) -> None:
    tp = build_bars.ticks_path(date, product)
    bp = build_bars.bars_path(date, product)
    if tp.exists() and bp.exists():
        print(f"[skip-build] {tp.name} 已存在")
        return
    try:
        ticks = build_bars.clean_ticks(date, product)
        bars = build_bars.build_bars(date, product)
    except ValueError as e:
        print(f"[warn] {date} 建檔失敗：{e}")
        return
    ticks.to_parquet(tp, index=False)
    bars.to_parquet(bp, index=False)
    print(f"[build] {date}：{len(ticks):,} 筆 tick、{len(bars)} 根 K")


def _parse_date(s: str) -> dt.date:
    return dt.datetime.strptime(s, "%Y-%m-%d").date()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="備妥過去 N 個交易日資料")
    ap.add_argument("--days", type=int, default=30, help="要湊滿的交易日數，預設 30")
    ap.add_argument("--product", default="TX", help="商品代號 (TX 大台 / MTX 小台)")
    args = ap.parse_args(argv)

    done = prepare(args.days, args.product)
    print(f"\n完成：備妥 {len(done)} 個交易日（{done[-1]} ~ {done[0]}）" if done
          else "\n沒有抓到任何交易日資料")
    return 0 if done else 1


if __name__ == "__main__":
    sys.exit(main())

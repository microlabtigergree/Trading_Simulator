"""下載期交所每日「期貨每筆成交資料」zip 到 data/raw/。

期交所每日逐筆檔網址：
  https://www.taifex.com.tw/file/taifex/Dailydownload/DailydownloadCSV/Daily_YYYY_MM_DD.zip
免費資料僅保證最近約 30 個交易日，欲累積長期歷史需每日排程執行本程式。

用法：
  python -m src.data_pipeline.downloader --date 2026-06-13
  python -m src.data_pipeline.downloader            # 預設抓「今天」
"""
from __future__ import annotations

import argparse
import datetime as dt
import sys

import requests

from src.config import RAW_DIR

BASE_URL = "https://www.taifex.com.tw/file/taifex/Dailydownload/DailydownloadCSV"
HEADERS = {
    # 期交所會擋掉沒有 UA 的請求
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) trading-simulator/0.1",
}


def zip_name(date: dt.date) -> str:
    return f"Daily_{date:%Y_%m_%d}.zip"


def download(date: dt.date, *, overwrite: bool = False) -> str | None:
    """下載指定日期的逐筆 zip。回傳存檔路徑；無資料(假日/未開放)回傳 None。"""
    dest = RAW_DIR / zip_name(date)
    if dest.exists() and not overwrite:
        print(f"[skip] 已存在 {dest.name}")
        return str(dest)

    url = f"{BASE_URL}/{zip_name(date)}"
    resp = requests.get(url, headers=HEADERS, timeout=60)

    # 期交所對沒有資料的日期可能回 200 但內容很小，或回 404
    content_type = resp.headers.get("Content-Type", "")
    if resp.status_code != 200 or "zip" not in content_type.lower() and len(resp.content) < 1000:
        print(f"[none] {date} 無逐筆資料 (status={resp.status_code}, len={len(resp.content)})")
        return None

    dest.write_bytes(resp.content)
    print(f"[ok] {dest.name} ({len(resp.content):,} bytes)")
    return str(dest)


def _parse_date(s: str) -> dt.date:
    return dt.datetime.strptime(s, "%Y-%m-%d").date()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="下載期交所每日逐筆成交 zip")
    ap.add_argument("--date", type=_parse_date, default=dt.date.today(),
                    help="交易日 YYYY-MM-DD，預設今天")
    ap.add_argument("--overwrite", action="store_true", help="覆寫已存在檔案")
    args = ap.parse_args(argv)

    path = download(args.date, overwrite=args.overwrite)
    return 0 if path else 1


if __name__ == "__main__":
    sys.exit(main())

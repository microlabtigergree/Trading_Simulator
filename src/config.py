"""集中設定：路徑、日盤時段、商品代號。"""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
RAW_DIR = DATA_DIR / "raw"
BARS_DIR = DATA_DIR / "bars"

# 日盤時段（含開盤集合競價 08:45，收盤 13:45）
DAY_SESSION_START = "08:45:00"
DAY_SESSION_END = "13:45:00"

# 預設商品：大台 TX；小台為 MTX
DEFAULT_PRODUCT = "TX"

for _d in (RAW_DIR, BARS_DIR):
    _d.mkdir(parents=True, exist_ok=True)

"""練習成績存檔：每場一筆，存成 JSON Lines（data/sessions.jsonl）。

純檔案存取，方便日後長期追蹤進步；不入 git（屬個人練習資料）。
"""
from __future__ import annotations

import json
from pathlib import Path

from src.config import DATA_DIR

SESSIONS_FILE = DATA_DIR / "sessions.jsonl"


def append_session(rec: dict, path: Path | None = None) -> None:
    p = path or SESSIONS_FILE
    with open(p, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")


def clear_sessions(path: Path | None = None) -> None:
    p = Path(path or SESSIONS_FILE)
    if p.exists():
        p.unlink()


def load_sessions(path: Path | None = None) -> list[dict]:
    p = Path(path or SESSIONS_FILE)
    if not p.exists():
        return []
    out = []
    with open(p, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                out.append(json.loads(line))
    return out

"""FastAPI：列出可回放交易日 + WebSocket 串流回放。

REST
  GET /api/dates                  → 可回放的 (product, date) 清單
WS
  /ws/replay/{product}/{date}     → 連線後依引擎節奏推 1分K
    client → server 控制訊息(JSON)：
      {"cmd":"play"} / {"cmd":"pause"} / {"cmd":"step"}
      {"cmd":"speed","value":60} / {"cmd":"seek","index":120}
    server → client：
      {"type":"meta","total":N,"date":...,"product":...}
      {"type":"bar","data":{time,open,high,low,close,volume}}
      {"type":"end"}
靜態前端掛在 /
"""
from __future__ import annotations

import asyncio
import re
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles

from src.config import BARS_DIR, ROOT
from src.replay.engine import ReplayEngine
from src.server import sessions

app = FastAPI(title="台指期當沖訓練 — 回放引擎")

_TICK_FILE_RE = re.compile(r"^(?P<product>\w+)_(?P<date>\d{4}-\d{2}-\d{2})_ticks\.parquet$")


@app.get("/api/dates")
def list_dates() -> list[dict]:
    """掃 data/bars 下已建好的逐筆 tick 檔（回放所需）。"""
    out = []
    for p in sorted(BARS_DIR.glob("*_ticks.parquet")):
        m = _TICK_FILE_RE.match(p.name)
        if m:
            out.append({"product": m["product"], "date": m["date"]})
    return out


@app.get("/api/sessions")
def get_sessions() -> list[dict]:
    """回傳所有已存檔的練習成績。"""
    return sessions.load_sessions()


@app.post("/api/session")
async def save_session(rec: dict) -> dict:
    """存檔一場練習成績。"""
    sessions.append_session(rec)
    return {"ok": True, "count": len(sessions.load_sessions())}


def _ticks_path(product: str, date: str) -> Path:
    return BARS_DIR / f"{product}_{date}_ticks.parquet"


@app.websocket("/ws/replay/{product}/{date}")
async def replay(ws: WebSocket, product: str, date: str) -> None:
    await ws.accept()
    path = _ticks_path(product, date)
    if not path.exists():
        await ws.send_json({"type": "error", "msg": f"找不到 {path.name}"})
        await ws.close()
        return

    engine = ReplayEngine.from_parquet(path, speed=1.0)
    await ws.send_json({"type": "meta", "total": engine.total,
                        "product": product, "date": date})

    async def pump_controls() -> None:
        """背景接收前端控制訊息。"""
        try:
            while True:
                msg = await ws.receive_json()
                cmd = msg.get("cmd")
                if cmd == "play":
                    engine.play()
                elif cmd == "pause":
                    engine.pause()
                elif cmd == "step":
                    engine.step()
                elif cmd == "speed":
                    engine.set_speed(float(msg.get("value", 60)))
                elif cmd == "seek":
                    engine.seek(int(msg.get("index", 0)))
        except (WebSocketDisconnect, RuntimeError):
            pass

    controls = asyncio.ensure_future(pump_controls())
    try:
        async for tick in engine.stream():
            await ws.send_json({"type": "tick", "data": tick})
        await ws.send_json({"type": "end"})
    except WebSocketDisconnect:
        pass
    finally:
        controls.cancel()


# 靜態前端（放最後，避免蓋掉 /api 與 /ws）
_web = ROOT / "web"
if _web.exists():
    app.mount("/", StaticFiles(directory=str(_web), html=True), name="web")

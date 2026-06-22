"""回放引擎：把某交易日的逐筆 tick 依時間順序、可控速度放出來。

前端收到 tick 後自行聚合成「正在形成中」的 1 分 K（最高/最低/收盤隨 tick 跳動）。

狀態機：play / pause / step / seek / set_speed。
推送節奏：相鄰 tick 的秒間隔 ÷ speed（長間隔上限 MAX_GAP_SEC，避免冷清時段卡住）。
  speed=60 → 1 分鐘的盤勢壓縮成約 1 秒播放。
step：往前播放「一整根 K」——把下一分鐘的 tick 連續放完後暫停。
  （對 1 分 K 資料而言，一次 step 剛好就是一根，與舊行為相容。）

預留下單接口：on_event callback —— 未來模擬下單模組可掛在這裡讀現價、撮合。
"""
from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable
from pathlib import Path

import pandas as pd

# 相鄰事件間隔上限（秒）：純安全閥，避免極端停頓凍結畫面。
# 日盤連續交易、tick 間隔通常僅數秒，放寬到 10 秒讓 1x 真實速度忠實重現盤中停頓。
MAX_GAP_SEC = 10.0


def _minute(epoch_sec: int) -> int:
    return epoch_sec // 60


class ReplayEngine:
    def __init__(self, events: pd.DataFrame, *, speed: float = 60.0,
                 on_event: Callable[[dict], None] | None = None):
        self._events: list[dict] = events.to_dict("records")
        self.cursor = 0                 # 下一個要放出的 index
        self.speed = max(speed, 0.001)
        self.on_event = on_event
        self._playing = False
        self._step_pending = False
        self._resume = asyncio.Event()  # play 時 set、pause 時 clear
        self._step_evt = asyncio.Event()

    @classmethod
    def from_parquet(cls, path: str | Path, **kw) -> "ReplayEngine":
        return cls(pd.read_parquet(path), **kw)

    @property
    def total(self) -> int:
        return len(self._events)

    @property
    def playing(self) -> bool:
        return self._playing

    # ---- 控制 ----
    def play(self) -> None:
        self._playing = True
        self._resume.set()

    def pause(self) -> None:
        self._playing = False
        self._resume.clear()

    def step(self) -> None:
        """往前播放一整根 K（放完下一分鐘的 tick 後暫停）。"""
        self._step_evt.set()

    def set_speed(self, speed: float) -> None:
        self.speed = max(speed, 0.001)

    def seek(self, index: int) -> None:
        self.cursor = max(0, min(index, self.total))

    def seek_time(self, epoch_sec: int) -> None:
        """跳到第一個 time >= epoch_sec 的事件（用於從盤中某時刻開始）。"""
        idx = next((i for i, ev in enumerate(self._events)
                    if ev["time"] >= epoch_sec), self.total)
        self.cursor = idx

    # ---- 串流 ----
    async def stream(self) -> AsyncIterator[dict]:
        while self.cursor < self.total:
            if not self._playing and not self._step_pending:
                await self._wait_play_or_step()
                if self._step_evt.is_set():
                    self._step_pending = True
                    self._step_evt.clear()

            ev = self._events[self.cursor]
            self.cursor += 1
            if self.on_event:
                self.on_event(ev)
            yield ev

            if self.cursor >= self.total:
                break
            nxt = self._events[self.cursor]
            crossed_minute = _minute(nxt["time"]) != _minute(ev["time"])

            if self._step_pending:
                # step 期間連續放完該分鐘的 tick；跨到新分鐘就停下
                if crossed_minute:
                    self._step_pending = False
                continue

            if self._playing:
                gap = min(max(nxt["time"] - ev["time"], 0), MAX_GAP_SEC)
                await asyncio.sleep(gap / self.speed)

    async def _wait_play_or_step(self) -> None:
        resume = asyncio.ensure_future(self._resume.wait())
        step = asyncio.ensure_future(self._step_evt.wait())
        _, pending = await asyncio.wait(
            {resume, step}, return_when=asyncio.FIRST_COMPLETED)
        for t in pending:
            t.cancel()

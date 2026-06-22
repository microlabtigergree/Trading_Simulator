"""驗證 ReplayEngine 狀態機（tick 串流）：step（依分鐘）/ play / seek / speed。"""
import asyncio

import pandas as pd

from src.replay.engine import ReplayEngine

# 兩分鐘的 tick：08:45 三筆、08:46 兩筆（time 為 epoch 秒）
M0 = 1000 * 60   # 第 0 分鐘起點
M1 = 1001 * 60   # 第 1 分鐘起點
TICKS = pd.DataFrame({
    "time":   [M0, M0 + 10, M0 + 30, M1, M1 + 5],
    "price":  [100, 101, 99, 102, 103],
    "volume": [1, 2, 1, 3, 1],
})


def _engine(**kw):
    return ReplayEngine(TICKS, speed=100000, **kw)  # 高速 → sleep 近乎 0


def test_play_streams_all_ticks_in_order():
    async def scenario():
        eng = _engine()
        eng.play()
        return [t["price"] async for t in eng.stream()]

    assert asyncio.run(scenario()) == [100, 101, 99, 102, 103]


def test_step_advances_one_bar_worth_of_ticks():
    async def scenario():
        eng = _engine()
        agen = eng.stream()
        got = []
        # 第一次 step → 放完第 0 分鐘的 3 筆後暫停
        eng.step()
        for _ in range(3):
            got.append((await asyncio.wait_for(agen.__anext__(), timeout=1))["price"])
        return got, eng

    got, eng = asyncio.run(scenario())
    assert got == [100, 101, 99]          # 剛好一根 K 的 tick
    assert eng.cursor == 3                 # 停在第 1 分鐘開頭，尚未放出


def test_seek_then_play():
    async def scenario():
        eng = _engine()
        eng.seek(3)
        eng.play()
        return [t["price"] async for t in eng.stream()]

    assert asyncio.run(scenario()) == [102, 103]


def test_seek_time_then_play():
    async def scenario():
        eng = _engine()
        eng.seek_time(M1)          # 跳到第 1 分鐘起點
        eng.play()
        return [t["price"] async for t in eng.stream()]

    assert asyncio.run(scenario()) == [102, 103]


def test_on_event_callback_fires():
    seen = []

    async def scenario():
        eng = _engine(on_event=lambda t: seen.append(t["price"]))
        eng.play()
        async for _ in eng.stream():
            pass

    asyncio.run(scenario())
    assert seen == [100, 101, 99, 102, 103]


def test_set_speed_clamps_and_applies():
    eng = _engine()
    eng.set_speed(0)            # 不可為 0
    assert eng.speed > 0
    eng.set_speed(120)
    assert eng.speed == 120

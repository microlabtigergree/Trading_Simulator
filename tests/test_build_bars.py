"""驗證 build_bars：TX 篩選、近月選取、日盤過濾、量÷2、OHLCV。"""
import datetime as dt
import io
import zipfile

import pytest

from src.config import RAW_DIR
from src.data_pipeline import build_bars

TEST_DATE = dt.date(2099, 1, 2)

HEADER = "成交日期,商品代號,到期月份(週別),成交時間,成交價格,成交數量(B+S),近月價格,遠月價格,開盤集合競價"

# 商品/到期月/時間/價/量(B+S)
ROWS = [
    # TX 近月 202901（總量大 → 應被選為近月）
    ("TX", "202901", "084500", 18000, 2),   # 08:45 開
    ("TX", "202901", "084530", 18010, 4),   # 08:45
    ("TX", "202901", "084610", 17990, 2),   # 08:46
    ("TX", "202901", "134500", 18050, 2),   # 13:45 收盤邊界（含）
    ("TX", "202901", "150000", 18100, 100),  # 夜盤 → 應排除
    # TX 遠月 202902（量小 → 不選）
    ("TX", "202902", "084500", 18500, 1),
    # 小台 → 應被商品篩掉
    ("MTX", "202901", "084500", 9000, 50),
    # 週合約 → 非 6 位數，應被近月規則排除
    ("TX", "202901W1", "084500", 17000, 30),
]


def _make_fake_zip():
    lines = [HEADER]
    for product, expiry, time, price, qty in ROWS:
        lines.append(f"{TEST_DATE:%Y/%m/%d},{product},{expiry},{time},{price},{qty},0,0,0")
    csv_bytes = "\n".join(lines).encode("ms950")

    zip_path = RAW_DIR / f"Daily_{TEST_DATE:%Y_%m_%d}.zip"
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr(f"Daily_{TEST_DATE:%Y_%m_%d}.csv", csv_bytes)
    return zip_path


@pytest.fixture
def fake_zip():
    path = _make_fake_zip()
    yield path
    path.unlink(missing_ok=True)


def test_build_bars(fake_zip):
    bars = build_bars.build_bars(TEST_DATE, "TX")

    # 夜盤、遠月、MTX、週合約都被排除 → 只剩 3 根日盤 K
    assert len(bars) == 3

    # time 以台北牆鐘當 UTC 存放 → 第一根應為 08:45、最後一根 13:45
    first_dt = dt.datetime.fromtimestamp(int(bars.iloc[0].time), dt.UTC)
    last_dt = dt.datetime.fromtimestamp(int(bars.iloc[-1].time), dt.UTC)
    assert (first_dt.hour, first_dt.minute) == (8, 45)
    assert (last_dt.hour, last_dt.minute) == (13, 45)

    first = bars.iloc[0]   # 08:45
    assert first.open == 18000
    assert first.high == 18010
    assert first.low == 18000
    assert first.close == 18010
    assert first.volume == 3            # (2+4)/2

    assert bars.iloc[1].close == 17990  # 08:46
    last = bars.iloc[2]                 # 13:45 邊界含入
    assert last.close == 18050
    assert last.volume == 1             # 2/2

    # 量已 ÷2：總和 = (2+4+2+2)/2 = 5
    assert int(bars["volume"].sum()) == 5


def test_clean_ticks(fake_zip):
    ticks = build_bars.clean_ticks(TEST_DATE, "TX")

    # 日盤 TX 近月 4 筆（夜盤/遠月/MTX/週合約皆排除）
    assert len(ticks) == 4
    assert list(ticks["price"]) == [18000, 18010, 17990, 18050]
    # 每筆量已 ÷2，總和 5
    assert ticks["volume"].sum() == 5.0
    # 依時間遞增
    assert list(ticks["time"]) == sorted(ticks["time"])

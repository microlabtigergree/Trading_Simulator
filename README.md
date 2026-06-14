# 台指期當沖訓練程式 — 第一階段：Tick → 1分K 回放引擎

把期交所歷史逐筆（tick）成交資料以可控速度（播放／暫停／單步／變速）放出來，
**正在形成中的那根 1 分 K 會隨 tick 即時跳動**（最高/最低/收盤逐筆變化），
到下一分鐘才落定、開新棒——像 TradingView 的 Bar Replay 一樣練盤感。

## 架構

```
downloader  →  build_bars  →  data/bars/*.parquet
（抓期交所 zip）（tick→1分K）          │
                                       ▼
                          FastAPI (REST + WebSocket)
                                       │  推 1分K
                                       ▼
                     瀏覽器（Lightweight Charts 蠟燭圖 + 控制列）
```

| 模組 | 檔案 |
|---|---|
| 下載期交所每日逐筆 zip | `src/data_pipeline/downloader.py` |
| 清洗 tick（篩 TX、近月、日盤、量÷2）+ 聚合 1分K，輸出 `_ticks.parquet` 與 `_1m.parquet` | `src/data_pipeline/build_bars.py` |
| 回放引擎（串流 tick，play/pause/step/seek/speed，預留 `on_event` 下單接口） | `src/replay/engine.py` |
| FastAPI（`/api/dates`、`/ws/replay/{product}/{date}`） | `src/server/app.py` |
| 前端 | `web/index.html`、`web/main.js` |

## 安裝

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e .
```

## 最簡單：雙擊啟動檔

| 檔案 | 用途 |
|---|---|
| **啟動網頁.bat** | 啟動回放伺服器並自動開啟瀏覽器（要結束就關掉那個黑視窗）。一次只跑一個。 |
| **更新資料.bat** | 下載最新逐筆資料並建 K 線（已下載過的會略過）。建議每天盤後雙擊一次累積歷史。 |

## 使用流程（手動指令）

```powershell
# 1. 下載某交易日逐筆資料（免費版僅最近約 30 個交易日）
.\.venv\Scripts\python.exe -m src.data_pipeline.downloader --date 2026-06-12

# 2. 建 1 分 K（TX 大台 / MTX 小台）
.\.venv\Scripts\python.exe -m src.data_pipeline.build_bars --date 2026-06-12 --product TX

# 3. 啟動回放伺服器
.\.venv\Scripts\python.exe -m uvicorn src.server.app:app --port 8000
# 開瀏覽器 http://127.0.0.1:8000 → 選交易日 → 按播放
```

## 測試

```powershell
.\.venv\Scripts\python.exe -m pytest -q
```

## 資料來源與限制

- 來源：期交所「每日期貨每筆成交資料」
  `https://www.taifex.com.tw/file/taifex/Dailydownload/DailydownloadCSV/Daily_YYYY_MM_DD.zip`
- **免費資料只涵蓋最近約 30 個交易日**。要累積長期歷史，需每日排程執行
  `downloader.py` 把每天的檔案存下來；或日後改走付費「交易歷史資料申請」／
  券商 API（如永豐 Shioaji）。資料來源已可抽換。

### 每日自動下載（Windows 工作排程器）

建立一個每交易日盤後（約 15:00 後）執行的工作，命令為：

```
<專案路徑>\.venv\Scripts\python.exe -m src.data_pipeline.downloader
```

工作目錄設為專案根目錄 `c:\TRADING_SIMULATOR`。

## 重要實作細節

- **tick 即時聚合**：後端串流逐筆 tick（節奏＝相鄰 tick 秒間隔 ÷ speed），
  前端把同分鐘的 tick 即時聚合成「形成中」的 K 棒（`candleSeries.update` 同一根反覆更新）。
  `單步` = 往前播放一整根 K（放完該分鐘 tick 後暫停）。
- **量÷2**：原始 `成交數量(B+S)` 是買賣雙邊重複計算，除以 2。
- **近月選取**：同日取成交量最大的月合約（排除週別／價差），即最活躍近月。
- **時間軸**：`time` 以「台北牆鐘時間當作 UTC」存成 epoch 秒，
  讓 Lightweight Charts 直接顯示 08:45–13:45，不需處理時區。

## 第一階段刻意未做（架構已預留）

- 模擬下單／部位／損益／當沖結算 → 掛在 `ReplayEngine.on_event`（每筆 tick 觸發）。
- 長期歷史資料來源切換 → loader 已抽象。
- 小台等其他商品 → `--product` 參數已支援。

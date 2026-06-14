@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo    台指期當沖訓練 - 更新期交所資料
echo ============================================
echo.
echo 正在下載最新逐筆資料並建立 K 線...
echo （已下載過的日期會自動略過）
echo.
".venv\Scripts\python.exe" -m src.data_pipeline.prepare_history --days 30 --product TX
echo.
echo 完成！按任意鍵關閉視窗。
pause >nul
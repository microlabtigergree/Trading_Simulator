@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo    台指期當沖訓練 - 更新期交所資料
echo ============================================
echo.
echo [1/3] 更新大台 TX...
".venv\Scripts\python.exe" -m src.data_pipeline.prepare_history --days 30 --product TX
echo.
echo [2/3] 更新小台 MTX...
".venv\Scripts\python.exe" -m src.data_pipeline.prepare_history --days 30 --product MTX
echo.
echo [3/3] 更新微台 TMF...
".venv\Scripts\python.exe" -m src.data_pipeline.prepare_history --days 30 --product TMF
echo.
echo 完成！按任意鍵關閉視窗。
pause >nul
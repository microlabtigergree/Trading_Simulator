@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo    台指期當沖訓練 - 啟動回放網頁
echo ============================================
echo.
echo 正在啟動伺服器，3 秒後自動開啟瀏覽器...
echo （要結束時，直接關閉這個視窗即可）
echo.
start "" powershell -WindowStyle Hidden -Command "Start-Sleep -Seconds 3; Start-Process 'http://127.0.0.1:8000'"
".venv\Scripts\python.exe" -m uvicorn src.server.app:app --host 127.0.0.1 --port 8000
echo.
echo 伺服器已停止。按任意鍵關閉視窗。
pause >nul
@echo off
setlocal
cd /d "%~dp0"
title SMART INVENTORY - Server
if not exist .venv\Scripts\python.exe (
 echo Setup is missing. Run setup.bat first.
 pause
 exit /b 1
)
start "SMART INVENTORY" http://127.0.0.1:8000
timeout /t 2 /nobreak >nul
.venv\Scripts\python.exe -m uvicorn app:app --host 0.0.0.0 --port 8000
 echo.
echo The server stopped. Read the error above.
pause

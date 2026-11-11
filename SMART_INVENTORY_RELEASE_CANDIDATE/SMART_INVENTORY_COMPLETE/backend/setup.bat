@echo off
setlocal
cd /d "%~dp0"
title SMART INVENTORY - Setup
where py >nul 2>nul
if not errorlevel 1 (
  py -3 -m venv .venv
) else (
  where python >nul 2>nul
  if errorlevel 1 goto no_python
  python -m venv .venv
)
if errorlevel 1 goto failed
.venv\Scripts\python.exe -m pip install --upgrade pip
if errorlevel 1 goto failed
.venv\Scripts\python.exe -m pip install -r requirements.txt
if errorlevel 1 goto failed
if not exist smart_inventory.db (
  .venv\Scripts\python.exe configure_admin.py
  if errorlevel 1 goto failed
)
echo.
echo Setup completed. Run start.bat to launch the application.
pause
exit /b 0
:no_python
echo Python 3 is not installed. Install Python 3.11 or newer and try again.
pause
exit /b 1
:failed
echo Setup failed. Read the error above.
pause
exit /b 1

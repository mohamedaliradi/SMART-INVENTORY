@echo off
setlocal
cd /d "%~dp0"
if not exist smart_inventory.db (
 echo Database not found.
 pause
 exit /b 1
)
if not exist backups mkdir backups
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd_HHmmss"') do set STAMP=%%i
copy /y smart_inventory.db "backups\smart_inventory_%STAMP%.db" >nul
if errorlevel 1 (echo Backup failed.) else (echo Backup saved in backups folder.)
pause

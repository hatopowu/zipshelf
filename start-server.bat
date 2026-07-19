@echo off
chcp 65001 >nul
rem Serve ZipShelf locally. Shares ZipSlide's serve.py (no copy kept here).
rem Runs over https too, so OPFS / ServiceWorker work on a real iPad
rem without pushing to GitHub Pages. Ports are offset so ZipSlide can run at the same time.
cd /d "%~dp0"
set "ZIPSLIDE_APP_DIR=%~dp0"
set "ZIPSLIDE_PORT=8010"
set "ZIPSLIDE_TLS_PORT=8453"
python "%~dp0..\ZipSlide\serve.py"
pause

@echo off
chcp 65001 >nul
rem Starts ZipSlide + ZipShelf + TextShelf together (one process, one port pair
rem per app), so any single start-server.bat makes all three reachable from iPad.
rem The three .bat files are interchangeable; per-app ports and import folders
rem live in ZipSlide\serve.py (SIBLING_APPS). Shares ZipSlide's serve.py (no copy here).
rem NOTE: keep this file ASCII-only. cmd reads .bat as cp932, so UTF-8 Japanese
rem breaks parsing (Japanese notes live in the usage memo .txt next to this file).
cd /d "%~dp0"
python "%~dp0..\ZipSlide\serve.py"
pause

@echo off
rem PC上での動作確認用。localhost は secure context なので OPFS / SW が動く
cd /d %~dp0
py -m http.server 8010 --bind 127.0.0.1

@echo off
title UNO Chips Server
cd /d "%~dp0"

echo ========================================
echo   UNO CHIPS - Server
echo   Biarkan jendela ini terbuka selama main.
echo   Tutup jendela ini untuk mematikan server.
echo ========================================
echo.

rem Buka browser sekali di awal
start "" http://localhost:3000

:loop
node server/index.js
echo.
echo Server berhenti. Menyalakan ulang dalam 3 detik... (tutup jendela ini untuk keluar)
timeout /t 3 /nobreak >nul
goto loop

@echo off
chcp 65001 >nul
title Bizadvisor Inflow Collector
cd /d "%~dp0"

echo ============================================================
echo    Bizadvisor Marketing Inflow - Daily Collection
echo ============================================================
echo.
echo  STEP 1) Open Bizadvisor "Marketing Analysis" page (logged in)
echo  STEP 2) F12 - Network tab - refresh the page
echo  STEP 3) Right-click "report?useIndex=..." request
echo          - Copy - "Copy as cURL (bash)"
echo  STEP 4) Paste into the Notepad that opens - Save(Ctrl+S) - Close
echo.
echo  Press any key to continue. (Notepad will open)
pause >nul

if not exist "scripts\bizadvisor-curl.txt" (type nul > "scripts\bizadvisor-curl.txt")
notepad "scripts\bizadvisor-curl.txt"

echo.
echo  Collecting... (last month + this month into DB)
echo.
for /f %%i in ('powershell -NoProfile -Command "(Get-Date).AddMonths(-1).ToString('yyyy-MM')"') do set YM=%%i
node "scripts\bizadvisor-export.js" %YM%

echo.
echo  Security: clearing saved token file.
type nul > "scripts\bizadvisor-curl.txt"
echo.
echo  =====  DONE  =====  (logout-login Bizadvisor to rotate session)
echo.
pause

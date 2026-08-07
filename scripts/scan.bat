@echo off
setlocal enabledelayedexpansion
REM ============================================================
REM  scan.bat - ASIN Offsite Promo Scanner (all-in-one CLI)
REM
REM  NOTE: This file is intentionally ASCII-only and CRLF-terminated.
REM        Non-ASCII text in a .bat breaks under the cmd GBK code page,
REM        and LF-only line endings corrupt block parsing (if/for).
REM        The Chinese quick-start guide lives in the repo root.
REM
REM  Usage:
REM    scan.bat B0H6Q7VFK9
REM    scan.bat B0H6Q7VFK9 --brand=Boytond --product="AI Translation Earbuds"
REM    scan.bat B0H6Q7VFK9 --out=D:\reports
REM    scan.bat B0H6Q7VFK9 --show          (show browser; quiet by default)
REM
REM  Prereqs: 1) Node.js  2) run setup.bat  3) run start_chrome_debug.bat and log in
REM ============================================================

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [X] Node.js not found. Install the LTS build first: https://nodejs.org
  echo     Then open a NEW cmd window and try again.
  echo.
  pause
  exit /b 1
)

if not exist "%~dp0node_modules\playwright" (
  echo.
  echo [X] Dependencies missing. Please run  setup.bat  in this folder first.
  echo.
  pause
  exit /b 1
)

REM No args (likely a double-click): ask for the ASIN interactively.
if "%~1"=="" (
  echo.
  echo ============================================================
  echo   ASIN Offsite Promo Scanner
  echo ============================================================
  echo.
  set /p ASIN="Enter ASIN (e.g. B0H6Q7VFK9): "
  if "!ASIN!"=="" goto :usage
  echo.
  node "%~dp0scan.js" !ASIN!
  echo.
  pause
  exit /b 0
)

node "%~dp0scan.js" %*
exit /b %errorlevel%

:usage
echo.
echo Usage: scan.bat ^<ASIN^> [--brand=NAME] [--product="KEYWORD"] [--out=DIR] [--show]
echo Example: scan.bat B0H6Q7VFK9 --brand=Boytond --product="AI Translation Earbuds"
echo.
pause
exit /b 1

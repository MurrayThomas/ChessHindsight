@echo off
rem One-time setup: create the virtual environment and install dependencies.
cd /d "%~dp0"

rem Anyone running this only wants to use the app is in the wrong place, and
rem the old message sent them to python.org to fix a problem they need not
rem have. This folder is the source; the built app needs nothing installed.
py -3 --version >nul 2>&1
if errorlevel 1 (
    echo.
    echo   Python 3 was not found - but you probably do not need it.
    echo.
    echo   This folder is the SOURCE CODE. To just use ChessHindsight,
    echo   download the ready-to-run version instead:
    echo.
    echo     https://github.com/MurrayThomas/ChessHindsight/releases
    echo.
    echo   Take ChessHindsight-windows-with-stockfish.zip, unzip it
    echo   anywhere, and double-click ChessHindsight.exe. Nothing to
    echo   install - that copy carries its own Python inside it.
    echo.
    echo   Only continue here if you actually want to work on the code,
    echo   in which case install Python 3 from python.org and re-run this.
    echo.
    pause
    exit /b 1
)

if not exist ".venv" (
    echo Creating virtual environment...
    py -3 -m venv .venv
)

echo Installing dependencies...
".venv\Scripts\python.exe" -m pip install --upgrade pip
".venv\Scripts\python.exe" -m pip install -r requirements.txt

echo.
echo Setup complete. Launch with ChessHindsight.bat
pause

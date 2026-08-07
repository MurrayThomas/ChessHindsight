@echo off
rem One-time setup: create the virtual environment and install dependencies.
cd /d "%~dp0"

py -3 --version >nul 2>&1
if errorlevel 1 (
    echo Python 3 not found. Install it from python.org and try again.
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
echo Setup complete. Launch with HindsightChess.bat
pause

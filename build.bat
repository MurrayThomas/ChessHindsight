@echo off
rem Build ChessHindsight.exe into dist\
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo Virtual environment not found. Run setup.bat first.
    pause
    exit /b 1
)

echo Installing/updating PyInstaller...
".venv\Scripts\python.exe" -m pip install --quiet --upgrade pyinstaller

echo.
echo Building ChessHindsight.exe ...
".venv\Scripts\python.exe" -m PyInstaller ChessHindsight.spec --noconfirm --clean
if errorlevel 1 (
    echo.
    echo Build FAILED.
    pause
    exit /b 1
)

echo.
echo Build complete: dist\ChessHindsight.exe
echo.
echo Copying Stockfish next to the exe...
if exist "stockfish" (
    if not exist "dist\stockfish" mkdir "dist\stockfish"
    copy /y "stockfish\*.exe" "dist\stockfish\" >nul
    echo   done.
) else (
    echo   no stockfish folder found - skipping.
)

echo.
echo You can now run dist\ChessHindsight.exe
pause

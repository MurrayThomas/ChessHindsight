@echo off
rem Package ChessHindsight into a zip that can be sent to someone else.
rem
rem This deliberately stages a clean folder rather than zipping dist\ directly:
rem dist\data\ holds the database and config.json - every game ever synced and
rem the account names behind them - and zipping dist\ would hand all of that
rem over along with the app.
rem
rem   package.bat                 app only (~15 MB zip)
rem   package.bat --with-engine   also bundles Stockfish (~100 MB zip)
setlocal
cd /d "%~dp0"

set "WITH_ENGINE="
if /i "%~1"=="--with-engine" set "WITH_ENGINE=1"

set "STAGE=build\package\ChessHindsight"
rem Distinct names, so the two variants cannot quietly overwrite each other and
rem leave you unsure which one you are about to send.
if defined WITH_ENGINE (
    set "ZIP=dist\ChessHindsight-windows-with-stockfish.zip"
) else (
    set "ZIP=dist\ChessHindsight-windows.zip"
)

if not exist "dist\ChessHindsight.exe" (
    echo dist\ChessHindsight.exe not found. Run build.bat first.
    pause
    exit /b 1
)

echo Staging...
if exist "build\package" rmdir /s /q "build\package"
mkdir "%STAGE%" || (echo Could not create staging folder. & pause & exit /b 1)

copy /y "dist\ChessHindsight.exe" "%STAGE%\" >nul
if exist "LICENSE" copy /y "LICENSE" "%STAGE%\LICENSE.txt" >nul

rem The two builds need different instructions: one sends the recipient off to
rem download Stockfish, the other tells them it is already there. Shipping the
rem wrong one is the likeliest way to confuse someone.
if defined WITH_ENGINE (
    copy /y "packaging\READ ME FIRST (with engine).txt" "%STAGE%\READ ME FIRST.txt" >nul
) else (
    copy /y "packaging\READ ME FIRST.txt" "%STAGE%\READ ME FIRST.txt" >nul
)

if defined WITH_ENGINE (
    if exist "stockfish" (
        echo Adding Stockfish...
        rem The whole official distribution goes in, verbatim, rather than just
        rem the .exe. Stockfish is GPL-3, so conveying the binary obliges us to
        rem convey its corresponding source too - and since src\ is under 1 MB
        rem against a 109 MB binary, mirroring the upstream archive is both the
        rem cheapest and the most defensible way to satisfy that.
        xcopy "stockfish" "%STAGE%\stockfish\" /e /i /q /y >nul
        if errorlevel 1 (
            echo   copying Stockfish FAILED.
            pause
            exit /b 1
        )
    ) else (
        echo   no stockfish folder found - skipping.
    )
)

echo Compressing...
if exist "%ZIP%" del /q "%ZIP%"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Compress-Archive -Path 'build\package\ChessHindsight' -DestinationPath '%ZIP%' -CompressionLevel Optimal"
if errorlevel 1 (
    echo.
    echo Packaging FAILED.
    pause
    exit /b 1
)

rem A data folder or a stray database in the zip would mean personal data just
rem got packaged. Two things this check has to get right:
rem   - Add-Type must run first, or the type is missing on Windows PowerShell.
rem   - Compress-Archive writes entry paths with BACKSLASHES, not the forward
rem     slashes the zip spec calls for, so the pattern has to accept both.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "try { Add-Type -AssemblyName System.IO.Compression.FileSystem; $z = [IO.Compression.ZipFile]::OpenRead((Resolve-Path '%ZIP%')); $bad = @($z.Entries | Where-Object { $_.FullName -match '(^|[\\/])data[\\/]' -or $_.FullName -match '\.(db|db-wal|db-shm|log)$' -or $_.FullName -match '(^|[\\/])config\.json$' }); $z.Dispose(); if ($bad.Count) { Write-Host ('Personal data in zip: ' + ($bad.FullName -join ', ')); exit 1 }; exit 0 } catch { Write-Host $_.Exception.Message; exit 2 }"
if errorlevel 1 (
    echo.
    echo Refusing to continue - could not verify the zip is free of personal data.
    pause
    exit /b 1
)

echo.
for %%F in ("%ZIP%") do echo Created %%~fF  (%%~zF bytes^)
echo.
echo Send that single file. The recipient unzips it and runs ChessHindsight.exe.
if not defined WITH_ENGINE echo Stockfish is not included - READ ME FIRST.txt tells them where to get it.
echo.
pause

# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller build spec for HindsightChess.

Produces a single HindsightChess.exe. The web/ folder is bundled inside it;
data/ (database + settings) and stockfish/ stay *outside*, next to the exe,
so they persist across runs and across rebuilds.

Build with:  build.bat      (or: pyinstaller HindsightChess.spec --noconfirm)
"""

hiddenimports = [
    # python-chess submodules are imported lazily, so PyInstaller's static
    # analysis does not always see them.
    "chess",
    "chess.pgn",
    "chess.engine",
    "chess.polyglot",
    "chess.variant",
    # pywebview picks its backend at runtime; on Windows 11 that is WebView2,
    # reached through pythonnet.
    "webview.platforms.edgechromium",
    "clr_loader",
    "clr_loader.netfx",
]

# Nothing here is used, and leaving them in roughly doubles the bundle.
excludes = [
    "tkinter",
    "unittest",
    "pydoc_data",
    "matplotlib",
    "numpy",
    "PIL",
    "pytest",
    "setuptools",
    "pip",
]

a = Analysis(
    ["app.py"],
    pathex=[],
    binaries=[],
    # openings.tsv is the opening-name book the Explorer labels lines with;
    # without it every position goes unnamed in the frozen build only, which is
    # the kind of difference that does not show up until release.
    datas=[
        ("web", "web"),
        ("assets/icon.ico", "assets"),
        ("assets/openings.tsv", "assets"),
    ],
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=excludes,
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="HindsightChess",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    runtime_tmpdir=None,
    console=False,          # desktop app: no console window
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon="assets/icon.ico",
)

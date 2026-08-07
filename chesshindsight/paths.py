"""Path resolution that works both from source and from a PyInstaller bundle.

Two distinct roots are needed, and conflating them is the classic packaging bug:

  resource_dir()  read-only assets shipped *inside* the bundle (the web/ folder).
                  Under one-file PyInstaller this is a temp directory that is
                  extracted on launch and deleted on exit — never write here.

  app_dir()       a writable, persistent location *beside* the executable, for
                  the database, settings and the engine binary. These must
                  survive across runs and must not be swallowed by the bundle.

Running from source both collapse to the project root.
"""

from __future__ import annotations

import sys
from pathlib import Path

_SOURCE_ROOT = Path(__file__).resolve().parent.parent


def is_frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def resource_dir() -> Path:
    """Where bundled read-only assets live."""
    if is_frozen():
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            return Path(meipass)
        return Path(sys.executable).resolve().parent
    return _SOURCE_ROOT


def app_dir() -> Path:
    """Where user data is read and written."""
    if is_frozen():
        return Path(sys.executable).resolve().parent
    return _SOURCE_ROOT

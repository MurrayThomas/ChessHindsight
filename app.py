"""HindsightChess desktop entry point.

Starts the local API server on a loopback port, then opens a native window
pointed at it. The window and the browser therefore run identical code.
"""

from __future__ import annotations

import argparse
import os
import sys
import time

# Set before WebView2 starts, because the browser environment reads it once when
# it is created and never again.
#
# This is what decides how a native <input type="date"> is written. Chromium
# takes the format from its UI language, not from the machine's regional
# settings — so a Windows install whose display language is English (United
# States) shows 08/05/2026 for the fifth of August however the rest of Windows
# formats dates. en-GB gives day/month/year, which is what this app means
# everywhere else.
os.environ.setdefault("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--lang=en-GB")

import webview  # noqa: E402

from hindsightchess import diagnostics
from hindsightchess.api import Api
from hindsightchess.engine import close_engine
from hindsightchess.paths import app_dir, is_frozen, resource_dir
from hindsightchess.server import serve, serve_background


def _ensure_streams() -> None:
    """Give a windowed build somewhere to write.

    PyInstaller's windowed bootloader sets sys.stdout and sys.stderr to None,
    so an ordinary print() or traceback.print_exc() raises AttributeError deep
    inside otherwise-working code. Point them at a log file beside the exe —
    that keeps stray output harmless *and* leaves crashes diagnosable.
    """
    if sys.stdout is not None and sys.stderr is not None:
        return

    sink = None
    if is_frozen():
        try:
            log_dir = app_dir() / "data"
            log_dir.mkdir(parents=True, exist_ok=True)
            sink = open(log_dir / "hindsightchess.log", "a", encoding="utf-8", buffering=1)
        except OSError:
            sink = None
    if sink is None:
        sink = open(os.devnull, "w", encoding="utf-8")

    if sys.stdout is None:
        sys.stdout = sink
    if sys.stderr is None:
        sys.stderr = sink


class JsApi:
    """The small slice of native functionality the web layer can't do itself.

    This object must expose *methods only* — never a data attribute holding a
    pywebview Window, a WinForms control, or anything else with a rich object
    graph.

    pywebview builds the JS bridge by recursively walking this object's public
    attributes. An earlier version stored the Window here so the file dialogs
    could reach it; pywebview then walked into the native Form and followed
    `AccessibilityObject.Bounds.Empty.Empty.Empty…`, which is self-referential
    in .NET. That recursed until it blew Python's recursion limit, killing the
    bridge thread during startup and leaving the UI liable to deadlock — the
    "Application Hang" seen when moving the window or switching tabs.

    So the window is looked up on demand instead, and the helper that does it
    is underscore-prefixed so the bridge skips it.
    """

    @staticmethod
    def _active_window():
        return webview.windows[0] if webview.windows else None

    @staticmethod
    def _pick(file_types: tuple[str, ...]) -> str | None:
        window = JsApi._active_window()
        if window is None:
            return None
        try:
            result = window.create_file_dialog(
                webview.OPEN_DIALOG, allow_multiple=False, file_types=file_types
            )
        except Exception:
            diagnostics.log.exception("file dialog failed")
            return None
        if not result:
            return None
        return result[0] if isinstance(result, (list, tuple)) else result

    def pick_pgn(self) -> str | None:
        return self._pick(("PGN files (*.pgn)", "All files (*.*)"))

    def pick_engine(self) -> str | None:
        return self._pick(("Executables (*.exe)", "All files (*.*)"))


def _set_app_user_model_id() -> None:
    """Give the process its own taskbar identity.

    Without this Windows may group the window under the host Python/launcher
    identity and borrow that icon instead of ours.
    """
    if os.name != "nt":
        return
    try:
        import ctypes

        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(
            "HindsightChess.Desktop.1"
        )
    except Exception:
        diagnostics.log.debug("could not set AppUserModelID", exc_info=True)


def _apply_window_icon(window) -> None:
    """Point the window (and so the taskbar) at the same icon as the exe.

    Explorer shows the icon embedded in the executable, but the taskbar and
    title bar show the *window* icon, which pywebview sets to its own default.
    They therefore disagreed. Sending WM_SETICON fixes both sizes.

    Done through Win32 rather than WinForms because SendMessage marshals to the
    window's owning thread by itself — assigning Form.Icon from this thread
    would be a cross-thread property set.
    """
    if os.name != "nt":
        return
    icon_path = resource_dir() / "assets" / "icon.ico"
    if not icon_path.exists():
        diagnostics.log.warning("window icon not found at %s", icon_path)
        return

    # The native handle appears slightly after the window is created, so wait
    # for it rather than assuming it is ready.
    handle = None
    for _ in range(100):
        native = getattr(window, "native", None)
        if native is not None:
            handle = getattr(native, "Handle", None)
            if handle:
                break
        time.sleep(0.05)
    if not handle:
        diagnostics.log.warning("native window handle never appeared; icon not applied")
        return

    try:
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.windll.user32
        user32.LoadImageW.argtypes = [
            wintypes.HINSTANCE, wintypes.LPCWSTR, wintypes.UINT,
            ctypes.c_int, ctypes.c_int, wintypes.UINT,
        ]
        user32.LoadImageW.restype = wintypes.HANDLE
        user32.SendMessageW.argtypes = [
            wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM,
        ]
        user32.SendMessageW.restype = wintypes.LPARAM

        hwnd = handle.ToInt64() if hasattr(handle, "ToInt64") else int(handle)

        IMAGE_ICON, LR_LOADFROMFILE, WM_SETICON = 1, 0x0010, 0x0080
        ICON_SMALL, ICON_BIG = 0, 1
        SM_CXICON, SM_CYICON, SM_CXSMICON, SM_CYSMICON = 11, 12, 49, 50

        # Ask for exact pixel sizes. Passing 0, 0 without LR_DEFAULTSIZE makes
        # LoadImage take the first image in the file — which is the 16x16 one —
        # so the taskbar was upscaling a 16px icon and looked small and soft
        # next to everything else. The system metrics give the sizes Windows
        # actually wants (typically 32 and 16, larger when DPI scaling is on),
        # and LoadImage then picks the matching entry out of the .ico.
        big_cx = user32.GetSystemMetrics(SM_CXICON) or 32
        big_cy = user32.GetSystemMetrics(SM_CYICON) or 32
        small_cx = user32.GetSystemMetrics(SM_CXSMICON) or 16
        small_cy = user32.GetSystemMetrics(SM_CYSMICON) or 16

        big = user32.LoadImageW(
            None, str(icon_path), IMAGE_ICON, big_cx, big_cy, LR_LOADFROMFILE
        )
        small = user32.LoadImageW(
            None, str(icon_path), IMAGE_ICON, small_cx, small_cy, LR_LOADFROMFILE
        )
        if not big and not small:
            diagnostics.log.warning("LoadImage returned no icon for %s", icon_path)
            return

        if big:
            user32.SendMessageW(hwnd, WM_SETICON, ICON_BIG, big)
        if small:
            user32.SendMessageW(hwnd, WM_SETICON, ICON_SMALL, small)
        diagnostics.log.info(
            "window icon applied (big=%sx%s:%s small=%sx%s:%s)",
            big_cx, big_cy, bool(big), small_cx, small_cy, bool(small),
        )
    except Exception:
        diagnostics.log.exception("could not apply window icon")


def _assert_bridge_safe(js_api: object) -> None:
    """Fail loudly if the JS bridge object grows a public data attribute.

    pywebview walks these recursively; a single reference to a native object is
    enough to hang the app at startup. Cheap to check, expensive to miss.
    """
    leaked = [name for name in vars(js_api) if not name.startswith("_")]
    if leaked:
        raise RuntimeError(
            f"JsApi must expose methods only, but has public data attributes: "
            f"{leaked}. pywebview will recurse into them when building the JS "
            f"bridge and the app will hang. Prefix them with '_' or look the "
            f"value up on demand."
        )


def run_desktop(debug: bool = False) -> None:
    _set_app_user_model_id()

    api = Api()
    server, base_url = serve_background(api, port=0)
    diagnostics.watchdog().start()
    diagnostics.log.info("serving on %s", base_url)

    js_api = JsApi()
    _assert_bridge_safe(js_api)

    window = webview.create_window(
        "HindsightChess",
        base_url,
        js_api=js_api,
        width=1560,
        height=1000,
        min_size=(1080, 680),
        background_color="#17140f",
    )

    try:
        # `func` runs once the GUI loop is up, which is the earliest point the
        # native window handle exists.
        webview.start(_apply_window_icon, window, debug=debug)
    except Exception:
        diagnostics.log.exception("webview.start failed")
        raise
    finally:
        diagnostics.log.info("shutting down")
        close_engine()
        server.shutdown()


def main(argv: list[str] | None = None) -> int:
    _ensure_streams()
    diagnostics.setup()
    parser = argparse.ArgumentParser(
        prog="hindsightchess",
        description="Analyze bulk chess games from Chess.com, Lichess and PGN files.",
    )
    parser.add_argument(
        "--serve",
        action="store_true",
        help="run the web server only, without opening a desktop window",
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8731)
    parser.add_argument("--debug", action="store_true", help="enable webview devtools")
    args = parser.parse_args(argv)

    if args.serve:
        serve(args.host, args.port)
        return 0

    run_desktop(debug=args.debug)
    return 0


if __name__ == "__main__":
    sys.exit(main())

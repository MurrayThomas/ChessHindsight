"""Logging and hang detection.

The app is a GUI process with no console, so a failure that is not written to a
file is a failure nobody can see. This module makes three classes of problem
self-reporting:

  * hard crashes           -> faulthandler writes a native traceback
  * unhandled exceptions   -> sys.excepthook / threading.excepthook log them
  * hangs                  -> a watchdog dumps *every* thread's stack

The watchdog is the important one. Windows kills an app whose UI thread stops
pumping messages and logs "Application Hang", which tells you nothing about
which thread was stuck. The frontend pings `ping()` on a timer; if those pings
stop arriving while the process is still alive, something is blocking, and we
dump all stacks so the culprit is visible.
"""

from __future__ import annotations

import faulthandler
import logging
import logging.handlers
import sys
import threading
import time
import traceback

from .paths import app_dir

LOG_NAME = "chesshindsight.log"

log = logging.getLogger("chesshindsight")

_watchdog: "Watchdog | None" = None
_log_file = None


def log_path():
    return app_dir() / "data" / LOG_NAME


def setup(level: int = logging.INFO) -> None:
    """Install logging, faulthandler and the exception hooks. Idempotent."""
    global _log_file
    if getattr(setup, "_done", False):
        return
    setup._done = True  # type: ignore[attr-defined]

    path = log_path()
    path.parent.mkdir(parents=True, exist_ok=True)

    handler = logging.handlers.RotatingFileHandler(
        path, maxBytes=2_000_000, backupCount=2, encoding="utf-8"
    )
    handler.setFormatter(
        logging.Formatter("%(asctime)s %(levelname)-7s [%(threadName)s] %(name)s: %(message)s")
    )
    root = logging.getLogger()
    root.setLevel(level)
    root.addHandler(handler)
    if sys.stderr is not None:
        stream = logging.StreamHandler(sys.stderr)
        stream.setFormatter(logging.Formatter("%(levelname)-7s %(message)s"))
        root.addHandler(stream)

    # Keep a real file object open for faulthandler; it writes at a level below
    # logging and needs a plain fd that stays valid for the process lifetime.
    _log_file = open(path, "a", encoding="utf-8", buffering=1)
    try:
        faulthandler.enable(file=_log_file, all_threads=True)
    except (AttributeError, OSError):
        pass

    def _excepthook(exc_type, exc, tb):
        log.error("unhandled exception", exc_info=(exc_type, exc, tb))

    sys.excepthook = _excepthook

    def _thread_excepthook(args):
        log.error(
            "unhandled exception in thread %s",
            args.thread.name if args.thread else "?",
            exc_info=(args.exc_type, args.exc_value, args.exc_traceback),
        )

    threading.excepthook = _thread_excepthook

    log.info("=" * 60)
    log.info("ChessHindsight starting (python %s)", sys.version.split()[0])


def dump_all_threads(reason: str) -> None:
    """Write every thread's stack to the log."""
    lines = [f"--- thread dump: {reason} ---"]
    frames = sys._current_frames()
    for thread in threading.enumerate():
        frame = frames.get(thread.ident)
        lines.append(f"\nThread {thread.name} (id={thread.ident}, daemon={thread.daemon})")
        if frame is None:
            lines.append("  <no frame>")
            continue
        lines.extend("  " + s.rstrip() for s in traceback.format_stack(frame))
    lines.append("--- end thread dump ---")
    log.error("\n".join(lines))


class Watchdog:
    """Detects the UI going unresponsive by watching frontend heartbeats."""

    def __init__(self, timeout: float = 12.0, check_interval: float = 3.0):
        self.timeout = timeout
        self.check_interval = check_interval
        self._last_ping = time.monotonic()
        self._started = False
        self._reported = False
        self._lock = threading.Lock()

    def ping(self) -> None:
        with self._lock:
            self._last_ping = time.monotonic()
            if self._reported:
                log.info("heartbeat resumed after a stall")
                self._reported = False

    def start(self) -> None:
        if self._started:
            return
        self._started = True
        threading.Thread(target=self._run, name="watchdog", daemon=True).start()

    def _run(self) -> None:
        # Give the UI time to load before expecting heartbeats.
        time.sleep(self.timeout)
        while True:
            time.sleep(self.check_interval)
            with self._lock:
                idle = time.monotonic() - self._last_ping
                already = self._reported
            if idle > self.timeout and not already:
                with self._lock:
                    self._reported = True
                log.error(
                    "no heartbeat from the UI for %.1fs — dumping thread stacks", idle
                )
                dump_all_threads(f"UI unresponsive for {idle:.1f}s")


def watchdog() -> Watchdog:
    global _watchdog
    if _watchdog is None:
        _watchdog = Watchdog()
    return _watchdog

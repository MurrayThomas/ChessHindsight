"""Application configuration, persisted as JSON next to the database."""

from __future__ import annotations

import json
import os
import shutil
from dataclasses import dataclass, field, asdict
from pathlib import Path

from .paths import app_dir

# Writable root: the project folder from source, the executable's folder when
# packaged. The database, settings and engine all live here.
APP_ROOT = app_dir()
DATA_DIR = APP_ROOT / "data"
DB_PATH = DATA_DIR / "chesshindsight.db"
CONFIG_PATH = DATA_DIR / "config.json"

# What the database was called under previous names for the app, newest first.
# The app has been renamed twice; a database that never opened the intermediate
# build still sits under the oldest name, so every name has to stay claimable.
LEGACY_DB_PATHS = [
    DATA_DIR / "hindsightchess.db",
    DATA_DIR / "chessanalyzer.db",
]


def adopt_legacy_db() -> bool:
    """Bring a database written under an old name forward to the current one.

    Returns True if anything was moved. Without this the rename silently starts
    a fresh, empty database beside a perfectly good one — which looks exactly
    like losing every game you have ever synced.

    The write-ahead log and shared-memory file move with it. A WAL left behind
    would be orphaned; worse, a WAL belonging to a *different* database sitting
    under the new name is how a file gets corrupted, so both are only moved when
    the destination is genuinely absent.
    """
    if DB_PATH.exists():
        return False
    for legacy in LEGACY_DB_PATHS:
        if not legacy.exists():
            continue
        for suffix in ("", "-wal", "-shm"):
            old = legacy.with_name(legacy.name + suffix)
            new = DB_PATH.with_name(DB_PATH.name + suffix)
            if old.exists() and not new.exists():
                old.replace(new)
        return True
    return False

# Positions are indexed for tree queries only up to this ply. Full move lists are
# always stored on the game itself; this cap just bounds the size of the position
# index, which is what "which positions do I reach most often" actually queries.
# 40 plies = 20 moves each side, which covers openings into the early middlegame.
DEFAULT_MAX_INDEXED_PLY = 40


@dataclass
class Account:
    """A tracked account whose games get synced."""

    source: str  # "chesscom" | "lichess"
    username: str

    @property
    def key(self) -> str:
        return f"{self.source}:{self.username.lower()}"


@dataclass
class Config:
    accounts: list[Account] = field(default_factory=list)
    # The user's own identities, lowercased, across all sources. Used to decide
    # which side of a game is "me" when computing win rates.
    me: list[str] = field(default_factory=list)
    # Optional; raises the Lichess export rate limit for large accounts.
    # Falls back to the LICHESS_TOKEN environment variable when unset.
    lichess_token: str | None = None
    engine_path: str | None = None
    engine_depth: int = 18
    engine_threads: int = 2
    engine_hash_mb: int = 256
    # How many candidate lines the engine reports. Three is the usual GUI
    # default: enough to see the alternatives without tripling the search time.
    engine_multipv: int = 3
    max_indexed_ply: int = DEFAULT_MAX_INDEXED_PLY
    theme: str = "walnut"  # see web/app.js THEMES
    # Board square colours, chosen independently of the theme. "theme" keeps
    # whichever pair the theme itself defines, which is what every saved
    # preference from before this existed means. See web/app.js BOARDS.
    board: str = "theme"
    piece_set: str = "cburnett"  # see web/pieces.js PIECE_SETS

    @classmethod
    def load(cls) -> "Config":
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        if not CONFIG_PATH.exists():
            cfg = cls()
            cfg.engine_path = find_stockfish()
            cfg.save()
            return cfg
        try:
            raw = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            raw = None
        if not isinstance(raw, dict):
            # A config that will not parse must not stop the app from starting.
            # The windowed build has no console, so the traceback this used to
            # raise went nowhere and the app simply never opened. Keep the bad
            # file instead of overwriting it, so it can still be looked at.
            try:
                CONFIG_PATH.replace(CONFIG_PATH.with_suffix(".json.bad"))
            except OSError:
                pass
            cfg = cls()
            cfg.engine_path = find_stockfish()
            cfg.save()
            return cfg
        accounts = [Account(**a) for a in raw.pop("accounts", [])]
        # Drop unknown keys so an older config file never crashes a newer build.
        known = {f for f in cls.__dataclass_fields__ if f != "accounts"}
        raw = {k: v for k, v in raw.items() if k in known}
        return cls(accounts=accounts, **raw)

    def save(self) -> None:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        payload = asdict(self)
        text = json.dumps(payload, indent=2, ensure_ascii=False)
        # Write to a sibling and rename over the top, because os.replace is
        # atomic. Writing in place leaves the file truncated if the process dies
        # partway through — and this is saved on every settings change, so the
        # window for that is every time a theme is picked.
        tmp = CONFIG_PATH.with_name(CONFIG_PATH.name + ".tmp")
        tmp.write_text(text, encoding="utf-8")
        os.replace(tmp, CONFIG_PATH)

    def is_me(self, username: str | None) -> bool:
        return bool(username) and username.lower() in {m.lower() for m in self.me}

    def add_account(self, source: str, username: str) -> Account:
        acct = Account(source=source, username=username)
        if not any(a.key == acct.key for a in self.accounts):
            self.accounts.append(acct)
        if username.lower() not in {m.lower() for m in self.me}:
            self.me.append(username.lower())
        self.save()
        return acct

    def remove_account(self, source: str, username: str) -> None:
        key = f"{source}:{username.lower()}"
        self.accounts = [a for a in self.accounts if a.key != key]
        # Only drop the identity if no remaining account claims that name.
        if not any(a.username.lower() == username.lower() for a in self.accounts):
            self.me = [m for m in self.me if m.lower() != username.lower()]
        self.save()


def find_stockfish() -> str | None:
    """Best-effort autodetect of a Stockfish binary.

    Official Windows builds unzip to a folder with a CPU-suffixed name like
    `stockfish-windows-x86-64-avx2.exe`, so search by glob rather than by an
    exact filename.
    """
    found = shutil.which("stockfish")
    if found:
        return found

    search_dirs = [
        APP_ROOT / "stockfish",
        APP_ROOT / "engines",
        APP_ROOT,
        Path.home() / "Downloads" / "stockfish",
        Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "Stockfish",
    ]
    patterns = ("stockfish*.exe", "stockfish*") if os.name == "nt" else ("stockfish*",)

    for directory in search_dirs:
        if not directory.is_dir():
            continue
        for pattern in patterns:
            for candidate in sorted(directory.glob(pattern)):
                if candidate.is_file() and _looks_executable(candidate):
                    return str(candidate)
            # Official archives nest the binary one level down.
            for candidate in sorted(directory.glob(f"*/{pattern}")):
                if candidate.is_file() and _looks_executable(candidate):
                    return str(candidate)
    return None


def _looks_executable(path: Path) -> bool:
    if os.name == "nt":
        return path.suffix.lower() == ".exe"
    return os.access(path, os.X_OK)

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
DB_PATH = DATA_DIR / "hindsightchess.db"
CONFIG_PATH = DATA_DIR / "config.json"

# What the database was called before the app was renamed.
LEGACY_DB_PATH = DATA_DIR / "chessanalyzer.db"


def adopt_legacy_db() -> bool:
    """Bring a database written under the old name forward to the new one.

    Returns True if anything was moved. Without this the rename silently starts
    a fresh, empty database beside a perfectly good one — which looks exactly
    like losing every game you have ever synced.

    The write-ahead log and shared-memory file move with it. A WAL left behind
    would be orphaned; worse, a WAL belonging to a *different* database sitting
    under the new name is how a file gets corrupted, so both are only moved when
    the destination is genuinely absent.
    """
    if DB_PATH.exists() or not LEGACY_DB_PATH.exists():
        return False
    for suffix in ("", "-wal", "-shm"):
        old = LEGACY_DB_PATH.with_name(LEGACY_DB_PATH.name + suffix)
        new = DB_PATH.with_name(DB_PATH.name + suffix)
        if old.exists() and not new.exists():
            old.replace(new)
    return True

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
        raw = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        accounts = [Account(**a) for a in raw.pop("accounts", [])]
        # Drop unknown keys so an older config file never crashes a newer build.
        known = {f for f in cls.__dataclass_fields__ if f != "accounts"}
        raw = {k: v for k, v in raw.items() if k in known}
        return cls(accounts=accounts, **raw)

    def save(self) -> None:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        payload = asdict(self)
        CONFIG_PATH.write_text(
            json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8"
        )

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

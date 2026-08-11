"""The application's API surface.

Deliberately transport-agnostic: the same object backs both the HTTP dev server
and the pywebview desktop window, so anything verified in a browser behaves
identically in the packaged app.
"""

from __future__ import annotations

import sqlite3
import threading
import traceback
from pathlib import Path
from typing import Any

from . import (
    diagnostics, engine, favourites, library, manual, stats, swings, sync, tree,
)
from .config import Config, DB_PATH
from .db import connect, init_db
from .ingest import reindex_positions
from .query import GameFilter


class Api:
    def __init__(self, db_path: Path | str = DB_PATH):
        self.db_path = Path(db_path)
        self._local = threading.local()
        self.config = Config.load()
        self._sync = {
            "running": False,
            "message": "",
            "log": [],
            "done": False,
            "error": None,
            "result": None,
        }
        self._sync_lock = threading.Lock()
        init_db(self.conn)

    # -- plumbing --------------------------------------------------------

    @property
    def conn(self) -> sqlite3.Connection:
        """One SQLite connection per thread; sqlite objects aren't thread-safe."""
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = connect(self.db_path)
            self._local.conn = conn
        return conn

    @staticmethod
    def _filter(data: dict | None) -> GameFilter:
        return GameFilter.from_dict(data)

    def about(self) -> dict:
        """Who wrote this, which build it is, and where its data lives.

        Reported rather than written into the page so the version can never
        drift from the package's own. The Python and engine lines are here
        because the first question about any bug report is which build it came
        from — and the packaged app has no console to ask.
        """
        import sys

        from . import __author__, __copyright__, __licence__, __version__

        engine_path = engine.resolve_engine_path(self.config)
        return {
            "name": "ChessHindsight",
            "version": __version__,
            "author": __author__,
            "copyright": __copyright__,
            "licence": __licence__,
            "url": "https://github.com/MurrayThomas/ChessHindsight",
            "python": sys.version.split()[0],
            "packaged": bool(getattr(sys, "frozen", False)),
            "db_path": str(self.db_path),
            "log_path": str(diagnostics.log_path()),
            "engine_path": engine_path,
            "engine_available": bool(engine_path and Path(engine_path).exists()),
        }

    def ping(self) -> dict:
        """Frontend heartbeat. Silence here is what the watchdog reacts to."""
        diagnostics.watchdog().ping()
        return {"ok": True}

    def log_client_error(
        self, message: str, source: str = "", line: int = 0, stack: str = ""
    ) -> dict:
        """Record a JavaScript error in the same log as the backend's."""
        diagnostics.log.error(
            "client error: %s (%s:%s)%s",
            message, source or "?", line, f"\n{stack}" if stack else "",
        )
        return {"ok": True}

    # -- config ----------------------------------------------------------

    def get_config(self) -> dict:
        cfg = self.config
        return {
            "accounts": [{"source": a.source, "username": a.username} for a in cfg.accounts],
            "me": cfg.me,
            "engine_path": cfg.engine_path,
            "engine_depth": cfg.engine_depth,
            # Sent with the config rather than only with the engine status: the
            # boards build their depth dropdown at startup, which is before
            # anyone has opened Settings.
            "engine_depth_choices": engine.DEPTH_CHOICES,
            "engine_threads": cfg.engine_threads,
            "engine_hash_mb": cfg.engine_hash_mb,
            "engine_multipv": cfg.engine_multipv,
            "max_indexed_ply": cfg.max_indexed_ply,
            "theme": cfg.theme,
            "board": cfg.board,
            "piece_set": cfg.piece_set,
            "has_lichess_token": bool(cfg.lichess_token),
            "db_path": str(self.db_path),
        }

    # Settings the running engine process was started with. Changing one of
    # these means restarting it; changing anything else does not, and must not,
    # because a restart throws away a hash table that a deep search depends on.
    _ENGINE_RESTART_KEYS = ("engine_path", "engine_threads", "engine_hash_mb")

    def save_config(self, patch: dict) -> dict:
        cfg = self.config
        before = tuple(getattr(cfg, k) for k in self._ENGINE_RESTART_KEYS)
        for key in (
            "engine_path", "engine_depth", "engine_threads",
            "engine_hash_mb", "engine_multipv", "max_indexed_ply",
            "lichess_token", "theme", "board", "piece_set",
        ):
            if key in patch:
                setattr(cfg, key, patch[key])
        # The board's depth dropdown writes straight here, so a value the engine
        # would refuse must not be what gets saved and reloaded next launch.
        cfg.engine_depth = engine.clamp_depth(cfg.engine_depth)
        if "me" in patch and isinstance(patch["me"], list):
            cfg.me = [m.strip().lower() for m in patch["me"] if m and m.strip()]
        cfg.save()
        if tuple(getattr(cfg, k) for k in self._ENGINE_RESTART_KEYS) != before:
            engine.close_engine()  # restart on next use, with the new settings
        return self.get_config()

    def add_account(self, source: str, username: str) -> dict:
        source = (source or "").strip().lower()
        username = (username or "").strip()
        if source not in ("chesscom", "lichess"):
            raise ValueError("source must be 'chesscom' or 'lichess'")
        if not username:
            raise ValueError("username is required")
        self.config.add_account(source, username)
        return self.get_config()

    def remove_account(self, source: str, username: str) -> dict:
        self.config.remove_account(source, username)
        return self.get_config()

    # -- sync ------------------------------------------------------------

    def sync_status(self) -> dict:
        with self._sync_lock:
            return dict(self._sync, log=list(self._sync["log"])[-40:])

    def _progress(self, message: str) -> None:
        with self._sync_lock:
            self._sync["message"] = message
            self._sync["log"].append(message)
            if len(self._sync["log"]) > 400:
                del self._sync["log"][:200]

    @staticmethod
    def _stats_dict(value) -> dict:
        """One ingest result, or the error that stopped it."""
        if isinstance(value, Exception):
            return {"error": str(value)}
        return {
            "inserted": value.inserted,
            "duplicates": value.skipped_duplicate,
            "seen": value.seen,
            "unparseable": value.unparseable,
        }

    def _background(self, name: str, starting: str, work, done_message) -> dict:
        """Run one long download on a worker thread, reporting through _sync.

        There is a single slot: downloads all contend for the same network and
        the same database, and two at once would interleave their progress into
        one log with no way to tell them apart.
        """
        with self._sync_lock:
            if self._sync["running"]:
                # Copy the log rather than handing back the live list: the
                # running worker appends to it through _progress, and a list
                # that grows while the transport is serializing it raises
                # mid-response. Built inline because sync_status() takes this
                # same lock, which is not reentrant.
                return dict(self._sync, log=list(self._sync["log"])[-40:])
            self._sync.update(
                running=True, done=False, error=None, result=None,
                message=starting, log=[],
            )

        def worker() -> None:
            conn = connect(self.db_path)
            try:
                result = work(conn)
                with self._sync_lock:
                    self._sync["result"] = result
                    self._sync["message"] = done_message(result)
            except Exception as exc:
                with self._sync_lock:
                    self._sync["error"] = f"{exc}"
                    self._sync["message"] = f"{name} failed"
                traceback.print_exc()
            finally:
                conn.close()
                with self._sync_lock:
                    self._sync["running"] = False
                    self._sync["done"] = True

        threading.Thread(target=worker, daemon=True, name=name).start()
        return self.sync_status()

    def start_sync(self, full: bool = False) -> dict:
        return self._background(
            "sync", "Starting…",
            lambda conn: {
                key: self._stats_dict(value)
                for key, value in sync.sync_all(
                    conn, self.config, self._progress, full=full
                ).items()
            },
            lambda _: "Sync complete",
        )

    def import_pgn(self, path: str, collection: str | None = None) -> dict:
        """Import a PGN file or a directory of them, in the background.

        `collection` sends the games to the reference library instead of the
        user's own record — which is how an over-the-board masters PGN gets
        added without polluting their win rate.
        """
        target = Path(path).expanduser()
        if not target.exists():
            raise FileNotFoundError(f"No such file or folder: {target}")
        if collection not in (None, "", library.COLLECTION):
            raise ValueError(f"unknown collection {collection!r}")

        return self._background(
            "import", f"Importing {target.name}…",
            lambda conn: {
                str(target): self._stats_dict(
                    sync.import_pgn(
                        conn, self.config, target, self._progress,
                        collection=collection or None,
                    )
                )
            },
            lambda result: f"Imported {result[str(target)].get('inserted', 0)} new games",
        )

    # -- reference library -----------------------------------------------

    def library_summary(self) -> dict:
        return library.summary(self.conn)

    def library_players(self) -> list[dict]:
        return library.list_players(self.conn)

    def library_search(
        self, source: str = "chesscom", query: str = "",
        title: str = "GM", limit: int = 12,
    ) -> list[dict]:
        return library.search(source, query, title=title, limit=limit, config=self.config)

    def library_add(
        self, source: str, username: str, require_title: bool = True
    ) -> dict:
        return library.add_player(
            self.conn, source, username, self.config, require_title=require_title
        )

    def library_remove(self, source: str, username: str) -> dict:
        removed = library.remove_player(self.conn, source, username)
        return {"removed_games": removed}

    def start_library_sync(self, full: bool = False, source: str | None = None,
                           username: str | None = None) -> dict:
        """Download games for the whole roster, or for one player."""
        if username:
            return self._background(
                "library", f"Downloading {username}'s games…",
                lambda conn: {
                    f"{source}:{username}": self._stats_dict(
                        library.sync_player(
                            conn, self.config, source, username,
                            progress=self._progress, full=full,
                        )
                    )
                },
                lambda _: f"{username} up to date",
            )
        return self._background(
            "library", "Updating the titled-player library…",
            lambda conn: {
                key: self._stats_dict(value)
                for key, value in library.sync_all(
                    conn, self.config, self._progress, full=full
                ).items()
            },
            lambda _: "Library up to date",
        )

    def reference_explore(
        self,
        fen: str | None = None,
        moves: list[str] | None = None,
        player: str | None = None,
        limit: int = 40,
    ) -> dict:
        """What titled players played from a position — the Explorer's second tab."""
        data = tree.reference_explore(
            self.conn, fen=fen, moves=moves, player=player, limit=limit
        )
        data["library"] = library.summary(self.conn)
        return data

    def reindex(self) -> dict:
        count = reindex_positions(self.conn, self.config)
        return {"reindexed_games": count}

    # -- material swings -------------------------------------------------

    def swing_status(self) -> dict:
        """How many games still need scanning for the "threw it away" filter."""
        return {
            "pending": swings.pending_count(self.conn),
            "sustain_plies": swings.SUSTAIN_PLIES,
        }

    def start_swing_scan(self) -> dict:
        """Work out who was winning in each game, in the background.

        Backgrounded because it replays every move of every game — seconds for a
        few thousand games, but long enough to freeze the window if it ran on
        the request thread.
        """
        return self._background(
            "swings", "Working out who was winning…",
            lambda conn: {"scanned": swings.backfill(conn, self._progress)},
            lambda result: f"Scanned {result['scanned']} game(s)",
        )

    # -- read-only analysis ---------------------------------------------

    def summary(self) -> dict:
        data = stats.database_summary(self.conn)
        data["accounts"] = [
            {"source": a.source, "username": a.username} for a in self.config.accounts
        ]
        data["me"] = self.config.me
        return data

    def piece_sets(self) -> list[dict]:
        """Complete piece sets installed under web/piecesets/.

        Lets a downloaded set be installed by dropping its folder in, with no
        code change — which is how the Lichess sets get added. A set is complete
        when all twelve pieces are present in one image format; the format is
        reported so the frontend knows what file name to ask for.
        """
        from .paths import resource_dir

        root = resource_dir() / "web" / "piecesets"
        if not root.is_dir():
            return []

        pieces = [f"{c}{p}" for c in ("w", "b") for p in ("K", "Q", "R", "B", "N", "P")]
        found = []
        for entry in sorted(root.iterdir()):
            if not entry.is_dir() or entry.name.startswith("."):
                continue
            names = {f.name for f in entry.iterdir() if f.is_file()}
            for ext in ("svg", "webp", "png", "gif"):
                if all(f"{p}.{ext}" in names for p in pieces):
                    found.append({"id": entry.name, "ext": ext})
                    break
        return found

    def known_players(self, limit: int = 30) -> list[dict]:
        return stats.known_players(self.conn, limit)

    def variants(self) -> list[dict]:
        return stats.variants_present(self.conn)

    def overview(self, filter: dict | None = None) -> dict:
        return stats.overview(self.conn, self._filter(filter))

    def by_time_control(self, filter: dict | None = None) -> list[dict]:
        return stats.by_time_control(self.conn, self._filter(filter))

    def by_clock(self, filter: dict | None = None) -> list[dict]:
        return stats.by_time_control_detail(self.conn, self._filter(filter))

    def by_opening(self, filter: dict | None = None, limit: int = 40) -> list[dict]:
        return stats.by_opening(self.conn, self._filter(filter), limit)

    def opening_lines(
        self,
        filter: dict | None = None,
        opening: str | None = None,
        max_plies: int = 12,
        limit: int = 10,
    ) -> dict:
        """The move orders that actually reach a given opening, and their record."""
        return tree.opening_lines(
            self.conn, self._filter(filter), opening, max_plies, limit
        )

    def opponents(self, filter: dict | None = None, limit: int = 50) -> list[dict]:
        return stats.opponents(self.conn, self._filter(filter), limit)

    def head_to_head(
        self, player: str, opponent: str, filter: dict | None = None
    ) -> dict:
        if not player or not opponent:
            raise ValueError("both player and opponent are required")
        return stats.head_to_head(self.conn, player, opponent, self._filter(filter))

    def games(
        self, filter: dict | None = None, limit: int = 100, offset: int = 0
    ) -> list[dict]:
        return stats.recent_games(self.conn, self._filter(filter), limit, offset)

    def game_detail(self, game_id: int) -> dict:
        row = self.conn.execute("SELECT * FROM games WHERE id = ?", (game_id,)).fetchone()
        if not row:
            raise ValueError(f"no game with id {game_id}")
        return dict(row)

    def game_line(self, game_id: int) -> dict:
        """A stored game as a playable move list, for opening it on the board."""
        row = self.conn.execute(
            """SELECT id, moves_san, played_at, result, opening,
                      white_name, black_name, white_lower, black_lower
               FROM games WHERE id = ?""",
            (game_id,),
        ).fetchone()
        if not row:
            raise ValueError(f"no game with id {game_id}")
        data = dict(row)
        data.pop("moves_san", None)
        data["moves"] = tree.move_list(row["moves_san"])
        return data

    # -- games entered by hand -------------------------------------------

    def parse_moves(self, text: str | None = None) -> dict:
        """Read typed notation, for the live preview while it is being written."""
        return manual.parse_moves(text)

    def add_manual_game(
        self,
        moves: str,
        white: str,
        black: str,
        result: str,
        played_at: str | None = None,
        time_class: str | None = None,
        event: str | None = None,
        white_elo: int | None = None,
        black_elo: int | None = None,
        source: str = manual.DEFAULT_SOURCE,
        favourite_name: str | None = None,
    ) -> dict:
        """Store a game typed from a scoresheet, optionally starring it."""
        saved = manual.save_game(
            self.conn, self.config, moves, white, black, result,
            played_at=played_at, time_class=time_class, event=event,
            white_elo=white_elo, black_elo=black_elo, source=source,
        )
        if favourite_name is not None:
            fav = favourites.add(self.conn, saved["game_id"], favourite_name)
            saved["favourite"] = fav["name"]
        return saved

    # -- favourites ------------------------------------------------------

    def favourites(
        self, search: str | None = None, player: str | None = None, limit: int = 300
    ) -> list[dict]:
        return favourites.list_all(
            self.conn, search=search, player=player, limit=limit
        )

    def favourite_ids(self) -> list[int]:
        return favourites.ids(self.conn)

    def favourite_summary(self) -> dict:
        return favourites.summary(self.conn)

    def favourite_add(self, game_id: int, name: str | None = None) -> dict:
        return favourites.add(self.conn, int(game_id), name)

    def favourite_rename(self, game_id: int, name: str) -> dict:
        return favourites.rename(self.conn, int(game_id), name)

    def favourite_remove(self, game_id: int) -> dict:
        return {"removed": favourites.remove(self.conn, int(game_id))}

    def tree(
        self, filter: dict | None = None, moves: list[str] | None = None, limit: int = 40
    ) -> dict:
        return tree.tree(self.conn, self._filter(filter), moves, limit)

    def explore(
        self,
        filter: dict | None = None,
        fen: str | None = None,
        moves: list[str] | None = None,
        limit: int = 40,
    ) -> dict:
        """Board state (including legal moves) plus database continuations.

        This is what the interactive board talks to: `fen` is the root position
        and `moves` is the line played from it, so a position opened from the
        Positions view can be played on even though its move history is unknown.
        """
        return tree.explore(self.conn, self._filter(filter), fen, moves, limit)

    def common_positions(
        self,
        filter: dict | None = None,
        min_ply: int = 8,
        max_ply: int | None = None,
        limit: int = 50,
        min_games: int = 2,
    ) -> list[dict]:
        return tree.common_positions(
            self.conn, self._filter(filter), min_ply, max_ply, limit, min_games
        )

    def games_at_position(
        self, position_key: str, filter: dict | None = None, limit: int = 100
    ) -> list[dict]:
        return tree.games_at_position(
            self.conn, self._filter(filter), position_key, limit
        )

    # -- engine ----------------------------------------------------------

    def engine_status(self) -> dict:
        return engine.engine_status(self.config)

    def evaluate(
        self, fen: str, depth: int | None = None, multipv: int | None = None
    ) -> dict:
        return engine.evaluate(self.conn, self.config, fen, depth, multipv)


# Method names the transports are allowed to expose.
PUBLIC_METHODS = [
    name
    for name in dir(Api)
    if not name.startswith("_") and callable(getattr(Api, name, None))
    and name not in {"conn"}
]

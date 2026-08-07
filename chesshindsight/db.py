"""SQLite storage: schema, migrations, and connection handling."""

from __future__ import annotations

import sqlite3
from pathlib import Path

from .config import DB_PATH, adopt_legacy_db

SCHEMA_VERSION = 6

SCHEMA = """
CREATE TABLE IF NOT EXISTS games (
    id                INTEGER PRIMARY KEY,
    source            TEXT NOT NULL,           -- chesscom | lichess | pgn
    source_game_id    TEXT NOT NULL,           -- stable id for dedupe
    url               TEXT,
    played_at         TEXT,                    -- ISO8601 UTC
    -- Which library this game belongs to. NULL is the user's own games, which
    -- every existing view reports on. 'titled' is the reference corpus of
    -- strong players' games, kept in the same tables so the position index and
    -- the tree queries work on it unchanged — but held apart so it can never
    -- be mistaken for the user's own record.
    collection        TEXT,
    white_name        TEXT,
    black_name        TEXT,
    white_lower       TEXT,
    black_lower       TEXT,
    white_title       TEXT,                    -- GM | IM | FM | ... when known
    black_title       TEXT,
    white_elo         INTEGER,
    black_elo         INTEGER,
    result            TEXT,                    -- 1-0 | 0-1 | 1/2-1/2 | *
    termination       TEXT,
    time_control_raw  TEXT,
    time_class        TEXT,                    -- bullet|blitz|rapid|classical|correspondence
    base_seconds      INTEGER,
    increment_seconds INTEGER,
    eco               TEXT,
    opening           TEXT,
    variant           TEXT,
    rated             INTEGER,
    ply_count         INTEGER,
    -- The largest material advantage each side held on to (in pawns), and the
    -- ply the run started at. Computed from moves_san by swings.py; NULL means
    -- the game has not been scanned yet, which 0 does not.
    peak_white_adv    INTEGER,
    peak_white_ply    INTEGER,
    peak_black_adv    INTEGER,
    peak_black_ply    INTEGER,
    moves_san         TEXT,                    -- space-separated SAN
    pgn               TEXT,
    imported_at       TEXT DEFAULT (datetime('now')),
    UNIQUE (source, source_game_id)
);

CREATE INDEX IF NOT EXISTS ix_games_white   ON games (white_lower);
CREATE INDEX IF NOT EXISTS ix_games_black   ON games (black_lower);
CREATE INDEX IF NOT EXISTS ix_games_played  ON games (played_at);
CREATE INDEX IF NOT EXISTS ix_games_tc      ON games (time_class);
-- Every query is scoped to one library, so this is the first cut on most of them.
CREATE INDEX IF NOT EXISTS ix_games_coll    ON games (collection);

-- The reference library's roster: whose games to fetch, and what they are.
-- Kept separate from `accounts` in config.json because these are not the user's
-- accounts — they are players being studied.
CREATE TABLE IF NOT EXISTS library_players (
    source     TEXT NOT NULL,        -- chesscom | lichess
    username   TEXT NOT NULL,
    username_lower TEXT NOT NULL,
    title      TEXT,                 -- GM | IM | ... as reported by the source
    real_name  TEXT,                 -- "Magnus Carlsen", when the source gives it
    added_at   TEXT DEFAULT (datetime('now')),
    synced_at  TEXT,
    PRIMARY KEY (source, username_lower)
) WITHOUT ROWID;

-- Games the user has starred, under a name they chose.
--
-- The name is the point: "the one where I mated with the h-pawn" is how a game
-- is remembered, and nothing derivable from the PGN records it. One row per
-- game, so starring twice renames rather than duplicating, and the games row
-- stays the single source of truth for everything else about it.
CREATE TABLE IF NOT EXISTS favourites (
    game_id  INTEGER PRIMARY KEY REFERENCES games (id) ON DELETE CASCADE,
    name     TEXT NOT NULL,
    added_at TEXT DEFAULT (datetime('now'))
);

-- One row per (game, ply): the position reached, and the move played from it.
-- Bounded by config.max_indexed_ply so the index stays small.
CREATE TABLE IF NOT EXISTS game_positions (
    game_id   INTEGER NOT NULL REFERENCES games (id) ON DELETE CASCADE,
    ply       INTEGER NOT NULL,   -- 0 = start position, before White's first move
    pos_key   TEXT NOT NULL,      -- zobrist hash (hex) of the position at this ply
    move_san  TEXT,               -- move played from here; NULL if game ended here
    move_uci  TEXT,
    PRIMARY KEY (game_id, ply)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS ix_gp_poskey ON game_positions (pos_key);

-- Display metadata for a position, recorded the first time it is seen.
CREATE TABLE IF NOT EXISTS positions (
    pos_key TEXT PRIMARY KEY,
    fen     TEXT NOT NULL,
    ply     INTEGER
) WITHOUT ROWID;

-- Engine evaluation cache, so a position is never analyzed twice.
CREATE TABLE IF NOT EXISTS evals (
    pos_key    TEXT NOT NULL,
    depth      INTEGER NOT NULL,   -- the depth that was *asked for*
    fen        TEXT NOT NULL,
    score_cp   INTEGER,           -- from side-to-move's perspective
    mate_in    INTEGER,
    best_move  TEXT,
    pv         TEXT,
    lines      TEXT,              -- JSON: the top-N variations, best first
    engine     TEXT,
    -- The depth the search actually finished. Below `depth` when the wall-clock
    -- ceiling stopped it first, which is routine once deep analysis is on the
    -- menu. Keyed on the requested depth so a capped search is not repeated
    -- forever, but reported as this, because this is what the number means.
    reached    INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (pos_key, depth)
) WITHOUT ROWID;

-- Per-account incremental sync bookkeeping.
CREATE TABLE IF NOT EXISTS sync_state (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
);
"""


def connect(path: Path | str = DB_PATH) -> sqlite3.Connection:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    # Adopt a database left under the pre-rename filename, before opening
    # anything — sqlite3.connect() creates an empty file on the spot, and once
    # it exists the adoption would refuse to overwrite it and the real database
    # would sit there ignored.
    if path == DB_PATH:
        adopt_legacy_db()
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA synchronous = NORMAL")
    return conn


def _migrate(conn: sqlite3.Connection) -> None:
    """Bring an existing database up to the current schema.

    CREATE TABLE IF NOT EXISTS is a no-op on a table that already exists, so
    columns added after the first release have to be applied by hand. Adding a
    nullable column is cheap and keeps every cached evaluation already on disk.
    """
    have = {r["name"] for r in conn.execute("PRAGMA table_info(evals)")}
    if have:
        if "lines" not in have:
            conn.execute("ALTER TABLE evals ADD COLUMN lines TEXT")
        if "reached" not in have:
            # Left NULL on existing rows rather than backfilled from `depth`:
            # those searches were run under the old, generous-for-their-depth
            # ceiling and almost certainly did finish, but "almost certainly"
            # is not something to write into the database as fact.
            conn.execute("ALTER TABLE evals ADD COLUMN reached INTEGER")

    games = {r["name"] for r in conn.execute("PRAGMA table_info(games)")}
    if games:
        for column in ("collection", "white_title", "black_title"):
            if column not in games:
                conn.execute(f"ALTER TABLE games ADD COLUMN {column} TEXT")
        for column in (
            "peak_white_adv", "peak_white_ply", "peak_black_adv", "peak_black_ply",
        ):
            if column not in games:
                conn.execute(f"ALTER TABLE games ADD COLUMN {column} INTEGER")


def init_db(conn: sqlite3.Connection) -> None:
    # Migrations run first. The schema declares indexes over columns added after
    # the first release, and CREATE INDEX on a column an older database has not
    # got yet fails outright — so the columns have to exist before the script
    # runs. On a fresh database the PRAGMA finds no tables and this is a no-op.
    _migrate(conn)
    conn.executescript(SCHEMA)
    conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
    conn.commit()


def get_sync_state(conn: sqlite3.Connection, key: str) -> str | None:
    row = conn.execute("SELECT value FROM sync_state WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else None


def set_sync_state(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        """INSERT INTO sync_state (key, value, updated_at)
           VALUES (?, ?, datetime('now'))
           ON CONFLICT (key) DO UPDATE SET value = excluded.value,
                                           updated_at = excluded.updated_at""",
        (key, value),
    )
    conn.commit()

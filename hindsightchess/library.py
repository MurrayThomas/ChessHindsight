"""The reference library: games by titled players, kept for comparison.

Why a local corpus rather than an online opening explorer: Lichess's explorer
(explorer.lichess.ovh) has been unavailable to third parties since an
infrastructure incident in February 2026 and answers 401 to everything, so
anything built on it would not work. Downloading the players you actually care
about is also a better fit for an app that already indexes positions locally —
the same tree query answers "what did I play here" and "what did Carlsen play
here", and it keeps working offline.

The games live in the ordinary `games` table with `collection = 'titled'`, so
the position index, the filter model and the tree code all apply unchanged.
That column is what keeps them out of the user's own statistics.
"""

from __future__ import annotations

import datetime as dt
import sqlite3

from .config import Config
from .db import get_sync_state, set_sync_state
from .ingest import IngestStats, ingest
from .sources import chesscom, lichess

COLLECTION = "titled"

SOURCES = ("chesscom", "lichess")


class LibraryError(RuntimeError):
    pass


def _profile(source: str, username: str, config: Config) -> dict:
    if source == "chesscom":
        return chesscom.profile(username)
    if source == "lichess":
        return lichess.profile(username, config.lichess_token)
    raise LibraryError(f"unknown source {source!r}")


def search(source: str, query: str, title: str = "GM", limit: int = 12,
           config: Config | None = None) -> list[dict]:
    """Find titled accounts to add, by username."""
    config = config or Config.load()
    if source == "chesscom":
        return chesscom.search_titled(query, title=title, limit=limit)
    if source == "lichess":
        return lichess.search_titled(query, limit=limit, token=config.lichess_token)
    raise LibraryError(f"unknown source {source!r}")


def add_player(
    conn: sqlite3.Connection,
    source: str,
    username: str,
    config: Config | None = None,
    require_title: bool = True,
) -> dict:
    """Put a player on the roster, verifying the account exists first.

    Verifying up front matters: a typo would otherwise sit in the roster and
    fail on every sync, and the title is needed anyway — Chess.com reports it on
    the profile rather than on each game.
    """
    config = config or Config.load()
    source = (source or "").strip().lower()
    username = (username or "").strip()
    if source not in SOURCES:
        raise LibraryError(f"Unknown source {source!r}")
    if not username:
        raise LibraryError("Enter a username")

    prof = _profile(source, username, config)
    if require_title and not prof.get("title"):
        raise LibraryError(
            f"{prof['username']} has no federation title on {source}. "
            f"The reference library is for titled players — add them anyway "
            f"by unticking 'titled players only'."
        )

    conn.execute(
        """INSERT INTO library_players
               (source, username, username_lower, title, real_name)
           VALUES (:source, :username, :lower, :title, :real_name)
           ON CONFLICT (source, username_lower) DO UPDATE SET
               username = excluded.username,
               title = excluded.title,
               real_name = excluded.real_name""",
        {
            "source": source,
            "username": prof["username"],
            "lower": prof["username"].lower(),
            "title": prof.get("title"),
            "real_name": prof.get("real_name"),
        },
    )
    conn.commit()
    return {**prof, "games": 0}


def remove_player(
    conn: sqlite3.Connection, source: str, username: str, delete_games: bool = True
) -> int:
    """Drop a player from the roster, and by default their games with them.

    Keeping the games would leave them in the explorer with no way to see where
    they came from, so removal deletes both unless asked otherwise. Only games
    in the reference library are touched — if the same person happens to be an
    opponent in the user's own games, those stay.
    """
    lower = (username or "").strip().lower()
    removed = 0
    if delete_games:
        cur = conn.execute(
            """DELETE FROM games
               WHERE collection = :collection AND source = :source
                 AND (white_lower = :lower OR black_lower = :lower)""",
            {"collection": COLLECTION, "source": source, "lower": lower},
        )
        removed = cur.rowcount or 0
        # game_positions is ON DELETE CASCADE, but `positions` is shared display
        # metadata for every game that ever reached a square, so it is left
        # alone — an orphan row there is harmless and gets reused.
    conn.execute(
        "DELETE FROM library_players WHERE source = ? AND username_lower = ?",
        (source, lower),
    )
    conn.execute(
        "DELETE FROM sync_state WHERE key = ?", (f"library:{source}:{lower}",)
    )
    conn.commit()
    return removed


def list_players(conn: sqlite3.Connection) -> list[dict]:
    """The roster, with how many games of each are actually held."""
    rows = conn.execute(
        f"""SELECT p.source, p.username, p.username_lower, p.title, p.real_name,
                   p.added_at, p.synced_at,
                   (SELECT COUNT(*) FROM games g
                     WHERE g.collection = '{COLLECTION}'
                       AND g.source = p.source
                       AND (g.white_lower = p.username_lower
                            OR g.black_lower = p.username_lower)) games
            FROM library_players p
            ORDER BY p.title IS NULL, p.title, p.username COLLATE NOCASE"""
    ).fetchall()
    return [dict(r) for r in rows]


def _last_played_ms(conn: sqlite3.Connection, source: str, lower: str) -> int | None:
    row = conn.execute(
        """SELECT MAX(played_at) m FROM games
           WHERE collection = ? AND source = ?
             AND (white_lower = ? OR black_lower = ?)""",
        (COLLECTION, source, lower, lower),
    ).fetchone()
    if not row or not row["m"]:
        return None
    try:
        stamp = dt.datetime.fromisoformat(row["m"])
    except ValueError:
        return None
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=dt.timezone.utc)
    return int(stamp.timestamp() * 1000)


def sync_player(
    conn: sqlite3.Connection,
    config: Config,
    source: str,
    username: str,
    progress=None,
    full: bool = False,
) -> IngestStats:
    """Download a roster player's games into the reference library."""
    lower = username.lower()
    row = conn.execute(
        "SELECT title FROM library_players WHERE source = ? AND username_lower = ?",
        (source, lower),
    ).fetchone()
    titles = {lower: row["title"]} if row and row["title"] else {}
    state_key = f"library:{source}:{lower}"

    if source == "chesscom":
        cursor = None if full else get_sync_state(conn, state_key)
        games = chesscom.fetch_games(username, since_archive=cursor, progress=progress)
        stats = ingest(
            conn, games, config, progress=progress,
            collection=COLLECTION, titles=titles,
        )
        latest = chesscom.latest_archive(username)
        if latest:
            set_sync_state(conn, state_key, latest)

    elif source == "lichess":
        since_ms = None
        if not full:
            since_ms = _last_played_ms(conn, "lichess", lower)
            if since_ms:
                since_ms += 1
        games = lichess.fetch_games(
            username, since_ms=since_ms, token=config.lichess_token, progress=progress
        )
        stats = ingest(
            conn, games, config, progress=progress,
            collection=COLLECTION, titles=titles,
        )
        set_sync_state(conn, state_key, dt.datetime.now(dt.timezone.utc).isoformat())

    else:
        raise LibraryError(f"unknown source {source!r}")

    conn.execute(
        "UPDATE library_players SET synced_at = datetime('now') "
        "WHERE source = ? AND username_lower = ?",
        (source, lower),
    )
    conn.commit()
    return stats


def sync_all(
    conn: sqlite3.Connection, config: Config, progress=None, full: bool = False
) -> dict[str, IngestStats]:
    """Refresh every player on the roster, carrying on past a failure."""
    results: dict[str, IngestStats] = {}
    for player in list_players(conn):
        key = f"{player['source']}:{player['username']}"
        if progress:
            progress(f"Library: {key}…")
        try:
            results[key] = sync_player(
                conn, config, player["source"], player["username"],
                progress=progress, full=full,
            )
        except Exception as exc:  # one unreachable account must not stop the rest
            if progress:
                progress(f"ERROR {key}: {exc}")
            results[key] = exc  # type: ignore[assignment]
    return results


def summary(conn: sqlite3.Connection) -> dict:
    """Headline numbers for the library, for the Explorer's empty state."""
    row = conn.execute(
        "SELECT COUNT(*) games, MIN(played_at) first, MAX(played_at) last "
        "FROM games WHERE collection = ?",
        (COLLECTION,),
    ).fetchone()
    players = conn.execute("SELECT COUNT(*) c FROM library_players").fetchone()["c"]
    return {
        "games": row["games"] or 0,
        "players": players,
        "first_game": row["first"],
        "last_game": row["last"],
    }

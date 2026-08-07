"""Incremental sync from remote accounts, and local PGN import.

Sync is resumable: Chess.com is tracked at monthly-archive granularity (only
the current month can gain games, so completed months are never refetched),
and Lichess is tracked by exact timestamp.
"""

from __future__ import annotations

import datetime as dt
import sqlite3
from pathlib import Path

from .config import Account, Config
from .db import get_sync_state, set_sync_state
from .ingest import IngestStats, ingest
from .sources import chesscom, lichess, pgnfile


def _last_played_ms(conn: sqlite3.Connection, source: str, username: str) -> int | None:
    """Most recent game timestamp we already hold for a user, in epoch ms."""
    row = conn.execute(
        """SELECT MAX(played_at) m FROM games
           WHERE source = ? AND collection IS NULL
             AND (white_lower = ? OR black_lower = ?)""",
        (source, username.lower(), username.lower()),
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


def sync_account(
    conn: sqlite3.Connection,
    config: Config,
    account: Account,
    progress=None,
    full: bool = False,
) -> IngestStats:
    """Fetch and ingest new games for one account."""
    state_key = f"cursor:{account.key}"
    cursor = None if full else get_sync_state(conn, state_key)

    if account.source == "chesscom":
        games = chesscom.fetch_games(
            account.username, since_archive=cursor, progress=progress
        )
        stats = ingest(conn, games, config, progress=progress)
        latest = chesscom.latest_archive(account.username)
        if latest:
            set_sync_state(conn, state_key, latest)

    elif account.source == "lichess":
        since_ms = None
        if not full:
            since_ms = _last_played_ms(conn, "lichess", account.username)
            if since_ms:
                since_ms += 1  # exclusive, so the last known game isn't refetched
        games = lichess.fetch_games(
            account.username,
            since_ms=since_ms,
            token=config.lichess_token,
            progress=progress,
        )
        stats = ingest(conn, games, config, progress=progress)
        set_sync_state(conn, state_key, dt.datetime.now(dt.timezone.utc).isoformat())

    else:
        raise ValueError(f"unknown source {account.source!r}")

    return stats


def sync_all(
    conn: sqlite3.Connection, config: Config, progress=None, full: bool = False
) -> dict[str, IngestStats]:
    results: dict[str, IngestStats] = {}
    for account in config.accounts:
        if progress:
            progress(f"Syncing {account.source}:{account.username}…")
        try:
            results[account.key] = sync_account(
                conn, config, account, progress=progress, full=full
            )
        except Exception as exc:  # keep going; one bad account shouldn't stop the rest
            if progress:
                progress(f"ERROR {account.key}: {exc}")
            results[account.key] = exc  # type: ignore[assignment]
    return results


def import_pgn(
    conn: sqlite3.Connection,
    config: Config,
    path: Path | str,
    progress=None,
    collection: str | None = None,
) -> IngestStats:
    """Import a local PGN file (or every .pgn in a directory).

    `collection` routes the games into a library other than the user's own —
    used to add an over-the-board masters PGN as reference material.
    """
    path = Path(path)
    if path.is_dir():
        total = IngestStats()
        for pgn in sorted(path.glob("*.pgn")):
            if progress:
                progress(f"Importing {pgn.name}…")
            part = import_pgn(conn, config, pgn, progress=progress, collection=collection)
            total.seen += part.seen
            total.inserted += part.inserted
            total.skipped_duplicate += part.skipped_duplicate
            total.unparseable += part.unparseable
        return total

    if not path.exists():
        raise FileNotFoundError(f"No such PGN file: {path}")
    return ingest(
        conn, pgnfile.read_pgn(path, progress=progress), config,
        progress=progress, collection=collection,
    )

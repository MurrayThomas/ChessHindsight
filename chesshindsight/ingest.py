"""Turn NormalizedGame records into database rows plus a position index."""

from __future__ import annotations

import io
import sqlite3
from dataclasses import dataclass
from typing import Iterable, Sequence

import chess
import chess.pgn
import chess.polyglot

from . import swings
from .config import Config
from .sources import NormalizedGame

# Variants whose positions can be indexed with a standard board.
_STANDARD_VARIANTS = {None, "", "chess", "standard", "Standard", "fromPosition"}

_GAME_COLUMNS = [
    "source", "source_game_id", "url", "played_at", "collection",
    "white_name", "black_name", "white_lower", "black_lower",
    "white_title", "black_title",
    "white_elo", "black_elo", "result", "termination",
    "time_control_raw", "time_class", "base_seconds", "increment_seconds",
    "eco", "opening", "variant", "rated", "ply_count", "moves_san", "pgn",
    "peak_white_adv", "peak_white_ply", "peak_black_adv", "peak_black_ply",
]

_INSERT_GAME = f"""
INSERT INTO games ({", ".join(_GAME_COLUMNS)})
VALUES ({", ".join(":" + c for c in _GAME_COLUMNS)})
ON CONFLICT (source, source_game_id) DO NOTHING
"""


@dataclass
class IngestStats:
    seen: int = 0
    inserted: int = 0
    skipped_duplicate: int = 0
    unparseable: int = 0

    def __str__(self) -> str:
        return (
            f"{self.inserted} new, {self.skipped_duplicate} already known, "
            f"{self.unparseable} unparseable ({self.seen} seen)"
        )


def extract_san_moves(pgn_text: str | None) -> list[str]:
    """Parse a PGN's mainline into a list of SAN moves."""
    if not pgn_text:
        return []
    try:
        game = chess.pgn.read_game(io.StringIO(pgn_text))
    except Exception:
        return []
    if game is None:
        return []
    board = game.board()
    moves: list[str] = []
    for move in game.mainline_moves():
        try:
            moves.append(board.san(move))
            board.push(move)
        except (ValueError, AssertionError):
            break
    return moves


def _position_rows(
    game_id: int, san_moves: Sequence[str], max_ply: int
) -> tuple[list[tuple], list[tuple]]:
    """Build (game_positions, positions) rows for a game's opening phase."""
    board = chess.Board()
    gp_rows: list[tuple] = []
    pos_rows: list[tuple] = []

    for ply, san in enumerate(san_moves):
        if ply >= max_ply:
            break
        key = f"{chess.polyglot.zobrist_hash(board):016x}"
        try:
            move = board.parse_san(san)
        except (ValueError, AssertionError):
            break
        gp_rows.append((game_id, ply, key, san, move.uci()))
        pos_rows.append((key, board.fen(), ply))
        board.push(move)
    else:
        # Game ended within the indexed window: record the final position too,
        # so a line that always ends in the same place is still countable.
        key = f"{chess.polyglot.zobrist_hash(board):016x}"
        gp_rows.append((game_id, len(san_moves), key, None, None))
        pos_rows.append((key, board.fen(), len(san_moves)))

    return gp_rows, pos_rows


def ingest(
    conn: sqlite3.Connection,
    games: Iterable[NormalizedGame],
    config: Config | None = None,
    progress=None,
    batch_size: int = 500,
    collection: str | None = None,
    titles: dict[str, str] | None = None,
) -> IngestStats:
    """Insert games and index their positions. Duplicates are silently skipped.

    `collection` names the library the games join — None for the user's own
    games, "titled" for the reference corpus. `titles` maps a lowercased player
    name to a federation title, for sources that report the title on the profile
    rather than on each game (Chess.com does this).
    """
    config = config or Config.load()
    max_ply = config.max_indexed_ply
    titles = {k.lower(): v for k, v in (titles or {}).items() if v}
    stats = IngestStats()

    pending: list[tuple[dict, list[str]]] = []

    def flush() -> None:
        if not pending:
            return
        for row, san_moves in pending:
            cur = conn.execute(_INSERT_GAME, row)
            if cur.rowcount == 0:
                stats.skipped_duplicate += 1
                continue
            stats.inserted += 1
            game_id = cur.lastrowid
            if row["variant"] in _STANDARD_VARIANTS and san_moves:
                gp_rows, pos_rows = _position_rows(game_id, san_moves, max_ply)
                if gp_rows:
                    conn.executemany(
                        "INSERT OR IGNORE INTO game_positions "
                        "(game_id, ply, pos_key, move_san, move_uci) VALUES (?,?,?,?,?)",
                        gp_rows,
                    )
                    conn.executemany(
                        "INSERT OR IGNORE INTO positions (pos_key, fen, ply) VALUES (?,?,?)",
                        pos_rows,
                    )
        conn.commit()
        pending.clear()

    for game in games:
        stats.seen += 1
        san_moves = extract_san_moves(game.pgn)
        if not san_moves:
            stats.unparseable += 1
            continue

        row = game.as_row()
        row["ply_count"] = len(san_moves)
        row["moves_san"] = " ".join(san_moves)
        row["collection"] = collection
        # Computed here rather than in a later pass: the move list is already in
        # hand, and a game that arrives unscanned would be invisible to the
        # "games I threw away" filter until someone remembered to rescan.
        row.update(swings.peaks(san_moves))
        # A title the source only states on the profile still belongs on the
        # game, so a game can be read without joining back to a roster.
        for side in ("white", "black"):
            if not row.get(f"{side}_title"):
                row[f"{side}_title"] = titles.get(row.get(f"{side}_lower") or "")
        pending.append((row, san_moves))

        if len(pending) >= batch_size:
            flush()
            if progress:
                progress(f"ingested {stats.inserted} games")

    flush()
    return stats


def reindex_positions(
    conn: sqlite3.Connection, config: Config | None = None, progress=None
) -> int:
    """Rebuild the position index from stored move lists.

    Needed after changing `max_indexed_ply` — existing games keep their moves,
    so this never re-downloads anything.
    """
    config = config or Config.load()
    max_ply = config.max_indexed_ply

    conn.execute("DELETE FROM game_positions")
    conn.execute("DELETE FROM positions")
    conn.commit()

    rows = conn.execute(
        "SELECT id, moves_san, variant FROM games WHERE moves_san IS NOT NULL AND moves_san != ''"
    ).fetchall()

    done = 0
    for row in rows:
        if row["variant"] not in _STANDARD_VARIANTS:
            continue
        gp_rows, pos_rows = _position_rows(row["id"], row["moves_san"].split(), max_ply)
        if gp_rows:
            conn.executemany(
                "INSERT OR IGNORE INTO game_positions "
                "(game_id, ply, pos_key, move_san, move_uci) VALUES (?,?,?,?,?)",
                gp_rows,
            )
            conn.executemany(
                "INSERT OR IGNORE INTO positions (pos_key, fen, ply) VALUES (?,?,?)",
                pos_rows,
            )
        done += 1
        if done % 1000 == 0:
            conn.commit()
            if progress:
                progress(f"reindexed {done}/{len(rows)} games")

    conn.commit()
    return done

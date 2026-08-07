"""Who was winning, and when — computed from the move list alone.

The question "which games did I throw away" needs to know that a player was
winning at some point and lost anyway. Asking Stockfish is out: a depth-18
evaluation of every position of every game is tens of hours of engine time for a
database this size, and it would have to be redone whenever games are added.

Material is the cheap answer, and at the sizes that matter it is very nearly the
same answer. Being four pawns up is being a rook up, or a piece and a pawn; the
engine and the scoresheet agree about that far more often than they disagree.
What they disagree about — a sacrifice that is worth more than the material —
does not survive the sustain window below.
"""

from __future__ import annotations

import sqlite3

import chess

# Kings excluded: both sides always have one, so it cancels.
PIECE_VALUES = {
    chess.PAWN: 1,
    chess.KNIGHT: 3,
    chess.BISHOP: 3,
    chess.ROOK: 5,
    chess.QUEEN: 9,
}

# How long an advantage has to last before it counts, in plies. Every ordinary
# capture puts one side "ahead" for a move until the recapture; without this,
# trading queens would be recorded as having been nine pawns up. Six plies is
# three moves each side — long enough that a real advantage is distinguishable
# from the middle of an exchange.
SUSTAIN_PLIES = 6

# The window is allowed to run short against the end of the game — an advantage
# held into the final position was held for as long as there was a game to hold
# it in — but not this short. Without a floor, a queen sacrificed to deliver
# mate reads as "the loser was nine pawns up on the last move".
MIN_WINDOW = 3


def material_balance(board: chess.Board) -> int:
    """Material from White's point of view, in pawns."""
    total = 0
    for piece_type, value in PIECE_VALUES.items():
        total += value * len(board.pieces(piece_type, chess.WHITE))
        total -= value * len(board.pieces(piece_type, chess.BLACK))
    return total


def peaks(moves: str | list[str] | None) -> dict:
    """The largest advantage each side sustained, and the ply it started at.

    Returns pawns (never negative) and the ply from which the run of at least
    SUSTAIN_PLIES positions began — which is where the board should open when
    someone asks to see the game they threw away.
    """
    tokens = moves.split() if isinstance(moves, str) else list(moves or [])
    board = chess.Board()

    # The balance after each move, plus the starting position at index 0.
    series = [material_balance(board)]
    for san in tokens:
        try:
            board.push_san(san)
        except ValueError:
            break
        series.append(material_balance(board))

    best = {chess.WHITE: (0, 0), chess.BLACK: (0, 0)}
    for start in range(len(series)):
        window = series[start:start + SUSTAIN_PLIES]
        if len(window) < MIN_WINDOW:
            break
        low = min(window)
        high = max(window)
        # The worst point of the window is what the side actually kept hold of.
        if low > best[chess.WHITE][0]:
            best[chess.WHITE] = (low, start)
        if -high > best[chess.BLACK][0]:
            best[chess.BLACK] = (-high, start)

    return {
        "peak_white_adv": best[chess.WHITE][0],
        "peak_white_ply": best[chess.WHITE][1],
        "peak_black_adv": best[chess.BLACK][0],
        "peak_black_ply": best[chess.BLACK][1],
    }


# Only the user's own games, unless asked otherwise.
#
# "Which games did I throw away" is a question about the user, and the reference
# library is an order of magnitude larger — scanning a hundred thousand titled
# games to answer a question about the two thousand of your own would turn a
# fifteen-second job into a four-minute one for nothing.
_OWN_GAMES = "AND collection IS NULL"

_UNSCANNED = """FROM games
   WHERE peak_white_adv IS NULL
     AND moves_san IS NOT NULL AND moves_san != ''
     {scope}"""


def pending_count(conn: sqlite3.Connection, all_collections: bool = False) -> int:
    """Games with a move list that have not been scanned yet."""
    scope = "" if all_collections else _OWN_GAMES
    return conn.execute(
        "SELECT COUNT(*) c " + _UNSCANNED.format(scope=scope)
    ).fetchone()["c"]


def backfill(
    conn: sqlite3.Connection,
    progress=None,
    batch: int = 500,
    all_collections: bool = False,
) -> int:
    """Scan every game that has not been scanned. Safe to run repeatedly."""
    scope = "" if all_collections else _OWN_GAMES
    rows = conn.execute(
        "SELECT id, moves_san " + _UNSCANNED.format(scope=scope)
    ).fetchall()

    total = len(rows)
    done = 0
    for row in rows:
        values = peaks(row["moves_san"])
        conn.execute(
            """UPDATE games SET peak_white_adv = :peak_white_adv,
                                peak_white_ply = :peak_white_ply,
                                peak_black_adv = :peak_black_adv,
                                peak_black_ply = :peak_black_ply
               WHERE id = :id""",
            {**values, "id": row["id"]},
        )
        done += 1
        if done % batch == 0:
            conn.commit()
            if progress:
                progress(f"scanned {done}/{total} games")

    conn.commit()
    if progress and total:
        progress(f"scanned {total} games")
    return total

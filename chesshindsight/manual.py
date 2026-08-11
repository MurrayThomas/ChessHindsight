"""Games entered by hand, from a scoresheet.

An over-the-board game has no API to sync from, so it arrives as notation
someone typed. That makes two things matter here that matter nowhere else in
the app:

  * The notation is *being written*, so it is wrong most of the time. Parsing
    has to report where it stopped rather than simply failing, or a single
    misread move leaves the writer hunting a whole game for it.
  * Everything downstream — the position index, the opening tree, the material
    scan, favourites — already works on stored games. So a hand-entered game is
    turned into the same NormalizedGame the sources produce and pushed through
    the same ingest path, rather than being written to the table directly.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import re
import sqlite3

import chess
import chess.pgn

from . import openings
from .config import Config
from .ingest import ingest
from .sources import NormalizedGame

# What a hand-entered game can be. The source is the existing filter dimension,
# so a game typed in here is separable from synced ones without a new column or
# a separate collection — and "typed in by hand" is not one kind of thing:
#
#   otb  a game actually played across a board, which has no online record
#   pgn  notation from somewhere else, pasted in; the same bucket a PGN file
#        import lands in, because that is what it is
#
# Allow-listed rather than free-form: the value is written into every row and
# read back by the filter, so an unrecognised one would create a source nobody
# can name.
SOURCES = ("otb", "pgn")
DEFAULT_SOURCE = "otb"

RESULTS = ("1-0", "0-1", "1/2-1/2")

# Everything a scoresheet or a pasted PGN carries that is not a move: comments,
# variations, numeric annotation glyphs, and the !/? a post-mortem adds.
_NOISE = re.compile(r"\{[^}]*\}|\([^)]*\)|\$\d+|;[^\n]*")
_TRAILING_MARKS = re.compile(r"[?!]+$")
# "12." and "12..." both introduce a move and may be written against it.
_MOVE_NUMBER = re.compile(r"^\d+\.(?:\.\.)?")


class MoveError(ValueError):
    """A move that will not play, with where in the line it happened."""

    def __init__(self, token: str, index: int, message: str):
        super().__init__(message)
        self.token = token
        self.index = index


def parse_moves(text: str | None) -> dict:
    """Read free-form notation into a playable move list.

    Accepts what people actually write: "1. e4 e5", "1.e4 e5", bare "e4 e5", a
    pasted PGN movetext with comments and variations, a trailing result. Returns
    the moves parsed so far even when it fails, because a half-typed game is the
    normal state of this box and the board should follow along regardless.
    """
    raw = _NOISE.sub(" ", text or "")
    board = chess.Board()
    moves: list[dict] = []
    result: str | None = None
    error: MoveError | None = None

    for token in raw.split():
        if token in RESULTS or token == "*":
            result = token if token in RESULTS else None
            continue
        # A move number may be a token of its own or stuck to the move.
        token = _MOVE_NUMBER.sub("", token, count=1)
        # Lone "..." continuation markers, and what is left of a bare number.
        token = token.strip(".")
        if not token:
            continue
        cleaned = _TRAILING_MARKS.sub("", token)
        if not cleaned:
            continue
        try:
            move = board.parse_san(cleaned)
        except ValueError:
            error = MoveError(
                token,
                len(moves),
                f"{token!r} is not a legal move at this point"
                f" ({_describe_ply(len(moves))}).",
            )
            break
        moves.append({"san": board.san(move), "uci": move.uci()})
        board.push(move)

    return {
        "ok": error is None,
        "moves": moves,
        "count": len(moves),
        "fen": board.fen(),
        "turn": "white" if board.turn == chess.WHITE else "black",
        "san_line": _numbered(moves),
        "result": result,
        # Reported rather than raised: the caller is a keystroke handler.
        "error": str(error) if error else None,
        "error_token": error.token if error else None,
        "error_index": error.index if error else None,
        "is_game_over": board.is_game_over(),
        "suggested_result": _outcome_result(board),
    }


def _describe_ply(ply: int) -> str:
    """"move 12 for Black" — where a reader should look on the scoresheet."""
    return f"move {ply // 2 + 1} for {'White' if ply % 2 == 0 else 'Black'}"


def _numbered(moves: list[dict]) -> str:
    out: list[str] = []
    for i, m in enumerate(moves):
        if i % 2 == 0:
            out.append(f"{i // 2 + 1}.{m['san']}")
        else:
            out.append(m["san"])
    return " ".join(out)


def _outcome_result(board: chess.Board) -> str | None:
    """The result the position itself dictates, when it dictates one.

    A game entered up to checkmate does not need to be told who won, and asking
    invites the wrong answer being clicked.
    """
    outcome = board.outcome()
    if outcome is None:
        return None
    if outcome.winner is None:
        return "1/2-1/2"
    return "1-0" if outcome.winner == chess.WHITE else "0-1"


def build_pgn(
    moves: list[dict],
    white: str,
    black: str,
    result: str,
    played_at: str | None,
    event: str | None = None,
) -> str:
    game = chess.pgn.Game()
    game.headers["Event"] = event or "Over the board"
    game.headers["Site"] = "?"
    game.headers["Date"] = (played_at or "")[:10].replace("-", ".") or "????.??.??"
    game.headers["Round"] = "-"
    game.headers["White"] = white
    game.headers["Black"] = black
    game.headers["Result"] = result

    node = game
    board = chess.Board()
    for m in moves:
        move = chess.Move.from_uci(m["uci"])
        node = node.add_variation(move)
        board.push(move)
    return str(game)


def _game_id(source: str, white: str, black: str, played_at: str,
             moves: list[dict]) -> str:
    """A stable id, salted with the moment it was recorded.

    Two genuinely different games can share players, date and moves — a pair of
    quick rematches down the same opening is not unusual — so a pure content
    hash would silently swallow the second one as a duplicate. The recording
    time separates them while keeping the id reproducible after the fact.
    """
    payload = "|".join(
        [white, black, played_at, " ".join(m["san"] for m in moves),
         dt.datetime.now(dt.timezone.utc).isoformat()]
    )
    return f"{source}-" + hashlib.sha1(
        payload.encode("utf-8", "replace")
    ).hexdigest()[:20]


def save_game(
    conn: sqlite3.Connection,
    config: Config,
    moves_text: str,
    white: str,
    black: str,
    result: str,
    played_at: str | None = None,
    time_class: str | None = None,
    event: str | None = None,
    white_elo: int | None = None,
    black_elo: int | None = None,
    source: str = DEFAULT_SOURCE,
) -> dict:
    """Validate, store, and index a hand-entered game.

    Raises ValueError with a message meant to be shown, since every failure here
    is something the person typing can fix.
    """
    white = (white or "").strip()
    black = (black or "").strip()
    source = (source or DEFAULT_SOURCE).strip().lower()
    if source not in SOURCES:
        raise ValueError(f"Unknown kind of game {source!r}.")
    if not white or not black:
        raise ValueError("Both players need a name.")
    if result not in RESULTS:
        raise ValueError("Pick a result: 1-0, 0-1 or 1/2-1/2.")

    parsed = parse_moves(moves_text)
    if not parsed["ok"]:
        raise ValueError(parsed["error"])
    if not parsed["moves"]:
        raise ValueError("No moves were entered.")

    # A bare date means midnight; games entered on the same day then sort by the
    # order they were recorded rather than arbitrarily.
    stamp = (played_at or "").strip()
    if not stamp:
        stamp = dt.datetime.now(dt.timezone.utc).isoformat()
    elif len(stamp) <= 10:
        stamp = f"{stamp}T12:00:00+00:00"

    moves = parsed["moves"]
    source_id = _game_id(source, white, black, stamp, moves)
    pgn = build_pgn(moves, white, black, result, stamp, event)

    # Name the opening from the local book. Synced games arrive with a name
    # from the source; a scoresheet has no source, and leaving it blank would
    # file every hand-entered game under "Unknown opening" — which is both
    # useless on the Openings view and wrong, since the moves say exactly what
    # was played.
    named = openings.name_for_line(
        chess.Board(), [chess.Move.from_uci(m["uci"]) for m in moves]
    )

    game = NormalizedGame(
        source=source,
        source_game_id=source_id,
        url=None,
        played_at=stamp,
        white_name=white,
        black_name=black,
        white_elo=white_elo,
        black_elo=black_elo,
        result=result,
        # Only an over-the-board game is known to have ended across a board.
        # Notation pasted from elsewhere says nothing about how it finished, and
        # inventing a termination would put a fact in the database that nobody
        # supplied.
        termination="over the board" if source == "otb" else None,
        time_control_raw=None,
        time_class=time_class or None,
        base_seconds=None,
        increment_seconds=None,
        eco=None,
        opening=named["name"] if named else None,
        variant=None,
        # Not rated: an over-the-board club game carries no online rating, and
        # claiming otherwise would put it in rating-filtered views as if it did.
        rated=0,
        pgn=pgn,
    )

    stats = ingest(conn, [game], config)
    if not stats.inserted:
        raise ValueError("That game could not be stored.")

    row = conn.execute(
        "SELECT id FROM games WHERE source = ? AND source_game_id = ?",
        (source, source_id),
    ).fetchone()
    if row is None:  # pragma: no cover - ingest just reported it inserted
        raise ValueError("The game was stored but could not be read back.")

    return {
        "game_id": row["id"],
        "moves": len(moves),
        "white": white,
        "black": black,
        "result": result,
        "played_at": stamp,
    }

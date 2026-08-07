"""Naming the position on the board.

A book of 3,810 named positions, keyed by the same Zobrist hash the position
index uses. Keying on the position rather than on a move order is what makes
transpositions work: 1.d4 Nf6 2.c4 g6 and 1.c4 g6 2.d4 Nf6 are one King's
Indian because they are one position.

The names come from lichess-org/chess-openings, which is CC0. Regenerate the
file with tools/fetch_openings.py.
"""

from __future__ import annotations

import threading

import chess
import chess.polyglot

from .paths import resource_dir

_book: dict[str, tuple[str, int]] | None = None
_lock = threading.Lock()


def _load() -> dict[str, tuple[str, int]]:
    """Read the book once, on first use.

    Lazily, because a database query that never asks about openings should not
    pay for parsing a quarter of a megabyte, and eagerly at import time would
    put it on the startup path.
    """
    global _book
    if _book is not None:
        return _book
    with _lock:
        if _book is not None:  # another thread won the race
            return _book
        book: dict[str, tuple[str, int]] = {}
        path = resource_dir() / "assets" / "openings.tsv"
        try:
            with path.open(encoding="utf-8") as fh:
                for line in fh:
                    if line.startswith("#") or not line.strip():
                        continue
                    parts = line.rstrip("\n").split("\t")
                    if len(parts) != 3:
                        continue
                    key, ply, name = parts
                    try:
                        book[key] = (name, int(ply))
                    except ValueError:
                        continue
        except OSError:
            # A missing book is not worth failing a request over; positions
            # simply go unnamed.
            book = {}
        _book = book
        return _book


def position_key(board: chess.Board) -> str:
    return f"{chess.polyglot.zobrist_hash(board):016x}"


def name_for(board: chess.Board) -> str | None:
    """The opening name for exactly this position, if it has one."""
    found = _load().get(position_key(board))
    return found[0] if found else None


def name_for_line(
    root: chess.Board, moves: list[chess.Move] | None
) -> dict | None:
    """The opening a line has reached, as the deepest named position in it.

    Openings are cumulative: 1.e4 c5 is a Sicilian and stays one however deep
    the game runs, so the name is the last one matched rather than only a name
    for where the board stands now. That is what keeps a label on screen when
    the line leaves book — which, in an explorer, is most of the time.

    `ply` is how far into the line the name was set, so the caller can say
    whether it names the current position or one further back.
    """
    book = _load()
    if not book:
        return None

    board = root.copy(stack=False)
    best: dict | None = None
    found = book.get(position_key(board))
    if found:
        best = {"name": found[0], "ply": 0}

    for index, move in enumerate(moves or [], start=1):
        board.push(move)
        found = book.get(position_key(board))
        if found:
            best = {"name": found[0], "ply": index}

    if best is not None:
        best["plies_since"] = len(moves or []) - best["ply"]
    return best

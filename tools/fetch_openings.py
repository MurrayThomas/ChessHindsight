r"""Build the opening-name book the Explorer labels positions with.

Source: lichess-org/chess-openings, five TSVs of ECO volume, name and the move
order that reaches the opening. Released under CC0 — a public domain dedication
— so it can be shipped with the app under any licence.

Each opening is replayed and reduced to the Zobrist hash of the position it
arrives at, which is the same identity the position index already uses. Keying
on the position rather than the move order means transpositions resolve for
free: 1.d4 Nf6 2.c4 g6 and 1.c4 g6 2.d4 Nf6 are the same King's Indian because
they are the same position.

The ECO code is deliberately dropped. It is a filing system that does not line
up with the names one-to-one, and this app stopped showing it everywhere else.

Run:  .venv\Scripts\python.exe tools\fetch_openings.py
"""

from __future__ import annotations

import sys
import urllib.request
from pathlib import Path

import chess
import chess.polyglot

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "openings.tsv"

BASE = "https://raw.githubusercontent.com/lichess-org/chess-openings/master"
VOLUMES = ("a", "b", "c", "d", "e")


def fetch(volume: str) -> str:
    url = f"{BASE}/{volume}.tsv"
    print(f"  {url}")
    with urllib.request.urlopen(url, timeout=60) as resp:
        if resp.status != 200:
            raise SystemExit(f"{url} returned HTTP {resp.status}")
        return resp.read().decode("utf-8")


def position_key(pgn_moves: str) -> tuple[str, int] | None:
    """Replay a move order and return (zobrist hex, ply) of where it lands."""
    board = chess.Board()
    plies = 0
    for token in pgn_moves.split():
        # The PGN column carries move numbers: "1. Nh3 d5 2. g3".
        if token[0].isdigit() and "." in token:
            token = token.split(".", 1)[1]
        if not token:
            continue
        try:
            board.push_san(token)
        except ValueError:
            return None
        plies += 1
    return f"{chess.polyglot.zobrist_hash(board):016x}", plies


def main() -> int:
    print("Downloading opening names (CC0, lichess-org/chess-openings)…")
    rows: dict[str, tuple[str, int]] = {}
    skipped = 0

    for volume in VOLUMES:
        text = fetch(volume)
        for line_no, line in enumerate(text.splitlines()):
            if line_no == 0 or not line.strip():
                continue  # header
            parts = line.split("\t")
            if len(parts) < 3:
                skipped += 1
                continue
            _eco, name, pgn_moves = parts[0], parts[1], parts[2]
            found = position_key(pgn_moves)
            if not found:
                skipped += 1
                continue
            key, plies = found
            # Two names can land on one position. Keep the shorter one: it is
            # the parent line, and the more specific sibling would be wrong for
            # every other move order that arrives here.
            if key not in rows or len(name) < len(rows[key][0]):
                rows[key] = (name, plies)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", encoding="utf-8", newline="\n") as fh:
        fh.write("# Opening names by Zobrist position key.\n")
        fh.write("# Source: lichess-org/chess-openings (CC0). "
                 "Regenerate with tools/fetch_openings.py\n")
        fh.write("# key\tply\tname\n")
        for key, (name, plies) in sorted(rows.items(), key=lambda kv: kv[1][1]):
            fh.write(f"{key}\t{plies}\t{name}\n")

    print(f"\nWrote {len(rows)} positions to {OUT.relative_to(ROOT)}"
          f" ({OUT.stat().st_size / 1024:.0f} KB)")
    if skipped:
        print(f"{skipped} row(s) skipped as unparseable")
    return 0


if __name__ == "__main__":
    sys.exit(main())

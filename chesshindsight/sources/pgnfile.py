"""Local PGN file import.

Accepts anything python-chess can parse: exported archives, TWIC downloads,
pro-game databases, OTB tournament files. Game ids are content hashes, so
re-importing the same file is idempotent.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import re
from pathlib import Path
from typing import Iterator

import chess.pgn

from . import NormalizedGame, classify_speed, normalize_speed, parse_time_control

_RESULTS = {"1-0", "0-1", "1/2-1/2"}


def _played_at(headers: chess.pgn.Headers) -> str | None:
    date = headers.get("UTCDate") or headers.get("Date")
    timestr = headers.get("UTCTime") or headers.get("Time") or "00:00:00"
    if not date or "?" in date:
        return None
    date = date.replace(".", "-")
    try:
        stamp = dt.datetime.fromisoformat(f"{date}T{timestr}")
    except ValueError:
        try:
            stamp = dt.datetime.fromisoformat(f"{date}T00:00:00")
        except ValueError:
            return None
    return stamp.replace(tzinfo=dt.timezone.utc).isoformat()


def _int_or_none(value: str | None) -> int | None:
    if not value:
        return None
    m = re.match(r"\d+", value.strip())
    return int(m.group()) if m else None


def _game_id(headers: chess.pgn.Headers, moves: str) -> str:
    """Content hash over the identifying headers plus the movetext."""
    parts = [
        headers.get("White", ""),
        headers.get("Black", ""),
        headers.get("Date", ""),
        headers.get("UTCTime", headers.get("Time", "")),
        headers.get("Event", ""),
        headers.get("Round", ""),
        headers.get("Site", ""),
        moves,
    ]
    return hashlib.sha1("|".join(parts).encode("utf-8", "replace")).hexdigest()[:24]


def _site_id(headers: chess.pgn.Headers) -> tuple[str, str] | None:
    """Recognize PGN exported from a known site so it dedupes against API syncs."""
    site = headers.get("Site", "") or ""
    link = headers.get("Link", "") or ""
    for candidate in (site, link):
        m = re.search(r"lichess\.org/(\w{8})", candidate)
        if m:
            return "lichess", m.group(1)
        m = re.search(r"chess\.com/(?:game/)?(?:live/|daily/)?(\d+)", candidate)
        if m:
            return "chesscom", m.group(1)
    return None


def read_pgn(path: Path | str, progress=None) -> Iterator[NormalizedGame]:
    path = Path(path)
    count = 0
    with path.open("r", encoding="utf-8", errors="replace") as fh:
        while True:
            before = fh.tell()
            try:
                game = chess.pgn.read_game(fh)
            except Exception:
                # Skip a game that will not parse and carry on with the file —
                # but only if the reader actually consumed something. A failure
                # that leaves the handle where it was would otherwise be retried
                # from the same offset forever, and an import that spins on one
                # damaged game looks exactly like the app having frozen.
                if fh.tell() == before:
                    break
                continue
            if game is None:
                break

            headers = game.headers
            board = game.board()
            san_moves = []
            for move in game.mainline_moves():
                try:
                    san_moves.append(board.san(move))
                    board.push(move)
                except (ValueError, AssertionError):
                    break
            moves = " ".join(san_moves)
            if not moves:
                continue

            tc_raw = headers.get("TimeControl")
            base, inc = parse_time_control(tc_raw)
            time_class = normalize_speed(
                headers.get("TimeClass") or headers.get("Speed")
            ) or classify_speed(base, inc)

            result = headers.get("Result", "*")
            source, source_id = (_site_id(headers) or ("pgn", _game_id(headers, moves)))

            count += 1
            if progress and count % 500 == 0:
                progress(f"{path.name}: {count} games parsed")

            yield NormalizedGame(
                source=source,
                source_game_id=source_id,
                url=headers.get("Link") or (headers.get("Site") if "://" in headers.get("Site", "") else None),
                played_at=_played_at(headers),
                white_name=headers.get("White"),
                black_name=headers.get("Black"),
                # OTB databases (TWIC and the like) carry the title here, which
                # is the only place a PGN records who the strong players were.
                white_title=headers.get("WhiteTitle") or None,
                black_title=headers.get("BlackTitle") or None,
                white_elo=_int_or_none(headers.get("WhiteElo")),
                black_elo=_int_or_none(headers.get("BlackElo")),
                result=result if result in _RESULTS else "*",
                termination=headers.get("Termination"),
                time_control_raw=tc_raw,
                time_class=time_class,
                base_seconds=base,
                increment_seconds=inc,
                eco=headers.get("ECO"),
                opening=headers.get("Opening"),
                variant=headers.get("Variant"),
                rated=None,
                pgn=str(game),
            )

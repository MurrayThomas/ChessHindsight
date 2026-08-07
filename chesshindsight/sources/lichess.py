"""Lichess game export adapter.

Uses the ndjson streaming export, which supports a `since` timestamp — so
incremental sync is exact rather than month-granular. An API token is optional
but raises the rate limit noticeably for large accounts.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import time
from typing import Iterator

import requests

from . import NormalizedGame, USER_AGENT, normalize_speed

BASE = "https://lichess.org"

_DRAW_STATUSES = {"draw", "stalemate"}
_UNFINISHED_STATUSES = {"created", "started", "aborted", "noStart", "unknownFinish"}


class LichessError(RuntimeError):
    pass


def _session(token: str | None = None) -> requests.Session:
    s = requests.Session()
    s.headers.update({"User-Agent": USER_AGENT, "Accept": "application/x-ndjson"})
    token = token or os.environ.get("LICHESS_TOKEN")
    if token:
        s.headers["Authorization"] = f"Bearer {token}"
    return s


def _iso(ms: int | None) -> str | None:
    if not ms:
        return None
    return dt.datetime.fromtimestamp(ms / 1000, tz=dt.timezone.utc).isoformat()


def _side(players: dict, colour: str) -> tuple[str | None, int | None, str | None]:
    side = (players or {}).get(colour) or {}
    user = side.get("user") or {}
    name = user.get("name")
    if not name and side.get("aiLevel"):
        name = f"Stockfish level {side['aiLevel']}"
    # BOT is a Lichess account flag, not a federation title.
    title = user.get("title")
    if title == "BOT":
        title = None
    return name, side.get("rating"), title


def _convert(raw: dict) -> NormalizedGame | None:
    game_id = raw.get("id")
    if not game_id:
        return None
    status = raw.get("status")
    if status in _UNFINISHED_STATUSES:
        return None

    white_name, white_elo, white_title = _side(raw.get("players"), "white")
    black_name, black_elo, black_title = _side(raw.get("players"), "black")

    winner = raw.get("winner")
    if winner == "white":
        result = "1-0"
    elif winner == "black":
        result = "0-1"
    elif status in _DRAW_STATUSES or raw.get("status") == "draw":
        result = "1/2-1/2"
    else:
        result = "1/2-1/2" if status not in _UNFINISHED_STATUSES else "*"

    clock = raw.get("clock") or {}
    base = clock.get("initial")
    inc = clock.get("increment")
    if base is not None:
        tc_raw = f"{base}+{inc or 0}"
    elif raw.get("daysPerTurn"):
        tc_raw = f"1/{raw['daysPerTurn'] * 86400}"
        base, inc = raw["daysPerTurn"] * 86400, 0
    else:
        tc_raw = None

    opening = raw.get("opening") or {}

    return NormalizedGame(
        source="lichess",
        source_game_id=game_id,
        url=f"{BASE}/{game_id}",
        played_at=_iso(raw.get("createdAt")),
        white_name=white_name,
        black_name=black_name,
        white_title=white_title,
        black_title=black_title,
        white_elo=white_elo,
        black_elo=black_elo,
        result=result,
        termination=status,
        time_control_raw=tc_raw,
        time_class=normalize_speed(raw.get("speed")),
        base_seconds=base,
        increment_seconds=inc,
        eco=opening.get("eco"),
        opening=opening.get("name"),
        variant=raw.get("variant"),
        rated=1 if raw.get("rated") else 0,
        pgn=raw.get("pgn"),
    )


def fetch_games(
    username: str,
    since_ms: int | None = None,
    token: str | None = None,
    progress=None,
) -> Iterator[NormalizedGame]:
    """Stream a user's games, newest-last, optionally only those after `since_ms`."""
    session = _session(token)
    params = {
        "pgnInJson": "true",
        "tags": "true",
        "opening": "true",
        "sort": "dateAsc",
        "moves": "true",
    }
    if since_ms:
        params["since"] = str(since_ms)

    url = f"{BASE}/api/games/user/{username}"
    for attempt in range(5):
        resp = session.get(url, params=params, stream=True, timeout=(30, 300))
        if resp.status_code == 404:
            raise LichessError(f"Lichess user '{username}' not found")
        if resp.status_code == 429:
            # Lichess asks for a full minute of backoff on rate limit.
            wait = 60
            if progress:
                progress(f"Lichess rate limited, waiting {wait}s")
            time.sleep(wait)
            continue
        resp.raise_for_status()

        count = 0
        for line in resp.iter_lines(decode_unicode=True):
            if not line:
                continue
            try:
                raw = json.loads(line)
            except json.JSONDecodeError:
                continue
            game = _convert(raw)
            if game is None:
                continue
            count += 1
            if progress and count % 200 == 0:
                progress(f"Lichess {username}: {count} games")
            yield game
        return

    raise LichessError("Lichess rate limit not cleared after several retries")


def profile(username: str, token: str | None = None) -> dict:
    """Public profile: the federation title and real name, when set."""
    session = _session(token)
    resp = session.get(
        f"{BASE}/api/user/{username}",
        headers={"Accept": "application/json"},
        timeout=30,
    )
    if resp.status_code == 404:
        raise LichessError(f"Lichess user '{username}' not found")
    resp.raise_for_status()
    data = resp.json()
    prof = data.get("profile") or {}
    real = prof.get("realName") or " ".join(
        p for p in (prof.get("firstName"), prof.get("lastName")) if p
    )
    title = data.get("title")
    return {
        "source": "lichess",
        "username": data.get("username") or username,
        "title": None if title == "BOT" else title,
        "real_name": real or None,
        "url": f"{BASE}/@/{data.get('id') or username}",
    }


def search_titled(query: str, limit: int = 12, token: str | None = None) -> list[dict]:
    """Find Lichess accounts by the start of their username.

    Lichess usernames are handles rather than names — Magnus plays as
    DrNykterstein — so this can only match what was typed. Only accounts that
    actually hold a title are returned, since this feeds the reference library.
    """
    query = (query or "").strip()
    if len(query) < 3:
        return []
    session = _session(token)
    resp = session.get(
        f"{BASE}/api/player/autocomplete",
        params={"term": query, "object": "true"},
        headers={"Accept": "application/json"},
        timeout=30,
    )
    resp.raise_for_status()
    names = [u.get("name") for u in resp.json().get("result", []) if u.get("name")]

    out = []
    for name in names[: limit * 2]:
        try:
            prof = profile(name, token)
        except (LichessError, requests.RequestException):
            continue
        if prof["title"]:
            out.append(prof)
        if len(out) >= limit:
            break
    return out

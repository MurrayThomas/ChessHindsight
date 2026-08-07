"""Chess.com Published-Data API adapter.

The API is public and needs no key, but it does require a descriptive
User-Agent. Games are served as monthly archives, which makes incremental
sync easy: only the current month can change, so older months are cached.
"""

from __future__ import annotations

import datetime as dt
from typing import Iterator

import requests

from . import NormalizedGame, USER_AGENT, normalize_speed, parse_time_control

BASE = "https://api.chess.com/pub"

# Chess.com reports a per-side outcome string; only "win" is a win, and the
# rest split into draw-ish and loss-ish reasons.
_DRAW_RESULTS = {
    "agreed",
    "repetition",
    "stalemate",
    "insufficient",
    "50move",
    "timevsinsufficient",
}


class ChessComError(RuntimeError):
    pass


def _session() -> requests.Session:
    s = requests.Session()
    s.headers.update({"User-Agent": USER_AGENT, "Accept": "application/json"})
    return s


def _looks_like_api_json(resp: requests.Response) -> bool:
    """Whether a response actually came from the API rather than the edge.

    The Published-Data API answers in JSON even when it is saying "no such
    user". An HTML body means the request never reached the API — Cloudflare or
    a misrouted origin answered instead — and that is a completely different
    problem from a username being wrong.
    """
    ctype = (resp.headers.get("Content-Type") or "").lower()
    return "json" in ctype


def list_archives(username: str, session: requests.Session | None = None) -> list[str]:
    """Return monthly archive URLs, oldest first."""
    session = session or _session()
    url = f"{BASE}/player/{username.lower()}/games/archives"
    resp = session.get(url, timeout=30)

    if resp.status_code == 404 and _looks_like_api_json(resp):
        raise ChessComError(f"Chess.com user '{username}' not found")

    if resp.status_code in (403, 404, 429) or not _looks_like_api_json(resp):
        # Do not blame the username for this: the same request for Chess.com's
        # own documented example user fails identically when the API is having
        # trouble, so reporting "user not found" here sends people off looking
        # for a spelling mistake that does not exist.
        raise ChessComError(
            f"Chess.com's game API did not respond properly "
            f"(HTTP {resp.status_code} from {url}). This is on Chess.com's side, "
            f"not your username — it is usually temporary, so try again later. "
            f"To analyse the games now, download them from "
            f"chess.com/games/archive and use Import PGN."
        )

    resp.raise_for_status()
    try:
        return resp.json().get("archives", [])
    except ValueError as exc:
        raise ChessComError(
            f"Chess.com returned something that is not JSON for {url}"
        ) from exc


def _result_from_sides(white_result: str, black_result: str) -> str:
    if white_result == "win":
        return "1-0"
    if black_result == "win":
        return "0-1"
    if white_result in _DRAW_RESULTS or black_result in _DRAW_RESULTS:
        return "1/2-1/2"
    return "*"


def _termination(white_result: str, black_result: str) -> str:
    loser_reason = black_result if white_result == "win" else white_result
    return loser_reason


def _convert(raw: dict) -> NormalizedGame | None:
    url = raw.get("url") or ""
    game_id = url.rstrip("/").rsplit("/", 1)[-1] or url
    if not game_id:
        return None

    white = raw.get("white") or {}
    black = raw.get("black") or {}
    tc_raw = raw.get("time_control")
    base, inc = parse_time_control(tc_raw)

    played_at = None
    if raw.get("end_time"):
        played_at = dt.datetime.fromtimestamp(
            raw["end_time"], tz=dt.timezone.utc
        ).isoformat()

    eco = None
    eco_url = raw.get("eco")
    opening = None
    if eco_url and "/openings/" in eco_url:
        # The `eco` field is a URL like .../openings/Sicilian-Defense-2.Nf3
        opening = eco_url.rsplit("/openings/", 1)[-1].replace("-", " ")
    elif eco_url:
        eco = eco_url

    return NormalizedGame(
        source="chesscom",
        source_game_id=str(game_id),
        url=url or None,
        played_at=played_at,
        white_name=white.get("username"),
        black_name=black.get("username"),
        white_elo=white.get("rating"),
        black_elo=black.get("rating"),
        result=_result_from_sides(white.get("result", ""), black.get("result", "")),
        termination=_termination(white.get("result", ""), black.get("result", "")),
        time_control_raw=tc_raw,
        time_class=normalize_speed(raw.get("time_class")),
        base_seconds=base,
        increment_seconds=inc,
        eco=eco,
        opening=opening,
        variant=raw.get("rules"),
        rated=1 if raw.get("rated") else 0,
        pgn=raw.get("pgn"),
    )


def fetch_games(
    username: str,
    since_archive: str | None = None,
    progress=None,
) -> Iterator[NormalizedGame]:
    """Yield games for a user.

    `since_archive` is the last fully-synced archive URL; that month is re-fetched
    (it may have gained games) and everything before it is skipped.
    """
    session = _session()
    archives = list_archives(username, session)
    if since_archive and since_archive in archives:
        archives = archives[archives.index(since_archive) :]

    for i, archive_url in enumerate(archives, 1):
        if progress:
            progress(f"Chess.com {username}: archive {i}/{len(archives)}")
        resp = session.get(archive_url, timeout=60)
        if resp.status_code == 404:
            continue
        resp.raise_for_status()
        if not _looks_like_api_json(resp):
            # A month that answers with HTML is the API faltering mid-sync;
            # skipping it silently would look like the games never existed.
            raise ChessComError(
                f"Chess.com returned a non-JSON response for {archive_url}. "
                f"The API is having trouble — try the sync again later."
            )
        for raw in resp.json().get("games", []):
            game = _convert(raw)
            if game is not None:
                yield game


def latest_archive(username: str) -> str | None:
    archives = list_archives(username)
    return archives[-1] if archives else None


def profile(username: str, session: requests.Session | None = None) -> dict:
    """Public profile: the federation title and real name, when set."""
    session = session or _session()
    url = f"{BASE}/player/{username.lower()}"
    resp = session.get(url, timeout=30)
    if resp.status_code == 404 and _looks_like_api_json(resp):
        raise ChessComError(f"Chess.com user '{username}' not found")
    if not _looks_like_api_json(resp):
        raise ChessComError(
            f"Chess.com's API did not respond properly (HTTP {resp.status_code}). "
            f"This is on their side — try again later."
        )
    resp.raise_for_status()
    data = resp.json()
    # The API reports the username folded to lower case; the profile URL keeps
    # the capitalisation the player chose, which is what to show them by.
    display = data.get("username") or username
    member_url = data.get("url") or ""
    if "/member/" in member_url:
        display = member_url.rsplit("/member/", 1)[-1].strip("/") or display
    return {
        "source": "chesscom",
        "username": display,
        "title": data.get("title"),
        "real_name": data.get("name"),
        "url": data.get("url"),
    }


# Chess.com publishes one roster per title, and it is a plain list of thousands
# of usernames. Fetching it is slow enough to be worth holding on to for the
# life of the process, and it changes at most daily.
_TITLED_CACHE: dict[str, list[str]] = {}

TITLES = ("GM", "WGM", "IM", "WIM", "FM", "WFM", "NM", "WNM", "CM", "WCM")


def titled_players(title: str, session: requests.Session | None = None) -> list[str]:
    """Every Chess.com account holding a given title."""
    title = title.upper()
    if title in _TITLED_CACHE:
        return _TITLED_CACHE[title]
    session = session or _session()
    resp = session.get(f"{BASE}/titled/{title}", timeout=60)
    if not _looks_like_api_json(resp):
        raise ChessComError(
            f"Chess.com's API did not respond properly (HTTP {resp.status_code}) "
            f"when listing {title} players. This is on their side."
        )
    resp.raise_for_status()
    names = resp.json().get("players", [])
    _TITLED_CACHE[title] = names
    return names


def search_titled(query: str, title: str = "GM", limit: int = 12) -> list[dict]:
    """Find titled accounts whose username contains `query`.

    The roster carries no real names, so the handful of matches that are going
    to be shown get a profile lookup each — enough to tell "magnuscarlsen" from
    "carlsenmagnus_fan" without fetching thousands of profiles.
    """
    query = (query or "").strip().lower()
    session = _session()
    names = titled_players(title, session)
    if query:
        starts = [n for n in names if n.startswith(query)]
        contains = [n for n in names if query in n and not n.startswith(query)]
        names = starts + contains
    out = []
    for name in names[:limit]:
        try:
            out.append(profile(name, session))
        except (ChessComError, requests.RequestException):
            out.append({"source": "chesscom", "username": name,
                        "title": title, "real_name": None})
    return out

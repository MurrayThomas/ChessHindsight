"""Game sources. Each adapter yields NormalizedGame regardless of origin."""

from __future__ import annotations

import re
from dataclasses import dataclass, asdict

USER_AGENT = "ChessHindsight/0.1 (personal game analysis tool)"

# Standard speed buckets, keyed off estimated game duration in seconds
# (base + 40 * increment), matching how Lichess classifies time controls.
_SPEED_THRESHOLDS = [
    (29, "bullet"),  # ultrabullet folded into bullet; the distinction rarely matters here
    (179, "bullet"),
    (479, "blitz"),
    (1499, "rapid"),
]


@dataclass
class NormalizedGame:
    source: str
    source_game_id: str
    url: str | None = None
    played_at: str | None = None          # ISO8601 UTC
    white_name: str | None = None
    black_name: str | None = None
    # Federation title (GM, IM, FM, …) when the source reports one. Kept on the
    # game rather than looked up per player, because a title is a fact about who
    # was playing at the time, and PGN carries it that way too.
    white_title: str | None = None
    black_title: str | None = None
    white_elo: int | None = None
    black_elo: int | None = None
    result: str | None = None             # 1-0 | 0-1 | 1/2-1/2 | *
    termination: str | None = None
    time_control_raw: str | None = None
    time_class: str | None = None
    base_seconds: int | None = None
    increment_seconds: int | None = None
    eco: str | None = None
    opening: str | None = None
    variant: str | None = None
    rated: int | None = None
    pgn: str | None = None

    @property
    def white_lower(self) -> str | None:
        return self.white_name.lower() if self.white_name else None

    @property
    def black_lower(self) -> str | None:
        return self.black_name.lower() if self.black_name else None

    def as_row(self) -> dict:
        row = asdict(self)
        row["white_lower"] = self.white_lower
        row["black_lower"] = self.black_lower
        return row


def parse_time_control(tc: str | None) -> tuple[int | None, int | None]:
    """Parse a PGN/Chess.com TimeControl string into (base_seconds, increment).

    Handles "300", "300+5", "1/86400" (correspondence, days per move) and "-".
    """
    if not tc or tc in {"-", "?"}:
        return None, None
    tc = tc.strip()
    # Correspondence: "1/259200" means one move per 259200 seconds.
    m = re.fullmatch(r"(\d+)/(\d+)", tc)
    if m:
        return int(m.group(2)), 0
    m = re.fullmatch(r"(\d+)(?:\+(\d+))?", tc)
    if m:
        return int(m.group(1)), int(m.group(2) or 0)
    return None, None


def classify_speed(base: int | None, increment: int | None) -> str | None:
    """Derive a speed bucket from a time control, for sources that don't state one."""
    if base is None:
        return None
    estimate = base + 40 * (increment or 0)
    if estimate >= 86400:
        return "correspondence"
    for threshold, name in _SPEED_THRESHOLDS:
        if estimate <= threshold:
            return name
    return "classical"


def normalize_speed(raw: str | None) -> str | None:
    """Map source-specific speed names onto our shared buckets."""
    if not raw:
        return None
    raw = raw.lower()
    return {
        "ultrabullet": "bullet",
        "daily": "correspondence",
        "correspondence": "correspondence",
        "bullet": "bullet",
        "blitz": "blitz",
        "rapid": "rapid",
        "classical": "classical",
    }.get(raw, raw)

"""Shared game-filter model.

Every analysis view — head-to-head, time-control splits, opening tree — runs
over the same filtered set of games, so the filter lives in one place and
compiles to a reusable SQL fragment.
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any

STANDARD_VARIANTS = ("chess", "standard", "fromPosition", "Standard")
TIME_CLASSES = ("bullet", "blitz", "rapid", "classical", "correspondence")

# One key per game mode, mapped to every spelling the sources actually write.
#
# The spellings are not tidy and cannot be made so at query time: Chess.com
# writes "chess" where Lichess writes "standard", and Lichess has changed its
# own casing over the years — a real database here holds both "threecheck" and
# "threeCheck". Grouping them is the only way a filter can mean a game mode
# rather than a spelling.
VARIANT_GROUPS: dict[str, tuple[str, ...]] = {
    "standard": STANDARD_VARIANTS,
    "chess960": ("chess960", "Chess960"),
    "antichess": ("antichess", "giveaway", "Giveaway"),
    "atomic": ("atomic", "Atomic"),
    "crazyhouse": ("crazyhouse", "Crazyhouse"),
    "horde": ("horde", "Horde"),
    "kingofthehill": ("kingOfTheHill", "kingofthehill", "King of the Hill"),
    "racingkings": ("racingKings", "racingkings", "Racing Kings"),
    "threecheck": ("threecheck", "threeCheck", "3check", "Three-check"),
}

VARIANT_LABELS: dict[str, str] = {
    "standard": "Standard",
    "chess960": "Chess960",
    "antichess": "Antichess",
    "atomic": "Atomic",
    "crazyhouse": "Crazyhouse",
    "horde": "Horde",
    "kingofthehill": "King of the Hill",
    "racingkings": "Racing Kings",
    "threecheck": "Three-check",
}

# Only standard games are position-indexed — replaying an atomic or Chess960
# move list on a standard board would produce nonsense — so the tree views have
# nothing to show for anything else. See ingest._STANDARD_VARIANTS.
INDEXED_VARIANTS = ("standard",)


def variant_group(raw: str | None) -> str:
    """Which game mode a stored `variant` string belongs to."""
    if raw is None or not raw.strip():
        return "standard"
    for key, spellings in VARIANT_GROUPS.items():
        if raw in spellings:
            return key
    return raw.strip().lower()


@dataclass
class GameFilter:
    """Selects a subset of games. All fields are optional and AND-ed together."""

    player: str | None = None          # games involving this player (either colour)
    color: str | None = None           # "white" | "black" — the *player's* colour
    opponent: str | None = None        # restrict to head-to-head vs this player
    sources: list[str] = field(default_factory=list)
    time_classes: list[str] = field(default_factory=list)
    rated: bool | None = None
    since: str | None = None           # ISO date, inclusive
    until: str | None = None           # ISO date, inclusive
    min_opponent_elo: int | None = None
    max_opponent_elo: int | None = None
    standard_only: bool = True
    # Which game mode to show. None keeps the standard-only default that every
    # view has always had; a key from VARIANT_GROUPS narrows to that mode; "any"
    # drops the restriction entirely. Set, it overrides `standard_only` — asking
    # for Atomic and being handed standard games would be absurd.
    variant: str | None = None
    exclude_unfinished: bool = True
    # Games the player was winning and lost anyway: they held at least this many
    # pawns of material and still went on to lose. Needs a player — it is a
    # question about someone in particular, not about the games.
    threw_from: int | None = None
    # Which library to read. None means the user's own games — the default for
    # every view, so the reference corpus of titled players can never inflate
    # their own record. "titled" reads the corpus instead; "any" reads both.
    collection: str | None = None

    def normalized(self) -> "GameFilter":
        """Lowercase the name fields so they match the indexed columns."""
        return GameFilter(
            player=self.player.lower().strip() if self.player else None,
            color=self.color if self.color in ("white", "black") else None,
            opponent=self.opponent.lower().strip() if self.opponent else None,
            sources=[s for s in self.sources if s],
            time_classes=[t for t in self.time_classes if t],
            rated=self.rated,
            since=self.since or None,
            until=self.until or None,
            min_opponent_elo=self.min_opponent_elo,
            max_opponent_elo=self.max_opponent_elo,
            standard_only=self.standard_only,
            variant=(self.variant or None) and self.variant.strip().lower() or None,
            exclude_unfinished=self.exclude_unfinished,
            collection=self.collection or None,
            threw_from=int(self.threw_from) if self.threw_from else None,
        )

    @classmethod
    def from_dict(cls, data: dict | None) -> "GameFilter":
        data = data or {}
        known = set(cls.__dataclass_fields__)
        clean = {k: v for k, v in data.items() if k in known and v not in (None, "")}
        for key in ("sources", "time_classes"):
            if key in clean and isinstance(clean[key], str):
                clean[key] = [clean[key]]
            if key in clean and not isinstance(clean[key], list):
                clean[key] = list(clean[key])
        return cls(**clean).normalized()

    def to_dict(self) -> dict:
        return asdict(self)

    # -- SQL compilation -------------------------------------------------

    def where(self, alias: str = "g") -> tuple[str, dict[str, Any]]:
        """Compile to a WHERE-clause body plus named parameters."""
        f = self.normalized()
        a = alias
        clauses: list[str] = []
        params: dict[str, Any] = {}

        if f.player:
            params["player"] = f.player
            if f.color == "white":
                clauses.append(f"{a}.white_lower = :player")
            elif f.color == "black":
                clauses.append(f"{a}.black_lower = :player")
            else:
                clauses.append(f"({a}.white_lower = :player OR {a}.black_lower = :player)")

        if f.opponent:
            params["opponent"] = f.opponent
            if not f.player:
                clauses.append(
                    f"({a}.white_lower = :opponent OR {a}.black_lower = :opponent)"
                )
            elif f.color == "white":
                clauses.append(f"{a}.black_lower = :opponent")
            elif f.color == "black":
                clauses.append(f"{a}.white_lower = :opponent")
            else:
                # Either seating, but the two must be on opposite sides.
                clauses.append(
                    f"(({a}.white_lower = :player AND {a}.black_lower = :opponent)"
                    f" OR ({a}.black_lower = :player AND {a}.white_lower = :opponent))"
                )

        if f.sources:
            keys = [f":src{i}" for i in range(len(f.sources))]
            params.update({f"src{i}": s for i, s in enumerate(f.sources)})
            clauses.append(f"{a}.source IN ({', '.join(keys)})")

        if f.time_classes:
            keys = [f":tc{i}" for i in range(len(f.time_classes))]
            params.update({f"tc{i}": t for i, t in enumerate(f.time_classes)})
            clauses.append(f"{a}.time_class IN ({', '.join(keys)})")

        if f.rated is not None:
            params["rated"] = 1 if f.rated else 0
            clauses.append(f"{a}.rated = :rated")

        if f.since:
            params["since"] = f.since
            clauses.append(f"{a}.played_at >= :since")

        if f.until:
            # Inclusive of the whole day when a bare date is given.
            params["until"] = f.until if len(f.until) > 10 else f.until + "T23:59:59Z"
            clauses.append(f"{a}.played_at <= :until")

        # Opponent-rating bounds only make sense relative to a known player.
        if f.player and (f.min_opponent_elo or f.max_opponent_elo):
            opp_elo = (
                f"CASE WHEN {a}.white_lower = :player THEN {a}.black_elo "
                f"ELSE {a}.white_elo END"
            )
            if f.min_opponent_elo:
                params["min_opp_elo"] = f.min_opponent_elo
                clauses.append(f"{opp_elo} >= :min_opp_elo")
            if f.max_opponent_elo:
                params["max_opp_elo"] = f.max_opponent_elo
                clauses.append(f"{opp_elo} <= :max_opp_elo")

        # "I was winning and lost anyway." Whichever colour the player had, they
        # must have held the advantage and the result must have gone the other
        # way. Silently ignored without a player: there is no "I" to measure.
        if f.threw_from and f.player:
            params["threw_from"] = f.threw_from
            clauses.append(
                f"(({a}.white_lower = :player AND {a}.peak_white_adv >= :threw_from"
                f"   AND {a}.result = '0-1')"
                f" OR ({a}.black_lower = :player AND {a}.peak_black_adv >= :threw_from"
                f"   AND {a}.result = '1-0'))"
            )

        # An explicit variant wins over the standard-only default; "any" drops
        # the restriction rather than naming every mode, so a game recorded
        # under a spelling nothing here knows about is still reachable.
        if f.variant == "any":
            pass
        elif f.variant or f.standard_only:
            group = VARIANT_GROUPS.get(f.variant or "standard")
            spellings = group if group is not None else (f.variant,)
            keys = [f":var{i}" for i in range(len(spellings))]
            params.update({f"var{i}": v for i, v in enumerate(spellings)})
            # NULL counts as standard: a source that omits the tag is playing
            # ordinary chess. It must not count as Atomic.
            null_ok = "" if f.variant and f.variant != "standard" else f"{a}.variant IS NULL OR "
            clauses.append(f"({null_ok}{a}.variant IN ({', '.join(keys)}))")

        if f.exclude_unfinished:
            clauses.append(f"{a}.result IN ('1-0', '0-1', '1/2-1/2')")

        # Never implicit: a query that does not say which library it wants gets
        # the user's own games, because that is what every existing view means.
        if f.collection == "any":
            pass
        elif f.collection:
            params["collection"] = f.collection
            clauses.append(f"{a}.collection = :collection")
        else:
            clauses.append(f"{a}.collection IS NULL")

        return (" AND ".join(clauses) if clauses else "1=1"), params


def player_wld_exprs(alias: str = "g") -> tuple[str, str, str]:
    """SQL count expressions for the filtered player's wins / losses / draws."""
    win = f"""SUM(CASE WHEN ({alias}.white_lower = :player AND {alias}.result = '1-0')
                      OR ({alias}.black_lower = :player AND {alias}.result = '0-1')
                 THEN 1 ELSE 0 END)"""
    loss = f"""SUM(CASE WHEN ({alias}.white_lower = :player AND {alias}.result = '0-1')
                       OR ({alias}.black_lower = :player AND {alias}.result = '1-0')
                  THEN 1 ELSE 0 END)"""
    draw = f"SUM(CASE WHEN {alias}.result = '1/2-1/2' THEN 1 ELSE 0 END)"
    return win, loss, draw

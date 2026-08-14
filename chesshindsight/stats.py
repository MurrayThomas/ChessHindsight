"""Aggregate statistics: win rates, time-control splits, head-to-head records."""

from __future__ import annotations

import sqlite3

from .query import (
    GameFilter,
    INDEXED_VARIANTS,
    VARIANT_LABELS,
    player_wld_exprs,
    TIME_CLASSES,
    variant_group,
)


def _win_pct(wins: int, losses: int, draws: int) -> float | None:
    """Share of games won outright. Draws count against it.

    The tournament "score" (a draw as half a point) is deliberately not
    reported: two similar percentages side by side invited confusion, and the
    win/draw/loss counts are shown in full anyway.
    """
    total = wins + losses + draws
    if not total:
        return None
    return round(100.0 * wins / total, 1)


def _row_to_record(
    row: sqlite3.Row, label_key: str | None = None, has_player: bool = True
) -> dict:
    """One aggregate row. `has_player` is whether a player is in focus.

    Without one there is no "you" to have won, so the win/loss expressions match
    nothing and every count comes back zero. Reporting that as 0.0% states a
    fact that was never measured — and 0% renders red, so an unfiltered
    dashboard reads as a catastrophic record. None is the honest answer, and the
    frontend already draws it as an em dash. tree.py has always done this; this
    is the same rule.
    """
    wins, losses, draws = row["wins"] or 0, row["losses"] or 0, row["draws"] or 0
    record = {
        "games": row["games"] or 0,
        "wins": wins,
        "losses": losses,
        "draws": draws,
        "win_pct": _win_pct(wins, losses, draws) if has_player else None,
    }
    if label_key is not None:
        record[label_key] = row[label_key]
    return record


def overview(conn: sqlite3.Connection, flt: GameFilter) -> dict:
    """Totals for the filtered set, plus a split by the player's colour."""
    flt = flt.normalized()
    where, params = flt.where("g")
    params.setdefault("player", flt.player)
    win, loss, draw = player_wld_exprs("g")

    row = conn.execute(
        f"""SELECT COUNT(*) games, {win} wins, {loss} losses, {draw} draws,
                   MIN(g.played_at) first_game, MAX(g.played_at) last_game
            FROM games g WHERE {where}""",
        params,
    ).fetchone()

    result = _row_to_record(row, has_player=bool(flt.player))
    result["first_game"] = row["first_game"]
    result["last_game"] = row["last_game"]

    # No colour split when the filter already fixes one: the other side would be
    # a row of zeros, which reads as a record rather than as "not asked for".
    if flt.player and not flt.color:
        colors = {}
        for color in ("white", "black"):
            sub = GameFilter(**{**flt.to_dict(), "color": color})
            sub_where, sub_params = sub.where("g")
            sub_params.setdefault("player", sub.player)
            crow = conn.execute(
                f"""SELECT COUNT(*) games, {win} wins, {loss} losses, {draw} draws
                    FROM games g WHERE {sub_where}""",
                sub_params,
            ).fetchone()
            colors[color] = _row_to_record(crow)
        result["by_color"] = colors

    return result


def by_time_control(conn: sqlite3.Connection, flt: GameFilter) -> list[dict]:
    """Games, record and win rate broken out per time class."""
    flt = flt.normalized()
    where, params = flt.where("g")
    params.setdefault("player", flt.player)
    win, loss, draw = player_wld_exprs("g")

    rows = conn.execute(
        f"""SELECT COALESCE(g.time_class, 'unknown') time_class,
                   COUNT(*) games, {win} wins, {loss} losses, {draw} draws
            FROM games g WHERE {where}
            GROUP BY COALESCE(g.time_class, 'unknown')""",
        params,
    ).fetchall()

    records = [_row_to_record(r, "time_class", bool(flt.player)) for r in rows]
    order = {tc: i for i, tc in enumerate(TIME_CLASSES)}
    records.sort(key=lambda r: (order.get(r["time_class"], 99), -r["games"]))
    return records


def by_time_control_detail(conn: sqlite3.Connection, flt: GameFilter) -> list[dict]:
    """Like by_time_control but split further by the exact clock (e.g. 3+0 vs 3+2)."""
    flt = flt.normalized()
    where, params = flt.where("g")
    params.setdefault("player", flt.player)
    win, loss, draw = player_wld_exprs("g")

    rows = conn.execute(
        f"""SELECT COALESCE(g.time_class, 'unknown') time_class,
                   g.base_seconds, g.increment_seconds,
                   COUNT(*) games, {win} wins, {loss} losses, {draw} draws
            FROM games g WHERE {where}
            GROUP BY g.time_class, g.base_seconds, g.increment_seconds
            HAVING COUNT(*) > 0
            ORDER BY games DESC""",
        params,
    ).fetchall()

    out = []
    for r in rows:
        rec = _row_to_record(r, "time_class", bool(flt.player))
        base, inc = r["base_seconds"], r["increment_seconds"]
        if base is None:
            rec["clock"] = "unknown"
        elif base >= 86400:
            rec["clock"] = f"{base // 86400}d/move"
        else:
            minutes = base / 60
            label = f"{int(minutes)}" if minutes == int(minutes) else f"{minutes:g}"
            rec["clock"] = f"{label}+{inc or 0}"
        rec["base_seconds"] = base
        rec["increment_seconds"] = inc
        out.append(rec)
    return out


def head_to_head(
    conn: sqlite3.Connection, player: str, opponent: str, base: GameFilter | None = None
) -> dict:
    """Full head-to-head record between two players, split by time control.

    A colour in the filter is honoured and narrows to the games the player had
    that side. It narrows the *games*, not the moves: in a set of games where
    the player had Black, White's moves are the opponent's, and those are
    exactly what the position tree and its arrow are for.
    """
    base = base or GameFilter()
    flt = GameFilter(
        **{**base.to_dict(), "player": player, "opponent": opponent}
    ).normalized()

    result = {
        "player": player,
        "opponent": opponent,
        # Echoed back so the view can say which side it is reporting on rather
        # than leaving a halved record looking like the whole story.
        "color": flt.color,
        "total": overview(conn, flt),
        "by_time_control": by_time_control(conn, flt),
        "by_clock": by_time_control_detail(conn, flt),
        # Split by colour: against one particular person, which side opened the
        # game is what makes an opening actionable. See by_opening.
        "by_opening": by_opening(conn, flt, limit=40, split_color=True),
        "games": recent_games(conn, flt, limit=200),
    }
    return result


def opponents(
    conn: sqlite3.Connection, flt: GameFilter, limit: int = 50
) -> list[dict]:
    """Most-played opponents for the filtered player, with the record against each."""
    flt = flt.normalized()
    if not flt.player:
        return []
    where, params = flt.where("g")
    params.setdefault("player", flt.player)
    params["limit"] = limit
    win, loss, draw = player_wld_exprs("g")

    opp_name = """CASE WHEN g.white_lower = :player THEN g.black_name
                       ELSE g.white_name END"""
    opp_lower = """CASE WHEN g.white_lower = :player THEN g.black_lower
                        ELSE g.white_lower END"""

    rows = conn.execute(
        f"""SELECT {opp_lower} opponent_lower,
                   MAX({opp_name}) opponent,
                   COUNT(*) games, {win} wins, {loss} losses, {draw} draws,
                   MAX(g.played_at) last_played
            FROM games g WHERE {where} AND {opp_lower} IS NOT NULL
            GROUP BY {opp_lower}
            ORDER BY games DESC
            LIMIT :limit""",
        params,
    ).fetchall()

    out = []
    for r in rows:
        rec = _row_to_record(r)
        rec["opponent"] = r["opponent"] or r["opponent_lower"]
        rec["opponent_lower"] = r["opponent_lower"]
        rec["last_played"] = r["last_played"]
        out.append(rec)
    return out


def by_opening(
    conn: sqlite3.Connection,
    flt: GameFilter,
    limit: int = 40,
    split_color: bool = False,
) -> list[dict]:
    """Performance grouped by opening name.

    Grouped by name because the name is what a player thinks in. The ECO code
    the sources also supply is not reported: it is a library filing system that
    does not line up with the names one-to-one — "Modern Defense" appears under
    both A40 and B06, while B20 covers several different Sicilians — so it could
    only ever sit beside the name without explaining anything about it.

    `split_color` groups by the player's colour as well, giving one row per
    opening per side. Across a whole database that is noise, but between two
    named players it is the whole point: "the Sicilian, 6 games, 2-3-1" hides
    that four of them were the opponent's Sicilian and two were the player's.
    Those are different openings to prepare for. It needs a player in focus to
    have a colour to report, so without one it is ignored rather than guessed at.
    """
    flt = flt.normalized()
    where, params = flt.where("g")
    params.setdefault("player", flt.player)
    params["limit"] = limit
    win, loss, draw = player_wld_exprs("g")

    split = split_color and bool(flt.player)
    color_expr = "CASE WHEN g.white_lower = :player THEN 'white' ELSE 'black' END"
    select_color = f"{color_expr} color," if split else ""
    group_color = f", {color_expr}" if split else ""

    rows = conn.execute(
        f"""SELECT COALESCE(g.opening, 'Unknown opening') opening,
                   {select_color}
                   COUNT(*) games, {win} wins, {loss} losses, {draw} draws,
                   MAX(g.played_at) last_played
            FROM games g WHERE {where}
            GROUP BY COALESCE(g.opening, 'Unknown opening'){group_color}
            ORDER BY games DESC
            LIMIT :limit""",
        params,
    ).fetchall()

    out = []
    for r in rows:
        rec = _row_to_record(r, "opening", bool(flt.player))
        rec["last_played"] = r["last_played"]
        if split:
            rec["color"] = r["color"]
        out.append(rec)
    return out


def recent_games(
    conn: sqlite3.Connection, flt: GameFilter, limit: int = 100, offset: int = 0
) -> list[dict]:
    """Individual games matching the filter, newest first."""
    flt = flt.normalized()
    where, params = flt.where("g")
    params.setdefault("player", flt.player)
    params["limit"] = limit
    params["offset"] = offset

    rows = conn.execute(
        f"""SELECT g.id, g.source, g.url, g.played_at, g.white_name, g.black_name,
                   g.white_lower, g.black_lower, g.white_elo, g.black_elo,
                   g.result, g.termination, g.time_class, g.time_control_raw,
                   g.base_seconds, g.increment_seconds, g.opening,
                   g.rated, g.ply_count,
                   g.peak_white_adv, g.peak_white_ply,
                   g.peak_black_adv, g.peak_black_ply
            FROM games g WHERE {where}
            ORDER BY g.played_at DESC, g.id DESC
            LIMIT :limit OFFSET :offset""",
        params,
    ).fetchall()

    out = []
    for r in rows:
        game = dict(r)
        if flt.player:
            if r["white_lower"] == flt.player:
                game["player_color"] = "white"
                game["opponent"] = r["black_name"]
                game["opponent_elo"] = r["black_elo"]
                game["player_elo"] = r["white_elo"]
            elif r["black_lower"] == flt.player:
                game["player_color"] = "black"
                game["opponent"] = r["white_name"]
                game["opponent_elo"] = r["white_elo"]
                game["player_elo"] = r["black_elo"]
            game["outcome"] = _outcome(r["result"], game.get("player_color"))
        out.append(game)
    return out


def _outcome(result: str | None, color: str | None) -> str | None:
    if not color or not result:
        return None
    if result == "1/2-1/2":
        return "draw"
    if (result == "1-0") == (color == "white"):
        return "win"
    return "loss"


def variants_present(conn: sqlite3.Connection) -> list[dict]:
    """Game modes the user actually has games in, most played first.

    Built from the database rather than from a fixed list so the dropdown stays
    short: there is no reason to offer Horde to somebody who has never played
    it, and no reason to hide it from somebody who has. Spellings are folded
    into one row per mode — Chess.com's "chess" and Lichess's "standard" are the
    same game, and so are "threecheck" and "threeCheck".
    """
    rows = conn.execute(
        "SELECT variant, COUNT(*) n FROM games WHERE collection IS NULL "
        "GROUP BY variant"
    ).fetchall()

    tally: dict[str, int] = {}
    for row in rows:
        tally[variant_group(row["variant"])] = (
            tally.get(variant_group(row["variant"]), 0) + row["n"]
        )

    out = [
        {
            "key": key,
            "label": VARIANT_LABELS.get(key, key),
            "games": n,
            # The tree views read the position index, which only standard games
            # are in, so the frontend has to know which choices go blank there.
            "indexed": key in INDEXED_VARIANTS,
        }
        for key, n in tally.items()
    ]
    # Standard first because it is the default, then by how much they are played.
    out.sort(key=lambda v: (v["key"] != "standard", -v["games"]))
    return out


def known_players(conn: sqlite3.Connection, limit: int = 30) -> list[dict]:
    """Players with the most games in the database — the useful starting points.

    The reference library is excluded. It holds thousands of games by one strong
    player, which would otherwise crowd out every name the user actually plays.
    """
    rows = conn.execute(
        """SELECT name, SUM(n) games FROM (
               SELECT white_lower name, COUNT(*) n FROM games
               WHERE white_lower IS NOT NULL AND collection IS NULL
               GROUP BY white_lower
               UNION ALL
               SELECT black_lower name, COUNT(*) n FROM games
               WHERE black_lower IS NOT NULL AND collection IS NULL
               GROUP BY black_lower
           ) GROUP BY name ORDER BY games DESC LIMIT ?""",
        (limit,),
    ).fetchall()
    return [{"player": r["name"], "games": r["games"]} for r in rows]


def database_summary(conn: sqlite3.Connection) -> dict:
    """Top-level counts for the dashboard.

    Counts the user's own games only. The reference library is reported
    separately, by library.summary(), because mixing the two would make
    "games in database" jump by ten thousand the first time a titled player is
    added and mean nothing about the user's own play.
    """
    row = conn.execute(
        """SELECT COUNT(*) games, MIN(played_at) first_game, MAX(played_at) last_game
           FROM games WHERE collection IS NULL"""
    ).fetchone()
    by_source = conn.execute(
        "SELECT source, COUNT(*) n FROM games WHERE collection IS NULL "
        "GROUP BY source ORDER BY n DESC"
    ).fetchall()
    # Positions are shared: one row per distinct position, whichever library
    # reached it. Splitting them would mean storing the same FEN twice.
    positions = conn.execute("SELECT COUNT(*) c FROM positions").fetchone()["c"]
    return {
        "games": row["games"],
        "first_game": row["first_game"],
        "last_game": row["last_game"],
        "by_source": [{"source": r["source"], "games": r["n"]} for r in by_source],
        "distinct_positions": positions,
    }

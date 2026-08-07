"""Starred games, under names the user chose.

A game is worth keeping for reasons the PGN does not record — a tactic that
worked, a loss to learn from, the one game against a friend that settled an
argument. Everything about the game itself already lives in `games`, so this
stores only what the database cannot derive: the fact that it was starred, and
what to call it.
"""

from __future__ import annotations

import sqlite3

from .stats import _outcome

# Everything the favourites list shows about a game. Joined from `games` rather
# than copied at star time, so a resync that corrects a rating or a result
# corrects it here too.
GAME_COLUMNS = """g.id, g.source, g.url, g.played_at, g.collection,
                  g.white_name, g.black_name, g.white_lower, g.black_lower,
                  g.white_title, g.black_title, g.white_elo, g.black_elo,
                  g.result, g.termination, g.time_class, g.time_control_raw,
                  g.base_seconds, g.increment_seconds, g.opening, g.ply_count"""


def _game_row(conn: sqlite3.Connection, game_id: int) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM games WHERE id = ?", (game_id,)).fetchone()
    if not row:
        raise ValueError(f"no game with id {game_id}")
    return row


def suggested_name(row: sqlite3.Row | dict) -> str:
    """What to call a game the user starred without typing anything.

    Never left blank: an unnamed row in the list would be indistinguishable
    from every other unnamed row, which defeats the point of the view.
    """
    white = row["white_name"] or "?"
    black = row["black_name"] or "?"
    label = f"{white} vs {black}"
    date = _short_date(row["played_at"])
    return f"{label}, {date}" if date else label


def _short_date(stamp: str | None) -> str:
    """An ISO timestamp as dd/mm/yy, the way the app writes dates everywhere."""
    iso = (stamp or "")[:10]
    parts = iso.split("-")
    if len(parts) != 3 or len(parts[0]) != 4:
        return iso
    return f"{parts[2]}/{parts[1]}/{parts[0][2:]}"


def add(conn: sqlite3.Connection, game_id: int, name: str | None = None) -> dict:
    """Star a game. Starring one that is already starred renames it."""
    row = _game_row(conn, game_id)
    label = (name or "").strip() or suggested_name(row)
    conn.execute(
        """INSERT INTO favourites (game_id, name, added_at)
           VALUES (?, ?, datetime('now'))
           ON CONFLICT (game_id) DO UPDATE SET name = excluded.name""",
        (game_id, label[:200]),
    )
    conn.commit()
    return get(conn, game_id)


def rename(conn: sqlite3.Connection, game_id: int, name: str) -> dict:
    label = (name or "").strip()
    if not label:
        raise ValueError("a favourite needs a name")
    return add(conn, game_id, label)


def remove(conn: sqlite3.Connection, game_id: int) -> bool:
    cur = conn.execute("DELETE FROM favourites WHERE game_id = ?", (game_id,))
    conn.commit()
    return cur.rowcount > 0


def get(conn: sqlite3.Connection, game_id: int) -> dict:
    rows = list_all(conn, game_id=game_id)
    if not rows:
        raise ValueError(f"game {game_id} is not a favourite")
    return rows[0]


def ids(conn: sqlite3.Connection) -> list[int]:
    """Every starred game id, so a table can draw its stars in one round-trip."""
    return [r["game_id"] for r in conn.execute("SELECT game_id FROM favourites")]


def list_all(
    conn: sqlite3.Connection,
    search: str | None = None,
    player: str | None = None,
    limit: int = 300,
    game_id: int | None = None,
) -> list[dict]:
    """The saved games, newest star first.

    `player` decides whose win or loss each game was — the list is not filtered
    by the filter bar (a favourite is a favourite whatever is filtered), so the
    caller says who to measure against.
    """
    where = ["1=1"]
    params: dict = {"limit": limit}

    if game_id is not None:
        where.append("f.game_id = :game_id")
        params["game_id"] = game_id

    if search and search.strip():
        params["q"] = f"%{search.strip().lower()}%"
        # The name first, but a game is also findable by who played it or what
        # was played — which is how you look for one you named badly.
        where.append(
            """(lower(f.name) LIKE :q
                OR lower(COALESCE(g.white_name, '')) LIKE :q
                OR lower(COALESCE(g.black_name, '')) LIKE :q
                OR lower(COALESCE(g.opening, '')) LIKE :q)"""
        )

    rows = conn.execute(
        f"""SELECT f.game_id, f.name, f.added_at, {GAME_COLUMNS}
            FROM favourites f
            JOIN games g ON g.id = f.game_id
            WHERE {" AND ".join(where)}
            ORDER BY f.added_at DESC, f.game_id DESC
            LIMIT :limit""",
        params,
    ).fetchall()

    who = player.lower().strip() if player else None
    out = []
    for r in rows:
        game = dict(r)
        if who:
            if r["white_lower"] == who:
                game["player_color"] = "white"
                game["opponent"] = r["black_name"]
            elif r["black_lower"] == who:
                game["player_color"] = "black"
                game["opponent"] = r["white_name"]
            game["outcome"] = _outcome(r["result"], game.get("player_color"))
        out.append(game)
    return out


def summary(conn: sqlite3.Connection) -> dict:
    row = conn.execute(
        "SELECT COUNT(*) n, MAX(added_at) last_added FROM favourites"
    ).fetchone()
    return {"count": row["n"] or 0, "last_added": row["last_added"]}

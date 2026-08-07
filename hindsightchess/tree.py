"""Position-frequency tree over a filtered set of games.

Answers two shapes of question:
  - "from this position, what do I play, and how does each move score?"  -> tree()
  - "which positions do I end up in most often?"                          -> common_positions()
"""

from __future__ import annotations

import sqlite3

import chess
import chess.polyglot

from . import openings
from .query import GameFilter, player_wld_exprs

START_KEY = f"{chess.polyglot.zobrist_hash(chess.Board()):016x}"


class IllegalLine(ValueError):
    pass


def pos_key(board: chess.Board) -> str:
    return f"{chess.polyglot.zobrist_hash(board):016x}"


def board_from_moves(moves: list[str] | None) -> chess.Board:
    """Replay a list of moves (SAN or UCI) from the start position."""
    board = chess.Board()
    for token in moves or []:
        token = token.strip()
        if not token:
            continue
        move = None
        try:
            move = board.parse_san(token)
        except ValueError:
            try:
                move = board.parse_uci(token)
            except ValueError as exc:
                raise IllegalLine(f"illegal move {token!r} in line") from exc
        board.push(move)
    return board


def _win_pct(wins: int, losses: int, draws: int) -> float | None:
    """Share of games won outright — see stats._win_pct on why not "score"."""
    total = wins + losses + draws
    if not total:
        return None
    return round(100.0 * wins / total, 1)


def legal_map(board: chess.Board) -> dict[str, list[dict]]:
    """Legal moves grouped by origin square, for a click-to-move board.

    Promotions are listed individually (one entry per promotion piece) rather
    than collapsed to a queen, so the frontend can offer the real choice.
    """
    out: dict[str, list[dict]] = {}
    for move in board.legal_moves:
        origin = chess.square_name(move.from_square)
        entry = {
            "to": chess.square_name(move.to_square),
            "uci": move.uci(),
            "san": board.san(move),
        }
        if move.promotion:
            entry["promotion"] = chess.piece_symbol(move.promotion)
        out.setdefault(origin, []).append(entry)
    return out


def _board_state(board: chess.Board, last_move: chess.Move | None) -> dict:
    """Everything the frontend needs to draw and interact with a position."""
    check_square = None
    if board.is_check():
        king = board.king(board.turn)
        if king is not None:
            check_square = chess.square_name(king)

    outcome = board.outcome()
    return {
        "fen": board.fen(),
        "pos_key": pos_key(board),
        "ply": board.ply(),
        "move_number": board.fullmove_number,
        "turn": "white" if board.turn == chess.WHITE else "black",
        "legal": legal_map(board),
        "legal_move_count": board.legal_moves.count(),
        "is_check": board.is_check(),
        "check_square": check_square,
        "is_game_over": board.is_game_over(),
        "game_over_reason": outcome.termination.name.lower() if outcome else None,
        "last_move": (
            {
                "uci": last_move.uci(),
                "from": chess.square_name(last_move.from_square),
                "to": chess.square_name(last_move.to_square),
            }
            if last_move
            else None
        ),
    }


def explore(
    conn: sqlite3.Connection,
    flt: GameFilter,
    fen: str | None = None,
    moves: list[str] | None = None,
    limit: int = 40,
) -> dict:
    """Board state plus database continuations for an arbitrary position.

    `fen` is the root — the standard start when omitted — and `moves` are played
    on top of it. Driving the board from a root FEN rather than always from the
    initial position is what lets a position opened from the Positions view be
    played on: there is no move list to reconstruct from a Zobrist hash.
    """
    board = chess.Board(fen) if fen else chess.Board()
    root = board.copy(stack=False)
    played: list[chess.Move] = []
    last_move: chess.Move | None = None
    for token in moves or []:
        token = (token or "").strip()
        if not token:
            continue
        try:
            move = board.parse_uci(token)
        except ValueError:
            try:
                move = board.parse_san(token)
            except ValueError as exc:
                raise IllegalLine(f"illegal move {token!r} in line") from exc
        board.push(move)
        played.append(move)
        last_move = move

    data = _tree_for_board(conn, flt, board, limit)
    data.update(_board_state(board, last_move))
    data["moves"] = [m for m in (moves or []) if (m or "").strip()]
    # What this line is called. Computed from the line rather than the position
    # alone so the name survives going off book, which in an explorer is most
    # of the time.
    data["opening"] = openings.name_for_line(root, played)
    data["san_line"] = _san_line_from(chess.Board(fen) if fen else chess.Board(), moves)
    data["from_start"] = not fen or chess.Board(fen) == chess.Board()
    return data


def tree(
    conn: sqlite3.Connection,
    flt: GameFilter,
    moves: list[str] | None = None,
    limit: int = 40,
) -> dict:
    """Continuations played from the position reached by `moves` from the start."""
    board = board_from_moves(moves)
    data = _tree_for_board(conn, flt.normalized(), board, limit)
    data.update(
        {
            "fen": board.fen(),
            "pos_key": pos_key(board),
            "ply": board.ply(),
            "turn": "white" if board.turn == chess.WHITE else "black",
            "moves": [m for m in (moves or []) if m.strip()],
            "san_line": _san_line(moves),
            "legal_move_count": board.legal_moves.count(),
            "is_game_over": board.is_game_over(),
        }
    )
    return data


def _tree_for_board(
    conn: sqlite3.Connection,
    flt: GameFilter,
    board: chess.Board,
    limit: int = 40,
) -> dict:
    """The database half of a tree query: what was played from this position."""
    flt = flt.normalized()
    key = pos_key(board)

    where, params = flt.where("g")
    params.setdefault("player", flt.player)
    params["pos_key"] = key
    params["limit"] = limit
    win, loss, draw = player_wld_exprs("g")

    # How many of these games the move was the *player's* own, rather than one
    # played against them.
    #
    # Whose move it is follows from the position, not from the game, so one
    # comparison covers every row: if White is to move here, the mover was the
    # player exactly in those games where the player was White. Without this the
    # panel could only say what was played from here, and calling that "what you
    # played" is wrong the moment the filter admits both colours — at 1.d4 g6
    # with Colour set to Both, half those moves are the opponent's.
    if flt.player:
        side = "g.white_lower" if board.turn == chess.WHITE else "g.black_lower"
        by_player = f"SUM(CASE WHEN {side} = :player THEN 1 ELSE 0 END)"
    else:
        by_player = "NULL"

    rows = conn.execute(
        f"""SELECT gp.move_san, gp.move_uci,
                   COUNT(*) games,
                   {by_player} by_player,
                   SUM(CASE WHEN g.result = '1-0'     THEN 1 ELSE 0 END) white_wins,
                   SUM(CASE WHEN g.result = '1/2-1/2' THEN 1 ELSE 0 END) draws_total,
                   SUM(CASE WHEN g.result = '0-1'     THEN 1 ELSE 0 END) black_wins,
                   {win} wins, {loss} losses, {draw} draws,
                   AVG(CASE WHEN g.white_lower = :player THEN g.white_elo
                            WHEN g.black_lower = :player THEN g.black_elo END) avg_player_elo,
                   AVG(CASE WHEN g.white_lower = :player THEN g.black_elo
                            WHEN g.black_lower = :player THEN g.white_elo END) avg_opponent_elo,
                   MAX(g.played_at) last_played
            FROM game_positions gp
            JOIN games g ON g.id = gp.game_id
            WHERE gp.pos_key = :pos_key AND gp.move_san IS NOT NULL AND {where}
            GROUP BY gp.move_san, gp.move_uci
            ORDER BY games DESC
            LIMIT :limit""",
        params,
    ).fetchall()

    ended = conn.execute(
        f"""SELECT COUNT(*) c FROM game_positions gp
            JOIN games g ON g.id = gp.game_id
            WHERE gp.pos_key = :pos_key AND gp.move_san IS NULL AND {where}""",
        params,
    ).fetchone()["c"]

    children = []
    for r in rows:
        wins, losses, draws = r["wins"] or 0, r["losses"] or 0, r["draws"] or 0
        child_board = board.copy()
        try:
            child_board.push_uci(r["move_uci"])
            child_fen = child_board.fen()
        except ValueError:
            child_fen = None
        children.append(
            {
                "san": r["move_san"],
                "uci": r["move_uci"],
                "games": r["games"],
                # None when no player is in focus — then nobody's move is "mine".
                "by_player": r["by_player"],
                "white_wins": r["white_wins"],
                "draws_total": r["draws_total"],
                "black_wins": r["black_wins"],
                "wins": wins,
                "losses": losses,
                "draws": draws,
                "win_pct": _win_pct(wins, losses, draws) if flt.player else None,
                "white_win_pct": _win_pct(
                    r["white_wins"], r["black_wins"], r["draws_total"]
                ),
                "avg_player_elo": round(r["avg_player_elo"])
                if r["avg_player_elo"]
                else None,
                "avg_opponent_elo": round(r["avg_opponent_elo"])
                if r["avg_opponent_elo"]
                else None,
                "last_played": r["last_played"],
                "fen": child_fen,
            }
        )

    total = sum(c["games"] for c in children) + ended
    for c in children:
        c["share_pct"] = round(100.0 * c["games"] / total, 1) if total else None

    return {
        "pos_key": key,
        "total_games": total,
        "ended_here": ended,
        "children": children,
    }


def reference_explore(
    conn: sqlite3.Connection,
    fen: str | None = None,
    moves: list[str] | None = None,
    player: str | None = None,
    limit: int = 40,
    players_limit: int = 30,
    games_limit: int = 25,
) -> dict:
    """What titled players played from a position, and which of them got there.

    The reference library lives in the same tables as the user's own games, so
    this is the same position lookup — only the collection differs, and the
    numbers are reported from White's point of view rather than a filtered
    player's, because there is no "you" in someone else's games.

    `player` narrows everything to one person, which is the question worth
    asking: not "what do strong players do here" but "what does Carlsen do
    here".
    """
    board = chess.Board(fen) if fen else chess.Board()
    last_move: chess.Move | None = None
    for token in moves or []:
        token = (token or "").strip()
        if not token:
            continue
        try:
            move = board.parse_uci(token)
        except ValueError:
            try:
                move = board.parse_san(token)
            except ValueError as exc:
                raise IllegalLine(f"illegal move {token!r} in line") from exc
        board.push(move)
        last_move = move

    key = pos_key(board)
    who = (player or "").strip().lower() or None
    params: dict = {"pos_key": key, "limit": limit, "collection": "titled"}

    where = ["gp.pos_key = :pos_key", "g.collection = :collection",
             "g.result IN ('1-0', '0-1', '1/2-1/2')"]
    if who:
        params["who"] = who
        where.append("(g.white_lower = :who OR g.black_lower = :who)")
    clause = " AND ".join(where)

    # How many of these were the focused player's own move rather than one
    # played at them. Narrowing to their games is not enough: a player's games
    # include both colours, so at a position where Black is to move, the games
    # they had White contribute their opponents' replies. Without this split,
    # "what Nihal plays after 1.e4" counts 5,960 games when only 3,936 of the
    # moves were his.
    if who:
        side = "g.white_lower" if board.turn == chess.WHITE else "g.black_lower"
        by_player = f"SUM(CASE WHEN {side} = :who THEN 1 ELSE 0 END)"
    else:
        by_player = "NULL"

    rows = conn.execute(
        f"""SELECT gp.move_san, gp.move_uci,
                   COUNT(*) games,
                   {by_player} by_player,
                   SUM(CASE WHEN g.result = '1-0'     THEN 1 ELSE 0 END) white_wins,
                   SUM(CASE WHEN g.result = '1/2-1/2' THEN 1 ELSE 0 END) draws_total,
                   SUM(CASE WHEN g.result = '0-1'     THEN 1 ELSE 0 END) black_wins,
                   AVG((COALESCE(g.white_elo, 0) + COALESCE(g.black_elo, 0)) / 2.0) avg_elo,
                   MAX(g.played_at) last_played
            FROM game_positions gp
            JOIN games g ON g.id = gp.game_id
            WHERE {clause} AND gp.move_san IS NOT NULL
            GROUP BY gp.move_san, gp.move_uci
            -- With somebody in focus the question is what *they* play, so rank
            -- by their own moves. Ranking by the total ranks their opponents'
            -- choices alongside theirs, and that changes the answer: at the
            -- start position Nihal's opponents open 1.e4 at him far more often
            -- than he plays it, so the total puts e4 top when his own most
            -- played first move is d4, by two thousand games.
            ORDER BY {'by_player DESC, ' if who else ''}games DESC
            LIMIT :limit""",
        params,
    ).fetchall()

    ended = conn.execute(
        f"""SELECT COUNT(*) c FROM game_positions gp
            JOIN games g ON g.id = gp.game_id
            WHERE {clause} AND gp.move_san IS NULL""",
        params,
    ).fetchone()["c"]

    children = []
    for r in rows:
        child = board.copy()
        try:
            child.push_uci(r["move_uci"])
            child_fen = child.fen()
        except ValueError:
            child_fen = None
        children.append(
            {
                "san": r["move_san"],
                "uci": r["move_uci"],
                "games": r["games"],
                # None with nobody in focus — then it is the library's move,
                # not anyone's in particular.
                "by_player": r["by_player"],
                "white_wins": r["white_wins"],
                "draws_total": r["draws_total"],
                "black_wins": r["black_wins"],
                "white_win_pct": _win_pct(
                    r["white_wins"], r["black_wins"], r["draws_total"]
                ),
                "avg_elo": round(r["avg_elo"]) if r["avg_elo"] else None,
                "last_played": r["last_played"],
                "fen": child_fen,
            }
        )

    total = sum(c["games"] for c in children) + ended
    for c in children:
        c["share_pct"] = round(100.0 * c["games"] / total, 1) if total else None

    # Everyone who reached the position, regardless of the focus — that list is
    # how the focus gets changed, so narrowing it would be a trap door.
    players = reference_players_at(conn, key, limit=players_limit)
    focus = next((p for p in players if p["username_lower"] == who), None) if who else None

    return {
        "pos_key": key,
        "fen": board.fen(),
        "turn": "white" if board.turn == chess.WHITE else "black",
        "player": who,
        # Which colour the focused player had here. Without it, "Carlsen's moves
        # from this position" is ambiguous: if he was White in all of them and
        # it is Black to move, these are his opponents' replies, not his.
        "focus": focus,
        "total_games": total,
        "ended_here": ended,
        "children": children,
        "players": players,
        "games": reference_games_at(conn, key, player=who, limit=games_limit),
        "last_move": (
            {"uci": last_move.uci(),
             "from": chess.square_name(last_move.from_square),
             "to": chess.square_name(last_move.to_square)}
            if last_move else None
        ),
    }


# One row per player per reference game at a position: the two sides of each
# game unpivoted, so a player can be counted whichever colour they had.
#
# Read from the games rather than from the roster on purpose. A masters PGN
# imported from an over-the-board database has no roster entries at all, and its
# players are exactly the ones worth listing — joining the roster would show an
# empty list for the corpus most likely to be interesting.
_SIDES_AT_POSITION = """
SELECT g.white_lower name_lower, g.white_name name, g.white_title title,
       g.source source, g.white_elo elo, g.played_at played_at, 'white' colour,
       CASE g.result WHEN '1-0' THEN 'win' WHEN '0-1' THEN 'loss' ELSE 'draw' END outcome
FROM game_positions gp JOIN games g ON g.id = gp.game_id
WHERE gp.pos_key = :pos_key AND g.collection = 'titled'
  AND g.result IN ('1-0', '0-1', '1/2-1/2') AND g.white_lower IS NOT NULL
UNION ALL
SELECT g.black_lower, g.black_name, g.black_title,
       g.source, g.black_elo, g.played_at, 'black',
       CASE g.result WHEN '0-1' THEN 'win' WHEN '1-0' THEN 'loss' ELSE 'draw' END
FROM game_positions gp JOIN games g ON g.id = gp.game_id
WHERE gp.pos_key = :pos_key AND g.collection = 'titled'
  AND g.result IN ('1-0', '0-1', '1/2-1/2') AND g.black_lower IS NOT NULL
"""


def reference_players_at(
    conn: sqlite3.Connection, position_key: str, limit: int = 30
) -> list[dict]:
    """Which titled players reached this position, and how they scored in it.

    A player appears once whichever colour they had, but the split is kept —
    "Carlsen has been here 40 times" is less useful than "38 of those as White".

    Players on the roster sort first: they are the ones deliberately added to
    compare against, so they should not be buried under their own opponents.
    """
    rows = conn.execute(
        f"""SELECT s.name_lower,
                   MAX(s.name) name,
                   MAX(s.title) title,
                   MAX(s.source) source,
                   MAX(p.real_name) real_name,
                   MAX(CASE WHEN p.username_lower IS NULL THEN 0 ELSE 1 END) in_library,
                   COUNT(*) games,
                   SUM(CASE WHEN s.colour = 'white' THEN 1 ELSE 0 END) as_white,
                   SUM(CASE WHEN s.colour = 'black' THEN 1 ELSE 0 END) as_black,
                   SUM(CASE WHEN s.outcome = 'win'  THEN 1 ELSE 0 END) wins,
                   SUM(CASE WHEN s.outcome = 'loss' THEN 1 ELSE 0 END) losses,
                   SUM(CASE WHEN s.outcome = 'draw' THEN 1 ELSE 0 END) draws,
                   AVG(s.elo) avg_elo,
                   MAX(s.played_at) last_played
            FROM ({_SIDES_AT_POSITION}) s
            LEFT JOIN library_players p
                   ON p.source = s.source AND p.username_lower = s.name_lower
            GROUP BY s.name_lower
            ORDER BY in_library DESC, games DESC, name COLLATE NOCASE
            LIMIT :limit""",
        {"pos_key": position_key, "limit": limit},
    ).fetchall()

    out = []
    for r in rows:
        wins, losses, draws = r["wins"] or 0, r["losses"] or 0, r["draws"] or 0
        out.append(
            {
                "username": r["name"] or r["name_lower"],
                "username_lower": r["name_lower"],
                "title": r["title"],
                "real_name": r["real_name"],
                "source": r["source"],
                "in_library": bool(r["in_library"]),
                "games": r["games"],
                "as_white": r["as_white"],
                "as_black": r["as_black"],
                "wins": wins,
                "losses": losses,
                "draws": draws,
                "win_pct": _win_pct(wins, losses, draws),
                "avg_elo": round(r["avg_elo"]) if r["avg_elo"] else None,
                "last_played": r["last_played"],
            }
        )
    return out


def reference_games_at(
    conn: sqlite3.Connection,
    position_key: str,
    player: str | None = None,
    limit: int = 25,
) -> list[dict]:
    """The individual reference games that passed through a position."""
    params: dict = {"pos_key": position_key, "limit": limit}
    where = ["gp.pos_key = :pos_key", "g.collection = 'titled'",
             "g.result IN ('1-0', '0-1', '1/2-1/2')"]
    if player:
        params["who"] = player.lower()
        where.append("(g.white_lower = :who OR g.black_lower = :who)")

    rows = conn.execute(
        f"""SELECT DISTINCT g.id, g.source, g.url, g.played_at,
                   g.white_name, g.black_name, g.white_title, g.black_title,
                   g.white_elo, g.black_elo, g.result, g.time_class,
                   g.opening, gp.move_san played_move
            FROM game_positions gp
            JOIN games g ON g.id = gp.game_id
            WHERE {" AND ".join(where)}
            ORDER BY g.played_at DESC
            LIMIT :limit""",
        params,
    ).fetchall()
    return [dict(r) for r in rows]


def move_list(moves: str | list[str] | None) -> list[dict]:
    """A stored SAN move list as the {uci, san} pairs the board plays.

    Stops at the first token that will not parse instead of raising: a game with
    a damaged tail is still worth replaying up to the point it goes wrong.
    """
    tokens = moves.split() if isinstance(moves, str) else list(moves or [])
    board = chess.Board()
    out: list[dict] = []
    for token in tokens:
        token = token.strip()
        if not token:
            continue
        try:
            move = board.parse_san(token)
        except ValueError:
            break
        out.append({"uci": move.uci(), "san": board.san(move)})
        board.push(move)
    return out


def _san_line(moves: list[str] | None) -> str:
    return _san_line_from(chess.Board(), moves)


def _san_line_from(board: chess.Board, moves: list[str] | None) -> str:
    """Render a move list as a numbered SAN line for display."""
    parts: list[str] = []
    for token in moves or []:
        token = token.strip()
        if not token:
            continue
        try:
            move = board.parse_san(token)
        except ValueError:
            try:
                move = board.parse_uci(token)
            except ValueError:
                break
        san = board.san(move)
        if board.turn == chess.WHITE:
            parts.append(f"{board.fullmove_number}.{san}")
        elif not parts:
            # A line that opens with a Black move needs the ellipsis, or the
            # move number it belongs to is lost.
            parts.append(f"{board.fullmove_number}...{san}")
        else:
            parts.append(san)
        board.push(move)
    return " ".join(parts)


def common_positions(
    conn: sqlite3.Connection,
    flt: GameFilter,
    min_ply: int = 8,
    max_ply: int | None = None,
    limit: int = 50,
    min_games: int = 2,
) -> list[dict]:
    """The positions the filtered games reach most often.

    `min_ply` skips the opening moves every game shares. The result carries the
    player's record in each position, so a frequently-reached position with a
    poor score stands out immediately.
    """
    flt = flt.normalized()
    where, params = flt.where("g")
    params.setdefault("player", flt.player)
    params["min_ply"] = min_ply
    params["max_ply"] = max_ply if max_ply is not None else 10_000
    params["limit"] = limit
    params["min_games"] = min_games
    win, loss, draw = player_wld_exprs("g")

    rows = conn.execute(
        f"""SELECT gp.pos_key,
                   COUNT(*) games,
                   {win} wins, {loss} losses, {draw} draws,
                   SUM(CASE WHEN g.result = '1-0'     THEN 1 ELSE 0 END) white_wins,
                   SUM(CASE WHEN g.result = '1/2-1/2' THEN 1 ELSE 0 END) draws_total,
                   SUM(CASE WHEN g.result = '0-1'     THEN 1 ELSE 0 END) black_wins,
                   p.fen, p.ply,
                   MAX(g.played_at) last_played
            FROM game_positions gp
            JOIN games g ON g.id = gp.game_id
            JOIN positions p ON p.pos_key = gp.pos_key
            WHERE {where} AND p.ply >= :min_ply AND p.ply <= :max_ply
            GROUP BY gp.pos_key
            HAVING COUNT(*) >= :min_games
            ORDER BY games DESC, p.ply ASC
            LIMIT :limit""",
        params,
    ).fetchall()

    out = []
    for r in rows:
        wins, losses, draws = r["wins"] or 0, r["losses"] or 0, r["draws"] or 0
        out.append(
            {
                "pos_key": r["pos_key"],
                "fen": r["fen"],
                "ply": r["ply"],
                "move_number": r["ply"] // 2 + 1,
                "turn": "white" if r["ply"] % 2 == 0 else "black",
                "games": r["games"],
                "wins": wins,
                "losses": losses,
                "draws": draws,
                "win_pct": _win_pct(wins, losses, draws) if flt.player else None,
                "white_wins": r["white_wins"],
                "draws_total": r["draws_total"],
                "black_wins": r["black_wins"],
                "white_win_pct": _win_pct(
                    r["white_wins"], r["black_wins"], r["draws_total"]
                ),
                "last_played": r["last_played"],
            }
        )
    return out


def opening_lines(
    conn: sqlite3.Connection,
    flt: GameFilter,
    opening: str | None = None,
    max_plies: int = 12,
    limit: int = 10,
) -> dict:
    """How an opening was actually reached, and how each move order scored.

    An opening name covers several move orders — "Queen's Pawn Game: Modern
    Defense" is reached by 1.d4 g6, by 1.d4 d6 2.Nc3 g6, and others — so this
    reports the distinct orders rather than a single canonical line, along with
    the moves every one of them shares.
    """
    flt = flt.normalized()
    where, params = flt.where("g")
    params.setdefault("player", flt.player)

    clauses = [where, "g.moves_san IS NOT NULL", "g.moves_san != ''"]
    if opening:
        clauses.append("g.opening = :opening")
        params["opening"] = opening

    rows = conn.execute(
        f"""SELECT g.moves_san, g.result, g.white_lower, g.black_lower, g.opening
            FROM games g WHERE {" AND ".join(clauses)}""",
        params,
    ).fetchall()

    if not rows:
        return {
            "opening": opening, "games": 0,
            "common_prefix": {"san": [], "uci": [], "san_line": ""},
            "lines": [], "played_as": None, "played_as_games": 0,
        }

    player = flt.player
    groups: dict[tuple, dict] = {}
    all_prefixes: list[list[str]] = []
    # Which side the player was on in these games. An opening is chosen by one
    # colour — a Sicilian is Black's — and knowing which lets the board be shown
    # from the point of view it was actually played from.
    colour_counts = {"white": 0, "black": 0}

    for row in rows:
        moves = (row["moves_san"] or "").split()
        if not moves:
            continue
        head = tuple(moves[:max_plies])
        all_prefixes.append(list(head))

        bucket = groups.setdefault(
            head, {"games": 0, "wins": 0, "losses": 0, "draws": 0}
        )
        bucket["games"] += 1

        colour = None
        if player:
            if row["white_lower"] == player:
                colour = "white"
            elif row["black_lower"] == player:
                colour = "black"
        if colour:
            colour_counts[colour] += 1
        outcome = _outcome_for(row["result"], colour)
        if outcome:
            bucket[{"win": "wins", "loss": "losses", "draw": "draws"}[outcome]] += 1

    # Moves shared by every single game — the part that defines the opening.
    common: list[str] = []
    if all_prefixes:
        shortest = min(len(p) for p in all_prefixes)
        for i in range(shortest):
            first = all_prefixes[0][i]
            if all(p[i] == first for p in all_prefixes):
                common.append(first)
            else:
                break

    ordered = sorted(groups.items(), key=lambda kv: -kv[1]["games"])[:limit]
    lines = []
    for head, rec in ordered:
        san = list(head)
        lines.append(
            {
                "san": san,
                "uci": _san_to_uci(san),
                "san_line": _san_line_from(chess.Board(), san),
                "games": rec["games"],
                "wins": rec["wins"],
                "losses": rec["losses"],
                "draws": rec["draws"],
                "win_pct": _win_pct(rec["wins"], rec["losses"], rec["draws"])
                if player
                else None,
            }
        )

    played_as = None
    if colour_counts["white"] or colour_counts["black"]:
        played_as = max(colour_counts, key=lambda c: colour_counts[c])

    return {
        "opening": opening,
        "games": sum(g["games"] for g in groups.values()),
        # None when no player is filtered on: there is then no "you" whose side
        # to report, and the frontend falls back to the opening's name.
        "played_as": played_as,
        "played_as_games": colour_counts.get(played_as) if played_as else 0,
        "common_prefix": {
            "san": common,
            "uci": _san_to_uci(common),
            "san_line": _san_line_from(chess.Board(), common),
        },
        "lines": lines,
    }


def _outcome_for(result: str | None, colour: str | None) -> str | None:
    if not colour or not result or result == "*":
        return None
    if result == "1/2-1/2":
        return "draw"
    return "win" if (result == "1-0") == (colour == "white") else "loss"


def _san_to_uci(san: list[str]) -> list[str]:
    """Replay a SAN line to get playable UCI, stopping at the first bad move."""
    board = chess.Board()
    out = []
    for token in san:
        try:
            move = board.parse_san(token)
        except ValueError:
            break
        out.append(move.uci())
        board.push(move)
    return out


def games_at_position(
    conn: sqlite3.Connection,
    flt: GameFilter,
    position_key: str,
    limit: int = 100,
) -> list[dict]:
    """The individual games that passed through a given position."""
    flt = flt.normalized()
    where, params = flt.where("g")
    params.setdefault("player", flt.player)
    params["pos_key"] = position_key
    params["limit"] = limit

    rows = conn.execute(
        f"""SELECT DISTINCT g.id, g.source, g.url, g.played_at,
                   g.white_name, g.black_name, g.white_lower, g.black_lower,
                   g.white_elo, g.black_elo, g.result, g.time_class,
                   g.opening, gp.move_san played_move
            FROM game_positions gp
            JOIN games g ON g.id = gp.game_id
            WHERE gp.pos_key = :pos_key AND {where}
            ORDER BY g.played_at DESC
            LIMIT :limit""",
        params,
    ).fetchall()

    out = []
    for r in rows:
        game = dict(r)
        if flt.player:
            if r["white_lower"] == flt.player:
                game["player_color"] = "white"
                game["opponent"] = r["black_name"]
            elif r["black_lower"] == flt.player:
                game["player_color"] = "black"
                game["opponent"] = r["white_name"]
            color = game.get("player_color")
            if color and r["result"]:
                if r["result"] == "1/2-1/2":
                    game["outcome"] = "draw"
                else:
                    game["outcome"] = (
                        "win" if (r["result"] == "1-0") == (color == "white") else "loss"
                    )
        out.append(game)
    return out

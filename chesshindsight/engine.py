"""Stockfish integration with a persistent process and a persistent eval cache.

A position is analyzed once at a given depth and then read from SQLite forever
after, so browsing the same opening tree repeatedly costs nothing.
"""

from __future__ import annotations

import json
import sqlite3
import subprocess
import sys
import threading
from pathlib import Path

import chess
import chess.engine

from .config import Config, find_stockfish

_lock = threading.Lock()
_engine: chess.engine.SimpleEngine | None = None
_engine_path: str | None = None

# Stockfish is a console program. Launched from a windowed build — which has no
# console of its own — Windows hands the child a brand-new console window, so a
# black cmd box flashes up on screen every time the engine starts. This flag
# suppresses it. It is Windows-only; elsewhere there is nothing to suppress.
_POPEN_FLAGS: dict = (
    {"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32" else {}
)


class EngineUnavailable(RuntimeError):
    pass


# The depths the board's dropdown offers. Not a linear scale of "a bit better":
# each extra ply costs roughly 60% more, so 26 is minutes of work where 18 is a
# second or two. The labels say so, because a number alone does not.
DEPTH_CHOICES: list[dict] = [
    {"depth": 12, "label": "12 · instant"},
    {"depth": 15, "label": "15 · quick"},
    {"depth": 18, "label": "18 · normal"},
    {"depth": 20, "label": "20 · careful"},
    {"depth": 22, "label": "22 · slow"},
    {"depth": 25, "label": "25 · deep"},
    {"depth": 28, "label": "28 · very slow"},
    {"depth": 30, "label": "30 · deepest"},
]

MIN_DEPTH = 6
MAX_DEPTH = 40

# No single search may hold the engine longer than this.
MAX_ANALYSIS_SECONDS = 120.0


def clamp_depth(value, fallback: int = 18) -> int:
    try:
        return max(MIN_DEPTH, min(MAX_DEPTH, int(value)))
    except (TypeError, ValueError):
        return fallback


def time_budget(depth: int, lines: int) -> float:
    """Wall-clock ceiling for one search.

    There has to be one: a wedged engine process otherwise holds `_lock` forever
    and every later evaluation piles up behind it until the app looks frozen.

    It has to grow with the search, though, or it quietly becomes the real limit
    — an allowance that is generous at depth 14 starves depth 26, and the user
    who picked 26 gets 18 without being told. So it grows the way the search
    does and stops at MAX_ANALYSIS_SECONDS. Past that the honest answer is the
    depth the search did reach, which is recorded and shown rather than rounded
    up to the depth that was asked for.
    """
    grow = 1.6 ** max(0, depth - 14)
    return max(5.0, min(MAX_ANALYSIS_SECONDS, 1.2 * grow * max(1, lines)))


def resolve_engine_path(config: Config) -> str | None:
    """The engine to use: the configured one, or a found one if it has moved.

    The configured path is absolute, so moving or renaming the application
    folder invalidates it — and a saved setting pointing at a file that is no
    longer there should not be preferred over a working binary sitting in the
    obvious place. Autodetection is the fallback, never the override.
    """
    configured = config.engine_path
    if configured and Path(configured).exists():
        return configured
    return find_stockfish() or configured


def engine_status(config: Config) -> dict:
    path = resolve_engine_path(config)
    exists = bool(path) and Path(path).exists()
    return {
        "configured": bool(config.engine_path),
        "path": path,
        "available": exists,
        "depth": config.engine_depth,
        "threads": config.engine_threads,
        "hash_mb": config.engine_hash_mb,
        "multipv": config.engine_multipv,
        "depth_choices": DEPTH_CHOICES,
        "hint": None
        if exists
        else "Set a Stockfish binary path in Settings. Download from stockfishchess.org/download.",
    }


def _get_engine(config: Config) -> chess.engine.SimpleEngine:
    global _engine, _engine_path
    path = resolve_engine_path(config)
    if not path or not Path(path).exists():
        raise EngineUnavailable(
            "No Stockfish binary found. Set the engine path in Settings "
            "(download from stockfishchess.org/download)."
        )
    if _engine is not None and _engine_path == path:
        return _engine
    close_engine()
    try:
        eng = chess.engine.SimpleEngine.popen_uci(path, **_POPEN_FLAGS)
    except Exception as exc:
        raise EngineUnavailable(f"Could not start engine at {path}: {exc}") from exc
    try:
        eng.configure(
            {"Threads": config.engine_threads, "Hash": config.engine_hash_mb}
        )
    except Exception:
        # Not every UCI engine exposes both options; analysis still works.
        pass
    _engine, _engine_path = eng, path
    return eng


def close_engine() -> None:
    global _engine, _engine_path
    if _engine is not None:
        try:
            _engine.quit()
        except Exception:
            pass
    _engine, _engine_path = None, None


def _cache_get(
    conn: sqlite3.Connection, pos_key: str, depth: int, multipv: int
) -> dict | None:
    """Best cached evaluation at or above `depth` that has enough lines.

    A row written before multi-PV existed holds a single variation, so it is not
    a usable answer to a three-line request; requiring the line count here makes
    those rows re-analyze instead of silently returning one line.

    Rows are ranked by the depth actually reached, not the depth requested: a
    depth-30 request that the clock stopped at 21 is a worse answer than a
    depth-22 request that finished, however they are filed.

    A row is served even when it reached less than was asked for. That looks
    like under-delivering and is not, because `time_budget` never decreases with
    depth: the stored row was filed at a depth at least as deep as this request,
    so it was given at least as much time, so a fresh search here cannot get any
    further than it did. Re-running would burn the budget to arrive at the same
    number. If that function ever stops being monotonic, this stops being true.
    """
    rows = conn.execute(
        """SELECT pos_key, fen, depth, reached, score_cp, mate_in,
                  best_move, pv, lines, engine
           FROM evals WHERE pos_key = ? AND depth >= ?
           ORDER BY COALESCE(reached, depth) DESC, depth DESC""",
        (pos_key, depth),
    ).fetchall()
    for row in rows:
        record = dict(row)
        lines = _decode_lines(record.pop("lines", None))
        # Fewer lines than asked for is only acceptable if the position itself
        # has fewer legal moves — the caller passes an already-capped multipv.
        if len(lines) < multipv:
            continue
        # Rows written before variations were stored in full hold only the
        # first move. Serving those would let the board walk one ply into a
        # line and then stop, so treat them as a miss and re-analyze.
        if not all(line.get("pv_uci") for line in lines):
            continue
        record["lines"] = lines
        # Old rows predate the column and cannot say otherwise, so they are
        # taken at their word.
        if record.get("reached") is None:
            record["reached"] = record["depth"]
        record["truncated"] = record["reached"] < record["depth"]
        return record
    return None


def _decode_lines(raw: str | None) -> list[dict]:
    if not raw:
        return []
    try:
        value = json.loads(raw)
    except (ValueError, TypeError):
        return []
    return value if isinstance(value, list) else []


def _cache_put(conn: sqlite3.Connection, record: dict) -> None:
    conn.execute(
        """INSERT INTO evals
               (pos_key, depth, fen, score_cp, mate_in, best_move, pv, lines,
                engine, reached)
           VALUES
               (:pos_key, :depth, :fen, :score_cp, :mate_in, :best_move, :pv,
                :lines, :engine, :reached)
           ON CONFLICT (pos_key, depth) DO UPDATE SET
               score_cp = excluded.score_cp, mate_in = excluded.mate_in,
               best_move = excluded.best_move, pv = excluded.pv,
               lines = excluded.lines, reached = excluded.reached""",
        record,
    )
    conn.commit()


def _describe_line(board: chess.Board, info: dict, rank: int) -> dict:
    """One principal variation, rendered for display.

    Scores stay relative to the side to move, matching the single-line fields,
    so the frontend can format every number through the same function.
    """
    score = info.get("score")
    pov = score.pov(board.turn) if score is not None else None

    # SAN for display and UCI for playing, built together so the two stay the
    # same length: the frontend walks the variation move by move and pairs them
    # by index. UCI is what actually gets played, since the frontend has no
    # chess rules of its own to resolve SAN against.
    moves = list(info.get("pv") or [])
    san: list[str] = []
    uci: list[str] = []
    walk = board.copy()
    for move in moves[:12]:
        try:
            san.append(walk.san(move))
            walk.push(move)
            uci.append(move.uci())
        except (ValueError, AssertionError):
            break

    return {
        "rank": rank,
        "score_cp": pov.score() if pov is not None else None,
        "mate_in": pov.mate() if pov is not None else None,
        "uci": uci[0] if uci else None,
        "san": san[0] if san else None,
        "pv": " ".join(san),
        "pv_san": san,
        "pv_uci": uci,
    }


def evaluate(
    conn: sqlite3.Connection,
    config: Config,
    fen: str,
    depth: int | None = None,
    multipv: int | None = None,
    use_cache: bool = True,
) -> dict:
    """Evaluate a position, reading from and writing to the cache.

    Returns the best line in the flat `score_cp` / `pv` fields — what the
    evaluation bar reads — plus a `lines` list holding the top `multipv`
    variations, best first.

    `depth` is the depth asked for; `reached` is the depth the search finished,
    and `truncated` says the two differ. The caller should show `reached`.
    """
    import chess.polyglot

    depth = clamp_depth(depth if depth else config.engine_depth,
                        fallback=config.engine_depth)
    board = chess.Board(fen)
    pos_key = f"{chess.polyglot.zobrist_hash(board):016x}"
    turn = "white" if board.turn == chess.WHITE else "black"

    # Asking for more lines than there are moves makes Stockfish report fewer
    # than requested, which would look like a cache miss forever.
    wanted = multipv if multipv is not None else config.engine_multipv
    wanted = max(1, min(int(wanted), 5))
    legal_count = board.legal_moves.count()
    wanted = min(wanted, legal_count) if legal_count else 1

    if use_cache:
        cached = _cache_get(conn, pos_key, depth, wanted)
        if cached:
            cached["cached"] = True
            cached["turn"] = turn
            return cached

    if board.is_game_over():
        outcome = board.outcome()
        record = {
            "pos_key": pos_key,
            "depth": depth,
            "fen": fen,
            "score_cp": 0 if outcome and outcome.winner is None else None,
            "mate_in": 0,
            "best_move": None,
            "pv": None,
            "lines": [],
            "engine": "terminal",
            "reached": depth,
        }
        return {**record, "cached": False, "game_over": True, "turn": turn,
                "truncated": False}

    budget = time_budget(depth, wanted)
    limit = chess.engine.Limit(depth=depth, time=budget)

    # Long enough for a search already running at its full budget to finish and
    # hand the engine over. A flat 30s here meant that picking a deep setting
    # turned every second board into "engine is busy".
    if not _lock.acquire(timeout=budget + 30):
        raise EngineUnavailable("engine is busy — try again in a moment")
    try:
        eng = _get_engine(config)
        try:
            info = eng.analyse(board, limit, multipv=wanted)
        except chess.engine.EngineTerminatedError:
            # Restart once: a crashed engine should not poison every later call.
            close_engine()
            try:
                eng = _get_engine(config)
                info = eng.analyse(board, limit, multipv=wanted)
            except chess.engine.EngineTerminatedError as exc:
                # Twice in a row means the position itself is the problem —
                # Stockfish aborts on positions it considers illegal, such as
                # one with a missing king. Report that rather than leaking an
                # engine-internal error into the UI.
                close_engine()
                raise EngineUnavailable(
                    "Stockfish stopped on this position. It is usually an "
                    "illegal position the engine refuses to search."
                ) from exc
        engine_name = (eng.id or {}).get("name", "unknown")
    finally:
        _lock.release()

    # analyse() returns a list when multipv is given and a bare dict otherwise.
    infos = info if isinstance(info, list) else [info]
    lines = [_describe_line(board, one, i + 1) for i, one in enumerate(infos)]
    best = lines[0] if lines else {}

    # What the search actually got to. With multi-PV the variations can finish
    # at different depths, so the shallowest is the honest figure for the set —
    # quoting the deepest would describe a comparison that was never made.
    depths = [one.get("depth") for one in infos if one.get("depth")]
    reached = min(depths) if depths else depth

    record = {
        "pos_key": pos_key,
        "depth": depth,
        "fen": fen,
        "score_cp": best.get("score_cp"),
        "mate_in": best.get("mate_in"),
        "best_move": best.get("uci"),
        "pv": best.get("pv"),
        "lines": json.dumps(lines),
        "engine": engine_name,
        "reached": reached,
    }
    _cache_put(conn, record)
    return {**record, "lines": lines, "cached": False, "turn": turn,
            "truncated": reached < depth}


def format_score(score_cp: int | None, mate_in: int | None, turn: str) -> str:
    """Render an eval as a White-relative string, the way GUIs conventionally show it."""
    sign = 1 if turn == "white" else -1
    if mate_in is not None:
        return f"#{sign * mate_in:+d}".replace("+", "") if mate_in else "#"
    if score_cp is None:
        return "—"
    return f"{sign * score_cp / 100:+.2f}"

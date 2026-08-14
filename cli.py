"""Command-line access to the same analysis the desktop app shows.

Useful for quick checks and for scripting; every command reads the same
database the GUI uses.
"""

from __future__ import annotations

import argparse
import json
import sys

from chesshindsight import stats, sync, tree
from chesshindsight.config import Config
from chesshindsight.db import connect, init_db
from chesshindsight.query import GameFilter


def _filter_from_args(args) -> GameFilter:
    return GameFilter(
        player=getattr(args, "player", None),
        opponent=getattr(args, "opponent", None),
        color=getattr(args, "color", None),
        time_classes=list(getattr(args, "tc", None) or []),
        sources=list(getattr(args, "source", None) or []),
        since=getattr(args, "since", None),
        until=getattr(args, "until", None),
        rated=getattr(args, "rated", None),
    )


def _print_records(rows: list[dict], label_key: str, label_head: str) -> None:
    if not rows:
        print("  (no games match)")
        return
    width = max(len(label_head), *(len(str(r.get(label_key, ""))) for r in rows))
    print(f"  {label_head:<{width}}  {'GAMES':>6} {'W':>5} {'L':>5} {'D':>5} {'WIN%':>7}")
    print("  " + "-" * (width + 34))
    for r in rows:
        win = f"{r['win_pct']:.1f}%" if r["win_pct"] is not None else "—"
        print(
            f"  {str(r.get(label_key, '')):<{width}}  {r['games']:>6} {r['wins']:>5} "
            f"{r['losses']:>5} {r['draws']:>5} {win:>7}"
        )


def cmd_sync(args, conn, config) -> int:
    if args.pgn:
        result = sync.import_pgn(conn, config, args.pgn, progress=print)
        print(result)
        return 0
    if not config.accounts:
        print("No accounts configured. Use: cli.py account add chesscom <username>")
        return 1
    results = sync.sync_all(conn, config, progress=print, full=args.full)
    for key, value in results.items():
        print(f"  {key}: {value}")
    return 0


def cmd_account(args, conn, config) -> int:
    if args.action == "add":
        config.add_account(args.source, args.username)
        print(f"Added {args.source}:{args.username}")
    elif args.action == "remove":
        config.remove_account(args.source, args.username)
        print(f"Removed {args.source}:{args.username}")
    else:
        for a in config.accounts:
            print(f"  {a.source:9} {a.username}")
        if not config.accounts:
            print("  (none configured)")
    return 0


def cmd_summary(args, conn, config) -> int:
    summary = stats.database_summary(conn)
    print(f"Games:     {summary['games']:,}")
    print(f"Range:     {str(summary['first_game'])[:10]} .. {str(summary['last_game'])[:10]}")
    print(f"Positions: {summary['distinct_positions']:,}")
    print("By source:")
    for s in summary["by_source"]:
        print(f"  {s['source']:10} {s['games']:,}")
    print("\nTop players in database:")
    for p in stats.known_players(conn, 10):
        print(f"  {p['player']:24} {p['games']:,}")
    return 0


def cmd_stats(args, conn, config) -> int:
    flt = _filter_from_args(args)
    ov = stats.overview(conn, flt)
    print(f"\n{args.player}: {ov['games']} games, "
          f"{ov['wins']}W {ov['losses']}L {ov['draws']}D, "
          f"win rate {ov['win_pct']}%")
    if ov.get("by_color"):
        print("\nBy colour:")
        rows = [
            {"label": "White", **ov["by_color"]["white"]},
            {"label": "Black", **ov["by_color"]["black"]},
        ]
        _print_records(rows, "label", "COLOUR")
    print("\nBy time control:")
    _print_records(stats.by_time_control(conn, flt), "time_class", "TIME CONTROL")
    print("\nBy exact clock:")
    _print_records(stats.by_time_control_detail(conn, flt)[:12], "clock", "CLOCK")
    return 0


def cmd_h2h(args, conn, config) -> int:
    data = stats.head_to_head(conn, args.player, args.opponent, _filter_from_args(args))
    t = data["total"]
    print(f"\n{args.player} vs {args.opponent}")
    print(f"  {t['games']} games — {t['wins']}W {t['losses']}L {t['draws']}D "
          f"— win rate {t['win_pct']}%")
    if t.get("by_color"):
        print("\nBy colour:")
        _print_records(
            [
                {"label": f"{args.player} as White", **t["by_color"]["white"]},
                {"label": f"{args.player} as Black", **t["by_color"]["black"]},
            ],
            "label", "COLOUR",
        )
    print("\nBy time control:")
    _print_records(data["by_time_control"], "time_class", "TIME CONTROL")
    print("\nBy exact clock:")
    _print_records(data["by_clock"], "clock", "CLOCK")
    print(f"\nBy opening (colour is {args.player}'s):")
    _print_records(
        [
            {**r, "label": f"{r['opening']} ({r['color']})"}
            for r in data["by_opening"][:15]
        ],
        "label", "OPENING",
    )
    return 0


def cmd_opponents(args, conn, config) -> int:
    rows = stats.opponents(conn, _filter_from_args(args), args.limit)
    print(f"\nOpponents of {args.player}:")
    _print_records(rows, "opponent", "OPPONENT")
    return 0


def cmd_tree(args, conn, config) -> int:
    moves = args.moves or []
    data = tree.tree(conn, _filter_from_args(args), moves, limit=args.limit)
    line = data["san_line"] or "(start position)"
    print(f"\n{line} — {data['total_games']} games, {data['turn']} to move")
    if not data["children"]:
        print("  (no continuations match)")
        return 0
    print(f"  {'MOVE':<8} {'GAMES':>6} {'SHARE':>7} {'W':>5} {'L':>5} {'D':>5} {'WIN%':>7}")
    print("  " + "-" * 48)
    for c in data["children"]:
        win = f"{c['win_pct']:.1f}%" if c["win_pct"] is not None else "—"
        print(f"  {c['san']:<8} {c['games']:>6} {c['share_pct']:>6.1f}% "
              f"{c['wins']:>5} {c['losses']:>5} {c['draws']:>5} {win:>7}")
    return 0


def cmd_positions(args, conn, config) -> int:
    # common_positions returns the most *frequent* positions. Re-sorting only
    # the first `limit` of those by win rate would rank within an arbitrary
    # slice, so pull a wider pool when a re-sort is coming — the same thing the
    # Positions view does.
    pool = max(args.limit * 4, 120) if args.worst else args.limit
    rows = tree.common_positions(
        conn, _filter_from_args(args),
        min_ply=args.min_move * 2 - 2, limit=pool, min_games=args.min_games,
    )
    if args.worst:
        rows = [r for r in rows if r["win_pct"] is not None]
        rows.sort(key=lambda r: (r["win_pct"], -r["games"]))
    print(f"\nMost-reached positions ({'lowest win rate first' if args.worst else 'most frequent first'}):")
    if not rows:
        print("  (none — try --min-games 2)")
        return 0
    for r in rows[: args.limit]:
        win = f"{r['win_pct']:.1f}%" if r["win_pct"] is not None else "—"
        print(f"  move {r['move_number']:>3} ({r['turn'][0]})  {r['games']:>4} games  "
              f"{r['wins']:>3}W {r['losses']:>3}L {r['draws']:>3}D  win {win:>7}")
        print(f"      {r['fen']}")
    return 0


def cmd_games(args, conn, config) -> int:
    rows = stats.recent_games(conn, _filter_from_args(args), args.limit)
    for g in rows:
        outcome = g.get("outcome") or ""
        print(f"  {str(g['played_at'])[:10]}  {str(g['white_name'] or '?'):<20} "
              f"{str(g['black_name'] or '?'):<20} {g['result']:<8} "
              f"{str(g['time_class'] or ''):<14} {outcome}")
    print(f"\n  {len(rows)} game(s)")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="cli.py", description=__doc__)
    p.add_argument(
        "--db", help="path to an alternate database (default: data/chesshindsight.db)"
    )
    sub = p.add_subparsers(dest="command", required=True)

    def add_filters(sp, require_player=False):
        sp.add_argument("--player", required=require_player)
        sp.add_argument("--opponent")
        sp.add_argument("--color", choices=["white", "black"])
        sp.add_argument("--tc", action="append",
                        choices=["bullet", "blitz", "rapid", "classical", "correspondence"])
        sp.add_argument("--source", action="append", choices=["chesscom", "lichess", "pgn"])
        sp.add_argument("--since")
        sp.add_argument("--until")
        sp.add_argument("--rated", type=lambda v: v.lower() == "true")

    sp = sub.add_parser("sync", help="download new games")
    sp.add_argument("--full", action="store_true", help="ignore cursors and refetch everything")
    sp.add_argument("--pgn", help="import a PGN file or folder instead of syncing accounts")
    sp.set_defaults(func=cmd_sync)

    sp = sub.add_parser("account", help="manage tracked accounts")
    sp.add_argument("action", choices=["add", "remove", "list"])
    sp.add_argument("source", nargs="?", choices=["chesscom", "lichess"])
    sp.add_argument("username", nargs="?")
    sp.set_defaults(func=cmd_account)

    sp = sub.add_parser("summary", help="what's in the database")
    sp.set_defaults(func=cmd_summary)

    sp = sub.add_parser("stats", help="record and win rates for a player")
    add_filters(sp, require_player=True)
    sp.set_defaults(func=cmd_stats)

    sp = sub.add_parser("h2h", help="head-to-head record between two players")
    add_filters(sp, require_player=True)
    sp.set_defaults(func=cmd_h2h)

    sp = sub.add_parser("opponents", help="most-played opponents")
    add_filters(sp, require_player=True)
    sp.add_argument("--limit", type=int, default=25)
    sp.set_defaults(func=cmd_opponents)

    sp = sub.add_parser("tree", help="continuations from a line")
    add_filters(sp)
    sp.add_argument("moves", nargs="*", help="e.g. e4 c5 Nf3")
    sp.add_argument("--limit", type=int, default=20)
    sp.set_defaults(func=cmd_tree)

    sp = sub.add_parser("positions", help="positions reached most often")
    add_filters(sp)
    sp.add_argument("--min-move", type=int, default=5)
    sp.add_argument("--min-games", type=int, default=3)
    sp.add_argument("--limit", type=int, default=15)
    sp.add_argument("--worst", action="store_true", help="sort by lowest win rate instead")
    sp.set_defaults(func=cmd_positions)

    sp = sub.add_parser("games", help="list individual games")
    add_filters(sp)
    sp.add_argument("--limit", type=int, default=40)
    sp.set_defaults(func=cmd_games)

    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    config = Config.load()
    conn = connect(args.db) if args.db else connect()
    init_db(conn)
    try:
        return args.func(args, conn, config)
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())

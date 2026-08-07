"""Download every Lichess piece set into web/piecesets/.

Lichess ships each set as twelve SVGs named wK.svg .. bP.svg. The app discovers
any complete folder under web/piecesets/ at startup, so nothing else has to
change when a set is added or removed — run this and restart.

Usage:  py -3 tools/fetch_piecesets.py [set ...]
        (no arguments = every set in the Lichess repository)
"""

from __future__ import annotations

import concurrent.futures
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEST = ROOT / "web" / "piecesets"

API = "https://api.github.com/repos/lichess-org/lila/contents/public/piece"
RAW = "https://raw.githubusercontent.com/lichess-org/lila/master/public/piece"
HEADERS = {"User-Agent": "HindsightChess-asset-fetch"}

PIECES = [f"{c}{p}" for c in ("w", "b") for p in ("K", "Q", "R", "B", "N", "P")]

# Most sets are SVG, a few ship raster art instead. The app serves whichever it
# finds, so the only requirement is that one extension covers all twelve pieces.
EXTENSIONS = ("svg", "webp", "png", "gif")


def get(url: str) -> bytes:
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read()


def list_sets() -> list[str]:
    entries = json.loads(get(API))
    return sorted(e["name"] for e in entries if e["type"] == "dir")


def _listing(name: str) -> dict[str, int]:
    """File name -> size for one set's folder."""
    entries = json.loads(get(f"{API}/{name}"))
    return {e["name"]: e["size"] for e in entries if e["type"] == "file"}


def _resolve(name: str, filename: str, files: dict[str, int], seen: set) -> bytes:
    """Fetch a file, following git symlinks.

    Git stores a symlink as a regular file whose whole content is the target
    path, so an unsuspecting download of `wK.svg` yields the five bytes `w.svg`.
    The `disguised` set is built entirely this way.
    """
    data = get(f"{RAW}/{name}/{filename}")
    target = data.decode("utf-8", "replace").strip()
    if len(data) < 120 and target in files and target not in seen:
        seen.add(target)
        return _resolve(name, target, files, seen)
    return data


def fetch_one(name: str) -> tuple[str, int, str | None]:
    """Download one set. Written to a temp folder first so a partial download
    never leaves a half-populated folder that the app would try to display."""
    target = DEST / name
    staging = DEST / f".{name}.part"
    if staging.exists():
        for f in staging.iterdir():
            f.unlink()
    staging.mkdir(parents=True, exist_ok=True)

    def give_up(message: str) -> tuple[str, int, str | None]:
        for f in staging.iterdir():
            f.unlink()
        staging.rmdir()
        return name, 0, message

    try:
        files = _listing(name)
        ext = next(
            (e for e in EXTENSIONS if all(f"{p}.{e}" in files for p in PIECES)),
            None,
        )
        if ext is None:
            # `mono` is the case in practice: six shape files with no colour,
            # meant to be recoloured by Lichess's own CSS.
            return give_up(
                "no complete set of twelve pieces in any supported format "
                f"(found: {', '.join(sorted(files)[:6])}…)"
            )

        for piece in PIECES:
            data = _resolve(name, f"{piece}.{ext}", files, {f"{piece}.{ext}"})
            if ext == "svg" and data.lstrip()[:1] != b"<":
                raise ValueError(f"{piece}.{ext} is not SVG")
            if len(data) < 40:
                raise ValueError(f"{piece}.{ext} is suspiciously small")
            (staging / f"{piece}.{ext}").write_bytes(data)
    except (urllib.error.URLError, urllib.error.HTTPError, ValueError, OSError) as exc:
        return give_up(str(exc))

    if target.exists():
        for f in target.iterdir():
            f.unlink()
        target.rmdir()
    staging.rename(target)
    return name, len(PIECES), None


def main() -> int:
    DEST.mkdir(parents=True, exist_ok=True)
    wanted = sys.argv[1:] or list_sets()
    print(f"{len(wanted)} set(s) -> {DEST}")

    failures: list[tuple[str, str]] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        for name, count, error in pool.map(fetch_one, wanted):
            if error:
                failures.append((name, error))
                print(f"  FAIL {name}: {error}")
            else:
                print(f"  ok   {name} ({count} files)")

    print(f"\n{len(wanted) - len(failures)}/{len(wanted)} sets installed")
    if failures:
        print("failed:", ", ".join(n for n, _ in failures))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())

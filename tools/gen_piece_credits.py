"""Regenerate piece-set credits from Lichess's own COPYING.md.

Writes two things, both derived rather than transcribed:
  * the PIECE_SET_META block in web/pieces.js  (name shown in the picker)
  * assets/NOTICE.md                           (author + licence per set)

Transcribing forty attributions by hand gets them wrong, so don't. Run this
after tools/fetch_piecesets.py.
"""

from __future__ import annotations

import re
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PIECES_JS = ROOT / "web" / "pieces.js"
NOTICE = ROOT / "assets" / "NOTICE.md"
INSTALLED = ROOT / "web" / "piecesets"

COPYING = "https://raw.githubusercontent.com/lichess-org/lila/master/COPYING.md"

# Sets whose picker label is not just the folder name title-cased.
LABELS = {
    "icpieces": "IC Pieces",
    "kiwen-suwi": "Kiwen-suwi",
    "mpchess": "MPChess",
    "reillycraig": "Reilly Craig",
    "rhosgfx": "RhosGFX",
    "shahi-ivory-brown": "Shahi Ivory Brown",
    "xkcd": "xkcd",
}

# Extra context worth showing next to the name in the picker.
EXTRA_NOTE = {
    "disguised": "every piece alike",
    "letter": "letters, not figures",
    "monarchy": "raster art",
    "mono": "single colour",
}

LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")


def strip_links(text: str) -> str:
    return LINK.sub(r"\1", text).strip()


def parse_copying(text: str) -> dict[str, tuple[str, str]]:
    """folder -> (author, licence). Rows after the "non-free" heading are
    flagged, because that distinction is the one that actually matters."""
    out: dict[str, tuple[str, str]] = {}
    non_free = False
    for line in text.splitlines():
        # COPYING.md has more than one "## Exceptions" heading; only the one
        # that says non-free starts the restricted list.
        stripped = line.strip().lower()
        if stripped.startswith("##") and "non-free" in stripped:
            non_free = True
        if "public/piece/" not in line:
            continue
        cells = [c.strip() for c in line.split("|")]
        folder = cells[0].split("public/piece/")[1].split(",")[0].split()[0]
        author = strip_links(cells[1]) if len(cells) > 1 else ""
        licence = strip_links(cells[2]) if len(cells) > 2 else ""
        # A bare URL in a table cell is unreadable; turn it into a link.
        licence = re.sub(r"(https?://\S+)", r"[terms](\1)", licence)
        licence = re.sub(r"\s+", " ", licence).strip() or "no licence stated"
        if non_free:
            licence = f"**non-free** — {licence}"
        out[folder.lower()] = (author or "unattributed", licence)
    return out


def installed_sets() -> list[str]:
    if not INSTALLED.is_dir():
        return []
    return sorted(
        d.name for d in INSTALLED.iterdir() if d.is_dir() and not d.name.startswith(".")
    )


def label_for(folder: str) -> str:
    if folder in LABELS:
        return LABELS[folder]
    return "-".join(p.capitalize() for p in folder.split("-"))


def note_for(folder: str, author: str) -> str:
    extra = EXTRA_NOTE.get(folder)
    if folder == "cburnett":
        return "Lichess default"
    if extra:
        return f"{author} — {extra}"
    return author


def write_pieces_js(sets: list[str], credits: dict[str, tuple[str, str]]) -> None:
    lines = []
    width = max(len(f"'{s}':") for s in sets) + 1
    for folder in sets:
        author, _ = credits.get(folder, ("unattributed", ""))
        key = folder if re.fullmatch(r"[A-Za-z_$][\w$]*", folder) else f"'{folder}'"
        label = label_for(folder).replace("'", "\\'")
        note = note_for(folder, author).replace("'", "\\'")
        lines.append(
            f"  {(key + ':'):<{width}} {{ label: '{label}', note: '{note}' }},"
        )

    block = (
        "const PIECE_SET_META = {\n" + "\n".join(lines) + "\n};"
    )
    source = PIECES_JS.read_text(encoding="utf-8")
    pattern = re.compile(r"const PIECE_SET_META = \{.*?\n\};", re.S)
    # Check the match, not whether the text changed — re-running with the same
    # set list legitimately produces identical output.
    if not pattern.search(source):
        raise SystemExit("could not find PIECE_SET_META in pieces.js")
    PIECES_JS.write_text(pattern.sub(lambda _: block, source, count=1), encoding="utf-8")


def write_notice(sets: list[str], credits: dict[str, tuple[str, str]]) -> None:
    rows = []
    for folder in sets:
        author, licence = credits.get(
            folder, ("unattributed", "not listed in Lichess's COPYING.md")
        )
        rows.append(f"| `{folder}` | {author} | {licence} |")

    NOTICE.write_text(
        "# Third-party assets\n"
        "\n"
        "## Piece sets\n"
        "\n"
        f"The {len(sets)} sets in `web/piecesets/` come from the\n"
        "[Lichess repository](https://github.com/lichess-org/lila/tree/master/public/piece)\n"
        "and are used unmodified. Authors and licences below are copied from\n"
        "Lichess's own `COPYING.md`, which is the authority on them.\n"
        "\n"
        "Several are **CC BY-NC-SA**: free for personal use, not for commercial\n"
        "redistribution. Others sit under Lichess's own \"Exceptions (non-free)\"\n"
        "heading and are flagged in the table. This application is a personal,\n"
        "local tool, which is within what those terms allow; anyone repackaging it\n"
        "commercially would need to remove the non-commercial and non-free sets\n"
        "first.\n"
        "\n"
        "The flag records where Lichess files a set, not a judgement of our own —\n"
        "which is why `totoy` and `papercut` are marked non-free even though the\n"
        "same row states CC BY 4.0. Two sets, `governor` and `kosal`, are shipped\n"
        "by Lichess but absent from `COPYING.md` altogether, so nothing can be\n"
        "claimed about them here.\n"
        "\n"
        "| Folder | Author | Licence |\n"
        "| --- | --- | --- |\n"
        + "\n".join(rows)
        + "\n"
        "\n"
        "`mono` is deliberately absent: it ships six colourless shapes meant to be\n"
        "recoloured by Lichess's own CSS, not twelve finished pieces, so it does not\n"
        "fit the folder layout this app reads.\n"
        "\n"
        "## Adding or removing a set\n"
        "\n"
        "Any folder of twelve images named `wK` … `bP` (`.svg`, `.webp`, `.png` or\n"
        "`.gif`) is picked up at startup. Delete a folder to remove it. Regenerate\n"
        "this file with `tools/gen_piece_credits.py` after either.\n"
        "\n"
        "## Everything else\n"
        "\n"
        "The application icon and the built-in \"Classic\" piece geometry are original\n"
        "to this project. Stockfish is GPLv3 and is not bundled — it is located on\n"
        "disk at runtime.\n",
        encoding="utf-8",
    )


def main() -> int:
    req = urllib.request.Request(COPYING, headers={"User-Agent": "HindsightChess"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        credits = parse_copying(resp.read().decode("utf-8"))

    sets = installed_sets()
    if not sets:
        raise SystemExit(f"no piece sets found in {INSTALLED}")

    write_pieces_js(sets, credits)
    write_notice(sets, credits)

    missing = [s for s in sets if s not in credits]
    print(f"{len(sets)} sets -> pieces.js and NOTICE.md")
    if missing:
        print("not listed in Lichess COPYING.md:", ", ".join(missing))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

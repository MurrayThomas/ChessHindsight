# Third-party assets

## Opening names

`openings.tsv` is built from
[lichess-org/chess-openings](https://github.com/lichess-org/chess-openings),
released under the **CC0 1.0 Public Domain Dedication** — no restrictions on
use or redistribution, commercial or otherwise. Attribution is given here
because the curation deserves it, not because the licence demands it.

Each row is a Zobrist position key, the ply it is reached at, and the name.
The ECO codes in the source are dropped; this app does not show them.
Regenerate with `tools/fetch_openings.py`.

## Piece sets

The 41 sets in `web/piecesets/` come from the
[Lichess repository](https://github.com/lichess-org/lila/tree/master/public/piece)
and are used unmodified. Authors and licences below are copied from
Lichess's own `COPYING.md`, which is the authority on them.

Several are **CC BY-NC-SA**: free for personal use, not for commercial
redistribution. Others sit under Lichess's own "Exceptions (non-free)"
heading and are flagged in the table. This application is a personal,
local tool, which is within what those terms allow; anyone repackaging it
commercially would need to remove the non-commercial and non-free sets
first.

The flag records where Lichess files a set, not a judgement of our own —
which is why `totoy` and `papercut` are marked non-free even though the
same row states CC BY 4.0. Two sets, `governor` and `kosal`, are shipped
by Lichess but absent from `COPYING.md` altogether, so nothing can be
claimed about them here.

| Folder | Author | Licence |
| --- | --- | --- |
| `alpha` | Eric Bentzen | **non-free** — "free for personal non commercial use" (see zip) |
| `anarcandy` | caderek | CC BY-NC-SA 4.0 |
| `caliente` | avi | CC BY-NC-SA 4.0 |
| `california` | Jerry S. | CC BY-NC-SA 4.0 |
| `cardinal` | sadsnake1 | CC BY-NC-SA 4.0 |
| `cburnett` | Colin M.L. Burnett | GPLv2+ |
| `celtic` | Maurizio Monge | MIT |
| `chess7` | Style-7 | **non-free** — "freeware" |
| `chessnut` | Alexis Luengas | Apache 2.0 |
| `companion` | David L. Brown | **non-free** — "freeware" |
| `cooke` | fejfar | CC BY-NC-SA 4.0 |
| `disguised` | danegraphics | CC BY-NC-SA 4.0 |
| `dubrovny` | sadsnake1 | CC BY-NC-SA 4.0 |
| `fantasy` | Maurizio Monge | MIT |
| `firi` | James Faure | CC BY 4.0 |
| `fresca` | sadsnake1 | CC BY-NC-SA 4.0 |
| `gioco` | sadsnake1 | CC BY-NC-SA 4.0 |
| `governor` | unattributed | not listed in Lichess's COPYING.md |
| `horsey` | cham, michael1241 | CC BY-NC-SA 4.0 |
| `icpieces` | sadsnake1 | CC BY-NC-SA 4.0 |
| `kiwen-suwi` | neverRare | CC BY 4.0 |
| `kosal` | unattributed | not listed in Lichess's COPYING.md |
| `leipzig` | Armando Hernandez Marroquin | **non-free** — "freeware" |
| `letter` | usolando | AGPLv3+ |
| `maestro` | sadsnake1 | CC BY-NC-SA 4.0 |
| `merida` | Armando Hernandez Marroquin | GPLv2+ |
| `monarchy` | slither77 | CC BY-NC-SA 4.0 |
| `mpchess` | Maxime Chupin | GPL3v3+ |
| `papercut` | Nikolay Anzarov | **non-free** — CC BY 4.0 |
| `pirouetti` | pirouetti | AGPLv3+ |
| `pixel` | therealqtpi | AGPLv3+ |
| `reillycraig` | Reilly Craig | **non-free** — no licence stated |
| `rhosgfx` | RhosGFX | CC0 1.0 |
| `riohacha` | unattributed | **non-free** — no licence stated |
| `shahi-ivory-brown` | Tamer Karatekin | **non-free** — Free for personal and commercial use, but non-derivative non-modify license (Şahî Chess & Shatranj Font License v1.0 – [terms](https://github.com/TamerKaratekin/shahi-chess-shatranj-font/blob/main/LICENSE.txt)) |
| `shapes` | flugsio | CC BY-SA 4.0 |
| `spatial` | Maurizio Monge | MIT |
| `staunty` | sadsnake1 | CC BY-NC-SA 4.0 |
| `tatiana` | sadsnake1 | CC BY-NC-SA 4.0 |
| `totoy` | Kosal Sen | **non-free** — CC BY 4.0 |
| `xkcd` | Randall Munroe | CC BY-NC-SA 2.5 |

`mono` is deliberately absent: it ships six colourless shapes meant to be
recoloured by Lichess's own CSS, not twelve finished pieces, so it does not
fit the folder layout this app reads.

## Adding or removing a set

Any folder of twelve images named `wK` … `bP` (`.svg`, `.webp`, `.png` or
`.gif`) is picked up at startup. Delete a folder to remove it. Regenerate
this file with `tools/gen_piece_credits.py` after either.

## Everything else

The application icon and the built-in "Classic" piece geometry are original
to this project. Stockfish is GPLv3 and is not bundled — it is located on
disk at runtime.

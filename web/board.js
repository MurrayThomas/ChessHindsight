/*
 * Interactive analysis board.
 *
 * One factory, mounted twice — once in the Explorer and once in the Positions
 * view — so click-to-move, arrow-key navigation, the evaluation bar and the
 * engine lines behave identically in both places.
 *
 * Positions are driven by a root FEN plus a list of moves played from it, not
 * by a move list from the initial position. That is what lets a position opened
 * from the Positions view be played on: it arrives as a Zobrist hash and a FEN,
 * with no move history to replay.
 */

'use strict';

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

/** Square name for a row/column in FEN order (row 0 = rank 8, col 0 = file a). */
function squareName(row, col) {
  return FILES[col] + (8 - row);
}

const PROMOTION_ORDER = ['q', 'r', 'b', 'n'];
const PROMOTION_LABEL = { q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight' };

/**
 * Which square a point falls on, from the board's rectangle alone.
 *
 * Pure arithmetic rather than document.elementFromPoint: hit testing forces a
 * layout on every pointer move, which is what made dragging feel heavy. Kept
 * as a free function so the maths can be tested without a rendered page.
 *
 * Returns null for points outside the board.
 */
function squareAtPoint(x, y, rect, flipped) {
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
  const fx = (x - rect.left) / rect.width;
  const fy = (y - rect.top) / rect.height;
  if (fx < 0 || fx >= 1 || fy < 0 || fy >= 1) return null;
  let col = Math.floor(fx * 8);
  let row = Math.floor(fy * 8);
  if (flipped) { col = 7 - col; row = 7 - row; }
  return squareName(row, col);
}

function createAnalysisBoard(opts) {
  const host = opts.host;
  const onChange = opts.onChange || (() => {});
  const onArrows = opts.onArrows || (() => {});
  const getFilter = opts.getFilter || (() => ({}));

  host.innerHTML = `
    <div class="board-wrap">
      <!-- Coordinates live outside the board, in their own gutters, the way a
           printed diagram or a wooden board labels its edges. Inside the corner
           squares they had to compete with the piece artwork for contrast and
           lost. -->
      <div class="board-frame">
        <div class="coords ranks"></div>
        <div class="board"></div>
        <!-- Arrows sit in the same grid cell as the board rather than inside
             it: draw() replaces the board's contents on every move, and an
             overlay living in there would be wiped with them. -->
        <svg class="arrows" viewBox="0 0 8 8" preserveAspectRatio="none"></svg>
        <!-- Inside the frame, not beside it, so the bar is exactly as tall as
             the board rather than as tall as the board plus its file labels. -->
        <div class="eval-col">
          <div class="eval-number">&mdash;</div>
          <div class="eval-bar" title="Engine evaluation — White's point of view">
            <div class="eval-black"></div>
            <div class="eval-white"></div>
            <div class="eval-zero"></div>
          </div>
        </div>
        <div class="coords files"></div>
      </div>
    </div>
    <div class="board-controls">
      <button class="ghost" data-act="start" title="Back to start (Home)">&#8676;</button>
      <button class="ghost" data-act="back" title="One move back (Left arrow)">&#8592;</button>
      <button class="ghost" data-act="forward" title="One move forward (Right arrow)">&#8594;</button>
      <button class="ghost" data-act="end" title="End of line (End)">&#8677;</button>
      <button class="ghost" data-act="flip" title="Flip board (F) — the colour filter sets this automatically">&#8645;</button>
      <label class="toggle" title="Evaluate each position automatically as you browse">
        <input type="checkbox" class="autoeval" checked><span>Auto&#8209;evaluate</span>
      </label>
      <!-- One setting shared by every board and by Settings, because it is one
           engine: two boards searching to different depths would be two answers
           to the same question. -->
      <label class="toggle depth-pick"
             title="How deep Stockfish searches. Each extra ply costs roughly 60% more time, so the deep settings are seconds to minutes per position, not milliseconds.">
        <span>Depth</span><select class="depth-select"></select>
      </label>
      <button class="ghost" data-act="eval" title="Evaluate this position now">Evaluate</button>
    </div>
    <!-- What the line on the board is called. Above the moves, because it is
         the heading for them. -->
    <div class="opening-name hidden"></div>
    <!-- The move list sits directly under the controls that walk it. It used to
         be last, below the engine lines and the arrow guide, which put a long
         game's moves off the bottom of the window exactly when they were being
         replayed. The arrow guide moved down to make room: it explains the
         engine's arrows, so it belongs with the engine's lines. -->
    <div class="branch-bar hidden"></div>
    <div class="line"></div>
    <div class="arrow-help hidden">
      <button class="arrow-help-toggle" type="button"
              title="What the arrows on the board mean">Board arrows</button>
      <div class="arrow-guide"></div>
    </div>
    <div class="engine-lines"></div>`;

  const boardEl = host.querySelector('.board');
  const arrowsEl = host.querySelector('.arrows');
  const ranksEl = host.querySelector('.coords.ranks');
  const filesEl = host.querySelector('.coords.files');
  const numEl = host.querySelector('.eval-number');
  const fillEl = host.querySelector('.eval-white');
  const linesEl = host.querySelector('.engine-lines');
  const helpEl = host.querySelector('.arrow-help');
  const guideEl = host.querySelector('.arrow-guide');
  const openingEl = host.querySelector('.opening-name');
  const branchEl = host.querySelector('.branch-bar');
  const lineEl = host.querySelector('.line');
  const autoEl = host.querySelector('.autoeval');
  const depthEl = host.querySelector('.depth-select');

  const self = {
    rootFen: null,        // null = the standard start position
    history: [],          // { uci, san } played from the root
    cursor: 0,            // how many of them are on the board
    goodCursor: 0,        // furthest cursor known to replay from the root
    flipped: false,
    orientedFor: null,    // colour filter the orientation was last set from
    lines: [],            // engine variations for the position on the board
    activeLine: 0,        // which of them the arrow keys follow (0 = best)
    // 'best'   — keep following whatever the engine currently rates highest,
    //            refreshed at every position so the queued line never goes stale.
    // 'chosen' — the user picked a specific variation; walk that one as it was.
    followMode: 'best',
    // Index in `history` from which the moves came from an engine line rather
    // than from the player. A single boolean cannot express this: once a
    // variation is queued after a move you played, the future is part yours and
    // part the engine's, and refreshing the whole of it discarded your move.
    engineFrom: Infinity,
    // How many moves at the head of `history` are the game that was loaded.
    // Infinity when no game was loaded — there is nothing to be past the end
    // of. Anything beyond it is the user's own analysis, however it got there:
    // a move they played, or a variation the engine queued.
    lineEnd: Infinity,
    lineLabel: 'the game',
    data: null,           // last explore() response
    selected: null,       // origin square awaiting a destination
    pending: null,        // promotion choice in progress
    // The move actually played from this position, by whoever the panel beside
    // the board is reporting on. Held per source and switched with the tab, so
    // the two panels cannot overwrite each other's arrow.
    playedMoves: { mine: null, titled: null },
    playedSource: 'mine',
    // Open to begin with, so the arrows explain themselves the first time they
    // appear; collapsible because once learned it is three lines of noise.
    guideOpen: true,
    arrowState: null,
  };

  /* ---------------- rendering ---------------- */

  function draw() {
    const data = self.data;
    const fen = (data && data.fen) || '8/8/8/8/8/8/8/8';
    const placement = fen.split(' ')[0];
    const grid = [];
    for (const row of placement.split('/')) {
      const cells = [];
      for (const ch of row) {
        if (/\d/.test(ch)) for (let i = 0; i < Number(ch); i++) cells.push(null);
        else cells.push(ch);
      }
      grid.push(cells);
    }

    const legal = (data && data.legal) || {};
    const last = data && data.last_move;

    boardEl.innerHTML = '';
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const realR = self.flipped ? 7 - r : r;
        const realC = self.flipped ? 7 - c : c;
        const name = squareName(realR, realC);
        const piece = grid[realR] ? grid[realR][realC] : null;

        const sq = document.createElement('div');
        sq.className = 'sq ' + ((realR + realC) % 2 === 0 ? 'light' : 'dark');
        sq.dataset.sq = name;
        if (last && (last.from === name || last.to === name)) sq.classList.add('lastmove');
        if (data && data.check_square === name) sq.classList.add('incheck');
        if (piece) sq.innerHTML = pieceHTML(piece, state.pieceSet);
        // Anything the player can move gets the grab cursor, so it is obvious
        // the board is interactive rather than a picture.
        if (legal[name] && legal[name].length) sq.classList.add('movable');
        boardEl.appendChild(sq);
      }
    }

    drawCoords();
    drawArrows();
    paintSelection();
    if (self.pending) drawPromotion();
    drawOpening();
    drawBranchBar();
    drawLine();
  }

  /*
   * What the line is called.
   *
   * The backend matches positions, not move orders, so a transposition is
   * named correctly — and the name is the deepest one the line has passed
   * through, so it stays on screen after the line leaves book rather than
   * blinking out at the first unusual move.
   */
  function drawOpening() {
    const opening = self.data && self.data.opening;
    openingEl.innerHTML = '';
    openingEl.classList.toggle('hidden', !opening);
    if (!opening) return;

    const name = document.createElement('b');
    name.textContent = opening.name;
    openingEl.appendChild(name);

    // Only worth saying once the board has left the named position behind.
    const past = opening.plies_since || 0;
    if (past > 0) {
      const moves = Math.ceil(past / 2);
      const note = document.createElement('span');
      note.className = 'past-book';
      note.textContent = ` · ${moves} move${moves === 1 ? '' : 's'} past the book`;
      openingEl.appendChild(note);
    }
    openingEl.title = past > 0
      ? `The line was still ${opening.name} ${Math.ceil(past / 2)} move(s) ago.`
      : `This position is ${opening.name}.`;
  }

  /*
   * Arrows over the board.
   *
   * Three of them, and each answers a different question at a glance: what the
   * engine would play, what it would play instead, and what was actually played
   * from here. Reading those off a table of text means holding three pairs of
   * squares in your head; on the board it is immediate.
   *
   * Drawn in an 8x8 coordinate space so the geometry never has to know the
   * board's pixel size — the SVG scales itself.
   */
  const ARROW_KINDS = {
    best:   { cls: 'a-best',   width: 0.17, head: 0.34 },
    second: { cls: 'a-second', width: 0.13, head: 0.28 },
    played: { cls: 'a-played', width: 0.13, head: 0.28 },
  };
  // Outline thickness, in the 8x8 board space — about 5% of a square.
  const OUTLINE = 0.045;

  /** Centre of a square in the 8x8 space, allowing for a flipped board. */
  function squareCentre(name) {
    const col = FILES.indexOf(name[0]);
    const rank = Number(name[1]);
    if (col < 0 || !rank) return null;
    const x = self.flipped ? 7 - col : col;
    const y = self.flipped ? rank - 1 : 8 - rank;
    return { x: x + 0.5, y: y + 0.5 };
  }

  function drawArrow(uci, kind, label) {
    const spec = ARROW_KINDS[kind];
    if (!spec || !uci || uci.length < 4) return;
    const from = squareCentre(uci.slice(0, 2));
    const to = squareCentre(uci.slice(2, 4));
    if (!from || !to) return;

    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy);
    if (!len) return;
    const ux = dx / len;
    const uy = dy / len;

    // Start clear of the piece being moved and stop short of the target square's
    // centre, so both pieces stay readable underneath.
    const startGap = 0.32;
    const endGap = 0.12;
    const sx = from.x + ux * startGap;
    const sy = from.y + uy * startGap;
    const ex = to.x - ux * endGap;
    const ey = to.y - uy * endGap;

    const head = Math.min(spec.head, len * 0.55);
    // Where the shaft stops and the head begins.
    const hx = ex - ux * head;
    const hy = ey - uy * head;
    const px = -uy;   // unit vector perpendicular to the arrow
    const py = ux;
    const wing = head * 0.62;

    const svg = (tag) => document.createElementNS('http://www.w3.org/2000/svg', tag);
    const g = svg('g');
    g.setAttribute('class', 'arrow ' + spec.cls);

    const points = [
      `${ex.toFixed(3)},${ey.toFixed(3)}`,
      `${(hx + px * wing).toFixed(3)},${(hy + py * wing).toFixed(3)}`,
      `${(hx - px * wing).toFixed(3)},${(hy - py * wing).toFixed(3)}`,
    ].join(' ');

    /*
     * Each arrow is drawn twice: a dark outline first, then the colour on top.
     *
     * Without it an arrow is only as legible as the difference between its
     * colour and the squares underneath — and on the green and blue board
     * themes a green or blue arrow has almost none. The outline gives every
     * arrow its own edge, so the same three colours stay readable on any board.
     */
    const shaftOf = (width, cls) => {
      const line = svg('line');
      line.setAttribute('x1', sx.toFixed(3));
      line.setAttribute('y1', sy.toFixed(3));
      line.setAttribute('x2', hx.toFixed(3));
      line.setAttribute('y2', hy.toFixed(3));
      line.setAttribute('stroke-width', String(width));
      line.setAttribute('stroke-linecap', 'round');
      if (cls) line.setAttribute('class', cls);
      return line;
    };
    const headOf = (cls, strokeWidth) => {
      const poly = svg('polygon');
      poly.setAttribute('points', points);
      if (cls) poly.setAttribute('class', cls);
      if (strokeWidth) {
        poly.setAttribute('stroke-width', String(strokeWidth));
        poly.setAttribute('stroke-linejoin', 'round');
      }
      return poly;
    };

    if (label) {
      const title = svg('title');
      title.textContent = label;
      g.appendChild(title);
    }
    g.append(
      shaftOf(spec.width + OUTLINE * 2, 'outline'),
      headOf('outline', OUTLINE * 2),
      shaftOf(spec.width),
      headOf(),
    );
    g.dataset.kind = kind;
    g.dataset.uci = uci;
    arrowsEl.appendChild(g);
  }

  function drawArrows() {
    arrowsEl.innerHTML = '';
    if (!self.data) return;

    const engine = linesAreCurrent() ? self.lines.slice(0, 2) : [];
    const played = self.playedMoves[self.playedSource];
    /*
     * Where the played move is also one the engine picked, the two arrows would
     * be drawn on top of each other and one would simply vanish — and that case
     * is the most interesting one to be sure about. So the duplicate is not
     * drawn at all, and the key says which engine choice it matched instead.
     */
    const agreesWith = played && played.uci
      ? engine.findIndex((l) => l.uci === played.uci)
      : -1;

    if (played && played.uci && agreesWith < 0) {
      drawArrow(played.uci, 'played',
        played.label || `played here: ${played.san || played.uci}`);
    }
    engine.forEach((line, i) => {
      if (!line.uci) return;
      const rank = i === 0 ? 'Best' : 'Second best';
      drawArrow(line.uci, i === 0 ? 'best' : 'second',
        `${rank}: ${line.san || line.uci}`);
    });

    self.arrowState = { engine, played, agreesWith };
    drawArrowGuide();
    // The tables beside the board mark their moves in the matching colour, and
    // only the board knows what is currently drawn — so it tells them, rather
    // than each table guessing and going stale when the next evaluation lands.
    onArrows(controller.arrowKindFor);
  }

  /*
   * What each arrow means, shown as the arrow itself.
   *
   * The colours are also carried where you are already looking — the engine
   * line numbers take their arrow's colour, and the move the blue arrow points
   * at is dotted in the continuations table — so this is the explanation you
   * read once rather than the thing you have to keep consulting. It collapses
   * for that reason.
   */
  function drawArrowGuide() {
    const { engine = [], played, agreesWith = -1 } = self.arrowState || {};
    guideEl.innerHTML = '';

    /*
     * One row per arrow actually on the board — never more.
     *
     * When the most-played move is also one the engine picked, no blue arrow is
     * drawn: there is nothing extra to point at. A third row for it, tinted the
     * colour of the arrow it coincides with, made the guide read as three green
     * arrows when only two exist. So that case is folded into the engine's own
     * row as a note instead of claiming a row of its own.
     */
    const agreeNote = played && played.uci && agreesWith >= 0
      ? (played.agreeLabel || 'also the most played here')
      : null;

    const rows = [];
    if (engine[0]) {
      rows.push(['best', 'Engine’s best move', engine[0].san || '',
        agreesWith === 0 ? agreeNote : null]);
    }
    if (engine[1]) {
      rows.push(['second', 'Engine’s second choice', engine[1].san || '',
        agreesWith === 1 ? agreeNote : null]);
    }
    if (played && played.uci && agreesWith < 0) {
      rows.push(['played', played.guideLabel || 'Played from this position',
        played.san || '', null]);
    }

    helpEl.classList.toggle('hidden', !rows.length);
    guideEl.classList.toggle('hidden', !self.guideOpen);
    helpEl.querySelector('.arrow-help-toggle')
      .classList.toggle('open', !!self.guideOpen);
    if (!self.guideOpen) return;

    rows.forEach(([kind, what, move, note]) => {
      const row = document.createElement('div');
      row.className = 'guide-row';
      row.appendChild(guideArrow(kind));
      const label = document.createElement('span');
      label.className = 'guide-what';
      label.textContent = what;
      const san = document.createElement('span');
      san.className = 'guide-move san';
      san.textContent = move;
      // Inside the move's cell, not beside it. The guide is a three-column grid
      // whose rows are `display: contents`, so a fourth child does not sit at
      // the end of the row — it falls into the next row's first column and
      // shunts every following row sideways.
      if (note) {
        const extra = document.createElement('span');
        extra.className = 'guide-also';
        extra.textContent = ' — ' + note;
        san.appendChild(extra);
      }
      row.append(label, san);
      guideEl.appendChild(row);
    });
  }

  /* A miniature of the real thing, so the swatch cannot be mistaken for a
   * generic colour chip. */
  function guideArrow(kind) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    // Deliberately not class "arrows": that selector means the board overlay,
    // and a swatch answering to it would be counted as an arrow on the board.
    svg.setAttribute('class', 'guide-swatch');
    svg.setAttribute('viewBox', '0 0 30 10');
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'arrow a-' + kind);
    const shaft = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    shaft.setAttribute('x1', '2'); shaft.setAttribute('y1', '5');
    shaft.setAttribute('x2', '19'); shaft.setAttribute('y2', '5');
    shaft.setAttribute('stroke-width', '3.4');
    shaft.setAttribute('stroke-linecap', 'round');
    const point = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    point.setAttribute('points', '28,5 18,10.5 18,-0.5');
    g.append(shaft, point);
    svg.appendChild(g);
    return svg;
  }

  helpEl.querySelector('.arrow-help-toggle').addEventListener('click', () => {
    self.guideOpen = !self.guideOpen;
    drawArrowGuide();
  });

  /*
   * The edge labels: ranks up the left, files along the bottom.
   *
   * One label per gutter cell rather than one per board square, so each sits
   * beside its own rank or file however the board is turned. Rebuilt with the
   * board because flipping reverses both.
   */
  function drawCoords() {
    const ranks = self.flipped ? [1, 2, 3, 4, 5, 6, 7, 8] : [8, 7, 6, 5, 4, 3, 2, 1];
    const files = self.flipped ? [...FILES].reverse() : FILES;
    const fill = (host, values) => {
      host.innerHTML = '';
      values.forEach((v) => {
        const cell = document.createElement('span');
        cell.className = 'coord';
        cell.textContent = String(v);
        host.appendChild(cell);
      });
    };
    fill(ranksEl, ranks);
    fill(filesEl, files);
  }

  /*
   * Selection highlight and destination markers, applied without rebuilding
   * the board. Picking a piece up touches a handful of squares; re-rendering
   * all 64 for it is what made the first frame of a drag stutter.
   */
  function paintSelection() {
    boardEl.querySelectorAll('.sq.sel').forEach((s) => s.classList.remove('sel'));
    boardEl.querySelectorAll('.sq .hint').forEach((h) => h.remove());
    if (!self.selected) return;

    const origin = boardEl.querySelector(`[data-sq="${self.selected}"]`);
    if (origin) origin.classList.add('sel');

    const legal = (self.data && self.data.legal) || {};
    const seen = new Set();
    (legal[self.selected] || []).forEach((m) => {
      if (seen.has(m.to)) return; // promotions list one entry per piece
      seen.add(m.to);
      const target = boardEl.querySelector(`[data-sq="${m.to}"]`);
      if (!target) return;
      const hint = document.createElement('span');
      hint.className = target.querySelector('.pc') ? 'hint capture' : 'hint';
      target.appendChild(hint);
    });
  }

  /** Move number and side the line starts on, read from the root position. */
  function lineStart() {
    if (!self.rootFen) return { white: true, num: 1 };
    const parts = self.rootFen.split(' ');
    return { white: parts[1] !== 'b', num: Number(parts[5]) || 1 };
  }

  /** Move number and side for the move at a given index in the line. */
  function moveNumberAt(index) {
    const start = lineStart();
    const white = start.white ? index % 2 === 0 : index % 2 === 1;
    const num = start.num + Math.floor((index + (start.white ? 0 : 1)) / 2);
    return { num, white };
  }

  /** Index of the first move that left the engine's main line, or -1. */
  function branchIndex() {
    return self.history.findIndex((h, i) => i < self.cursor && h.deviation);
  }

  /** Move label as it reads in prose: "37.Qxe6" or "12…Bg4". */
  function moveLabel(index) {
    const entry = self.history[index];
    if (!entry) return '';
    const { num, white } = moveNumberAt(index);
    return `${num}${white ? '.' : '…'}${entry.san}`;
  }

  /** One bar: a coloured tag, a sentence, and the button that undoes it. */
  function stateBar(tagText, tagClass, describe, backLabel, backTitle, backTo) {
    const bar = document.createElement('div');
    bar.className = 'branch-row ' + tagClass;

    const tag = document.createElement('span');
    tag.className = 'branch-tag';
    tag.textContent = tagText;

    const text = document.createElement('span');
    text.className = 'branch-text';
    describe(text);

    const back = document.createElement('button');
    back.className = 'ghost branch-back';
    back.textContent = backLabel;
    back.title = backTitle;
    back.addEventListener('click', () => { self.cursor = backTo; reload(); });

    bar.append(tag, text, back);
    return bar;
  }

  /*
   * A plain statement of the situation, with the way out attached.
   *
   * A marker buried in the move text is easy to miss when the line is long,
   * and it does not answer the question that actually matters: where am I, and
   * how do I get back. Two things can be true at once — you can be past the end
   * of a game *and* off the engine's main line — so both get a row.
   */
  function drawBranchBar() {
    branchEl.innerHTML = '';

    /*
     * Past the end of a loaded game.
     *
     * This is the one that misleads most: a game ends at move 37, the engine
     * queues its own continuation from there, and moves 38 onward sit in the
     * list looking exactly like moves that were played. They were not.
     */
    if (self.cursor > self.lineEnd) {
      const beyond = self.cursor - self.lineEnd;
      const end = moveLabel(self.lineEnd - 1);
      branchEl.appendChild(stateBar(
        'YOUR ANALYSIS', 'past-end',
        (text) => {
          text.append(document.createTextNode(`${self.lineLabel} ended at `));
          const at = document.createElement('b');
          at.textContent = end;
          text.appendChild(at);
          text.append(document.createTextNode(
            ` — the ${beyond} move${beyond === 1 ? '' : 's'} after it `
            + `${beyond === 1 ? 'is' : 'are'} not part of it`));
        },
        `↩ Back to ${end}`,
        `Return to the last move actually played in ${self.lineLabel}`,
        self.lineEnd,
      ));
    }

    const branch = branchIndex();
    if (branch >= 0) {
      const entry = self.history[branch];
      const label = moveLabel(branch);
      const depth = self.cursor - branch;
      branchEl.appendChild(stateBar(
        'SIDE LINE', 'side-line',
        (text) => {
          text.append(document.createTextNode('left the main line at '));
          const at = document.createElement('b');
          at.textContent = label;
          text.appendChild(at);
          if (entry.bestSan) {
            text.append(document.createTextNode(` — the engine played ${entry.bestSan}`));
          }
          text.append(document.createTextNode(
            ` · ${depth} move${depth === 1 ? '' : 's'} deep`));
        },
        `↩ Back to ${label}`,
        'Return to the position just before you left the main line',
        branch,
      ));
    }

    branchEl.classList.toggle('hidden', !branchEl.childElementCount);
  }

  /*
   * The move list, rendered move by move rather than as one string, so a move
   * that left the engine's main line can be marked where it happened and every
   * move can be clicked to jump to it.
   */
  function drawLine() {
    lineEl.innerHTML = '';
    const data = self.data;
    if (!data) return;

    const crumb = document.createElement('span');
    crumb.className = 'crumb';
    crumb.textContent = self.rootFen ? 'position' : 'start';
    crumb.title = 'Back to the start of this line';
    crumb.addEventListener('click', () => { self.cursor = 0; reload(); });
    lineEl.appendChild(crumb);

    if (self.history.length) lineEl.append(document.createTextNode(' · '));

    const branch = branchIndex();
    let { white, num } = lineStart();
    self.history.forEach((entry, i) => {
      // Where the loaded game stops and your own moves start, said outright.
      // Marking the moves alone is not enough: a line of greyed SAN reads as
      // "further along" rather than "no longer the game".
      if (i === self.lineEnd) {
        const mark = document.createElement('span');
        mark.className = 'line-end';
        mark.textContent = `end of ${self.lineLabel}`;
        mark.title = `${self.lineLabel} finished here — everything after this is `
          + 'your own analysis';
        lineEl.append(document.createTextNode(' '), mark);
      }

      if (white) lineEl.append(document.createTextNode(` ${num}.`));
      else if (i === 0) lineEl.append(document.createTextNode(` ${num}...`));
      else lineEl.append(document.createTextNode(' '));

      const span = document.createElement('span');
      // Moves stepped back over stay visible, greyed, so Right arrow is
      // discoverable — you can see there is something to go forward to.
      // `current` is the move the board is showing: without it a long line
      // gives no sense of where you actually are.
      span.className = 'mv'
        + (i >= self.cursor ? ' ahead' : '')
        + (i === self.cursor - 1 ? ' current' : '')
        + (entry.deviation ? ' sideline' : '')
        + (i >= self.lineEnd ? ' beyond' : '')
        + (branch >= 0 && i >= branch ? ' in-branch' : '');
      span.textContent = entry.san;

      // A move can be both past the end of the game and off the engine's line;
      // both facts are worth having, so they are collected rather than one
      // overwriting the other.
      const notes = [];
      if (i >= self.lineEnd) {
        notes.push(`Not part of ${self.lineLabel} — your own continuation`);
      }
      if (entry.deviation) {
        notes.push((entry.engineRank
          ? `Side line — the engine's number ${entry.engineRank} choice here`
          : 'Side line — not among the engine\'s top choices here')
          + (entry.bestSan ? `, it preferred ${entry.bestSan}` : ''));
      }
      if (notes.length) span.title = notes.join('\n');
      span.addEventListener('click', () => { self.cursor = i + 1; reload(); });
      lineEl.appendChild(span);

      if (!white) num += 1;
      white = !white;
    });

    if (data.is_game_over) {
      lineEl.append(document.createTextNode(' — '));
      const over = document.createElement('b');
      over.textContent = (data.game_over_reason || 'game over').replace(/_/g, ' ');
      lineEl.appendChild(over);
    }

    keepCurrentVisible();
  }

  /*
   * The list scrolls once a game is long enough, and stepping through a game is
   * exactly when it is. Scrolled by hand rather than with scrollIntoView, which
   * would also scroll the page and drag the board out from under you.
   */
  function keepCurrentVisible() {
    const cur = lineEl.querySelector('.mv.current');
    if (!cur || lineEl.scrollHeight <= lineEl.clientHeight) return;
    const top = cur.offsetTop - lineEl.offsetTop;
    const bottom = top + cur.offsetHeight;
    if (top < lineEl.scrollTop || bottom > lineEl.scrollTop + lineEl.clientHeight) {
      lineEl.scrollTop = Math.max(0, top - lineEl.clientHeight / 2);
    }
  }

  /* ---------------- promotion ---------------- */

  function drawPromotion() {
    const sq = boardEl.querySelector(`[data-sq="${self.pending.to}"]`);
    if (!sq) return;
    const menu = document.createElement('div');
    menu.className = 'promo';
    const white = self.data.turn === 'white';
    PROMOTION_ORDER.forEach((p) => {
      const choice = self.pending.options.find((m) => m.promotion === p);
      if (!choice) return;
      const cell = document.createElement('button');
      cell.className = 'promo-choice';
      cell.title = PROMOTION_LABEL[p];
      cell.innerHTML = pieceHTML(white ? p.toUpperCase() : p, state.pieceSet);
      cell.addEventListener('click', (e) => {
        e.stopPropagation();
        self.pending = null;
        play(choice);
      });
      menu.appendChild(cell);
    });
    sq.appendChild(menu);
  }

  /* ---------------- moving ---------------- */

  /*
   * Both ways of moving, from one set of pointer handlers.
   *
   *   drag  — press on a piece, move, release on a square.
   *   click — press and release on a piece to pick it up, then click a square.
   *
   * They have to share a handler because a drag and a click both begin with a
   * pointerdown on the same piece; what separates them is whether the pointer
   * actually travelled before it came up. Pointer events cover mouse, pen and
   * touch at once, so this works with a trackpad or a touchscreen too.
   */
  let drag = null;
  let dragFrame = 0;
  const DRAG_THRESHOLD = 3; // px of travel before a press counts as a drag

  /** Square name under a pointer event, or null if it is off the board. */
  function squareNameUnder(e) {
    // Geometry first: no layout, no hit testing, correct even though the ghost
    // is sitting under the cursor.
    const rect = (drag && drag.rect) || boardEl.getBoundingClientRect();
    const byPoint = squareAtPoint(e.clientX, e.clientY, rect, self.flipped);
    if (byPoint) return byPoint;
    // Fallback for environments with no layout (the rect is all zeros there).
    const direct = e.target && e.target.closest ? e.target.closest('.sq') : null;
    if (direct && boardEl.contains(direct)) return direct.dataset.sq;
    return null;
  }

  const squareEl = (name) =>
    (name ? boardEl.querySelector(`[data-sq="${name}"]`) : null);

  function tryMove(from, to) {
    const options = ((self.data.legal || {})[from] || []).filter((m) => m.to === to);
    if (options.length > 1) {            // a promotion — let the player choose
      self.pending = { to, options };
      self.selected = null;
      draw();
      return true;
    }
    if (options.length === 1) {
      self.selected = null;
      play(options[0]);
      return true;
    }
    return false;
  }

  function endDrag() {
    if (dragFrame) { cancelAnimationFrame(dragFrame); dragFrame = 0; }
    if (!drag) return;
    if (drag.ghost) drag.ghost.remove();
    const origin = squareEl(drag.from);
    if (origin) origin.classList.remove('dragging');
    if (drag.overEl) drag.overEl.classList.remove('over');
    drag = null;
  }

  boardEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !self.data) return;
    // Presses inside the promotion chooser are its own buttons' business.
    if (e.target.closest && e.target.closest('.promo')) return;

    const name = squareNameUnder(e);
    if (!name) return;
    const legal = self.data.legal || {};

    if (self.pending) { self.pending = null; self.selected = null; draw(); return; }

    // Second click of a click-to-move.
    if (self.selected && self.selected !== name && tryMove(self.selected, name)) return;

    if (!(legal[name] && legal[name].length)) {
      self.selected = null;
      paintSelection();
      return;
    }

    self.selected = name;
    paintSelection();

    const sq = squareEl(name);
    const piece = sq && sq.querySelector('.pc');
    if (!piece) return;
    e.preventDefault(); // stop the browser starting its own image drag

    // The board's rect is measured once per drag, not per pointer move.
    const boardRect = boardEl.getBoundingClientRect();
    const size = boardRect.width / 8;

    const ghost = document.createElement('div');
    ghost.className = 'piece-ghost';
    ghost.style.width = `${size}px`;
    ghost.style.height = `${size}px`;
    // The piece alone — copying the whole square would drag its coordinate
    // label along with it.
    ghost.appendChild(piece.cloneNode(true));
    document.body.appendChild(ghost);

    drag = {
      from: name, ghost, rect: boardRect, size,
      moved: false, x: e.clientX, y: e.clientY,
      px: e.clientX, py: e.clientY, overEl: null,
    };
    moveGhost(e.clientX, e.clientY);

    // Keeps events coming even when the pointer leaves the window.
    try { boardEl.setPointerCapture(e.pointerId); } catch { /* not supported */ }
  });

  function moveGhost(x, y) {
    if (!drag || !drag.ghost) return;
    // translate3d rather than left/top: it is a compositor-only change, so the
    // piece tracks the cursor without laying the page out on every frame.
    drag.ghost.style.transform =
      `translate3d(${x - drag.size / 2}px, ${y - drag.size / 2}px, 0)`;
  }

  /* Pointer moves arrive faster than the screen refreshes, so the work is
   * coalesced into one update per frame. */
  function onDragFrame() {
    dragFrame = 0;
    if (!drag) return;
    moveGhost(drag.px, drag.py);

    // Geometry when the board has a measured size; otherwise the square the
    // pointer was last over, which covers a board that is hidden or mid-relayout.
    const name = squareAtPoint(drag.px, drag.py, drag.rect, self.flipped);
    let next = name ? squareEl(name) : drag.pointerSq;
    if (next && next.dataset.sq === drag.from) next = null;
    if (next !== drag.overEl) {
      if (drag.overEl) drag.overEl.classList.remove('over');
      if (next) next.classList.add('over');
      drag.overEl = next;
    }
  }

  window.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (!drag.moved
        && Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > DRAG_THRESHOLD) {
      drag.moved = true;
      const origin = squareEl(drag.from);
      if (origin) origin.classList.add('dragging');
      if (drag.ghost) drag.ghost.classList.add('active');
    }
    if (!drag.moved) return;
    drag.px = e.clientX;
    drag.py = e.clientY;
    const over = e.target && e.target.closest ? e.target.closest('.sq') : null;
    drag.pointerSq = over && boardEl.contains(over) ? over : null;
    if (!dragFrame) dragFrame = requestAnimationFrame(onDragFrame);
  });

  window.addEventListener('pointerup', (e) => {
    if (!drag) return;
    const { from, moved } = drag;
    const target = squareNameUnder(e);
    endDrag();

    // A press that never travelled is a click: leave the piece selected so the
    // next click can name a destination.
    if (!moved) return;

    if (target && target !== from && tryMove(from, target)) return;
    // Dropped somewhere illegal — put it back rather than leaving it lifted.
    self.selected = null;
    paintSelection();
  });

  // A drag interrupted by the window losing focus must not strand the ghost.
  window.addEventListener('pointercancel', () => {
    endDrag();
    self.selected = null;
    paintSelection();
  });
  window.addEventListener('blur', () => {
    if (drag) { endDrag(); self.selected = null; paintSelection(); }
  });

  function play(move) {
    const entry = { uci: move.uci, san: move.san };

    /*
     * Record whether this move left the engine's main line, while the lines for
     * the position being left are still to hand — after the reload they are
     * gone. The FEN check matters: an evaluation still in flight leaves the
     * previous position's lines on display, and comparing against those would
     * label moves wrongly.
     */
    if (linesAreCurrent()) {
      const rank = self.lines.findIndex((l) => l.uci === move.uci);
      entry.deviation = rank !== 0;
      entry.engineRank = rank >= 0 ? rank + 1 : null;
      entry.bestSan = self.lines[0].san;
    }

    // Playing from a stepped-back position replaces whatever followed, the way
    // every analysis board behaves — including a queued engine variation.
    //
    // If that cuts into a loaded game, the rest of it is gone: from here on the
    // line is yours, so the end-of-game marker moves back to meet the cut.
    if (Number.isFinite(self.lineEnd) && self.cursor < self.lineEnd) {
      self.lineEnd = self.cursor;
    }
    self.history = self.history.slice(0, self.cursor);
    self.history.push(entry);
    self.cursor = self.history.length;
    // A move of your own ends the line you were following; the next position's
    // best line becomes the default again.
    self.activeLine = 0;
    self.followMode = 'best';
    self.engineFrom = Infinity;
    reload();
  }

  /* ---------------- evaluation ---------------- */

  /*
   * Do the variations on display belong to the position on the board?
   *
   * Evaluations are not cancelled when the board moves on, so a result for the
   * previous position lands after the move has already been made. Showing it is
   * merely confusing; *walking* it is worse, because a variation computed for a
   * different position is a list of moves that are not legal here — which is
   * how "illegal move 'b1c3' in line" got into the move list and jammed every
   * arrow key after it.
   */
  function linesAreCurrent() {
    return !!(self.lines.length && self.data && self.linesFen === self.data.fen);
  }

  function showEval(ev, pending, forFen) {
    // A result for a position the board has already left is dropped outright.
    if (forFen && self.data && self.data.fen && forFen !== self.data.fen) return;
    if (pending) {
      numEl.textContent = '…';
      numEl.className = 'eval-number pending';
      showSearching();
      return;
    }
    linesEl.classList.remove('busy');
    if (!ev) {
      numEl.textContent = '—';
      numEl.className = 'eval-number pending';
      fillEl.style.height = '50%';
      linesEl.innerHTML = '';
      self.lines = []; // stale variations must not be walked into
      drawArrows();    // ...and their arrows must go with them
      return;
    }
    const best = formatEval(ev);
    numEl.textContent = best.text;
    numEl.className = 'eval-number ' + best.cls;
    fillEl.style.height = (best.frac * 100).toFixed(1) + '%';
    self.lastEval = ev;
    // Which position these lines describe, so a stale panel is never mistaken
    // for the current one. The requested fen is authoritative — it is the one
    // the engine was actually asked about.
    self.linesFen = forFen || ev.fen || (self.data && self.data.fen) || null;
    drawEngineLines(ev);
    // The engine's two arrows only exist once there is an evaluation, so they
    // are drawn again here rather than only when the board is rebuilt.
    drawArrows();
    refreshBestLine();
  }

  /*
   * Say what is being waited for, while it is being waited for.
   *
   * A lone "…" on the evaluation bar was fine when every search took about a
   * second. At depth 25 it can take a minute, and a minute of no explanation
   * next to a stale set of variations reads as a hang. The previous lines stay
   * on screen but dimmed — they are the last thing known, and blanking them
   * would throw away the only information there is until the answer arrives.
   */
  function showSearching() {
    let head = linesEl.querySelector('.engine-head');
    if (!head) {
      linesEl.innerHTML = '';
      head = document.createElement('div');
      head.className = 'engine-head';
      linesEl.appendChild(head);
    }
    head.textContent = `Stockfish · searching to depth ${engineDepth()}`;
    const dots = document.createElement('span');
    dots.className = 'engine-note';
    dots.textContent = ' …';
    head.appendChild(dots);
    linesEl.classList.add('busy');
  }

  function drawEngineLines(ev) {
    linesEl.innerHTML = '';
    self.lines = (ev && ev.lines) || [];
    if (!self.lines.length) return;

    /*
     * Which line is being studied?
     *
     * Following the best line, it is always rank 1 — the queued variation is
     * refreshed from the engine at every position, so what Right arrow plays
     * and what is highlighted cannot drift apart. Following a variation the
     * user picked, the engine's ranking has moved on, so mark whichever row
     * now starts with the move Right arrow will play, or none if the engine no
     * longer lists it at all.
     */
    let activeIndex;
    if (self.followMode === 'best') {
      activeIndex = 0;
    } else {
      const queued = self.cursor < self.history.length
        ? self.history[self.cursor].uci
        : null;
      activeIndex = queued ? self.lines.findIndex((l) => l.uci === queued) : -1;
    }

    const head = document.createElement('div');
    head.className = 'engine-head';
    // The depth reached, not the depth requested — a search the clock stopped
    // early is not the analysis that was asked for, and quoting the request
    // would be claiming work that was not done.
    const reached = ev.reached || ev.depth;
    head.textContent = `Stockfish · depth ${reached}` + (ev.cached ? ' · cached' : '');
    if (ev.truncated) {
      const cut = document.createElement('span');
      cut.className = 'engine-cut';
      cut.textContent = ` · time limit, ${ev.depth} not reached`;
      cut.title = `The search ran out of time at depth ${reached} on the way to `
        + `${ev.depth}. More engine threads in Settings would get it further; `
        + 'so would a shallower setting.';
      head.appendChild(cut);
    }
    // Say outright which line the arrow keys will walk. The highlight alone
    // does not explain itself once the engine's ranking has moved on from the
    // line that was picked.
    const note = document.createElement('span');
    note.className = 'engine-note';
    if (activeIndex >= 0) {
      note.textContent = ` · following line ${activeIndex + 1}`;
      note.title = 'Right arrow plays the next move of this line';
    } else {
      note.textContent = ' · following a line the engine no longer rates';
      note.title = 'Click a line to follow one of these instead';
    }
    head.appendChild(note);
    linesEl.appendChild(head);

    self.lines.forEach((l, i) => {
      const row = document.createElement('div');
      row.className = 'engine-line';
      if (i === activeIndex) row.classList.add('active');

      // Rank, so "which of these is best" needs no counting — and for the two
      // lines that get an arrow, the badge takes the arrow's colour. That is
      // the whole legend: the number you are already reading is the key.
      const rank = document.createElement('span');
      rank.className = 'el-rank'
        + (i === 0 ? ' a-best' : i === 1 ? ' a-second' : '');
      rank.textContent = String(l.rank || i + 1);
      if (i < 2) {
        rank.title = i === 0
          ? 'Drawn on the board as the dark green arrow'
          : 'Drawn on the board as the pale green arrow';
      }

      const res = formatEval({ turn: ev.turn, score_cp: l.score_cp, mate_in: l.mate_in });
      const score = document.createElement('span');
      score.className = 'el-score ' + res.cls;
      score.textContent = res.text;

      const pv = document.createElement('span');
      pv.className = 'el-pv';
      pv.textContent = l.pv || l.san || '';

      row.append(rank, score, pv);

      if (l.uci) {
        row.classList.add('playable');
        row.title = 'Follow this line — Right arrow walks it, Left arrow comes back';
        // Selecting only. Playing the move here as well made clicking feel
        // like two actions at once.
        row.addEventListener('click', () => {
          self.followMode = 'chosen';
          self.activeLine = i;
          queueLine(i);
          drawEngineLines(self.lastEval);
        });
      }
      linesEl.appendChild(row);
    });
  }

  /*
   * Queue an engine line as the moves ahead of the cursor.
   *
   * Rather than tracking "we are following variation 2" as separate state, the
   * variation is loaded into the ordinary move list as future moves. Right
   * arrow then walks it with the same code that redoes a move you stepped back
   * over, Left arrow comes back, End jumps to the end of it — and playing any
   * move by hand truncates it, which is exactly the right thing to happen.
   *
   * Queueing never moves the board; walking is the arrow keys' job.
   */
  function queueLine(index) {
    // Never load a variation belonging to some other position — see
    // linesAreCurrent().
    if (!linesAreCurrent()) return false;
    const line = self.lines[index];
    if (!line || !line.pv_uci || !line.pv_uci.length) return false;

    const san = line.pv_san || (line.pv ? line.pv.split(/\s+/) : []);
    const queued = line.pv_uci.map((uci, i) => ({ uci, san: san[i] || uci }));

    self.history = self.history.slice(0, self.cursor).concat(queued);
    self.engineFrom = self.cursor;
    drawBranchBar();
    drawLine();
    return true;
  }

  /*
   * Keep the queued line in step with the engine.
   *
   * Walking a variation captured several moves ago goes stale: the engine
   * searches deeper at each new position and often changes its mind, so the
   * move you were about to play stops being the one it now recommends. While
   * following "best", the queue is therefore replaced at every position — what
   * Right arrow plays is always the current top line.
   *
   * A variation the user picked is left alone, and so are moves they played
   * themselves and then stepped back over; overwriting those would throw away
   * their line.
   */
  function refreshBestLine() {
    if (self.followMode !== 'best') return;
    if (!linesAreCurrent()) return;
    // Never overwrite moves the player made and then stepped back over.
    if (self.cursor < self.history.length && self.cursor < self.engineFrom) return;
    queueLine(0);
  }

  // Identifies this board to the shared single-flight evaluator, which calls
  // back through it so a result always lands on the board that asked.
  const evalOwner = { showEval };

  function evaluateNow(immediate) {
    if (!self.data || !self.data.fen) return;
    if (!autoEl.checked && !immediate) { showEval(null); return; }
    requestEval(self.data.fen, evalOwner, immediate);
  }

  /* ---------------- loading ---------------- */

  /*
   * Get back to a playable board after a line failed to replay.
   *
   * Reporting the error and returning left `self.cursor` past the bad move, so
   * every following arrow key re-ran the same failing query and the board
   * appeared frozen. The unplayable tail is dropped instead and the board stays
   * on the last position that did replay — which is the one already on screen,
   * so no second round-trip is needed.
   */
  function recover(err) {
    if (!self.data) { toast(err.message, true); return; }
    self.history = self.history.slice(0, self.goodCursor);
    self.cursor = self.goodCursor;
    if (Number.isFinite(self.lineEnd) && self.lineEnd > self.history.length) {
      self.lineEnd = self.history.length;
    }
    self.lines = [];
    self.linesFen = null;
    self.followMode = 'best';
    self.engineFrom = Infinity;
    linesEl.innerHTML = '';
    draw();
    // An unplayable queued line is now handled and needs no alarm; anything
    // else is a real failure the user should hear about.
    if (!/illegal move/i.test(err.message || '')) toast(err.message, true);
    else evaluateNow(false);
  }

  async function reload() {
    const moves = self.history.slice(0, self.cursor).map((m) => m.uci);
    let data;
    try {
      data = await api('explore', {
        filter: getFilter(),
        fen: self.rootFen,
        moves,
        limit: 40,
      });
    } catch (e) {
      recover(e);
      return;
    }
    self.data = data;
    // The furthest point known to replay cleanly, so a line that turns out to
    // be unplayable has somewhere to fall back to.
    self.goodCursor = self.cursor;
    self.selected = null;
    self.pending = null;
    draw();
    evaluateNow(false);
    // The public controller, not the internal state — the host view calls
    // playSan() on whatever it is handed.
    onChange(data, controller);
  }

  /* ---------------- controls ---------------- */

  host.querySelectorAll('[data-act]').forEach((btn) => {
    btn.addEventListener('click', () => act(btn.dataset.act));
  });

  autoEl.addEventListener('change', () => {
    if (autoEl.checked) evaluateNow(true);
    else { cancelEval(); showEval(null); }
  });

  /*
   * Fill the depth dropdown from the choices the backend publishes.
   *
   * Called again whenever the setting changes anywhere, because the depth
   * belongs to the engine rather than to a board: change it in Settings or on
   * the other board and this one has to agree, or the label stops describing
   * what the next search will do.
   */
  function syncDepth() {
    const choices = engineDepthChoices();
    const want = String(engineDepth());
    const have = Array.prototype.map.call(depthEl.options, (o) => o.value);
    if (have.join(',') !== choices.map((c) => String(c.depth)).join(',')) {
      depthEl.innerHTML = '';
      for (const choice of choices) {
        const opt = document.createElement('option');
        opt.value = String(choice.depth);
        opt.textContent = choice.label;
        depthEl.appendChild(opt);
      }
    }
    // A depth typed into Settings need not be one of the offered ones, and a
    // select silently showing the wrong entry would be worse than an extra row.
    if (!Array.prototype.some.call(depthEl.options, (o) => o.value === want)) {
      const opt = document.createElement('option');
      opt.value = want;
      opt.textContent = want + ' · custom';
      depthEl.appendChild(opt);
    }
    depthEl.value = want;
  }

  depthEl.addEventListener('change', () => {
    // An explicit choice deserves to be acted on now, not at the next move, and
    // a failure at the new depth should be reported rather than swallowed as a
    // repeat of one already shown.
    state.engineWarned = false;
    setEngineDepth(Number(depthEl.value));
    if (self.data && self.data.fen) requestEval(self.data.fen, evalOwner, true);
  });

  function act(name) {
    switch (name) {
      case 'start':   if (self.cursor) { self.cursor = 0; reload(); } break;
      case 'back':    if (self.cursor > 0) { self.cursor--; reload(); } break;
      case 'forward':
        // The engine's line is already sitting in the move list as future
        // moves, so this is the same step-forward as redoing a move.
        if (self.cursor < self.history.length) { self.cursor++; reload(); }
        break;
      case 'end':     if (self.cursor < self.history.length) { self.cursor = self.history.length; reload(); } break;
      case 'flip':    self.flipped = !self.flipped; draw(); break;
      case 'eval':
        state.engineWarned = false; // an explicit click should always report failures
        evaluateNow(true);
        break;
    }
  }

  const controller = {
    el: host,
    act,
    showEval,
    get flipped() { return self.flipped; },
    get fen() { return self.data ? self.data.fen : null; },
    get data() { return self.data; },
    get autoEval() { return autoEl.checked; },
    /** How many moves of a loaded game are still on the board; Infinity if
     *  none was loaded, 0 once the line has been cut back past its start. */
    get lineEnd() { return self.lineEnd; },

    /** Start a fresh line from `fen` (null = the standard start position). */
    setPosition(fen) {
      self.rootFen = fen || null;
      self.history = [];
      self.cursor = 0;
      self.goodCursor = 0;
      self.lines = [];
      self.linesFen = null;
      self.activeLine = 0;
      self.followMode = 'best';
      self.engineFrom = Infinity;
      self.lineEnd = Infinity;
      return reload();
    },

    /**
     * Replace the whole line with a given move list.
     *
     * `moves` is [{ uci, san }] — used to open a move order found elsewhere,
     * such as an opening's most-played line, or a whole saved game.
     *
     * `opts.markEnd` names what the line is ("the game"), which turns on the
     * end-of-line marking: anything played past it is flagged as the user's own
     * analysis rather than something that was played.
     * `opts.at` is where to leave the board; the end of the line by default,
     * but a game is reviewed from the start.
     */
    setLine(moves, opts) {
      opts = opts || {};
      self.rootFen = null;
      self.history = (moves || []).slice();
      self.cursor = opts.at == null
        ? self.history.length
        : Math.max(0, Math.min(opts.at, self.history.length));
      self.goodCursor = 0;
      self.lines = [];
      self.linesFen = null;
      self.activeLine = 0;
      self.followMode = 'best';
      self.engineFrom = Infinity;
      self.lineEnd = opts.markEnd ? self.history.length : Infinity;
      self.lineLabel = typeof opts.markEnd === 'string' ? opts.markEnd : 'the game';
      return reload();
    },

    /** Re-run the query without disturbing the line — e.g. after a filter change. */
    reload,

    /**
     * The move actually played from this position, as an arrow on the board.
     *
     * `source` names which panel it came from ('mine' or 'titled'), and both
     * are remembered: the two panels refresh independently, so without keeping
     * them apart whichever ran last would win regardless of which tab is open.
     */
    setPlayedMove(move, source) {
      self.playedMoves[source || 'mine'] = move || null;
      drawArrows();
    },

    /**
     * Which arrow, if any, is currently drawn for a move — 'best', 'second',
     * 'played', or null. A move the engine picked *and* the player played is
     * reported as the engine colour, because that is the arrow on the board;
     * saying "played" would point at a blue arrow that was never drawn.
     */
    arrowKindFor(uci) {
      const s = self.arrowState;
      if (!uci || !s) return null;
      if (s.engine[0] && s.engine[0].uci === uci) return 'best';
      if (s.engine[1] && s.engine[1].uci === uci) return 'second';
      if (s.played && s.played.uci === uci) return 'played';
      return null;
    },

    /** Which panel's played-move arrow to show — follows the Explorer's tab. */
    setPlayedSource(source) {
      self.playedSource = source === 'titled' ? 'titled' : 'mine';
      drawArrows();
    },

    /** Append a move by SAN, used when a tree row is clicked. */
    playSan(san) {
      const legal = (self.data && self.data.legal) || {};
      for (const from of Object.keys(legal)) {
        const hit = legal[from].find((m) => m.san === san);
        if (hit) { play(hit); return true; }
      }
      return false;
    },

    /**
     * Face the board the way the colour filter implies: filtering to Black puts
     * Black at the bottom, which is how you actually looked at those games.
     *
     * Applied only when the requested colour changes, so pressing F to flip
     * manually is not undone by the next redraw or view switch. `force` overrides
     * that, for callers that know which way round the position belongs — opening
     * a Sicilian line, say, which is Black's whatever the colour filter says.
     */
    setOrientation(colour, force) {
      const wanted = colour === 'black' ? 'black' : 'white';
      if (!force && self.orientedFor === wanted) return;
      self.orientedFor = wanted;
      self.flipped = wanted === 'black';
      draw();
    },

    /** Redraw with the current piece set / orientation, no server round-trip. */
    redraw: draw,

    /** Re-read the shared depth setting after it changed somewhere else. */
    syncDepth,
  };

  syncDepth();
  registerBoard(controller);
  return controller;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createAnalysisBoard, squareName, squareAtPoint };
}

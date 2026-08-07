/* ChessHindsight frontend — plain ES modules-free JS, no build step. */

'use strict';

/* ---------------- transport ---------------- */

async function api(method, args) {
  const res = await fetch('/api/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args || {}),
  });
  let data;
  try { data = await res.json(); } catch { throw new Error('Bad response from server'); }
  if (!res.ok || (data && data.error && res.status >= 400)) {
    throw new Error((data && data.error) || ('HTTP ' + res.status));
  }
  return data;
}

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

let toastTimer = null;
function toast(msg, isError) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('err', !!isError);
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), isError ? 6000 : 3000);
}

/* ---------------- state ---------------- */

const state = {
  view: 'dashboard',
  filter: { time_classes: [] },
  gamesOffset: 0,
  gamesLimit: 50,
  config: null,
  // Game modes present in the database, from api('variants').
  variants: [],
  engineWarned: false,
  pieceSet: 'cburnett',
  // Ids of the starred games, so every table can draw its stars without asking
  // the backend once per row.
  favourites: new Set(),
  me: [],
  // The game currently loaded on the Explorer board, if any.
  reviewing: null,
};

function readFilter() {
  const f = {};
  const player = $('#f-player').value.trim();
  const opponent = $('#f-opponent').value.trim();
  const color = $('#f-color').value;
  const source = $('#f-source').value;
  const rated = $('#f-rated').value;
  const since = $('#f-since').value;
  const until = $('#f-until').value;
  const minelo = $('#f-minelo').value;
  const maxelo = $('#f-maxelo').value;
  const threw = $('#f-threw').value;
  const variant = $('#f-variant').value;

  if (player) f.player = player;
  if (opponent) f.opponent = opponent;
  if (color) f.color = color;
  if (source) f.sources = [source];
  if (rated) f.rated = rated === 'true';
  if (since) f.since = since;
  if (until) f.until = until;
  if (minelo) f.min_opponent_elo = Number(minelo);
  if (maxelo) f.max_opponent_elo = Number(maxelo);
  if (threw) f.threw_from = Number(threw);
  // Blank means the standard-only default, which the backend already applies —
  // sending "standard" explicitly would mean the same thing and only makes the
  // saved filter noisier.
  if (variant) f.variant = variant;

  const tcs = $$('#f-tc .chip.on').map((c) => c.dataset.tc);
  if (tcs.length) f.time_classes = tcs;

  state.filter = f;
  return f;
}

/* ---------------- formatting ---------------- */

const fmtPct = (v) => (v == null ? '—' : v.toFixed(1) + '%');

/*
 * Every date the app writes, in day/month/year — the same order as the From and
 * To pickers, so nothing in the program has to be read twice.
 *
 * Two digits of year: these are dense lists where the column is scanned rather
 * than read, and no chess database of your own games spans a century. Anything
 * that is not an ISO date is passed through untouched rather than guessed at.
 */
function fmtDate(s) {
  if (!s) return '—';
  const iso = String(s).slice(0, 10);
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return parts ? `${parts[3]}/${parts[2]}/${parts[1].slice(2)}` : iso;
}

/* Colour marker for a win rate. A rough visual cue, not a verdict — where
 * "good" sits depends on how often you draw, which varies by time control. */
function winClass(pct) {
  if (pct == null) return '';
  if (pct >= 55) return 'score-good';
  if (pct <= 45) return 'score-bad';
  return '';
}

function wdlBar(w, d, l) {
  const total = (w || 0) + (d || 0) + (l || 0);
  const bar = el('div', 'wdl');
  if (!total) return bar;
  const mk = (cls, n) => {
    const i = el('i', cls);
    i.style.width = (100 * n / total) + '%';
    return i;
  };
  bar.append(mk('w', w || 0), mk('d', d || 0), mk('l', l || 0));
  bar.title = `${w} wins / ${d} draws / ${l} losses`;
  return bar;
}

function clockLabel(base, inc) {
  if (base == null) return 'unknown';
  if (base >= 86400) return Math.round(base / 86400) + 'd/move';
  const m = base / 60;
  return (Number.isInteger(m) ? m : m.toFixed(1)) + '+' + (inc || 0);
}

/* ---------------- engine evaluation ---------------- */

/*
 * Renders an engine score the traditional way: pawn units from White's point of
 * view, so +1.20 means White is a pawn and a bit better and -0.35 means Black is
 * slightly better, with 0.00 dead equal. The engine reports from the side to
 * move, so flip the sign when it is Black's turn.
 *
 * `frac` is only for the bar's fill height. A linear map would peg the bar at
 * any decisive advantage, so it goes through a logistic curve: small edges are
 * visible, large ones saturate gracefully.
 */
function formatEval(ev) {
  const whiteToMove = ev.turn === 'white';
  const sign = whiteToMove ? 1 : -1;

  // Terminal positions are reported with mate_in = 0.
  if (ev.mate_in === 0) {
    if (ev.score_cp === 0) return { text: '0.00', cls: 'plus', frac: 0.5 };
    return {
      text: whiteToMove ? '0–1' : '1–0',
      cls: 'mate',
      frac: whiteToMove ? 0 : 1,
    };
  }
  if (ev.mate_in != null) {
    const m = sign * ev.mate_in;
    return { text: (m > 0 ? '#' : '#-') + Math.abs(m), cls: 'mate', frac: m > 0 ? 1 : 0 };
  }
  if (ev.score_cp == null) return { text: '—', cls: 'pending', frac: 0.5 };

  const cp = sign * ev.score_cp;
  const pawns = cp / 100;
  return {
    text: pawns > 0 ? '+' + pawns.toFixed(2) : pawns.toFixed(2),
    cls: pawns >= 0 ? 'plus' : 'minus',
    frac: 1 / (1 + Math.exp(-cp / 350)),
  };
}

/*
 * Evaluation is single-flight and debounced, and both parts matter.
 *
 * A depth-18 evaluation takes about a second, and the backend serialises them
 * on one engine process. Firing one per click meant a fast walk through the
 * tree left several requests queued, each holding one of the six HTTP
 * connections the webview allows per origin — which starves the ordinary
 * requests the rest of the UI needs and looks like a freeze.
 *
 * So: at most one evaluation in flight, ever. A newer request while one is
 * running does not queue; it replaces the pending target, and is issued when
 * the current one returns. The request carries the board that asked for it, so
 * a result never lands on the wrong board once there is more than one.
 */
let evalToken = 0;
let evalInFlight = false;
let evalPending = null;
let evalDebounce = null;

/*
 * Search depth is one setting for the whole app, not one per board.
 *
 * There is a single engine process behind every board, so two boards set to
 * different depths would be two different answers to the same question with
 * nothing on screen to say which was which. Settings and both boards therefore
 * read and write the same value, and each other's dropdown updates when it
 * changes.
 */
const DEPTH_FALLBACK = [
  { depth: 12, label: '12 · instant' },
  { depth: 18, label: '18 · normal' },
  { depth: 22, label: '22 · slow' },
];

// The depth the Positions grid scans at, whatever the boards are set to. The
// grid runs one search per card, so a deep setting would turn a 40-card scan
// into an hour of work for a row of thumbnail score tags. Capped, not fixed:
// someone who chose a shallower depth than this still gets what they asked for.
const GRID_DEPTH = 16;

const boards = [];

function registerBoard(board) {
  if (board && !boards.includes(board)) boards.push(board);
}

function engineDepth() {
  const d = state.config && state.config.engine_depth;
  return Number(d) > 0 ? Number(d) : 18;
}

function engineDepthChoices() {
  const choices = state.config && state.config.engine_depth_choices;
  return Array.isArray(choices) && choices.length ? choices : DEPTH_FALLBACK;
}

let depthSave = null;

/** Change the shared depth: every dropdown, then the stored config. */
function setEngineDepth(depth) {
  depth = Number(depth);
  if (!(depth > 0) || !state.config || depth === state.config.engine_depth) return;
  state.config.engine_depth = depth;
  boards.forEach((b) => b.syncDepth());
  const field = $('#eng-depth');
  if (field) field.value = String(depth);
  // Debounced: clicking through a dropdown fires a change per stop on the way,
  // and each one is a disk write.
  clearTimeout(depthSave);
  depthSave = setTimeout(() => {
    api('save_config', { patch: { engine_depth: depth } }).catch(() => {});
  }, 400);
}

function requestEval(fen, owner, immediate) {
  if (!fen || !owner) return;
  clearTimeout(evalDebounce);
  const fire = () => {
    evalPending = { fen, owner };
    if (!evalInFlight) drainEval();
  };
  if (immediate) fire();
  else evalDebounce = setTimeout(fire, 250);
}

async function drainEval() {
  if (evalInFlight || !evalPending) return;
  const { fen, owner } = evalPending;
  evalPending = null;
  evalInFlight = true;
  const token = ++evalToken;

  // The fen travels with the result. A newer request does not cancel the one
  // already running, so a result routinely arrives after the board has moved
  // on; without knowing which position it describes, the board cannot tell.
  owner.showEval(null, true, fen);
  try {
    const ev = await api('evaluate', { fen, depth: engineDepth() });
    if (token === evalToken) owner.showEval(ev, false, fen);
  } catch (e) {
    if (token === evalToken) {
      owner.showEval(null, false, fen);
      if (!state.engineWarned) {
        toast(e.message, true);
        state.engineWarned = true;
      }
    }
  } finally {
    evalInFlight = false;
    if (evalPending) drainEval(); // a newer position arrived while we waited
  }
}

function cancelEval() {
  clearTimeout(evalDebounce);
  evalPending = null;
  evalToken++;
}

/* ---------------- board rendering ---------------- */

/* Static board, used for the thumbnails on the Positions grid. The interactive
 * board lives in board.js and draws itself. */
function renderBoard(container, fen, flipped) {
  container.innerHTML = '';
  const placement = (fen || '8/8/8/8/8/8/8/8').split(' ')[0];
  const rows = placement.split('/');
  const grid = [];
  for (const row of rows) {
    const cells = [];
    for (const ch of row) {
      if (/\d/.test(ch)) {
        for (let i = 0; i < Number(ch); i++) cells.push(null);
      } else {
        cells.push(ch);
      }
    }
    grid.push(cells);
  }
  const order = flipped ? [...grid].reverse() : grid;
  order.forEach((row, r) => {
    const cells = flipped ? [...row].reverse() : row;
    cells.forEach((piece, c) => {
      const realR = flipped ? 7 - r : r;
      const realC = flipped ? 7 - c : c;
      const sq = el('div', 'sq ' + ((realR + realC) % 2 === 0 ? 'light' : 'dark'));
      // Named the same way the interactive board names its squares, so both
      // kinds of board can be inspected identically.
      sq.dataset.sq = squareName(realR, realC);
      if (piece) sq.innerHTML = pieceHTML(piece, state.pieceSet);
      container.appendChild(sq);
    });
  });
}

/* ---------------- generic table builder ---------------- */

function buildTable(columns, rows, opts) {
  opts = opts || {};
  const table = el('table');
  const thead = el('thead');
  const htr = el('tr');
  columns.forEach((col) => {
    const th = el('th', col.num ? 'num' : '', col.label);
    if (col.help) { th.title = col.help; th.classList.add('has-help'); }
    htr.appendChild(th);
  });
  thead.appendChild(htr);
  table.appendChild(thead);

  const tbody = el('tbody');
  rows.forEach((row) => {
    const tr = el('tr', opts.onRowClick ? 'clickable' : '');
    columns.forEach((col) => {
      const td = el('td', col.num ? 'num' : '');
      const value = col.render ? col.render(row) : row[col.key];
      if (value instanceof Node) td.appendChild(value);
      else td.textContent = value == null ? '—' : value;
      // classList.add('') throws, and winClass() returns '' for anything in
      // the middle of the range — which is most rows.
      const extra = col.cls && col.cls(row);
      if (extra) td.classList.add(extra);
      tr.appendChild(td);
    });
    if (opts.onRowClick) tr.addEventListener('click', () => opts.onRowClick(row));
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  if (!rows.length) {
    const empty = el('p', 'muted', opts.empty || 'No games match the current filter.');
    const wrap = el('div');
    wrap.append(table, empty);
    return wrap;
  }
  return table;
}

/*
 * Win rate is the only percentage the app reports: wins / games, with draws
 * counting against it. The tournament "score" (a draw as half a point) used to
 * sit beside it, but two similar-looking percentages in every table was more
 * confusing than useful — and the W/D/L counts are always shown in full, so
 * nothing is actually lost.
 */
const WIN_HELP = 'Share of games won outright. Draws count against it.';

const recordColumns = () => [
  { label: 'Games', key: 'games', num: true },
  { label: 'W', key: 'wins', num: true },
  { label: 'L', key: 'losses', num: true },
  { label: 'D', key: 'draws', num: true },
  { label: '', render: (r) => wdlBar(r.wins, r.draws, r.losses) },
  {
    label: 'Win %', num: true, help: WIN_HELP,
    render: (r) => fmtPct(r.win_pct),
    cls: (r) => winClass(r.win_pct),
  },
];

/* ---------------- dashboard ---------------- */

async function loadDashboard() {
  const filter = readFilter();
  const [summary, ov, tc, opps] = await Promise.all([
    api('summary'),
    api('overview', { filter }),
    api('by_time_control', { filter }),
    filter.player ? api('opponents', { filter, limit: 40 }) : Promise.resolve([]),
  ]);

  const cards = $('#dash-cards');
  cards.innerHTML = '';
  const mkCard = (k, v, s) => {
    const c = el('div', 'card');
    c.append(el('div', 'k', k), el('div', 'v', v), el('div', 's', s || ''));
    return c;
  };
  cards.append(
    mkCard('Games in database', summary.games.toLocaleString(), summary.by_source.map((s) => `${s.source} ${s.games}`).join(' · ')),
    mkCard('Matching filter', ov.games.toLocaleString(), `${fmtDate(ov.first_game)} → ${fmtDate(ov.last_game)}`),
    mkCard('Win rate', fmtPct(ov.win_pct), filter.player ? 'as ' + filter.player : 'set a player for W/L/D'),
    mkCard('Distinct positions', summary.distinct_positions.toLocaleString(), 'indexed for the explorer'),
  );

  $('#db-badge').textContent =
    `${summary.games.toLocaleString()} games\n${summary.accounts.length} account(s)`;

  // Nothing to analyze yet — say where to start rather than showing bare zeros.
  if (!summary.accounts.length) {
    $('#sync-msg').textContent =
      'No accounts yet — add your Chess.com or Lichess username in Settings first.';
  } else if (!summary.games) {
    $('#sync-msg').textContent = 'Accounts configured. Press "Sync accounts" to download your games.';
  }

  const rec = $('#dash-record');
  rec.innerHTML = '';
  if (filter.player) {
    const rows = [{ label: 'Overall', ...ov }];
    if (ov.by_color) {
      rows.push({ label: 'as White', ...ov.by_color.white });
      rows.push({ label: 'as Black', ...ov.by_color.black });
    }
    rec.appendChild(buildTable(
      [{ label: '', key: 'label' }, ...recordColumns()], rows));
  } else {
    rec.appendChild(el('p', 'muted', 'Enter a player above to see win/loss/draw records.'));
  }

  const tcDiv = $('#dash-tc');
  tcDiv.innerHTML = '';
  tcDiv.appendChild(buildTable(
    [{ label: 'Time control', key: 'time_class' }, ...recordColumns()], tc));

  const oppDiv = $('#dash-opponents');
  oppDiv.innerHTML = '';
  if (!filter.player) {
    oppDiv.appendChild(el('p', 'muted', 'Enter a player above to list their opponents.'));
  } else {
    oppDiv.appendChild(buildTable(
      [
        { label: 'Opponent', key: 'opponent' },
        ...recordColumns(),
        { label: 'Last played', render: (r) => fmtDate(r.last_played) },
      ],
      opps,
      {
        empty: 'No opponents found for this player.',
        onRowClick: (r) => {
          $('#h2h-player').value = filter.player;
          $('#h2h-opponent').value = r.opponent_lower;
          switchView('h2h');
          loadH2H();
        },
      },
    ));
    const list = $('#opponents-list');
    list.innerHTML = '';
    opps.forEach((o) => {
      const opt = document.createElement('option');
      opt.value = o.opponent_lower;
      list.appendChild(opt);
    });
  }
}

async function loadPlayersDatalist() {
  const players = await api('known_players', { limit: 60 });
  const list = $('#players-list');
  list.innerHTML = '';
  players.forEach((p) => {
    const opt = document.createElement('option');
    opt.value = p.player;
    opt.label = `${p.games} games`;
    list.appendChild(opt);
  });
}

/*
 * Fill the variant dropdown from the modes actually in the database.
 *
 * Kept in `state.variants` as well, because the tree views need to know whether
 * the chosen mode is position-indexed before they can explain an empty panel.
 */
async function loadVariants() {
  let variants = [];
  try {
    variants = await api('variants');
  } catch {
    // A missing list is not worth a toast: the select still offers Standard,
    // which is what every view defaults to anyway.
  }
  state.variants = variants;
  const sel = $('#f-variant');
  const keep = sel.value;
  sel.innerHTML = '';

  const add = (value, text) => {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = text;
    sel.appendChild(opt);
  };

  const standard = variants.find((v) => v.key === 'standard');
  add('', standard ? `Standard (${standard.games.toLocaleString()})` : 'Standard');
  const others = variants.filter((v) => v.key !== 'standard');
  for (const v of others) add(v.key, `${v.label} (${v.games.toLocaleString()})`);
  // Only worth offering once there is something else to mix in.
  if (others.length) add('any', 'Any variant');

  sel.value = keep;
  if (sel.selectedIndex < 0) sel.value = '';
  // Nothing but standard games means nothing to choose between.
  sel.closest('.f').classList.toggle('hidden', !others.length);
}

/** Is the filtered variant one the position index covers? */
function variantIsIndexed() {
  const key = $('#f-variant') ? $('#f-variant').value : '';
  if (!key) return true;                     // blank is standard
  if (key === 'any') return false;           // a mixed set cannot all be indexed
  const found = (state.variants || []).find((v) => v.key === key);
  return !!(found && found.indexed);
}

/** The chosen variant's display name, for messages about it. */
function variantLabel() {
  const key = $('#f-variant') ? $('#f-variant').value : '';
  if (key === 'any') return 'Any variant';
  const found = (state.variants || []).find((v) => v.key === key);
  return found ? found.label : 'Standard';
}

/* ---------------- explorer ---------------- */

let explorerBoard = null;

function ensureExplorerBoard() {
  if (!explorerBoard) {
    explorerBoard = createAnalysisBoard({
      host: $('#explorer-board-host'),
      getFilter: () => state.filter,
      onChange: (data, board) => {
        renderTreePanel(data, board, {
          total: $('#ex-total'),
          tree: $('#explorer-tree'),
          games: $('#explorer-games'),
        });
        // The board drives both readings of the position, so the titled tab
        // follows the same moves without any separate navigation.
        loadTitled(board);
        // Fires on every reload, which is what keeps the review bar honest
        // when the loaded game is cut away underneath it.
        renderReviewBar();
      },
      // Fires whenever the arrows change — including when a slow evaluation
      // finally lands, long after the tables were drawn.
      onArrows: markArrows,
    });
  }
  return explorerBoard;
}

async function loadExplorer() {
  readFilter();
  const board = ensureExplorerBoard();
  board.setOrientation(state.filter.color);
  // First visit starts a line at the initial position; later visits keep
  // whatever line is on the board and just re-run the filtered query.
  if (!board.data) await board.setPosition(null);
  else await board.reload();
}

/* Renders the database side of a position — the continuations table and the
 * games that reached it. Shared by the Explorer and the Positions view's
 * analysis panel so the two stay identical. */
let treeGamesToken = 0;

/*
 * A move in a continuations table, dotted in the colour of the arrow the board
 * is drawing for it. Carrying the colour into the table is what makes the
 * arrows legible without a legend: the row and the arrow are visibly the same
 * thing.
 *
 * The dot is applied separately by markArrows() rather than here, because the
 * table is built as soon as the position loads while the engine's arrows only
 * appear a second later — so the marks have to be re-applied when they do.
 */
function sanCell(row) {
  const span = el('span', 'san', row.san);
  if (row.uci) span.dataset.uci = row.uci;
  return span;
}

const ARROW_TITLES = {
  best: 'Drawn on the board as the dark green arrow — the engine’s best move',
  second: 'Drawn on the board as the pale green arrow — the engine’s second choice',
  played: 'Drawn on the board as the blue arrow — what was played from here',
};

/** Colour every move in a table that has an arrow on the board right now. */
function markArrows(kindFor) {
  if (!kindFor) return;
  $$('#explorer-tree .san[data-uci], #tp-tree .san[data-uci]').forEach((span) => {
    const kind = kindFor(span.dataset.uci);
    ['best', 'second', 'played'].forEach((k) => span.classList.remove('arrow-' + k));
    if (kind) {
      span.classList.add('arrow-' + kind);
      span.title = ARROW_TITLES[kind];
    } else {
      span.removeAttribute('title');
    }
  });
}

/**
 * Who played the arrowed move, said plainly.
 *
 * `by_player` is how many of those games it was the focused player's own move;
 * the rest were played against them. All, none, or a mix — and the mix is
 * common enough (any position reachable from both sides of the board) that it
 * needs its own wording rather than being rounded to whichever is larger.
 *
 * `who` names the player when it is not the user — the titled-player panel asks
 * exactly the same question about somebody else, and got it wrong the same way.
 * `noneLabel` is what to say when nobody is in focus and the move belongs to a
 * whole corpus rather than to a person.
 */
function playedCase(top) {
  const mine = top.by_player;
  if (mine == null) return 'none';
  if (mine === 0) return 'against';
  if (mine === top.games) return 'own';
  return 'mixed';
}

/**
 * Short wording for the arrow guide.
 *
 * Deliberately free of "(as White)". Naming the side to move next to "against
 * you" read as though *you* were White — the parenthetical attached to the
 * wrong noun. Which colour is moving is on the board anyway; whose move it was
 * is the thing this has to get across, so it says only that.
 */
function playedByLabel(top, data, who, noneLabel) {
  const you = who || 'you';
  const poss = who ? `${who}’s` : 'your';
  switch (playedCase(top)) {
    case 'none':    return noneLabel || 'Most played here';
    case 'against': return `What ${poss} opponents played most here`;
    case 'own':     return `What ${you} played most often here`;
    default:        return `Most played here — partly ${poss}, partly their opponents’`;
  }
}

/** The same fact as a full sentence, for the arrow's tooltip. */
function playedByTitle(top, data, who) {
  const total = top.games;
  const mine = top.by_player;
  const side = data.turn === 'white' ? 'White' : 'Black';
  const other = data.turn === 'white' ? 'Black' : 'White';
  const you = who || 'you';
  const at = who || 'you';
  switch (playedCase(top)) {
    case 'none':
      return `${top.san} was played here ${total} time(s)`;
    case 'against':
      return `${top.san} was played against ${at} here ${total} time(s) — it is `
        + `${side} to move and ${at} had ${other}, so none of them were theirs`;
    case 'own':
      return `${you} played ${top.san} here ${total} time(s), with ${side}`;
    default:
      return `${top.san} was played here ${total} time(s): ${mine} by ${you} `
        + `with ${side}, ${total - mine} against ${at}`;
  }
}

/**
 * Wording for when this move is also one the engine picked.
 *
 * There is no separate arrow in that case, so this is appended to the engine's
 * own row rather than given a row of its own — three legend entries for two
 * arrows on the board is what made the guide look wrong.
 */
function playedAgreeNote(top, who) {
  const poss = who ? `${who}’s` : 'your';
  switch (playedCase(top)) {
    case 'none':    return 'also the most played here';
    case 'against': return `also what ${poss} opponents played most here`;
    case 'own':     return `also ${poss} most played here`;
    default:        return 'also the most played here';
  }
}

function renderTreePanel(data, board, els) {
  els.total.textContent = `— ${data.total_games} game(s) reached this position`;

  /*
   * Only standard games are position-indexed — replaying an Atomic or Chess960
   * move list on a standard board would be nonsense, so ingest never does it.
   * That means the tree has genuinely nothing to show for those modes, and an
   * empty panel would read as "you have never played this position" rather than
   * "this view cannot answer that". Say which it is.
   */
  if (!variantIsIndexed()) {
    els.total.textContent = `— ${variantLabel()} games are not in the position index`;
    els.total.title = 'Openings are indexed by replaying moves on a standard '
      + 'board, which does not work for other game modes. Those games are still '
      + 'in the Games list, the Dashboard and Head-to-head.';
  } else {
    els.total.removeAttribute('title');
  }

  /*
   * The most common move from here, as an arrow on the board — and, crucially,
   * whose move it was.
   *
   * Whether it is yours depends on the position, not on the filter: at a
   * position where White is to move, it is your move only in the games you had
   * White. With Colour set to Both those games are mixed together, so the arrow
   * is often part yours and part your opponents', and one label cannot honestly
   * cover both. It used to say "what you played most often here" regardless,
   * which was wrong every time you were studying a position from the other
   * side of the board.
   */
  const top = data.children && data.children[0];
  board.setPlayedMove(top ? {
    uci: top.uci,
    san: top.san,
    label: playedByTitle(top, data, null),
    guideLabel: playedByLabel(top, data, null),
    agreeLabel: playedAgreeNote(top, null),
  } : null, 'mine');

  els.tree.innerHTML = '';
  els.tree.appendChild(buildTable(
    [
      { label: 'Move', render: (r) => sanCell(r) },
      { label: 'Games', key: 'games', num: true },
      {
        label: 'Share', num: true, render: (r) => fmtPct(r.share_pct),
        help: 'How often this move was played from this position.',
      },
      { label: '', render: (r) => wdlBar(r.wins, r.draws, r.losses) },
      {
        label: 'Your win %', num: true,
        help: `${WIN_HELP} Measured for the player in the filter bar.`,
        render: (r) => fmtPct(r.win_pct),
        cls: (r) => winClass(r.win_pct),
      },
      {
        label: 'White win %', num: true,
        help: `${WIN_HELP} Measured for White, whoever was playing it.`,
        render: (r) => fmtPct(r.white_win_pct),
      },
      { label: 'Avg opp', key: 'avg_opponent_elo', num: true,
        help: 'Average rating of the opponent in these games.' },
    ],
    data.children,
    {
      empty: data.is_game_over
        ? 'The game is over in this position.'
        : 'No games continue from here — you are off the book. Keep playing moves on the board to analyse further.',
      onRowClick: (r) => board.playSan(r.san),
    },
  ));
  markArrows(board.arrowKindFor);

  // The games list is a second round-trip, so a fast walk through the tree can
  // land an old response after a newer one. Token guards against that.
  const token = ++treeGamesToken;
  els.games.innerHTML = '';
  if (!data.total_games) return;
  api('games_at_position', { position_key: data.pos_key, filter: state.filter, limit: 60 })
    .then((games) => {
      if (token !== treeGamesToken) return;
      els.games.innerHTML = '';
      els.games.appendChild(gamesTable(games));
    })
    .catch(() => {});
}

/* ---------------- titled players ---------------- */

/*
 * The second reading of the position on the board: not "what have I played
 * here" but "what have strong players played here".
 *
 * It runs off a local corpus rather than an online opening explorer. Lichess's
 * explorer has been returning 401 to every third-party request since an
 * infrastructure incident in February 2026, so anything built on it would be
 * broken; downloading the players you care about also keeps working offline and
 * reuses the position index the app already maintains.
 */
let titledFocus = '';        // username to compare against, '' = everyone
let titledToken = 0;         // guards against an older response landing last

function titledName(p) {
  const label = p.title ? `${p.title} ${p.username}` : p.username;
  return p.real_name && p.real_name !== p.username
    ? `${label} — ${p.real_name}`
    : label;
}

async function loadTitled(board) {
  if (state.view !== 'explorer' || activeTab() !== 'titled') return;
  const data = board && board.data;
  if (!data) return;

  const token = ++titledToken;
  let out;
  try {
    out = await api('reference_explore', {
      fen: data.fen, moves: [], player: titledFocus || null, limit: 40,
    });
  } catch (e) {
    toast(e.message, true);
    return;
  }
  if (token !== titledToken) return;   // a newer position won

  // An empty library is a setup step, not a result — say so instead of showing
  // a table of nothing.
  const empty = !out.library || !out.library.games;
  $('#tp-empty').classList.toggle('hidden', !empty);
  $('#tp-body').classList.toggle('hidden', empty);
  $('#tp-hint').classList.toggle('hidden', empty);
  if (empty) { $('#tp-total').textContent = ''; return; }

  $('#tp-total').textContent =
    `— ${out.total_games} game(s) from ${out.library.players} player(s)`;

  renderTitledFocusOptions(out.players);
  renderTitledFocusNote(out);

  /*
   * What was actually played from here, as an arrow beside the engine's two.
   *
   * With a player in focus this is meant to be *their* move — the whole point
   * of studying someone's games is that the engine says what is best and the
   * arrow says what they chose, so the interesting positions are the ones where
   * those differ. That only holds where they were the side to move: their games
   * include both colours, so at a position with Black to move, the ones they
   * had White contribute their opponents' replies. Narrowing to their games is
   * not the same as narrowing to their moves, and the label used to claim it
   * was.
   */
  const top = out.children && out.children[0];
  const who = out.focus ? out.focus.username : null;
  board.setPlayedMove(top ? {
    uci: top.uci,
    san: top.san,
    label: playedByTitle(top, out, who),
    guideLabel: playedByLabel(top, out, who, 'Most played here in the library'),
    agreeLabel: playedAgreeNote(top, who),
  } : null, 'titled');

  $('#tp-tree').innerHTML = '';
  $('#tp-tree').appendChild(buildTable(
    [
      { label: 'Move', render: (r) => sanCell(r) },
      { label: 'Games', key: 'games', num: true },
      // Only meaningful with somebody in focus, and then it is the column the
      // rows are ordered by — so it has to be visible, or the order looks
      // arbitrary wherever it disagrees with Games.
      ...(out.focus ? [{
        label: 'Theirs', num: true, key: 'by_player',
        help: `Of those games, the ones where ${out.focus.username} was the `
            + 'player to move — the rest were played against them. The rows are '
            + 'ordered by this.',
      }] : []),
      {
        label: 'Share', num: true, render: (r) => fmtPct(r.share_pct),
        help: 'How often this move was played from this position.',
      },
      { label: '', render: (r) => wdlBar(r.white_wins, r.draws_total, r.black_wins) },
      {
        label: 'White win %', num: true,
        help: `${WIN_HELP} Measured for White — these are other people's games, `
            + 'so there is no "you" to measure.',
        render: (r) => fmtPct(r.white_win_pct),
      },
      { label: 'Avg rating', key: 'avg_elo', num: true,
        help: 'Average rating of the two players in these games.' },
    ],
    out.children,
    {
      empty: titledFocus
        ? 'This player has not reached this position in the games you hold.'
        : 'No titled game in your library reached this position. '
          + 'Add more players, or step back to an earlier position.',
      // Playing the move keeps both tabs in step, since the board drives both.
      onRowClick: (r) => board.playSan(r.san),
    },
  ));
  markArrows(board.arrowKindFor);

  $('#tp-players').innerHTML = '';
  $('#tp-players').appendChild(buildTable(
    [
      {
        label: 'Player',
        render: (r) => {
          const span = el('span', r.in_library ? 'lib-player' : null, titledName(r));
          if (!r.in_library) {
            span.title = 'An opponent in these games, not someone you added';
          }
          return span;
        },
      },
      { label: 'Games', key: 'games', num: true },
      {
        label: 'As', num: true,
        render: (r) => `${r.as_white}W / ${r.as_black}B`,
        help: 'How often they had each colour in this position.',
      },
      { label: '', render: (r) => wdlBar(r.wins, r.draws, r.losses) },
      {
        label: 'Win %', num: true, help: `${WIN_HELP} Measured for this player.`,
        render: (r) => fmtPct(r.win_pct),
        cls: (r) => winClass(r.win_pct),
      },
      { label: 'Last played', render: (r) => fmtDate(r.last_played) },
    ],
    out.players,
    {
      empty: 'Nobody in the library has reached this position.',
      onRowClick: (r) => setTitledFocus(r.username_lower, board),
    },
  ));

  $('#tp-games').innerHTML = '';
  $('#tp-games').appendChild(referenceGamesTable(out.games));
}

/* The focus selector is rebuilt from whoever actually reached this position, so
 * it never offers a player who would return nothing. The current focus is kept
 * even when they are not among them — otherwise stepping into a line they never
 * played would silently widen the comparison back to everyone. */
function renderTitledFocusOptions(players) {
  const sel = $('#tp-player');
  const wanted = titledFocus;
  sel.innerHTML = '';
  const all = document.createElement('option');
  all.value = '';
  all.textContent = 'Everyone in the library';
  sel.appendChild(all);

  const seen = new Set();
  players.forEach((p) => {
    if (seen.has(p.username_lower)) return;
    seen.add(p.username_lower);
    const opt = document.createElement('option');
    opt.value = p.username_lower;
    opt.textContent = `${titledName(p)} (${p.games})`;
    sel.appendChild(opt);
  });
  if (wanted && !seen.has(wanted)) {
    const opt = document.createElement('option');
    opt.value = wanted;
    opt.textContent = `${wanted} (0 here)`;
    sel.appendChild(opt);
  }
  sel.value = wanted;
}

/* Which colour the focused player had here decides whose moves the table is
 * showing — their own, or the replies they faced. */
function renderTitledFocusNote(out) {
  const note = $('#tp-focus-note');
  if (!out.player) { note.textContent = ''; return; }
  const f = out.focus;
  if (!f) {
    note.textContent = 'has not reached this position';
    return;
  }
  const turn = out.turn;
  const theirs = turn === 'white' ? f.as_white : f.as_black;
  note.textContent = theirs === f.games
    ? `${f.games} game(s) — ${turn} to play, so these are their moves`
    : theirs === 0
      ? `${f.games} game(s) — they had the other colour, so these are the replies they faced`
      : `${f.games} game(s), ${theirs} of them with ${turn} to play`;
}

function setTitledFocus(username, board) {
  titledFocus = username || '';
  $('#tp-player').value = titledFocus;
  loadTitled(board || explorerBoard);
}

/** One side of a game as it reads in a table: "GM Carlsen (2882)". */
function sideLabel(name, title, elo) {
  const bits = [title, name].filter(Boolean).join(' ');
  return elo ? `${bits} (${elo})` : bits || '?';
}

function referenceGamesTable(games) {
  return buildTable(
    [
      starColumn(),
      { label: 'Date', render: (r) => fmtDate(r.played_at) },
      { label: 'White', render: (r) => sideLabel(r.white_name, r.white_title, r.white_elo) },
      { label: 'Black', render: (r) => sideLabel(r.black_name, r.black_title, r.black_elo) },
      { label: 'Result', key: 'result', num: true },
      { label: 'Played', render: (r) => el('span', 'san', r.played_move || '—') },
      { label: 'TC', key: 'time_class' },
      {
        label: 'Link',
        render: (r) => {
          if (!r.url) return '—';
          const a = el('a', null, 'open');
          a.href = r.url; a.target = '_blank'; a.rel = 'noreferrer';
          a.style.color = 'var(--accent)';
          return a;
        },
      },
    ],
    games,
    { empty: 'No games to show.' },
  );
}

/* ---------------- explorer tabs ---------------- */

function activeTab() {
  const on = $('#ex-tabs .tab.on');
  return on ? on.dataset.tab : 'mine';
}

function switchTab(name) {
  $$('#ex-tabs .tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  $('#ex-panel-mine').classList.toggle('hidden', name !== 'mine');
  $('#ex-panel-titled').classList.toggle('hidden', name !== 'titled');
  // The "played" arrow follows the tab, so it always describes the panel you
  // are actually reading.
  if (explorerBoard) explorerBoard.setPlayedSource(name);
  if (name === 'titled') loadTitled(explorerBoard);
}

/* `opts.openable` makes each row open the game on the board. On for lists that
 * are lists of games to look at; off for the Explorer's "games through this
 * position", where a click would throw away the line you are exploring. */
function gamesTable(games, opts) {
  return buildTable(
    [
      starColumn(),
      { label: 'Date', render: (r) => fmtDate(r.played_at) },
      { label: 'White', key: 'white_name' },
      { label: 'Black', key: 'black_name' },
      { label: 'Result', key: 'result', num: true },
      {
        label: 'Outcome',
        render: (r) => {
          if (!r.outcome) return '—';
          const s = el('span', 'res-' + r.outcome, r.outcome);
          return s;
        },
      },
      { label: 'TC', key: 'time_class' },
      {
        label: 'Link',
        render: (r) => {
          if (!r.url) return '—';
          const a = el('a', null, 'open');
          a.href = r.url; a.target = '_blank'; a.rel = 'noreferrer';
          a.style.color = 'var(--accent)';
          a.addEventListener('click', (ev) => ev.stopPropagation());
          return a;
        },
      },
    ],
    games,
    {
      empty: 'No games to show.',
      onRowClick: opts && opts.openable ? (r) => openGameOnBoard(r) : null,
    },
  );
}

/* ---------------- positions ---------------- */

async function loadPositions() {
  const filter = readFilter();
  const minMove = Number($('#pos-minply').value) || 5;
  const maxMove = Number($('#pos-maxply').value) || 20;
  const sort = $('#pos-sort').value;
  const limit = Number($('#pos-limit').value) || 24;

  let rows = await api('common_positions', {
    filter,
    min_ply: (minMove - 1) * 2,
    max_ply: maxMove * 2,
    limit: sort === 'games' ? limit : Math.max(limit * 4, 120),
    min_games: Number($('#pos-mingames').value) || 3,
  });

  if (sort === 'worst') {
    rows = rows.filter((r) => r.win_pct != null)
      .sort((a, b) => a.win_pct - b.win_pct || b.games - a.games).slice(0, limit);
  } else if (sort === 'best') {
    rows = rows.filter((r) => r.win_pct != null)
      .sort((a, b) => b.win_pct - a.win_pct || b.games - a.games).slice(0, limit);
  }

  const grid = $('#positions-grid');
  grid.innerHTML = '';
  if (!rows.length) {
    grid.appendChild(el('p', 'muted', 'No repeated positions found. Try lowering "Min games" or widening the move range.'));
    return;
  }

  posEvalRun++; // stop any evaluation loop still running over the old cards

  // Thumbnails face the same way as the analysis board, so a position looks the
  // same whether you are scanning the grid or studying it.
  const flipped = filter.color === 'black';

  rows.forEach((r) => {
    const card = el('div', 'pos-card');
    card.dataset.fen = r.fen;
    const mini = el('div', 'board mini');
    renderBoard(mini, r.fen, flipped);
    card.appendChild(mini);

    const meta = el('div', 'meta');
    const left = el('span', 'g', `move ${r.move_number} · ${r.games} games`);
    const right = el('span');
    right.append(
      el('span', winClass(r.win_pct), fmtPct(r.win_pct)),
      el('span', 'eval-tag', ''),
    );
    meta.append(left, right);
    card.appendChild(meta);
    card.appendChild(wdlBar(r.wins, r.draws, r.losses));
    card.title = `${r.games} games · W${r.wins} D${r.draws} L${r.losses}\n`
      + 'Click to open it on a board you can play moves on';
    card.addEventListener('click', () => openPositionAnalysis(r));
    grid.appendChild(card);
  });

  $('#pos-eval-msg').textContent = '';
}

// Incremented whenever the grid is rebuilt, so a stale loop exits.
let posEvalRun = 0;

async function evaluateVisiblePositions() {
  const cards = $$('#positions-grid .pos-card');
  const btn = $('#pos-eval');
  const msg = $('#pos-eval-msg');
  if (!cards.length) return;

  cancelEval(); // don't compete with the explorer's auto-evaluation
  const run = ++posEvalRun;
  btn.disabled = true;
  let done = 0;

  for (const card of cards) {
    if (run !== posEvalRun) break; // grid was rebuilt underneath us
    msg.textContent = `Evaluating ${done + 1}/${cards.length}…`;
    try {
      // One line is enough for a thumbnail's score tag, and asking for three
      // would triple the search time across the whole grid.
      const ev = await api('evaluate', {
        fen: card.dataset.fen,
        multipv: 1,
        depth: Math.min(GRID_DEPTH, engineDepth()),
      });
      const res = formatEval(ev);
      const tag = card.querySelector('.eval-tag');
      tag.textContent = res.text;
      tag.className = 'eval-tag ' + res.cls;
    } catch (e) {
      msg.textContent = '';
      toast(e.message, true);
      btn.disabled = false;
      return;
    }
    done++;
  }

  if (run === posEvalRun) msg.textContent = `Evaluated ${done} position(s)`;
  btn.disabled = false;
}

/* The analysis panel that opens above the grid when a position card is clicked.
 * It is the same component the Explorer uses, so the position can be played on
 * without leaving the view that found it. */
let positionsBoard = null;

function ensurePositionsBoard() {
  if (!positionsBoard) {
    positionsBoard = createAnalysisBoard({
      host: $('#pos-board-host'),
      getFilter: () => state.filter,
      onChange: (data, board) => renderTreePanel(data, board, {
        total: $('#pos-an-total'),
        tree: $('#pos-an-tree'),
        games: $('#pos-an-games'),
      }),
    });
  }
  return positionsBoard;
}

async function openPositionAnalysis(pos) {
  readFilter();
  const panel = $('#pos-analysis');
  panel.classList.remove('hidden');
  $('#pos-an-title').textContent =
    `move ${pos.move_number}, ${pos.turn} to play · ${pos.games} game(s)`;
  const board = ensurePositionsBoard();
  board.setOrientation(state.filter.color);
  // A position arrives as a FEN with no move history, so it becomes the root of
  // a new line rather than a step in an existing one.
  await board.setPosition(pos.fen);
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ---------------- head to head ---------------- */

async function loadH2H() {
  const player = $('#h2h-player').value.trim();
  const opponent = $('#h2h-opponent').value.trim();
  const out = $('#h2h-out');
  out.innerHTML = '';
  if (!player || !opponent) {
    out.appendChild(el('p', 'muted', 'Enter both a player and an opponent.'));
    return;
  }

  const base = readFilter();
  delete base.player;
  delete base.opponent;
  delete base.color;

  let data;
  try {
    data = await api('head_to_head', { player, opponent, filter: base });
  } catch (e) {
    toast(e.message, true);
    return;
  }

  const t = data.total;
  const cards = el('div', 'cards');
  const mkCard = (k, v, s) => {
    const c = el('div', 'card');
    c.append(el('div', 'k', k), el('div', 'v', v), el('div', 's', s || ''));
    return c;
  };
  const winCard = mkCard('Win rate', fmtPct(t.win_pct),
    `${t.wins} of ${t.games} games`);
  winCard.title = WIN_HELP;
  cards.append(
    mkCard('Games played', String(t.games), `${fmtDate(t.first_game)} → ${fmtDate(t.last_game)}`),
    mkCard('Record', `${t.wins}–${t.losses}–${t.draws}`, 'W–L–D for ' + player),
    winCard,
  );
  out.appendChild(cards);

  if (t.by_color) {
    const p1 = el('div', 'panel');
    p1.appendChild(el('h2', null, 'By colour'));
    p1.appendChild(buildTable(
      [{ label: '', key: 'label' }, ...recordColumns()],
      [
        { label: `${player} as White`, ...t.by_color.white },
        { label: `${player} as Black`, ...t.by_color.black },
      ],
    ));
    out.appendChild(p1);
  }

  const p2 = el('div', 'panel');
  p2.appendChild(el('h2', null, 'By time control'));
  p2.appendChild(buildTable(
    [{ label: 'Time control', key: 'time_class' }, ...recordColumns()],
    data.by_time_control,
    { empty: 'No games between these two players.' },
  ));
  p2.appendChild(el('h3', null, 'By exact clock'));
  p2.appendChild(buildTable(
    [
      { label: 'Clock', key: 'clock' },
      { label: 'Class', key: 'time_class' },
      ...recordColumns(),
    ],
    data.by_clock,
    { empty: '—' },
  ));
  out.appendChild(p2);

  const p3 = el('div', 'panel');
  p3.appendChild(el('h2', null, `Games (${data.games.length})`));
  const wrap = el('div', 'scroll-y');
  wrap.appendChild(gamesTable(data.games, { openable: true }));
  p3.appendChild(wrap);
  out.appendChild(p3);
}

/* ---------------- openings ---------------- */

/* No ECO codes here. They are a library filing system — several codes share one
 * opening name and several names share one code — so the column said nothing
 * about how the opening was played and only crowded out the numbers that do. */
async function loadOpenings() {
  const filter = readFilter();
  const rows = await api('by_opening', { filter, limit: 60 });
  const out = $('#openings-out');
  out.innerHTML = '';
  out.appendChild(buildTable(
    [
      { label: 'Opening', key: 'opening' },
      ...recordColumns(),
      { label: 'Last played', render: (r) => fmtDate(r.last_played) },
    ],
    rows,
    {
      empty: 'No games match the current filter.',
      onRowClick: (r) => showOpeningDetail(r.opening),
    },
  ));
}

/* Which opening the detail panel is showing, so the depth selector can
 * re-query without the caller having to pass it back in. */
let openingShown = null;
/* And which side it belongs to, so a line opened from it faces the right way. */
let openingSide = 'white';

/*
 * Whose opening is this?
 *
 * An opening is a choice one colour makes — a Sicilian is Black's — so a line
 * from it should be shown from that side of the board, not always from White's.
 *
 * The games themselves answer it: whichever colour the filtered player had in
 * them is the side they play it from. Without a player to measure, fall back on
 * the naming convention, where a defence is what Black answers with and an
 * accepted or declined gambit is Black's decision too.
 */
function sideForOpening(name, playedAs) {
  if (playedAs === 'white' || playedAs === 'black') return playedAs;
  return /defen[cs]e|gambit (accepted|declined)|counter/i.test(name || '')
    ? 'black'
    : 'white';
}

async function showOpeningDetail(opening) {
  openingShown = opening;
  const panel = $('#opening-detail');
  panel.classList.remove('hidden');
  // The list is long enough to have scrolled the panel out of view.
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('#op-name').textContent = opening;
  $('#op-lines').innerHTML = '';
  $('#op-summary').textContent = 'Loading…';

  let data;
  try {
    data = await api('opening_lines', {
      filter: readFilter(),
      opening,
      max_plies: Number($('#op-depth').value) || 4,
      limit: 12,
    });
  } catch (e) {
    $('#op-summary').textContent = '';
    toast(e.message, true);
    return;
  }
  if (openingShown !== opening) return; // a newer click won

  openingSide = sideForOpening(opening, data.played_as);

  const shared = data.common_prefix.san_line;
  const summary = $('#op-summary');
  summary.innerHTML = '';
  summary.append(document.createTextNode(`${data.games} game(s)`));
  // Say which side, because it is also what decides how the board is turned
  // when a move order is opened.
  if (data.played_as) {
    summary.append(document.createTextNode(
      `, ${data.played_as_games} of them as ${data.played_as}`));
  }
  summary.append(document.createTextNode('. '));
  if (shared) {
    summary.append(document.createTextNode('Every one of them starts '));
    const b = el('b', 'san', shared);
    summary.appendChild(b);
    summary.append(document.createTextNode(' — that is what defines this opening here.'));
  }

  $('#op-lines').appendChild(buildTable(
    [
      { label: 'Move order', render: (r) => el('span', 'san', r.san_line) },
      { label: 'Games', key: 'games', num: true },
      { label: 'W', key: 'wins', num: true },
      { label: 'L', key: 'losses', num: true },
      { label: 'D', key: 'draws', num: true },
      { label: '', render: (r) => wdlBar(r.wins, r.draws, r.losses) },
      {
        label: 'Win %', num: true, help: WIN_HELP,
        render: (r) => fmtPct(r.win_pct),
        cls: (r) => winClass(r.win_pct),
      },
    ],
    data.lines,
    {
      empty: 'No move orders recorded — these games have no move list stored.',
      onRowClick: (r) => openLineInExplorer(r.uci, r.san),
    },
  ));
}

/**
 * Load a concrete move order onto the Explorer board and switch to it.
 *
 * Faced from the side that plays the opening, overriding the colour filter:
 * looking at a Sicilian from White's side of the board is the wrong way round
 * even when no colour is filtered on.
 */
function openLineInExplorer(uci, san) {
  if (!uci || !uci.length) return;
  switchView('explorer');
  const board = ensureExplorerBoard();
  board.setOrientation(openingSide, true);
  board.setLine(uci.map((u, i) => ({ uci: u, san: (san && san[i]) || u })));
}

/* ---------------- games ---------------- */

/*
 * Which move of a game was the high-water mark of the player's advantage, if
 * this is one of the games they threw away.
 *
 * Opening such a game at move one would mean walking forty moves to reach the
 * point of interest. The position where you were winning is the point.
 */
function thrownPeak(game) {
  const from = state.filter.threw_from;
  const me = (state.filter.player || '').toLowerCase();
  if (!from || !me) return null;
  if (game.white_lower === me && game.peak_white_adv >= from) {
    return { adv: game.peak_white_adv, ply: game.peak_white_ply };
  }
  if (game.black_lower === me && game.peak_black_adv >= from) {
    return { adv: game.peak_black_adv, ply: game.peak_black_ply };
  }
  return null;
}

/* The scan has to have run for the "threw it away" filter to see a game. Said
 * here rather than in Settings, because here is where it is missed. */
async function refreshSwingStrip() {
  const strip = $('#games-scan');
  let st;
  try {
    st = await api('swing_status');
  } catch {
    strip.classList.add('hidden');
    return;
  }
  if (!st.pending) { strip.classList.add('hidden'); strip.innerHTML = ''; return; }

  strip.innerHTML = '';
  strip.classList.remove('hidden');
  strip.append(el('span', null,
    `${st.pending.toLocaleString()} of your games have not been checked for `
    + 'material swings yet, so "Threw it away" cannot see them.'));
  const btn = el('button', 'primary', 'Scan now');
  btn.title = 'Replays your stored games to work out who was winning in each. '
    + 'Seconds, not minutes — the titled-player library is left alone.';
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      await api('start_swing_scan');
      startSyncPolling();
    } catch (e) {
      btn.disabled = false;
      toast(e.message, true);
    }
  });
  strip.appendChild(btn);
}

async function loadGames() {
  const filter = readFilter();
  const rows = await api('games', {
    filter, limit: state.gamesLimit, offset: state.gamesOffset,
  });
  refreshSwingStrip();

  if (filter.threw_from && !filter.player) {
    toast('"Threw it away" needs a name in the Player box', true);
  }

  const out = $('#games-out');
  out.innerHTML = '';
  out.appendChild(buildTable(
    [
      starColumn(),
      { label: 'Date', render: (r) => fmtDate(r.played_at) },
      { label: 'White', render: (r) => `${r.white_name || '?'}${r.white_elo ? ' (' + r.white_elo + ')' : ''}` },
      { label: 'Black', render: (r) => `${r.black_name || '?'}${r.black_elo ? ' (' + r.black_elo + ')' : ''}` },
      { label: 'Result', key: 'result', num: true },
      {
        label: 'Outcome',
        render: (r) => (r.outcome ? el('span', 'res-' + r.outcome, r.outcome) : '—'),
      },
      { label: 'Clock', render: (r) => clockLabel(r.base_seconds, r.increment_seconds) },
      { label: 'TC', key: 'time_class' },
      { label: 'Moves', render: (r) => (r.ply_count ? Math.ceil(r.ply_count / 2) : '—'), num: true },
      // Only while the filter is on, and then it is the whole reason the row is
      // here: how far ahead you were, and when.
      ...(filter.threw_from ? [{
        label: 'Was winning', cls: () => 'nowrap',
        help: 'The biggest material lead you held for at least three moves, '
            + 'and the move it started at. Clicking the row opens it there.',
        render: (r) => {
          const peak = thrownPeak(r);
          return peak ? `+${peak.adv} at move ${Math.floor(peak.ply / 2) + 1}` : '—';
        },
      }] : []),
      {
        label: 'Link',
        render: (r) => {
          if (!r.url) return '—';
          const a = el('a', null, 'open');
          a.href = r.url; a.target = '_blank'; a.rel = 'noreferrer';
          a.style.color = 'var(--accent)';
          // The row opens the game on our own board; the link goes to the site.
          a.addEventListener('click', (ev) => ev.stopPropagation());
          return a;
        },
      },
    ],
    rows,
    {
      onRowClick: (r) => {
        const peak = thrownPeak(r);
        openGameOnBoard(r, peak ? { at: peak.ply } : null);
      },
    },
  ));
  $('#games-page').textContent =
    `${state.gamesOffset + 1}–${state.gamesOffset + rows.length}`;
  $('#games-prev').disabled = state.gamesOffset === 0;
  $('#games-next').disabled = rows.length < state.gamesLimit;
}

/* ---------------- favourites ---------------- */

/*
 * Starring a game saves it under a name you type.
 *
 * The name is the whole point. A game is remembered as "the h-pawn mate against
 * Anders", not as row 41,207 played on a Tuesday, and nothing in the PGN
 * records that — so it is the one thing this stores. Everything else the list
 * shows is joined from the game itself, which means a resync that corrects a
 * rating corrects it here too.
 */

function suggestName(game) {
  const white = game.white_name || '?';
  const black = game.black_name || '?';
  const date = fmtDate(game.played_at);
  return date === '—' ? `${white} vs ${black}` : `${white} vs ${black}, ${date}`;
}

/** The line under the dialog's title: enough to be sure it is the right game. */
function describeGame(game) {
  return [suggestName(game), game.opening, game.result].filter(Boolean).join(' · ');
}

async function loadFavouriteIds() {
  try {
    state.favourites = new Set(await api('favourite_ids'));
  } catch {
    // Leaves the stars hollow. Starring still works; it just cannot show what
    // is already saved, which is better than failing to draw the table.
  }
  paintStars();
}

function paintStar(btn) {
  const on = state.favourites.has(Number(btn.dataset.game));
  btn.classList.toggle('on', on);
  btn.textContent = on ? '★' : '☆';
  btn.title = on
    ? 'Saved in Favourites — click to remove'
    : 'Save this game to Favourites under a name';
}

/* Every star on screen, re-painted from the one Set — a game unstarred in the
 * Favourites view goes hollow in the Games table behind it. */
function paintStars() {
  $$('.star[data-game]').forEach(paintStar);
}

function favStar(game) {
  const btn = el('button', 'star');
  btn.type = 'button';
  btn.dataset.game = String(game.id);
  // Painted on creation, not by a later sweep: a table built after the ids are
  // known would otherwise draw every star hollow until something repaints it.
  paintStar(btn);
  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();   // the row underneath may open the game
    if (state.favourites.has(game.id)) unfavourite(game.id);
    else favouriteGame(game);
  });
  return btn;
}

/** The star column every games table carries, wherever a game is listed. */
const starColumn = () => ({
  label: '★',
  help: 'Star a game to save it in Favourites under a name of your own.',
  render: (r) => (r.id == null ? '—' : favStar(r)),
});

async function favouriteGame(game) {
  const name = await askName({
    title: 'Name this game',
    sub: describeGame(game),
    value: suggestName(game),
  });
  if (name == null) return;   // cancelled
  try {
    const fav = await api('favourite_add', { game_id: game.id, name });
    state.favourites.add(game.id);
    paintStars();
    toast(`Saved as "${fav.name}"`);
    if (state.reviewing && state.reviewing.id === game.id) {
      state.reviewing.name = fav.name;
      renderReviewBar();
    }
    if (state.view === 'favourites') loadFavourites();
  } catch (e) {
    toast(e.message, true);
  }
}

async function unfavourite(gameId) {
  try {
    await api('favourite_remove', { game_id: gameId });
    state.favourites.delete(gameId);
    paintStars();
    toast('Removed from Favourites');
    if (state.reviewing && state.reviewing.id === gameId) {
      delete state.reviewing.name;
      renderReviewBar();
    }
    if (state.view === 'favourites') loadFavourites();
  } catch (e) {
    toast(e.message, true);
  }
}

/* The app's own prompt(). window.prompt is not reliably available in the
 * WebView2 host the packaged app runs in, and naming a game is the one thing
 * this feature cannot do without. Resolves to the typed string, or null if the
 * dialog was cancelled. */
let askResolve = null;

function askName(opts) {
  const dlg = $('#fav-dialog');
  $('#fav-dialog-title').textContent = opts.title || 'Name this game';
  $('#fav-dialog-sub').textContent = opts.sub || '';
  const input = $('#fav-name');
  input.value = opts.value || '';
  dlg.classList.remove('hidden');
  input.focus();
  input.select();
  return new Promise((resolve) => {
    // Opening a second dialog over the first would strand its caller waiting
    // on a promise nothing can settle.
    if (askResolve) askResolve(null);
    askResolve = resolve;
  });
}

function closeAsk(value) {
  $('#fav-dialog').classList.add('hidden');
  const resolve = askResolve;
  askResolve = null;
  if (resolve) resolve(value);
}

async function loadFavourites() {
  const search = $('#fav-search').value.trim();
  // Whose win or loss each game was. The filter bar is hidden on this view, but
  // the player it names is still the best answer to "who am I looking at".
  const player = ($('#f-player').value.trim() || state.me[0] || '').toLowerCase();

  let rows;
  try {
    rows = await api('favourites', {
      search: search || null, player: player || null, limit: 300,
    });
  } catch (e) {
    toast(e.message, true);
    return;
  }

  // The list is authoritative about what is starred, so trust it over whatever
  // the Set picked up while other views were open.
  if (!search) state.favourites = new Set(rows.map((r) => r.game_id));

  $('#fav-count').textContent = rows.length ? `— ${rows.length} game(s)` : '';

  const out = $('#fav-out');
  out.innerHTML = '';
  out.appendChild(buildTable(
    [
      starColumn(),
      { label: 'Name', render: (r) => el('b', 'fav-name', r.name) },
      // The name and the opening are the only columns worth wrapping; a date
      // broken across two lines just makes the row taller and harder to scan.
      { label: 'Date', render: (r) => fmtDate(r.played_at), cls: () => 'nowrap' },
      {
        label: 'White', cls: () => 'nowrap',
        render: (r) => sideLabel(r.white_name, r.white_title, r.white_elo),
      },
      {
        label: 'Black', cls: () => 'nowrap',
        render: (r) => sideLabel(r.black_name, r.black_title, r.black_elo),
      },
      { label: 'Result', key: 'result', num: true },
      {
        label: 'Outcome',
        render: (r) => (r.outcome ? el('span', 'res-' + r.outcome, r.outcome) : '—'),
      },
      { label: 'TC', key: 'time_class' },
      { label: 'Opening', key: 'opening' },
      { label: 'Saved', render: (r) => fmtDate(r.added_at), cls: () => 'nowrap' },
      { label: '', render: (r) => favActions(r) },
    ],
    rows,
    {
      empty: search
        ? `Nothing saved matches "${search}".`
        : 'No favourites yet. Press the star beside a game — in Games, '
          + 'Head-to-head or the Explorer — and it appears here under the '
          + 'name you give it.',
      onRowClick: (r) => openGameOnBoard(r),
    },
  ));
  paintStars();
}

function favActions(fav) {
  const wrap = el('span', 'fav-actions');

  const open = el('button', 'ghost', 'Open');
  open.title = 'Replay the whole game on the Explorer board';
  open.addEventListener('click', (ev) => {
    ev.stopPropagation();
    openGameOnBoard(fav);
  });

  const ren = el('button', 'ghost', 'Rename');
  ren.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    const name = await askName({
      title: 'Rename', sub: describeGame(fav), value: fav.name,
    });
    if (name == null) return;
    if (!name.trim()) return toast('A favourite needs a name', true);
    try {
      await api('favourite_rename', { game_id: fav.game_id, name });
      loadFavourites();
    } catch (e) {
      toast(e.message, true);
    }
  });

  const del = el('button', 'ghost', 'Remove');
  del.title = 'Takes it out of Favourites. The game itself is untouched.';
  del.addEventListener('click', (ev) => {
    ev.stopPropagation();
    unfavourite(fav.game_id);
  });

  wrap.append(open, ren, del);
  return wrap;
}

/** Which side "you" had in a game — the filter's player first, then your own
 *  identities. Null when neither played it. */
function myColour(game) {
  const names = [$('#f-player').value.trim(), ...(state.me || [])]
    .filter(Boolean).map((s) => s.toLowerCase());
  if (names.includes(game.white_lower)) return 'white';
  if (names.includes(game.black_lower)) return 'black';
  return null;
}

/**
 * Replay a whole stored game on the Explorer board.
 *
 * Faced from the side you had, which is the only way a game of your own is
 * worth reviewing — and the engine, the arrows and the continuations tables all
 * come with it, because it is the same board the Explorer always uses.
 *
 * Opened at move one rather than at the final position: a game is reviewed
 * forwards, and landing on the last move puts the board somewhere the engine
 * immediately queues a continuation of its own, which reads like part of the
 * game. The whole move list is right there to click, and End jumps to the
 * finish. `opts.at` overrides that — a game you threw away opens at the
 * position you threw.
 */
async function openGameOnBoard(game, opts) {
  let line;
  try {
    line = await api('game_line', { game_id: game.game_id || game.id });
  } catch (e) {
    return toast(e.message, true);
  }
  if (!line.moves.length) {
    return toast('No move list is stored for this game.', true);
  }
  switchView('explorer');
  const board = ensureExplorerBoard();
  // Kept so the review bar can name the game and offer to star it — a game is
  // most obviously worth keeping while you are looking at it.
  state.reviewing = { ...game, id: game.game_id || game.id };
  board.setOrientation(myColour(line) || 'white', true);
  board.setLine(line.moves, { markEnd: 'the game', at: (opts && opts.at) || 0 });
}

/*
 * The strip above the board: which game is being reviewed, and a star for it.
 *
 * Whether a game is still on the board is the board's own answer, not a flag
 * kept here — playing a different move at move 12 cuts the game away, and the
 * bar has to stop claiming otherwise.
 */
function renderReviewBar() {
  const bar = $('#review-bar');
  const game = state.reviewing;
  const board = explorerBoard;
  const live = !!game && !!board
    && Number.isFinite(board.lineEnd) && board.lineEnd > 0;

  if (!live) {
    state.reviewing = null;
    bar.classList.add('hidden');
    bar.innerHTML = '';
    return;
  }

  bar.innerHTML = '';
  bar.classList.remove('hidden');
  bar.appendChild(favStar(game));

  const label = el('span', 'review-label');
  const saved = state.favourites.has(game.id);
  label.append(el('b', null, saved && game.name ? game.name : 'Reviewing'));
  label.append(document.createTextNode(' ' + [
    `${game.white_name || '?'} vs ${game.black_name || '?'}`,
    fmtDate(game.played_at),
    game.result,
    game.time_class,
  ].filter((s) => s && s !== '—').join(' · ')));
  bar.appendChild(label);

  if (game.url) {
    const a = el('a', 'review-link', 'open on site ↗');
    a.href = game.url; a.target = '_blank'; a.rel = 'noreferrer';
    bar.appendChild(a);
  }

  const done = el('button', 'ghost review-done', 'Done');
  done.title = 'Stop reviewing this game and go back to exploring';
  done.addEventListener('click', () => {
    state.reviewing = null;
    board.setPosition(null);
  });
  bar.appendChild(done);
}

/* ---------------- theme ---------------- */

/* The single source of truth for the picker. Swatch colours mirror the CSS
 * variables in style.css: background, panel, accent, dark board square.
 * To add a theme: add its :root[data-theme="..."] block to style.css and one
 * row here. */
const THEMES = [
  { id: 'walnut',   label: 'Walnut',   note: 'warm dark',  swatch: ['#17140f', '#2c251c', '#e0a343', '#a2703f'] },
  { id: 'slate',    label: 'Slate',    note: 'cool dark',  swatch: ['#0f1418', '#212c38', '#57b6e8', '#6f8ba3'] },
  { id: 'midnight', label: 'Midnight', note: 'near-black', swatch: ['#0a0b12', '#1b1e2d', '#8b7dfa', '#5d5788'] },
  { id: 'forest',   label: 'Forest',   note: 'tournament', swatch: ['#101512', '#1f2b23', '#7fbf6a', '#6d8f5a'] },
  { id: 'nord',     label: 'Nord',     note: 'arctic',     swatch: ['#2e3440', '#434c5e', '#88c0d0', '#7b8ca3'] },
  { id: 'ocean',    label: 'Ocean',    note: 'deep teal',  swatch: ['#08171c', '#143038', '#45c2c8', '#5d8c92'] },
  { id: 'ember',    label: 'Ember',    note: 'charcoal',   swatch: ['#141212', '#272322', '#e07a3f', '#9e6a4d'] },
  { id: 'paper',    label: 'Paper',    note: 'light',      swatch: ['#f2efe9', '#ebe6dd', '#9a6b1f', '#b08a5c'] },
  { id: 'sepia',    label: 'Sepia',    note: 'light warm', swatch: ['#ece2cf', '#e2d6bf', '#8a6a2f', '#b38f5f'] },
  { id: 'contrast', label: 'Contrast', note: 'high vis',   swatch: ['#000000', '#1a1a1a', '#ffd400', '#595959'] },
  { id: 'dark',     label: 'Dark',     note: 'plain',     swatch: ['#121212', '#2a2a2a', '#4a9eff', '#6e6e6e'] },
  { id: 'light',    label: 'Light',    note: 'plain',     swatch: ['#ffffff', '#f0f0f0', '#0969da', '#9c9c9c'] },
];

const THEME_IDS = THEMES.map((t) => t.id);

/*
 * Board colours, chosen separately from the interface theme.
 *
 * Every theme already carries a pair of square colours, and for most people
 * that pairing is the point. But wanting a grey interface and a green board is
 * an ordinary preference, and tying the two together made it unreachable. The
 * default keeps the theme's own squares, so nobody's saved look changes.
 */
const BOARDS = [
  { id: 'theme',    label: 'Follow theme', note: 'default' },
  { id: 'wood',     label: 'Wood',     note: 'oak',       light: '#e3d3b0', dark: '#94764c' },
  { id: 'green',    label: 'Green',    note: 'club vinyl', light: '#ffffff', dark: '#769656' },
  { id: 'blue',     label: 'Blue',     note: 'cool',      light: '#dee3e6', dark: '#698aab' },
  { id: 'grey',     label: 'Grey',     note: 'neutral',   light: '#dcdcdc', dark: '#8f8f8f' },
  { id: 'marble',   label: 'Marble',   note: 'soft',      light: '#f0efe8', dark: '#a7a29a' },
  { id: 'purple',   label: 'Purple',   note: 'muted',     light: '#e6e0f0', dark: '#8878ad' },
  // `id` is what gets written to config.json, so it stays 'coral' even though
  // the colours are no longer coral — renaming it would orphan a saved
  // preference. The label is the part anyone actually reads.
  { id: 'coral',    label: 'Classic',  note: 'chess.com', light: '#f0d9b5', dark: '#b58863' },
  { id: 'ink',      label: 'Ink',      note: 'slate',     light: '#cfd4da', dark: '#4d5560' },
  { id: 'contrast', label: 'Contrast', note: 'high vis',  light: '#ffffff', dark: '#4a4a4a' },
];

const BOARD_IDS = BOARDS.map((b) => b.id);

function renderThemePicker() {
  const host = $('#theme-picker');
  if (!host || host.childElementCount) return; // build once
  THEMES.forEach((t) => {
    const btn = el('button', 'theme-swatch');
    btn.dataset.theme = t.id;

    const sw = el('span', 'sw');
    t.swatch.forEach((colour) => {
      const i = el('i');
      i.style.background = colour;
      sw.appendChild(i);
    });

    const nm = el('span', 'nm');
    nm.append(document.createTextNode(t.label + ' '), el('span', 'muted', t.note));

    btn.append(sw, nm);
    btn.addEventListener('click', async () => {
      applyTheme(t.id); // apply first so it feels instant
      try {
        await api('save_config', { patch: { theme: t.id } });
      } catch (e) {
        toast(e.message, true);
      }
    });
    host.appendChild(btn);
  });
}

function applyTheme(name) {
  const theme = THEME_IDS.includes(name) ? name : 'walnut';
  document.documentElement.setAttribute('data-theme', theme);
  // Scoped to the theme picker: the piece and board swatches share the class,
  // and an unscoped selector would clear their selection every time a theme is
  // applied.
  $$('#theme-picker .theme-swatch')
    .forEach((b) => b.classList.toggle('on', b.dataset.theme === theme));
  state.theme = theme;
}

/* ---------------- board colours ---------------- */

function renderBoardPicker() {
  const host = $('#board-picker');
  if (!host || host.childElementCount) return; // build once
  BOARDS.forEach((b) => {
    const btn = el('button', 'theme-swatch board-swatch');
    btn.dataset.board = b.id;

    // "Follow theme" has no colours of its own, so its preview is left to the
    // live variables and changes with the theme — which is exactly what it does.
    const prev = el('div', 'board-prev');
    if (b.id !== 'theme') prev.classList.add('fixed');
    ['l', 'd', 'd', 'l'].forEach((shade) => {
      const cell = el('div', 'cell');
      if (b.id !== 'theme') cell.style.background = shade === 'l' ? b.light : b.dark;
      else cell.classList.add(shade === 'l' ? 'from-light' : 'from-dark');
      prev.appendChild(cell);
    });

    const nm = el('span', 'nm');
    nm.append(document.createTextNode(b.label + ' '), el('span', 'muted', b.note));

    btn.append(prev, nm);
    btn.addEventListener('click', async () => {
      applyBoard(b.id);
      if (explorerBoard) explorerBoard.redraw();
      if (positionsBoard) positionsBoard.redraw();
      try {
        await api('save_config', { patch: { board: b.id } });
      } catch (e) {
        toast(e.message, true);
      }
    });
    host.appendChild(btn);
  });
}

function applyBoard(name) {
  const id = BOARD_IDS.includes(name) ? name : 'theme';
  // The attribute is removed rather than set to "theme": the CSS overrides are
  // keyed on its presence, so absence *is* "use whatever the theme chose".
  if (id === 'theme') document.documentElement.removeAttribute('data-board');
  else document.documentElement.setAttribute('data-board', id);
  $$('#board-picker .board-swatch')
    .forEach((b) => b.classList.toggle('on', b.dataset.board === id));
  state.board = id;
}

/* ---------------- piece set ---------------- */

function renderPiecePicker() {
  const host = $('#piece-picker');
  if (!host) return;
  host.innerHTML = '';

  PIECE_SETS.forEach((set) => {
    const btn = el('button', 'theme-swatch piece-swatch');
    btn.dataset.pieces = set.id;

    // Each preview is scoped by its own attribute so the swatch shows *its*
    // set, not whichever one happens to be active.
    const prev = el('div', 'prev');
    prev.setAttribute('data-pieces-preview', set.id);
    ['K', 'n', 'B', 'p'].forEach((letter) => {
      const cell = el('div', 'cell');
      cell.innerHTML = pieceHTML(letter, set.id);
      prev.appendChild(cell);
    });

    const nm = el('span', 'nm');
    nm.append(document.createTextNode(set.label + ' '), el('span', 'muted', set.note));
    // Searched against by the filter box; folder name included so a set can be
    // found by either the name shown or the name on disk.
    btn.dataset.search = `${set.label} ${set.id} ${set.note}`.toLowerCase();

    btn.append(prev, nm);
    btn.addEventListener('click', async () => {
      applyPieceSet(set.id);
      // The analysis boards draw themselves, so they need telling directly;
      // refreshView only rebuilds the current view's tables and thumbnails.
      if (explorerBoard) explorerBoard.redraw();
      if (positionsBoard) positionsBoard.redraw();
      refreshView();
      try {
        await api('save_config', { patch: { piece_set: set.id } });
      } catch (e) {
        toast(e.message, true);
      }
    });
    host.appendChild(btn);
  });

  $('#piece-count').textContent = `${PIECE_SETS.length} available`;
}

function filterPiecePicker(term) {
  const needle = (term || '').trim().toLowerCase();
  $$('#piece-picker .piece-swatch').forEach((b) => {
    b.classList.toggle('hidden', !!needle && !b.dataset.search.includes(needle));
  });
}

function applyPieceSet(name) {
  // Falls back to the first available set rather than a hard-coded id, so a
  // saved preference for a set that has since been removed still renders.
  const id = PIECE_SET_IDS.includes(name)
    ? name
    : (PIECE_SET_IDS.includes('cburnett') ? 'cburnett' : PIECE_SET_IDS[0]);
  document.documentElement.setAttribute('data-pieces', id);
  $$('.piece-swatch').forEach((b) => b.classList.toggle('on', b.dataset.pieces === id));
  state.pieceSet = id;
}

/* ---------------- settings ---------------- */

async function loadSettings() {
  const cfg = await api('get_config');
  state.config = cfg;
  applyTheme(cfg.theme);
  applyBoard(cfg.board);
  applyPieceSet(cfg.piece_set);

  const list = $('#accounts-list');
  list.innerHTML = '';
  if (!cfg.accounts.length) {
    list.appendChild(el('p', 'muted', 'No accounts yet. Add one below to start syncing.'));
  } else {
    list.appendChild(buildTable(
      [
        { label: 'Source', key: 'source' },
        { label: 'Username', key: 'username' },
        {
          label: '',
          render: (r) => {
            const b = el('button', 'ghost', 'Remove');
            b.addEventListener('click', async (ev) => {
              ev.stopPropagation();
              await api('remove_account', { source: r.source, username: r.username });
              toast('Account removed');
              loadSettings();
            });
            return b;
          },
        },
      ],
      cfg.accounts,
    ));
  }

  $('#me-list').value = (cfg.me || []).join('\n');
  $('#eng-path').value = cfg.engine_path || '';
  $('#eng-depth').value = cfg.engine_depth;
  $('#eng-threads').value = cfg.engine_threads;
  $('#eng-hash').value = cfg.engine_hash_mb;
  $('#eng-multipv').value = cfg.engine_multipv;
  $('#idx-ply').value = cfg.max_indexed_ply;

  await loadLibrary();

  const status = await api('engine_status');
  const s = $('#engine-status');
  s.textContent = status.available
    ? `Engine ready: ${status.path}`
    : (status.hint || 'No engine configured.');
  s.style.color = status.available ? 'var(--win)' : 'var(--muted)';
}

/* ---------------- titled-player library ---------------- */

async function loadLibrary() {
  const [sum, players] = await Promise.all([
    api('library_summary'), api('library_players'),
  ]);

  $('#lib-summary').textContent = sum.games
    ? `${sum.games.toLocaleString()} game(s) from ${sum.players} player(s), `
      + `${fmtDate(sum.first_game)} → ${fmtDate(sum.last_game)}`
    : 'No reference games yet.';

  const list = $('#lib-list');
  list.innerHTML = '';
  if (!players.length) {
    list.appendChild(el('p', 'muted',
      'Nobody added yet. Magnus Carlsen plays as MagnusCarlsen on Chess.com '
      + 'and DrNykterstein on Lichess.'));
    return;
  }
  list.appendChild(buildTable(
    [
      { label: 'Title', key: 'title' },
      { label: 'Player', key: 'username' },
      { label: 'Name', render: (r) => r.real_name || '—' },
      { label: 'Source', key: 'source' },
      { label: 'Games', key: 'games', num: true },
      { label: 'Last updated', render: (r) => fmtDate(r.synced_at) },
      {
        label: '',
        render: (r) => {
          const wrap = el('span');
          const get = el('button', 'ghost', r.games ? 'Update' : 'Download');
          get.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            await api('start_library_sync', {
              source: r.source, username: r.username,
            });
            startSyncPolling();
          });
          const del = el('button', 'ghost', 'Remove');
          del.title = 'Removes the player and their games from the library';
          del.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            const out = await api('library_remove', {
              source: r.source, username: r.username,
            });
            toast(`Removed ${r.username} and ${out.removed_games} game(s)`);
            loadLibrary();
          });
          wrap.append(get, del);
          return wrap;
        },
      },
    ],
    players,
  ));
}

async function addLibraryPlayer(source, username) {
  $('#lib-msg').textContent = `Looking up ${username}…`;
  try {
    const p = await api('library_add', { source, username });
    $('#lib-msg').textContent = '';
    $('#lib-username').value = '';
    toast(`Added ${p.title || ''} ${p.username} — downloading their games`);
    await loadLibrary();
    // Downloading straight away, because a player with no games is a row that
    // does nothing and gives no hint that a second step is needed.
    await api('start_library_sync', { source, username: p.username });
    startSyncPolling();
  } catch (e) {
    $('#lib-msg').textContent = '';
    toast(e.message, true);
  }
}

async function searchLibrary() {
  const source = $('#lib-source').value;
  const query = $('#lib-search').value.trim();
  const title = $('#lib-title').value;
  const out = $('#lib-results');
  out.innerHTML = '';
  if (!query) return toast('Type part of a username first', true);

  $('#lib-msg').textContent = 'Searching…';
  let rows;
  try {
    rows = await api('library_search', { source, query, title, limit: 12 });
  } catch (e) {
    $('#lib-msg').textContent = '';
    return toast(e.message, true);
  }
  $('#lib-msg').textContent = '';
  out.appendChild(buildTable(
    [
      { label: 'Title', key: 'title' },
      { label: 'Username', key: 'username' },
      { label: 'Name', render: (r) => r.real_name || '—' },
      {
        label: '',
        render: (r) => {
          const b = el('button', 'ghost', 'Add');
          b.addEventListener('click', (ev) => {
            ev.stopPropagation();
            addLibraryPlayer(r.source, r.username);
          });
          return b;
        },
      },
    ],
    rows,
    { empty: `No ${title} accounts matched "${query}".` },
  ));
}

/* ---------------- sync ---------------- */

let syncPoll = null;

async function pollSync() {
  const st = await api('sync_status');
  $('#sync-msg').textContent = st.message || '';
  const log = $('#sync-log');
  if (st.log && st.log.length) {
    log.classList.remove('hidden');
    log.textContent = st.log.join('\n');
    log.scrollTop = log.scrollHeight;
  }
  if (!st.running) {
    clearInterval(syncPoll);
    syncPoll = null;
    $('#btn-sync').disabled = false;
    $('#btn-sync-full').disabled = false;
    $('#btn-import').disabled = false;
    if (st.error) toast('Sync failed: ' + st.error, true);
    else if (st.result) {
      const added = Object.values(st.result)
        .reduce((sum, r) => sum + (r.inserted || 0), 0);
      toast(`Sync complete — ${added} new game(s)`);
      await loadPlayersDatalist();
      await refreshView();
    }
  }
}

function startSyncPolling() {
  $('#btn-sync').disabled = true;
  $('#btn-sync-full').disabled = true;
  $('#btn-import').disabled = true;
  if (syncPoll) clearInterval(syncPoll);
  syncPoll = setInterval(pollSync, 700);
  pollSync();
}

/* ---------------- view switching ---------------- */

const LOADERS = {
  dashboard: loadDashboard,
  explorer: loadExplorer,
  positions: loadPositions,
  h2h: loadH2H,
  openings: loadOpenings,
  games: loadGames,
  favourites: loadFavourites,
  settings: loadSettings,
};

/** The analysis board the keyboard should drive, or null if none is showing. */
function activeBoard() {
  if (state.view === 'explorer') return explorerBoard;
  if (state.view === 'positions' && !$('#pos-analysis').classList.contains('hidden')) {
    return positionsBoard;
  }
  return null;
}

function switchView(name) {
  // Leaving a board behind should not leave an evaluation queued for it.
  if (activeBoard() && name !== state.view) cancelEval();
  state.view = name;
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  // Hidden where it would lie: Settings has nothing to filter, and a favourite
  // stays in its list whatever the filter bar says.
  $('#filterbar').classList.toggle('hidden', name === 'settings' || name === 'favourites');
}

async function refreshView() {
  const loader = LOADERS[state.view];
  if (!loader) return;
  try {
    await loader();
  } catch (e) {
    toast(e.message, true);
    console.error(e);
  }
}

/* ---------------- wiring ---------------- */

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/* Date N calendar months back, as YYYY-MM-DD in local time.
 * Built from the date parts rather than toISOString(), which would shift the
 * day across the UTC boundary for anyone east or west of Greenwich. */
function monthsAgoISO(months) {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function init() {
  renderThemePicker();
  renderBoardPicker();
  $('#piece-search').addEventListener('input', (e) => filterPiecePicker(e.target.value));

  $$('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      switchView(btn.dataset.view);
      refreshView();
    });
  });

  /*
   * Typed filters commit on Enter, or when you leave the box.
   *
   * They used to re-query on every keystroke, debounced. Half a username is a
   * valid filter that matches nothing, so typing "s1mplepie" flashed through
   * several empty results on the way — and each one was a full round of
   * queries. Enter is the deliberate moment; leaving the box counts as one too,
   * so a filter is never silently ignored.
   */
  const applyFilters = () => { state.gamesOffset = 0; refreshView(); };
  ['#f-player', '#f-opponent', '#f-minelo', '#f-maxelo'].forEach((sel) => {
    $(sel).addEventListener('change', applyFilters);   // fires on blur, if edited
    $(sel).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); applyFilters(); }
    });
  });
  ['#f-color', '#f-source', '#f-rated', '#f-threw', '#f-variant'].forEach((sel) =>
    $(sel).addEventListener('change', applyFilters));

  // Typing an explicit date means the preset buttons no longer describe the range.
  ['#f-since', '#f-until'].forEach((sel) =>
    $(sel).addEventListener('change', () => {
      $$('#f-period .chip').forEach((c) => c.classList.remove('on'));
      state.gamesOffset = 0;
      refreshView();
    }));

  $$('#f-tc .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      chip.classList.toggle('on');
      state.gamesOffset = 0;
      refreshView();
    });
  });

  // Period presets write into the From/To date inputs, which stay the single
  // source of truth for the filter.
  $$('#f-period .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      $$('#f-period .chip').forEach((c) => c.classList.remove('on'));
      chip.classList.add('on');
      const months = Number(chip.dataset.months);
      $('#f-since').value = months > 0 ? monthsAgoISO(months) : '';
      $('#f-until').value = '';
      state.gamesOffset = 0;
      refreshView();
    });
  });

  $('#more-filters').addEventListener('click', () => {
    $('#extra-filters').classList.toggle('hidden');
  });

  $('#reset-filters').addEventListener('click', () => {
    ['#f-player', '#f-opponent', '#f-minelo', '#f-maxelo', '#f-since', '#f-until']
      .forEach((s) => { $(s).value = ''; });
    ['#f-color', '#f-source', '#f-rated', '#f-threw', '#f-variant']
      .forEach((s) => { $(s).value = ''; });
    $$('#f-tc .chip').forEach((c) => c.classList.remove('on'));
    $$('#f-period .chip').forEach((c, i) => c.classList.toggle('on', i === 0));
    state.gamesOffset = 0;
    refreshView();
  });

  // Positions
  $('#pos-refresh').addEventListener('click', loadPositions);
  $('#pos-sort').addEventListener('change', loadPositions);
  $('#pos-eval').addEventListener('click', evaluateVisiblePositions);
  $('#pos-an-close').addEventListener('click', () => {
    $('#pos-analysis').classList.add('hidden');
    cancelEval();
  });

  // Keyboard navigation for whichever board is on screen. Skipped while a form
  // control has focus, so arrow keys still move the caret and change dropdowns.
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const t = e.target;
    if (t && (/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(t.tagName) || t.isContentEditable)) return;
    const board = activeBoard();
    if (!board) return;

    const actions = {
      ArrowLeft: 'back', ArrowRight: 'forward',
      ArrowUp: 'start', ArrowDown: 'end',
      Home: 'start', End: 'end',
      f: 'flip', F: 'flip',
    };
    const action = actions[e.key];
    if (!action) return;
    e.preventDefault();
    board.act(action);
  });

  // Explorer tabs
  $$('#ex-tabs .tab').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
  $('#tp-player').addEventListener('change', (e) => {
    setTitledFocus(e.target.value, explorerBoard);
  });
  $('#tp-goto-settings').addEventListener('click', () => {
    switchView('settings');
    refreshView();
  });

  // Titled-player library
  $('#lib-add').addEventListener('click', () => {
    const username = $('#lib-username').value.trim();
    if (!username) return toast('Enter a username', true);
    addLibraryPlayer($('#lib-source').value, username);
  });
  $('#lib-username').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#lib-add').click();
  });
  $('#lib-search-go').addEventListener('click', searchLibrary);
  $('#lib-search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') searchLibrary();
  });
  $('#lib-sync').addEventListener('click', async () => {
    await api('start_library_sync', {});
    startSyncPolling();
  });

  // Favourites
  $('#fav-search').addEventListener('input', debounce(loadFavourites, 250));
  $('#fav-save').addEventListener('click', () => closeAsk($('#fav-name').value.trim()));
  $('#fav-cancel').addEventListener('click', () => closeAsk(null));
  $('#fav-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') closeAsk($('#fav-name').value.trim());
    if (e.key === 'Escape') closeAsk(null);
  });
  // Clicking the backdrop cancels; clicking inside the card must not.
  $('#fav-dialog').addEventListener('click', (e) => {
    if (e.target === $('#fav-dialog')) closeAsk(null);
  });

  // Openings
  $('#op-close').addEventListener('click', () => {
    $('#opening-detail').classList.add('hidden');
    openingShown = null;
  });
  $('#op-depth').addEventListener('change', () => {
    if (openingShown) showOpeningDetail(openingShown);
  });

  // Head-to-head
  $('#h2h-go').addEventListener('click', loadH2H);
  $('#h2h-opponent').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadH2H(); });

  // Games paging
  $('#games-prev').addEventListener('click', () => {
    state.gamesOffset = Math.max(0, state.gamesOffset - state.gamesLimit);
    loadGames();
  });
  $('#games-next').addEventListener('click', () => {
    state.gamesOffset += state.gamesLimit;
    loadGames();
  });

  // Sync
  $('#btn-sync').addEventListener('click', async () => {
    await api('start_sync', { full: false });
    startSyncPolling();
  });
  $('#btn-sync-full').addEventListener('click', async () => {
    await api('start_sync', { full: true });
    startSyncPolling();
  });
  const importPgn = async (collection) => {
    let path = null;
    if (window.pywebview && window.pywebview.api && window.pywebview.api.pick_pgn) {
      path = await window.pywebview.api.pick_pgn();
    } else {
      path = prompt('Full path to a .pgn file or a folder of them:');
    }
    if (!path) return;
    try {
      await api('import_pgn', collection ? { path, collection } : { path });
      startSyncPolling();
    } catch (e) {
      toast(e.message, true);
    }
  };
  $('#btn-import').addEventListener('click', () => importPgn(null));
  // The same importer, but the games land in the reference library instead of
  // the user's own record — an OTB masters database is not their play.
  $('#lib-import').addEventListener('click', () => importPgn('titled'));

  // Settings
  $('#acct-add').addEventListener('click', async () => {
    const source = $('#acct-source').value;
    const username = $('#acct-username').value.trim();
    if (!username) return toast('Enter a username', true);
    try {
      await api('add_account', { source, username });
      $('#acct-username').value = '';
      toast('Account added — press Sync to download games');
      loadSettings();
    } catch (e) { toast(e.message, true); }
  });

  $('#me-save').addEventListener('click', async () => {
    const me = $('#me-list').value.split('\n').map((s) => s.trim()).filter(Boolean);
    await api('save_config', { patch: { me } });
    toast('Saved');
  });

  $('#eng-save').addEventListener('click', async () => {
    // The saved config comes back clamped, so the boards take their depth from
    // the reply rather than from the box — a 99 typed in here is a 40 to the
    // engine, and the dropdowns should say 40.
    const saved = await api('save_config', {
      patch: {
        engine_path: $('#eng-path').value.trim() || null,
        engine_depth: Number($('#eng-depth').value),
        engine_threads: Number($('#eng-threads').value),
        engine_hash_mb: Number($('#eng-hash').value),
        engine_multipv: Number($('#eng-multipv').value),
      },
    });
    state.config = saved;
    boards.forEach((b) => b.syncDepth());
    toast('Engine settings saved');
    loadSettings();
  });

  $('#idx-save').addEventListener('click', async () => {
    await api('save_config', { patch: { max_indexed_ply: Number($('#idx-ply').value) } });
    toast('Saved — press Reindex to apply to existing games');
  });

  $('#idx-reindex').addEventListener('click', async () => {
    $('#idx-msg').textContent = 'Reindexing…';
    try {
      const r = await api('reindex');
      $('#idx-msg').textContent = `Reindexed ${r.reindexed_games} games`;
    } catch (e) {
      $('#idx-msg').textContent = '';
      toast(e.message, true);
    }
  });

  $('#token-save').addEventListener('click', async () => {
    const token = $('#lichess-token').value.trim();
    if (!token) return toast('Enter a token first', true);
    await api('save_config', { patch: { lichess_token: token } });
    $('#lichess-token').value = '';
    toast('Token saved');
  });

  // Startup order matters: the installed piece sets have to be known before the
  // saved preference can be applied, or a valid choice looks unavailable and
  // silently falls back to the wrong set.
  (async () => {
    try {
      registerDiscoveredSets(await api('piece_sets'));
    } catch {
      // Leaves the built-in Classic set, which is enough to draw a board.
    }
    renderPiecePicker();

    try {
      const cfg = await api('get_config');
      // Kept, not just read: the boards take their search depth from here, and
      // waiting for a visit to Settings to learn it would mean the first
      // session's analysis silently ran at the default.
      state.config = cfg;
      boards.forEach((b) => b.syncDepth());
      applyTheme(cfg.theme);
      applyBoard(cfg.board);
      applyPieceSet(cfg.piece_set);
    } catch {
      applyTheme('walnut');
      applyBoard('theme');
      applyPieceSet('cburnett');
    }

    try {
      const s = await api('summary');
      state.me = s.me || [];
      if (state.me.length && !$('#f-player').value) $('#f-player').value = state.me[0];
      loadPlayersDatalist();
      loadVariants();
    } catch (e) {
      toast(e.message, true);
    }
    // Which games are starred has to be known before the first table is drawn,
    // or every star renders hollow until something happens to repaint it.
    await loadFavouriteIds();
    refreshView();
  })();

  // A sync may already be running from a previous window.
  api('sync_status').then((st) => { if (st.running) startSyncPolling(); });

  // Heartbeat. If these stop arriving the backend watchdog dumps every thread's
  // stack to data/chesshindsight.log, which is how a UI freeze gets diagnosed.
  const beat = () => { api('ping').catch(() => {}); };
  beat();
  setInterval(beat, 4000);

  // Surface frontend faults in the log too, not just the console.
  window.addEventListener('error', (e) => {
    api('log_client_error', {
      message: String(e.message), source: String(e.filename || ''),
      line: e.lineno || 0, stack: e.error && e.error.stack ? String(e.error.stack) : '',
    }).catch(() => {});
  });
  window.addEventListener('unhandledrejection', (e) => {
    api('log_client_error', {
      message: 'unhandled promise rejection: ' + String(e.reason),
      source: '', line: 0,
      stack: e.reason && e.reason.stack ? String(e.reason.stack) : '',
    }).catch(() => {});
  });
}

document.addEventListener('DOMContentLoaded', init);

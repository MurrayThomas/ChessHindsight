/*
 * End-to-end UI test: loads the real index.html into jsdom, points fetch at the
 * running Python API, and drives the app the way a person would.
 */
import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.argv[2] || '.';
const BASE = process.argv[3] || 'http://127.0.0.1:8799';
const WEB = path.join(ROOT, 'web');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${extra ? '  ' + extra : ''}`); }
};
const head = (s) => console.log(`\n=== ${s} ===`);

process.on('unhandledRejection', (err) => {
  console.log('\n!! UNHANDLED REJECTION');
  console.log('   name:', err && err.name, '| message:', JSON.stringify(err && err.message));
  console.log('   stack:', err && err.stack);
  process.exit(1);
});

const vc = new VirtualConsole();
vc.on('jsdomError', (e) => { console.log('  !! jsdom error:', e.message); fail++; });
vc.on('error', (...a) => { console.log('  !! console.error:', ...a); });

const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
// pretendToBeVisual gives jsdom a requestAnimationFrame, which the drag loop
// uses to coalesce pointer moves into one update per frame. Without it the real
// code path could not be tested at all.
const dom = new JSDOM(html, {
  runScripts: 'outside-only', virtualConsole: vc, url: BASE, pretendToBeVisual: true,
});
const { window } = dom;

// Real fetch against the Python server.
window.fetch = (url, opts) => fetch(new URL(url, BASE).href, opts);
window.scrollTo = () => {};
window.Element.prototype.scrollIntoView = () => {};

// One eval for all three: a browser puts top-level `let`/`const` from every
// classic script into a shared global lexical scope, but separate eval() calls
// each get their own, which would hide PIECE_SETS from app.js.
window.eval(
  ['pieces.js', 'board.js', 'app.js']
    .map((f) => fs.readFileSync(path.join(WEB, f), 'utf8'))
    .join('\n;\n')
  // Test-only handle on the module-scoped board instances. Appended here rather
  // than added to app.js so the shipped code carries no test hooks.
  + '\n;window.__test = {'
  + ' get explorerBoard() { return explorerBoard; },'
  + ' get positionsBoard() { return positionsBoard; },'
  // The scripts are strict, so eval-scoped declarations do not become globals.
  + ' squareAtPoint: squareAtPoint,'
  + ' playedByLabel: playedByLabel,'
  + ' playedByTitle: playedByTitle,'
  + ' fmtDate: fmtDate };',
);

const $ = (s) => window.document.querySelector(s);
// An optional root, for asking about one panel rather than the whole page.
const $$ = (s, root) => Array.from((root || window.document).querySelectorAll(s));
const click = (elm) => elm.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const key = (k) => window.document.dispatchEvent(
  new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
const idle = (ms = 350) => new Promise((r) => setTimeout(r, ms));
const headersOf = (sel) => $$(sel).map((t) => t.textContent.trim());
/** Call the backend directly, for asserting on what it returns. */
const apiOf = (method, body) => window.fetch('/api/' + method, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body || {}),
}).then((r) => r.json());
/** Moves actually on the board (not the greyed ones still ahead). */
const playedText = (host = '#explorer-board-host') =>
  $$(`${host} .line .mv`).filter((m) => !m.classList.contains('ahead'))
    .map((m) => m.textContent).join(' ');

/* Board interaction goes through pointer events, so a plain click() does not
 * drive it. MouseEvent carries every field the handlers read; only the event
 * type name matters for dispatch. */
const ptr = (elm, type, x = 0, y = 0) => elm.dispatchEvent(
  new window.MouseEvent(type, {
    bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y,
  }));
/** Press and release without travelling — the click-to-move gesture. */
const tap = (elm) => { ptr(elm, 'pointerdown', 10, 10); ptr(elm, 'pointerup', 10, 10); };
/** Press, travel, release elsewhere — the drag gesture. */
const dragTo = (fromEl, toEl) => {
  ptr(fromEl, 'pointerdown', 10, 10);
  ptr(toEl, 'pointermove', 90, 90);
  ptr(toEl, 'pointerup', 90, 90);
};

// jsdom fires DOMContentLoaded itself, asynchronously, after construction.
// Dispatching one manually as well would run init() twice and register every
// listener twice — so wait for the real one instead.
let inits = 0;
window.document.addEventListener('DOMContentLoaded', () => { inits++; });
if (window.document.readyState === 'loading') {
  await new Promise((r) => window.document.addEventListener('DOMContentLoaded', r, { once: true }));
} else {
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
}
await idle(2500);
ok('init ran exactly once', inits === 1, `${inits} times`);

/* ---------------------------------------------------------------- */
head('piece sets');
const sets = await (await fetch(BASE + '/api/piece_sets', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
})).json();
ok('backend reports many sets', sets.length >= 40, `got ${sets.length}`);
ok('monarchy reported as webp',
  sets.some((s) => s.id === 'monarchy' && s.ext === 'webp'),
  JSON.stringify(sets.find((s) => s.id === 'monarchy')));
ok('picker rendered every set + Classic',
  $$('#piece-picker .piece-swatch').length === sets.length + 1,
  `${$$('#piece-picker .piece-swatch').length} swatches vs ${sets.length} sets`);
ok('cburnett is first', $$('#piece-picker .piece-swatch')[0].dataset.pieces === 'cburnett');
ok('mono is absent (colourless, unsupported)', !sets.some((s) => s.id === 'mono'));

$('#piece-search').value = 'maestro';
$('#piece-search').dispatchEvent(new window.Event('input', { bubbles: true }));
const visible = $$('#piece-picker .piece-swatch').filter((b) => !b.classList.contains('hidden'));
ok('search filters the picker', visible.length === 1 && visible[0].dataset.pieces === 'maestro',
  `${visible.length} visible`);

/* ---------------------------------------------------------------- */
head('explorer board is interactive');
$('#f-player').value = 's1mplepie';
click($$('.nav-item').find((b) => b.dataset.view === 'explorer'));
await idle(1200);

const board = () => $('#explorer-board-host .board');
ok('board rendered 64 squares', board() && board().children.length === 64,
  board() ? `${board().children.length}` : 'no board');
ok('squares carry names', $('#explorer-board-host [data-sq="e2"]') !== null);
ok('white pawn on e2 has a piece image',
  $('#explorer-board-host [data-sq="e2"] .pc') !== null);
ok('movable pieces are marked',
  $('#explorer-board-host [data-sq="e2"]').classList.contains('movable'));

// click e2 -> should select and show destination hints on e3/e4
tap($('#explorer-board-host [data-sq="e2"]'));
await idle(120);
ok('clicking a piece selects it',
  $('#explorer-board-host [data-sq="e2"]').classList.contains('sel'));
ok('legal destinations are marked',
  $('#explorer-board-host [data-sq="e4"] .hint') !== null
  && $('#explorer-board-host [data-sq="e3"] .hint') !== null);
ok('illegal destination is not marked',
  $('#explorer-board-host [data-sq="e5"] .hint') === null);

// play e4
tap($('#explorer-board-host [data-sq="e4"]'));
await idle(1200);
ok('the move was played (pawn now on e4)',
  $('#explorer-board-host [data-sq="e4"] .pc') !== null
  && $('#explorer-board-host [data-sq="e2"] .pc') === null);
ok('line shows 1.e4', $('#explorer-board-host .line').textContent.includes('1.e4'),
  JSON.stringify($('#explorer-board-host .line').textContent));
ok('last move highlighted',
  $('#explorer-board-host [data-sq="e4"]').classList.contains('lastmove'));
ok('continuations table repopulated',
  $('#explorer-tree').textContent.includes('Games'));

// black to move: black pieces should now be the movable ones
ok('turn passed to Black',
  $('#explorer-board-host [data-sq="e7"]').classList.contains('movable')
  && !$('#explorer-board-host [data-sq="d2"]').classList.contains('movable'));

/* ---------------------------------------------------------------- */
head('dragging a piece with the mouse');
key('Home');
await idle(1000);
const sq = (name) => $(`#explorer-board-host [data-sq="${name}"]`);

// Press and travel: a ghost should appear and the origin should fade.
ptr(sq('d2'), 'pointerdown', 10, 10);
ptr(sq('d4'), 'pointermove', 90, 90);
ok('a drag ghost follows the pointer', $('.piece-ghost') !== null);
ok('the origin square is marked as dragging', sq('d2').classList.contains('dragging'));
await idle(60); // the hover mark lands on the next animation frame
ok('the hovered square is highlighted', sq('d4').classList.contains('over'));
ok('the ghost moves by transform, not layout',
  /translate3d/.test($('.piece-ghost').style.transform || ''),
  JSON.stringify($('.piece-ghost').style.transform));
ptr(sq('d4'), 'pointerup', 90, 90);
await idle(1300);
ok('dropping plays the move',
  sq('d4').querySelector('.pc') !== null && sq('d2').querySelector('.pc') === null);
ok('line shows 1.d4', $('#explorer-board-host .line').textContent.includes('1.d4'),
  JSON.stringify($('#explorer-board-host .line').textContent));
ok('the ghost is cleaned up', $('.piece-ghost') === null);
ok('no square is left marked dragging', $('#explorer-board-host .sq.dragging') === null);
ok('no square is left highlighted', $('#explorer-board-host .sq.over') === null);

// Dropping on an illegal square must put the piece back, not move it.
key('Home');
await idle(1000);
ptr(sq('e2'), 'pointerdown', 10, 10);
ptr(sq('e5'), 'pointermove', 90, 90);
ptr(sq('e5'), 'pointerup', 90, 90);
await idle(700);
ok('an illegal drop leaves the board unchanged',
  sq('e2').querySelector('.pc') !== null && sq('e5').querySelector('.pc') === null);
ok('an illegal drop clears the selection', $('#explorer-board-host .sq.sel') === null);
ok('an illegal drop cleans up the ghost', $('.piece-ghost') === null);

// A drag abandoned outside the board must not strand the ghost.
ptr(sq('g1'), 'pointerdown', 10, 10);
ptr($('#filterbar'), 'pointermove', 400, 400);
ptr($('#filterbar'), 'pointerup', 400, 400);
await idle(400);
ok('dragging off the board cancels cleanly',
  $('.piece-ghost') === null && $('#explorer-board-host .sq.dragging') === null);
ok('the piece stayed where it was', sq('g1').querySelector('.pc') !== null);

// Click-to-move must still work alongside dragging.
tap(sq('g1'));
await idle(150);
ok('tap still selects', sq('g1').classList.contains('sel'));
tap(sq('f3'));
await idle(1300);
ok('tap-then-tap still moves',
  sq('f3').querySelector('.pc') !== null && sq('g1').querySelector('.pc') === null);

key('Home');
await idle(1000);
tap(sq('e2'));
tap(sq('e4'));
await idle(1300);

/* ---------------------------------------------------------------- */
head('clicking a database move follows it');
const rows = $$('#explorer-tree tbody tr');
ok('database continuations listed', rows.length > 0, `${rows.length} rows`);
const firstSan = rows[0] ? rows[0].querySelector('.san').textContent : null;
click(rows[0]);
await idle(1300);
ok(`row click played ${firstSan}`,
  $('#explorer-board-host .line').textContent.includes(firstSan),
  JSON.stringify($('#explorer-board-host .line').textContent));

/* ---------------------------------------------------------------- */
head('keyboard navigation');
const lineText = () => $('#explorer-board-host .line').textContent;
const played = () => playedText();
// Log every explore() round-trip so the exact move list the board asks for is
// visible, rather than inferred from the rendered line.
const origFetch = window.fetch;
window.fetch = (url, opts) => {
  if (String(url).endsWith('/api/explore')) {
    const body = JSON.parse(opts.body);
    console.log('   -> explore moves=', JSON.stringify(body.moves));
  }
  return origFetch(url, opts);
};
console.log('   line before arrows:', JSON.stringify(lineText()));
key('ArrowLeft');
await idle(900);
console.log('   after ArrowLeft:', JSON.stringify(lineText()), '| played:', JSON.stringify(played()));
ok('left arrow steps back',
  !played().includes(firstSan) && played().includes('e4'),
  JSON.stringify(lineText()));
key('ArrowRight');
await idle(900);
ok('right arrow steps forward again',
  $('#explorer-board-host .line').textContent.includes(firstSan));
key('Home');
await idle(900);
ok('Home returns to the start',
  $('#explorer-board-host [data-sq="e2"] .pc') !== null);
key('End');
await idle(900);
ok('End returns to the end of the line',
  $('#explorer-board-host .line').textContent.includes(firstSan));

// arrows must be ignored while typing in a filter box
const before = $('#explorer-board-host .line').textContent;
const ev = new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true });
$('#f-player').dispatchEvent(ev);
await idle(400);
ok('arrows ignored while a text box has focus',
  $('#explorer-board-host .line').textContent === before);

// flip must not move the eval bar or change the DOM order of the eval column
const wrapKids = [...$('#explorer-board-host .board-wrap').children].map((c) => c.className);
key('f');
await idle(200);
const wrapKidsAfter = [...$('#explorer-board-host .board-wrap').children].map((c) => c.className);
ok('flip keeps the eval bar on the right',
  JSON.stringify(wrapKids) === JSON.stringify(wrapKidsAfter), JSON.stringify(wrapKidsAfter));
ok('flip actually flipped the board',
  $('#explorer-board-host .board').children[0].dataset.sq === 'h1',
  $('#explorer-board-host .board').children[0].dataset.sq);
key('f');
await idle(200);

/* ---------------------------------------------------------------- */
head('engine lines');
click($('#explorer-board-host [data-act="eval"]'));
await idle(9000);
const lines = $$('#explorer-board-host .engine-line');
ok('engine reported multiple lines', lines.length >= 2, `${lines.length} lines`);
ok('each line has a score and a variation',
  lines.every((l) => l.querySelector('.el-score').textContent.trim()
                  && l.querySelector('.el-pv').textContent.trim()),
  lines.map((l) => l.textContent).join(' | '));
// A dead-level line is "0.00", with no sign — signing a zero would be claiming
// an advantage for somebody. Deep searches of the start position produce
// several of them, so the pattern has to allow it.
ok('scores look like +/- pawn units',
  lines.every((l) => /^([+-]\d+\.\d\d|0\.00)$|^#/
    .test(l.querySelector('.el-score').textContent.trim())),
  lines.map((l) => l.querySelector('.el-score').textContent).join(','));
ok('eval bar number set',
  /^[+-]\d+\.\d\d$|^#/.test($('#explorer-board-host .eval-number').textContent.trim()),
  $('#explorer-board-host .eval-number').textContent);

ok('lines are numbered 1..n',
  lines.map((l) => l.querySelector('.el-rank').textContent).join(',') === '1,2,3',
  lines.map((l) => l.querySelector('.el-rank').textContent).join(','));
ok('the best line is highlighted by default',
  lines[0].classList.contains('active')
  && !lines[1].classList.contains('active'));

/* ---------------------------------------------------------------- */
head('walking an engine line with the arrow keys');
const elines = () => $$('#explorer-board-host .engine-line');
const lineText2 = () => $('#explorer-board-host .line').textContent;

const bestPv = elines()[0].querySelector('.el-pv').textContent.trim().split(/\s+/);
ok('best line has several moves to walk', bestPv.length >= 3, JSON.stringify(bestPv));
ok('the best line is queued without pressing anything',
  lineText2().includes(bestPv[0]) && lineText2().includes(bestPv[1]),
  JSON.stringify(lineText2()));

// Right arrow walks it; the highlight must stay on rank 1 the whole way, which
// is the thing that felt wrong before.
const playedPart = () => playedText();
key('ArrowRight');
await idle(9000);
ok(`Right arrow played the best move (${bestPv[0]})`,
  playedPart().includes(bestPv[0]), JSON.stringify(lineText2()));
ok('the highlight is still on line 1 after stepping',
  elines()[0].classList.contains('active')
  && !elines().slice(1).some((r) => r.classList.contains('active')),
  elines().map((r) => r.className).join(' | '));

key('ArrowRight');
await idle(9000);
ok('a second step keeps the highlight on line 1',
  elines()[0].classList.contains('active')
  && !elines().slice(1).some((r) => r.classList.contains('active')),
  elines().map((r) => r.className).join(' | '));

key('ArrowLeft');
await idle(9000);
ok('Left arrow comes back up the line', playedPart().includes(bestPv[0]),
  JSON.stringify(lineText2()));

key('Home');
await idle(9000);
ok('Home returns to the start', playedPart() === '', JSON.stringify(lineText2()));

// Clicking a line must select it and nothing more.
const rows2 = elines();
ok('three lines still listed', rows2.length === 3, `${rows2.length}`);
const secondPv = rows2[1].querySelector('.el-pv').textContent.trim().split(/\s+/);
const beforeClick = playedPart();
click(rows2[1]);
await idle(1200);
ok('clicking a line does not play a move', playedPart() === beforeClick,
  `${JSON.stringify(beforeClick)} -> ${JSON.stringify(playedPart())}`);
ok('clicking a line highlights it', elines()[1].classList.contains('active'),
  elines().map((r) => r.className).join(' | '));
ok('the chosen line is queued ahead',
  lineText2().includes(secondPv[0]) && lineText2().includes(secondPv[1]),
  JSON.stringify(lineText2()));

key('ArrowRight');
await idle(9000);
ok(`arrow keys then walk the chosen line (${secondPv[0]})`,
  playedPart().includes(secondPv[0]), JSON.stringify(lineText2()));

// Playing a move by hand must discard the queued variation and go back to best.
key('Home');
await idle(9000);
tap($('#explorer-board-host [data-sq="e2"]'));
tap($('#explorer-board-host [data-sq="e4"]'));
await idle(9000);
ok('a manual move plays only that move', playedPart().trim().endsWith('e4'),
  JSON.stringify(lineText2()));
ok('and hands the arrow keys back to the best line',
  elines().length === 0 || elines()[0].classList.contains('active'),
  elines().map((r) => r.className).join(' | '));
key('Home');
await idle(2000);

/* ---------------------------------------------------------------- */
head('positions view has its own playable board');
click($$('.nav-item').find((b) => b.dataset.view === 'positions'));
await idle(2500);
const cards = $$('#positions-grid .pos-card');
ok('position cards rendered', cards.length > 0, `${cards.length} cards`);
ok('analysis panel starts hidden', $('#pos-analysis').classList.contains('hidden'));

click(cards[0]);
await idle(1800);
ok('clicking a card opens the analysis panel',
  !$('#pos-analysis').classList.contains('hidden'));
ok('positions board rendered', $('#pos-board-host .board').children.length === 64);
const movable = $$('#pos-board-host .sq.movable');
ok('positions board has legal moves', movable.length > 0, `${movable.length} movable`);

// play a move on it
tap(movable[0]);
await idle(150);
const hint = $('#pos-board-host .sq .hint');
ok('selecting on the positions board shows destinations', hint !== null);
const destSq = hint ? hint.parentElement.dataset.sq : null;
tap(hint.parentElement);
await idle(1400);
ok('a move can be played on the positions board',
  $('#pos-board-host .line').textContent.trim().length > 'position'.length,
  JSON.stringify($('#pos-board-host .line').textContent));

key('ArrowLeft');
await idle(900);
ok('arrow keys drive the positions board too',
  $('#pos-board-host .line').textContent.includes('position'));

click($('#pos-an-close'));
ok('close hides the panel', $('#pos-analysis').classList.contains('hidden'));

/* ---------------------------------------------------------------- */
head('promotion');
click($$('.nav-item').find((b) => b.dataset.view === 'positions'));
await idle(300);
click(cards[0]);
await idle(1200);
// Drive the positions board straight to a promotion position.
const promoFen = '8/4P3/8/8/8/8/8/K5k1 w - - 0 1';
await window.eval(`window.__test.positionsBoard.setPosition(${JSON.stringify(promoFen)})`);
await idle(1500);
ok('promotion position loaded', $('#pos-board-host [data-sq="e7"] .pc') !== null);
tap($('#pos-board-host [data-sq="e7"]'));
await idle(120);
tap($('#pos-board-host [data-sq="e8"]'));
await idle(200);
const promo = $('#pos-board-host .promo');
ok('promotion chooser appears instead of auto-queening', promo !== null);
ok('chooser offers all four pieces',
  promo && promo.querySelectorAll('.promo-choice').length === 4,
  promo ? String(promo.querySelectorAll('.promo-choice').length) : 'no chooser');
// pick the knight (last of Q,R,B,N)
const knight = promo.querySelectorAll('.promo-choice')[3];
ok('fourth choice is the knight', knight.title === 'Knight', knight.title);
click(knight);
await idle(1500);
ok('under-promotion played',
  $('#pos-board-host .line').textContent.includes('e8=N'),
  JSON.stringify($('#pos-board-host .line').textContent));

/* ---------------------------------------------------------------- */
head('raster piece set serves correctly');
const webp = await fetch(BASE + '/piecesets/monarchy/wK.webp');
ok('monarchy king serves 200', webp.status === 200, String(webp.status));
ok('served as image/webp', webp.headers.get('content-type') === 'image/webp',
  webp.headers.get('content-type'));
const svg = await fetch(BASE + '/piecesets/cburnett/bQ.svg');
ok('cburnett queen serves as svg',
  svg.status === 200 && svg.headers.get('content-type') === 'image/svg+xml',
  `${svg.status} ${svg.headers.get('content-type')}`);

/* ---------------------------------------------------------------- */
head('side lines');
// Arrow keys drive whichever board is on screen, and the previous block left
// the Positions analysis panel open.
click($('#pos-an-close'));
click($$('.nav-item').find((b) => b.dataset.view === 'explorer'));
await idle(1500);
key('Home');
await idle(9000);
const movesIn = () => $$('#explorer-board-host .line .mv');
const bestFirst = elines()[0].querySelector('.el-pv').textContent.trim().split(/\s+/)[0];

// 1.a4 is never Stockfish's choice, so playing it must register as a side line.
ok('the best move is not a4', bestFirst !== 'a4', bestFirst);
tap($('#explorer-board-host [data-sq="a2"]'));
tap($('#explorer-board-host [data-sq="a4"]'));
await idle(12000);

const onBoard = movesIn().filter((m) => !m.classList.contains('ahead'));
ok('the hand-played move is on the board',
  onBoard.length === 1 && onBoard[0].textContent === 'a4',
  onBoard.map((m) => m.textContent).join(','));
ok('it is marked as a side line', onBoard[0].classList.contains('sideline'),
  onBoard[0].className);
ok('and says what the engine preferred',
  /preferred/.test(onBoard[0].title || ''), JSON.stringify(onBoard[0].title));
const bar = $('#explorer-board-host .branch-bar');
ok('a side-line banner appears', bar && !bar.classList.contains('hidden'),
  bar ? bar.className : 'no bar');
ok('the banner names where the line branched', /1\.a4/.test(bar.textContent),
  JSON.stringify(bar.textContent));
ok('the banner says how deep the side line is', /1 move deep/.test(bar.textContent),
  JSON.stringify(bar.textContent));
ok('the banner offers a way back', $('#explorer-board-host .branch-back') !== null);
ok('the current move is marked on the line',
  $$('#explorer-board-host .line .mv.current').length === 1,
  `${$$('#explorer-board-host .line .mv.current').length} marked`);
ok('the branch tail is tinted',
  $('#explorer-board-host .line .mv.in-branch') !== null);

// The position after it must get its own fresh set of lines.
ok('fresh engine lines for the new position', elines().length >= 2, `${elines().length}`);
const afterA4 = elines()[0].querySelector('.el-pv').textContent.trim().split(/\s+/)[0];
ok('those lines are Black replies, not the old White ones',
  afterA4 !== bestFirst, `${bestFirst} -> ${afterA4}`);

// Going back must return to the position before it, with a4 still recoverable.
key('ArrowLeft');
await idle(9000);
ok('Left arrow returns to the position before the side line',
  $('#explorer-board-host [data-sq="a2"] .pc') !== null);
ok('a4 is still there, greyed, to go forward to',
  movesIn().some((m) => m.textContent === 'a4' && m.classList.contains('ahead')),
  movesIn().map((m) => m.textContent + ':' + m.className).join(' | '));
ok('the banner is gone once back above the branch',
  $('#explorer-board-host .branch-bar').classList.contains('hidden'),
  $('#explorer-board-host .branch-bar').className);

// Stepping back and pressing Right replays *your* move rather than the
// engine's — the same as any analysis board, and the reason a clean board is
// needed to check that following the engine is not flagged.
key('Home');
await idle(6000);
key('ArrowRight');
await idle(9000);
ok('Right arrow replays your own move rather than overwriting it',
  movesIn().filter((m) => !m.classList.contains('ahead'))
    .some((m) => m.textContent === 'a4'),
  movesIn().map((m) => m.textContent + ':' + m.className).join(' | '));

await window.__test.explorerBoard.setPosition(null);
await idle(9000);
const top = elines()[0].querySelector('.el-pv').textContent.trim().split(/\s+/)[0];
key('ArrowRight');
await idle(9000);
const stepped = movesIn().filter((m) => !m.classList.contains('ahead'));
ok(`following the best move (${top}) is not marked as a side line`,
  stepped.length && !stepped[stepped.length - 1].classList.contains('sideline'),
  stepped.map((m) => m.textContent + ':' + m.className).join(' | '));
ok('and no side-line banner is shown',
  $('#explorer-board-host .branch-bar').classList.contains('hidden'));

// Clicking a move in the list jumps to it.
key('End');
await idle(9000);
const all = movesIn();
ok('the whole line is listed move by move', all.length > 3, `${all.length}`);
click(all[0]);
await idle(9000);
ok('clicking a move jumps to it',
  movesIn().filter((m) => !m.classList.contains('ahead')).length === 1,
  movesIn().map((m) => m.textContent + ':' + m.className).join(' | '));
key('Home');
await idle(6000);

/* ---------------------------------------------------------------- */
head('board coordinates');
// Outside the board, in their own gutters — inside the squares they could not
// be made legible without fighting the piece artwork.
const coordText = (which) => $$(`#explorer-board-host .coords.${which} .coord`)
  .map((c) => c.textContent).join('');
ok('coordinates are not drawn inside the squares',
  $('#explorer-board-host .board .coord') === null,
  $('#explorer-board-host .board .coord') ? 'still inside a square' : '');
ok('16 labels, eight per gutter',
  $$('#explorer-board-host .coords .coord').length === 16,
  `${$$('#explorer-board-host .coords .coord').length}`);
ok('ranks run 8 down to 1 up the left', coordText('ranks') === '87654321',
  coordText('ranks'));
ok('files run a to h along the bottom', coordText('files') === 'abcdefgh',
  coordText('files'));
ok('the evaluation bar sits inside the frame, level with the board',
  $('#explorer-board-host .board-frame > .eval-col') !== null);
key('f');
await idle(400);
ok('flipping turns the coordinates round too',
  coordText('ranks') === '12345678' && coordText('files') === 'hgfedcba',
  `${coordText('ranks')} / ${coordText('files')}`);
key('f');
await idle(400);
// The ghost is built from the piece, not the square, or the label would be
// dragged around with it.
ptr($('#explorer-board-host [data-sq="e2"]'), 'pointerdown', 10, 10);
ptr($('#explorer-board-host [data-sq="e4"]'), 'pointermove', 90, 90);
ok('a dragged piece does not carry its coordinate label',
  $('.piece-ghost') && $('.piece-ghost .coord') === null,
  $('.piece-ghost') ? $('.piece-ghost').innerHTML.slice(0, 80) : 'no ghost');
ptr($('#explorer-board-host [data-sq="e2"]'), 'pointerup', 10, 10);
await idle(400);
key('Home');
await idle(3000);

/* ---------------------------------------------------------------- */
head('arrows on the board');
/*
 * Three questions answered at a glance: what the engine plays, what it plays
 * instead, and what was actually played from here.
 */
click($$('.nav-item').find((b) => b.dataset.view === 'explorer'));
await idle(800);
await window.__test.explorerBoard.setLine([
  { uci: 'e2e4', san: 'e4' }, { uci: 'c7c5', san: 'c5' },
  { uci: 'g1f3', san: 'Nf3' }, { uci: 'b8c6', san: 'Nc6' },
]);
await idle(12000);

const arrows = () => $$('#explorer-board-host .arrows .arrow');
const arrowFor = (kind) => arrows().find((a) => a.dataset.kind === kind);
const guideText = () => $('#explorer-board-host .arrow-guide').textContent;
const engineLines = () => $$('#explorer-board-host .engine-line');
const rankBadge = (i) => engineLines()[i].querySelector('.el-rank');

ok('the overlay does not sit inside the board, which is rebuilt every move',
  $('#explorer-board-host .board .arrows') === null
  && $('#explorer-board-host .board-frame > .arrows') !== null);
ok('an arrow is drawn for the best move', arrowFor('best') !== undefined,
  arrows().map((a) => a.dataset.kind).join(','));
ok('and one for the second best', arrowFor('second') !== undefined,
  arrows().map((a) => a.dataset.kind).join(','));
const arrowEval = await apiOf('evaluate', { fen: window.__test.explorerBoard.fen });
ok('the panel lists the same lines the arrows come from',
  engineLines().length >= 2, `${engineLines().length} lines`);
ok('the best arrow is the engine\'s first line',
  arrowFor('best').dataset.uci === arrowEval.lines[0].uci,
  `${arrowFor('best').dataset.uci} vs ${arrowEval.lines[0].uci}`);
ok('the second arrow is the engine\'s second line',
  arrowFor('second').dataset.uci === arrowEval.lines[1].uci,
  `${arrowFor('second').dataset.uci} vs ${arrowEval.lines[1].uci}`);
ok('each arrow has a shaft and a head',
  arrows().every((a) => a.querySelector('line') && a.querySelector('polygon')));
ok('and says what it is on hover',
  /Best/.test(arrowFor('best').querySelector('title').textContent),
  arrowFor('best').querySelector('title').textContent);
/*
 * The colours are carried where they are read, so the arrows need no legend to
 * be understood: the engine line numbers wear their arrow's colour, and a move
 * in the continuations table is dotted in its arrow's colour.
 */
ok('line 1\'s number wears the best arrow\'s colour',
  rankBadge(0).classList.contains('a-best'), rankBadge(0).className);
ok('line 2\'s number wears the second arrow\'s colour',
  rankBadge(1).classList.contains('a-second'), rankBadge(1).className);
ok('line 3 has no arrow, so no colour',
  !engineLines()[2] || !/a-best|a-second/.test(rankBadge(2).className),
  engineLines()[2] ? rankBadge(2).className : 'no third line');
ok('and the numbers say so on hover',
  /arrow/.test(rankBadge(0).title || ''), JSON.stringify(rankBadge(0).title));

const dotted = () => $$('#explorer-tree .san[class*="arrow-"]')
  .map((s) => `${s.textContent.trim()}:${s.className}`);
ok('the move the best arrow points at is dotted in the table',
  dotted().some((d) => d.includes('arrow-best')), dotted().join(' | '));
ok('the guide explains each arrow',
  /best move/i.test(guideText()) && /second choice/i.test(guideText()),
  JSON.stringify(guideText()));
ok('and can be collapsed once learned',
  $('#explorer-board-host .arrow-help-toggle') !== null);
click($('#explorer-board-host .arrow-help-toggle'));
await idle(300);
ok('collapsing hides it', $('#explorer-board-host .arrow-guide')
  .classList.contains('hidden'));
click($('#explorer-board-host .arrow-help-toggle'));
await idle(300);
ok('and it comes back', !$('#explorer-board-host .arrow-guide')
  .classList.contains('hidden'));

// The played-move arrow, and the overlap case.
const dbTop = $$('#explorer-tree tbody tr')[0];
const dbSan = dbTop ? dbTop.querySelector('.san').textContent.trim() : null;
ok('the guide also reports what was played here',
  /played/i.test(guideText()), JSON.stringify(guideText()));
if (dbSan) {
  const agrees = arrowEval.lines.slice(0, 2).some((l) => l.san === dbSan);
  if (agrees) {
    // Drawing it would put one arrow exactly under another and lose it.
    ok('a played move the engine also picked is not drawn twice',
      arrowFor('played') === undefined,
      arrows().map((a) => `${a.dataset.kind}=${a.dataset.uci}`).join(','));
    // The note hangs off the engine row it coincides with, rather than being a
    // row of its own — three legend entries for two arrows read as three arrows.
    ok('and the guide notes it on that engine row instead of adding a third',
      /also/.test(guideText())
      && $$('#explorer-board-host .guide-row').length === arrows().length,
      `${$$('#explorer-board-host .guide-row').length} rows, ${arrows().length} arrows: `
      + JSON.stringify(guideText()));
    // A blue dot with no blue arrow on the board would be a lie.
    ok('its table dot takes the engine colour, not the played colour',
      !dotted().some((d) => d.startsWith(dbSan + ':') && d.includes('arrow-played')),
      dotted().join(' | '));
  } else {
    ok('a played move the engine did not pick gets its own arrow',
      arrowFor('played') !== undefined,
      arrows().map((a) => `${a.dataset.kind}=${a.dataset.uci}`).join(','));
    ok('drawn in its own colour, distinct from the engine\'s two',
      arrowFor('played').classList.contains('a-played'));
    ok('and dotted the same colour in the table',
      dotted().some((d) => d.startsWith(dbSan + ':') && d.includes('arrow-played')),
      dotted().join(' | '));
  }
}

// Flipping must move the arrows with the board, or they point at the wrong
// squares — the one bug an arrow overlay is most prone to.
const beforeFlip = arrowFor('best').querySelector('line').getAttribute('x1');
key('f');
await idle(600);
const afterFlip = arrowFor('best').querySelector('line').getAttribute('x1');
ok('flipping the board mirrors the arrows too', beforeFlip !== afterFlip,
  `x1 ${beforeFlip} -> ${afterFlip}`);
ok('and the arrow still names the same move',
  arrowFor('best').dataset.uci === arrowEval.lines[0].uci);
key('f');
await idle(600);

/* ---------------------------------------------------------------- */
head('an evaluation for a position the board has left is ignored');
/*
 * Evaluations are not cancelled when the board moves on, so a result for the
 * previous position routinely arrives after a move has been made. Displaying it
 * is confusing; queueing its variation is worse — those moves are not legal in
 * the position now on the board, which put "illegal move 'b1c3' in line" into
 * the move list and jammed every arrow key after it.
 */
const exBoard = window.__test.explorerBoard;
await exBoard.setPosition(null);
await idle(9000);
const goodLines = elines().map((r) => r.textContent);
ok('the start position has lines to begin with', goodLines.length >= 2,
  `${goodLines.length}`);

const staleFen = 'rnbqkbnr/pppppppp/8/8/8/5N2/PPPPPPPP/RNBQKB1R b KQkq - 1 1';
exBoard.showEval({
  turn: 'black', depth: 20, score_cp: -900, mate_in: null,
  // A SAN that could never be produced by a real position, so finding it in the
  // move list can only mean this line was queued.
  lines: [{ rank: 1, score_cp: -900, san: 'STALE', uci: 'b8c6',
            pv: 'STALE', pv_san: ['STALE'], pv_uci: ['b8c6'] }],
}, false, staleFen);
await idle(500);
ok('a result for another position does not replace the lines',
  elines().map((r) => r.textContent).join('|') === goodLines.join('|'),
  elines().map((r) => r.textContent).join(' | '));
ok('and does not move the evaluation number',
  $('#explorer-board-host .eval-number').textContent.trim() !== '-9.00',
  $('#explorer-board-host .eval-number').textContent);
ok('nor queues its moves into the line',
  !$('#explorer-board-host .line').textContent.includes('STALE'),
  JSON.stringify($('#explorer-board-host .line').textContent));

// Even so, an unplayable line must not be able to wedge the board: the arrow
// keys have to keep working afterwards.
key('ArrowRight');
await idle(9000);
ok('the arrow keys still work',
  playedText().trim().length > 0, JSON.stringify(playedText()));
key('Home');
await idle(6000);
ok('and Home still works', playedText().trim() === '', JSON.stringify(playedText()));
ok('the engine panel says which line is being followed',
  /following line 1/.test($('#explorer-board-host .engine-head').textContent),
  $('#explorer-board-host .engine-head').textContent);

/* ---------------------------------------------------------------- */
head('drag hit-testing maths');
// jsdom has no layout, so the drag geometry is tested directly rather than
// through rendered pixels. 400px board at (100, 50) => 50px squares.
const sap = window.__test.squareAtPoint;
const rect = { left: 100, top: 50, width: 400, height: 400 };
const at = (x, y, flipped) => sap(x, y, rect, !!flipped);
ok('top-left is a8', at(105, 55) === 'a8', at(105, 55));
ok('bottom-left is a1', at(105, 445) === 'a1', at(105, 445));
ok('top-right is h8', at(495, 55) === 'h8', at(495, 55));
ok('bottom-right is h1', at(495, 445) === 'h1', at(495, 445));
ok('centre of e2', at(100 + 4.5 * 50, 50 + 6.5 * 50) === 'e2',
  at(100 + 4.5 * 50, 50 + 6.5 * 50));
ok('flipped top-left is h1', at(105, 55, true) === 'h1', at(105, 55, true));
ok('flipped bottom-right is a8', at(495, 445, true) === 'a8', at(495, 445, true));
ok('square boundaries do not overlap',
  at(149, 55) === 'a8' && at(151, 55) === 'b8',
  `${at(149, 55)} / ${at(151, 55)}`);
ok('left of the board is null', at(99, 200) === null, String(at(99, 200)));
ok('below the board is null', at(200, 451) === null, String(at(200, 451)));
ok('a zero-size rect returns null (no layout yet)',
  sap(10, 10, { left: 0, top: 0, width: 0, height: 0 }, false) === null);

/* ---------------------------------------------------------------- */
head('openings');
click($$('.nav-item').find((b) => b.dataset.view === 'openings'));
await idle(2000);
const opHeads = headersOf('#openings-out th');
ok('grouped by opening name, not ECO', opHeads[0] === 'Opening', JSON.stringify(opHeads));
// ECO is a library filing code, not a fact about how the opening was played.
ok('no ECO column', !opHeads.includes('ECO'), JSON.stringify(opHeads));
ok('and no ECO tooltip left behind',
  !$$('#openings-out th').some((t) => /Encyclopaedia|ECO/.test(t.title || '')),
  'an ECO tooltip survived');
ok('no ECO filter box anywhere in the app', $('#f-eco') === null);
ok('the backend no longer reports ECO codes for an opening',
  !(await apiOf('by_opening', { filter: { player: 's1mplepie' }, limit: 3 }))
    .some((r) => 'eco' in r || 'ecos' in r),
  JSON.stringify((await apiOf('by_opening', { filter: { player: 's1mplepie' }, limit: 1 }))[0]));
ok('detail panel starts hidden', $('#opening-detail').classList.contains('hidden'));
// The list runs to 60 rows, so a detail panel rendered after it opens below the
// fold and looks like the click did nothing.
ok('detail panel sits above the list, not below it',
  $('#opening-detail').compareDocumentPosition($('#openings-out'))
    & window.Node.DOCUMENT_POSITION_FOLLOWING);

const opRows = $$('#openings-out tbody tr');
ok('openings listed', opRows.length > 0, `${opRows.length}`);
const opName = opRows[0].children[0].textContent;
click(opRows[0]);
await idle(2500);
ok('clicking an opening opens the detail panel',
  !$('#opening-detail').classList.contains('hidden'));
ok('detail names the opening', $('#op-name').textContent === opName,
  `${$('#op-name').textContent} vs ${opName}`);
ok('detail says what every game shares',
  /Every one of them starts/.test($('#op-summary').textContent),
  $('#op-summary').textContent.slice(0, 140));
ok('the shared line is real moves',
  /1\.\S+/.test($('#op-summary').querySelector('.san').textContent),
  $('#op-summary').textContent.slice(0, 140));
ok('the detail panel does not mention ECO either',
  !/ECO/.test($('#opening-detail').textContent),
  $('#op-summary').textContent.slice(0, 160));
const orderRows = $$('#op-lines tbody tr');
ok('move orders listed', orderRows.length > 0, `${orderRows.length}`);
ok('each move order shows a numbered line',
  orderRows.every((r) => /^\d+\./.test(r.children[0].textContent.trim())),
  orderRows[0] ? orderRows[0].children[0].textContent : '');

// Changing the depth re-queries.
const firstOrder = orderRows[0].children[0].textContent;
$('#op-depth').value = '8';
$('#op-depth').dispatchEvent(new window.Event('change', { bubbles: true }));
await idle(2500);
ok('depth selector deepens the move orders',
  $$('#op-lines tbody tr')[0].children[0].textContent.length > firstOrder.length,
  `${firstOrder} -> ${$$('#op-lines tbody tr')[0].children[0].textContent}`);

// Clicking a move order should load it onto the Explorer board.
const chosen = $$('#op-lines tbody tr')[0].children[0].textContent.trim();
click($$('#op-lines tbody tr')[0]);
await idle(2500);
ok('clicking a move order switches to the Explorer',
  $('#view-explorer').classList.contains('active'));
const loaded = $('#explorer-board-host .line').textContent;
const firstMove = chosen.split(/\s+/)[0].replace(/^1\./, '');
ok(`the Explorer board loaded the line (${firstMove})`,
  loaded.includes(firstMove), JSON.stringify(loaded));
ok('the board is no longer at the start position',
  $('#explorer-board-host [data-sq="e2"] .pc') === null
  || !loaded.trim().endsWith('start'), JSON.stringify(loaded));

/* ---------------------------------------------------------------- */
head('an opening opens from the side that plays it');
/*
 * An opening is a choice one colour makes — a Sicilian is Black's — so its
 * lines belong the other way up. The games say which side: whichever colour the
 * filtered player had in them.
 */
const openingSideOf = async (name) => (await (await window.fetch('/api/opening_lines', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    filter: { player: $('#f-player').value.trim() || undefined },
    opening: name, max_plies: 6, limit: 3,
  }),
})).json());

click($$('.nav-item').find((b) => b.dataset.view === 'openings'));
await idle(2000);
const named = $$('#openings-out tbody tr').map((r) => r.children[0].textContent);
// Sequentially: the dev server is a small threaded one, and firing two dozen
// queries at it at once is testing the wrong thing.
const detailFor = [];
for (const name of named.slice(0, 20)) detailFor.push(await openingSideOf(name));
const asBlack = detailFor.findIndex((d) => d.played_as === 'black');
const asWhite = detailFor.findIndex((d) => d.played_as === 'white');
ok('the backend reports which side each opening was played from',
  asBlack >= 0 && asWhite >= 0,
  detailFor.slice(0, 6).map((d, i) => `${named[i]}=${d.played_as}`).join(', '));

for (const [which, idx, corner] of [['Black', asBlack, 'h1'], ['White', asWhite, 'a8']]) {
  if (idx < 0) continue;
  click($$('#openings-out tbody tr')[idx]);
  await idle(2500);
  ok(`the summary says the ${which} opening was played as ${which.toLowerCase()}`,
    new RegExp(`as ${which.toLowerCase()}`).test($('#op-summary').textContent),
    $('#op-summary').textContent.slice(0, 160));
  click($$('#op-lines tbody tr')[0]);
  await idle(2500);
  ok(`a ${which} opening opens with ${which} at the bottom`,
    $('#explorer-board-host .board').children[0].dataset.sq === corner,
    `${named[idx]} -> ${$('#explorer-board-host .board').children[0].dataset.sq}`);
  click($$('.nav-item').find((b) => b.dataset.view === 'openings'));
  await idle(1500);
}

/* ---------------------------------------------------------------- */
head('board faces the filtered colour');
const topLeft = (sel) => $(sel + ' .board').children[0].dataset.sq;
click($$('.nav-item').find((b) => b.dataset.view === 'explorer'));
await idle(600);

$('#f-color').value = '';
$('#f-color').dispatchEvent(new window.Event('change', { bubbles: true }));
await idle(1200);
ok('Both -> White at the bottom', topLeft('#explorer-board-host') === 'a8',
  topLeft('#explorer-board-host'));

$('#f-color').value = 'black';
$('#f-color').dispatchEvent(new window.Event('change', { bubbles: true }));
await idle(1400);
ok('Black filter -> Black at the bottom', topLeft('#explorer-board-host') === 'h1',
  topLeft('#explorer-board-host'));

// A manual flip must survive a redraw that re-applies the same colour.
key('f');
await idle(200);
ok('manual flip overrides', topLeft('#explorer-board-host') === 'a8',
  topLeft('#explorer-board-host'));
click($$('.nav-item').find((b) => b.dataset.view === 'openings'));
await idle(500);
click($$('.nav-item').find((b) => b.dataset.view === 'explorer'));
await idle(1200);
ok('manual flip is not undone by revisiting the view',
  topLeft('#explorer-board-host') === 'a8', topLeft('#explorer-board-host'));

$('#f-color').value = 'white';
$('#f-color').dispatchEvent(new window.Event('change', { bubbles: true }));
await idle(1400);
ok('changing the filter again retakes control',
  topLeft('#explorer-board-host') === 'a8', topLeft('#explorer-board-host'));

// Positions thumbnails follow the same rule.
$('#f-color').value = 'black';
$('#f-color').dispatchEvent(new window.Event('change', { bubbles: true }));
click($$('.nav-item').find((b) => b.dataset.view === 'positions'));
await idle(2500);
const firstMini = $('#positions-grid .pos-card .board');
ok('position thumbnails face Black too',
  firstMini && firstMini.children[0].dataset.sq === 'h1',
  firstMini ? firstMini.children[0].dataset.sq : 'no cards');
click($$('.nav-item').find((b) => b.dataset.view === 'explorer'));
$('#f-color').value = '';
$('#f-color').dispatchEvent(new window.Event('change', { bubbles: true }));
await idle(1200);

/* ---------------------------------------------------------------- */
head('comparing against titled players');
/*
 * The reference library is a second corpus in the same tables, flagged with
 * `collection = 'titled'`. Two things have to hold: the tab answers "what did
 * this player play from the position on the board", and the corpus never leaks
 * into the user's own record.
 */
const libSummary = await apiOf('library_summary');
ok('the library holds reference games', libSummary.games > 0,
  JSON.stringify(libSummary));
const ownSummary = await apiOf('summary');
ok('reference games are not counted as the user\'s own',
  ownSummary.games < libSummary.games,
  `own ${ownSummary.games} vs library ${libSummary.games}`);
ok('and not offered as a player to analyse',
  !(await apiOf('known_players', { limit: 60 }))
    .some((p) => p.player === 'magnuscarlsen'),
  'magnuscarlsen appeared in known_players');

// Play into a real opening so there is something to compare.
click($$('.nav-item').find((b) => b.dataset.view === 'explorer'));
await idle(1000);
$('#f-color').value = '';
$('#f-color').dispatchEvent(new window.Event('change', { bubbles: true }));
await idle(1200);
await window.__test.explorerBoard.setLine([
  { uci: 'e2e4', san: 'e4' }, { uci: 'c7c5', san: 'c5' },
  { uci: 'g1f3', san: 'Nf3' },
]);
await idle(2500);

ok('the explorer has two tabs', $$('#ex-tabs .tab').length === 2,
  headersOf('#ex-tabs .tab').join(','));
ok('your games are shown first', $('#ex-tabs .tab.on').dataset.tab === 'mine');
ok('the titled panel starts hidden',
  $('#ex-panel-titled').classList.contains('hidden'));

click($$('#ex-tabs .tab').find((b) => b.dataset.tab === 'titled'));
await idle(2500);
ok('clicking the tab shows the titled panel',
  !$('#ex-panel-titled').classList.contains('hidden')
  && $('#ex-panel-mine').classList.contains('hidden'));
ok('and it is not showing the empty-library message',
  $('#tp-empty').classList.contains('hidden'), 'library looked empty');

const tpRows = $$('#tp-tree tbody tr');
ok('titled continuations listed', tpRows.length > 0, `${tpRows.length} rows`);
ok('the moves are Black replies to 2.Nf3',
  ['d6', 'Nc6', 'e6', 'g6', 'a6', 'Nf6', 'e5', 'd5']
    .includes(tpRows[0].querySelector('.san').textContent.trim()),
  tpRows.map((r) => r.querySelector('.san').textContent).join(','));
ok('titled columns report White, not "your", win rate',
  headersOf('#tp-tree th').includes('White win %')
  && !headersOf('#tp-tree th').includes('Your win %'),
  headersOf('#tp-tree th').join(','));
ok('and an average rating for the games',
  headersOf('#tp-tree th').includes('Avg rating'),
  headersOf('#tp-tree th').join(','));

const whoRows = $$('#tp-players tbody tr');
ok('the players who reached this position are listed', whoRows.length > 0,
  `${whoRows.length}`);
const whoFirst = whoRows[0].children[0].textContent;
ok('a player you added is named with their title',
  /GM/.test(whoFirst), JSON.stringify(whoFirst));
ok('and is marked as one of yours rather than an opponent',
  whoRows[0].querySelector('.lib-player') !== null, whoRows[0].innerHTML.slice(0, 120));
ok('reference games are listed with a link out',
  $$('#tp-games tbody tr').length > 0, `${$$('#tp-games tbody tr').length}`);

// Focusing on one player is the point of the feature.
const everyone = Number($('#tp-total').textContent.replace(/\D+/, '').trim())
  || $$('#tp-tree tbody tr').reduce((n, r) => n + Number(r.children[1].textContent), 0);
click(whoRows[0]);
await idle(2500);
ok('clicking a player focuses on them',
  $('#tp-player').value !== '', JSON.stringify($('#tp-player').value));
ok('the focus note says which colour they had here',
  /game\(s\)/.test($('#tp-focus-note').textContent),
  JSON.stringify($('#tp-focus-note').textContent));
const focusedTotal = $$('#tp-tree tbody tr')
  .reduce((n, r) => n + Number(r.children[1].textContent), 0);
ok('and narrows the moves to that player\'s games',
  focusedTotal > 0 && focusedTotal <= everyone,
  `${focusedTotal} of ${everyone}`);
ok('the player list still shows everyone, so the focus can be changed',
  $$('#tp-players tbody tr').length === whoRows.length,
  `${$$('#tp-players tbody tr').length} vs ${whoRows.length}`);

// Moving the board must move both tabs — one board, two readings.
const beforeMove = $('#tp-total').textContent;
$('#tp-player').value = '';
$('#tp-player').dispatchEvent(new window.Event('change', { bubbles: true }));
await idle(2000);
click($$('#ex-tabs .tab').find((b) => b.dataset.tab === 'mine'));
await idle(500);
tap($('#explorer-board-host [data-sq="d7"]'));
tap($('#explorer-board-host [data-sq="d6"]'));
await idle(3000);
click($$('#ex-tabs .tab').find((b) => b.dataset.tab === 'titled'));
await idle(2500);
ok('playing a move on the board moves the titled tab too',
  $('#tp-total').textContent !== beforeMove,
  `${beforeMove} -> ${$('#tp-total').textContent}`);

/*
 * An empty library is the first thing anyone sees, and a table of nothing does
 * not explain that a setup step is missing. Driven by answering one call as an
 * empty library would, rather than by standing up a second server.
 */
const realFetch = window.fetch;
window.fetch = (url, opts) => {
  if (String(url).endsWith('/api/reference_explore')) {
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        pos_key: 'x', fen: null, turn: 'white', player: null, focus: null,
        total_games: 0, ended_here: 0, children: [], players: [], games: [],
        library: { games: 0, players: 0, first_game: null, last_game: null },
      }),
    });
  }
  return realFetch(url, opts);
};
await window.__test.explorerBoard.reload();
await idle(2000);
ok('an empty library explains itself instead of showing an empty table',
  !$('#tp-empty').classList.contains('hidden')
  && $('#tp-body').classList.contains('hidden'),
  `empty=${$('#tp-empty').className} body=${$('#tp-body').className}`);
ok('and says where to add players',
  /Settings/.test($('#tp-empty').textContent), $('#tp-empty').textContent.slice(0, 120));
click($('#tp-goto-settings'));
await idle(1500);
ok('its button opens Settings', $('#view-settings').classList.contains('active'));
window.fetch = realFetch;

/* ---------------------------------------------------------------- */
head('the titled library is managed from Settings');
click($$('.nav-item').find((b) => b.dataset.view === 'settings'));
await idle(2500);
ok('the roster is listed', $$('#lib-list tbody tr').length > 0,
  `${$$('#lib-list tbody tr').length} players`);
ok('with a game count each',
  headersOf('#lib-list th').includes('Games'), headersOf('#lib-list th').join(','));
ok('and the library size is stated',
  /game\(s\) from \d+ player/.test($('#lib-summary').textContent),
  JSON.stringify($('#lib-summary').textContent));

// Adding a player must verify the account rather than storing a typo.
const bogus = await apiOf('library_add', {
  source: 'chesscom', username: 'definitely-not-a-real-account-xyz',
});
ok('a username that does not exist is refused',
  !!bogus.error, JSON.stringify(bogus).slice(0, 120));
const untitled = await apiOf('library_add', { source: 'chesscom', username: 'erik' });
ok('an account with no title is refused by default',
  !!untitled.error && /no federation title/.test(untitled.error),
  JSON.stringify(untitled).slice(0, 160));

/* ---------------------------------------------------------------- */
head('win rate is the only percentage');
const dashHeads = headersOf('#dash-tc th');
ok('dashboard table has a Win % column', dashHeads.includes('Win %'), JSON.stringify(dashHeads));
ok('dashboard table has no Score column', !dashHeads.includes('Score'), JSON.stringify(dashHeads));

const treeHeads = headersOf('#explorer-tree th');
ok('explorer uses win % columns',
  treeHeads.includes('Your win %') && treeHeads.includes('White win %'),
  JSON.stringify(treeHeads));
ok('explorer has no score columns',
  !treeHeads.some((h) => /score/i.test(h)), JSON.stringify(treeHeads));

const helpTitles = $$('#explorer-tree th, #dash-tc th').map((t) => t.title).filter(Boolean);
ok('Win % carries help text',
  helpTitles.some((t) => t.includes('won outright')), JSON.stringify(helpTitles));
ok('no help text mentions half a point',
  !helpTitles.some((t) => /0\.5|half a point/.test(t)), JSON.stringify(helpTitles));

// W/D/L counts must survive: dropping the percentage is not dropping the record.
ok('W, L and D columns still present',
  ['W', 'L', 'D'].every((h) => dashHeads.includes(h)), JSON.stringify(dashHeads));
ok('W/D/L bar still rendered', $('#dash-tc .wdl') !== null);

click($$('.nav-item').find((b) => b.dataset.view === 'h2h'));
$('#h2h-player').value = 's1mplepie';
$('#h2h-opponent').value = 'Bitcoins-Gambit';
click($('#h2h-go'));
await idle(2500);
const h2hCards = $$('#h2h-out .card .k').map((k) => k.textContent.trim());
ok('head-to-head shows Win rate', h2hCards.includes('Win rate'), JSON.stringify(h2hCards));
ok('head-to-head no longer shows Score', !h2hCards.includes('Score'), JSON.stringify(h2hCards));
ok('head-to-head still shows the W-L-D record',
  h2hCards.includes('Record') && /\d+–\d+–\d+/.test($('#h2h-out').textContent),
  JSON.stringify(h2hCards));
ok('no "half a point" prose left', !/half a point/.test($('#h2h-out').textContent));

/* ---------------------------------------------------------------- */
head('head-to-head reports the openings the two of them play');

const h2hPanels = $$('#h2h-out .panel');
const openPanel = h2hPanels.find((p) => {
  const h = p.querySelector('h2');
  return h && h.textContent.trim() === 'By opening';
});
ok('there is a By opening panel', !!openPanel,
  JSON.stringify(h2hPanels.map((p) => p.querySelector('h2') && p.querySelector('h2').textContent)));

const openHeads = openPanel ? $$('th', openPanel).map((t) => t.textContent.trim()) : [];
ok('it names the opening', openHeads.includes('Opening'), JSON.stringify(openHeads));
ok('and which side the player had', openHeads.includes('Colour'), JSON.stringify(openHeads));
ok('with the same record columns as everywhere else',
  ['Games', 'W', 'L', 'D', 'Win %'].every((h) => openHeads.includes(h)),
  JSON.stringify(openHeads));

const colourIdx = openHeads.indexOf('Colour');
const openRows = openPanel ? $$('tbody tr', openPanel) : [];
ok('it lists openings', openRows.length > 0, `${openRows.length} rows`);

const colours = openRows.map((r) => r.children[colourIdx].textContent.trim());
ok('every row says which side the player had',
  colours.length > 0 && colours.every((c) => c === 'White' || c === 'Black'),
  JSON.stringify([...new Set(colours)]));
// The whole reason for splitting: one side's opening is not the other's.
ok('and both sides are represented',
  colours.includes('White') && colours.includes('Black'),
  JSON.stringify([...new Set(colours)]));

const nameIdx = openHeads.indexOf('Opening');
const pairs = openRows.map((r) => r.children[nameIdx].textContent.trim() + '|' + r.children[colourIdx].textContent.trim());
ok('one row per opening per colour, never a duplicate',
  new Set(pairs).size === pairs.length,
  `${pairs.length} rows, ${new Set(pairs).size} distinct`);

/* ---------------------------------------------------------------- */
head('filtering to one colour asks "what does he play against my Black?"');

const postJson = (m, b) => fetch(BASE + '/api/' + m, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
}).then((r) => r.json());
const bothColours = await postJson('head_to_head',
  { player: 's1mplepie', opponent: 'Bitcoins-Gambit' });

$('#f-color').value = 'black';
click($('#h2h-go'));
await idle(2500);

const blackPanels = $$('#h2h-out .panel');
const blackOpenPanel = blackPanels.find((p) => {
  const h = p.querySelector('h2');
  return h && h.textContent.trim() === 'By opening';
});
ok('the openings panel survives the colour filter', !!blackOpenPanel);

const blackHeads = blackOpenPanel ? $$('th', blackOpenPanel).map((t) => t.textContent.trim()) : [];
// Every row would say "Black", so the column is dropped and the note says it once.
ok('the now-constant Colour column is dropped', !blackHeads.includes('Colour'),
  JSON.stringify(blackHeads));
ok('and the view says which side it is reporting',
  /Only the games where s1mplepie had Black/.test($('#h2h-out').textContent));
ok('the By colour split is gone, not left half empty',
  !blackPanels.some((p) => {
    const h = p.querySelector('h2');
    return h && h.textContent.trim() === 'By colour';
  }));

// The real check: it is a strict subset, not the same numbers relabelled.
const blackData = await postJson('head_to_head',
  { player: 's1mplepie', opponent: 'Bitcoins-Gambit', filter: { color: 'black' } });
ok('the colour is echoed back', blackData.color === 'black', String(blackData.color));
ok('fewer games than the full rivalry',
  blackData.total.games > 0 && blackData.total.games < bothColours.total.games,
  `${blackData.total.games} of ${bothColours.total.games}`);
ok('and only openings played as Black',
  blackData.by_opening.every((r) => r.color === 'black'),
  JSON.stringify([...new Set(blackData.by_opening.map((r) => r.color))]));

/*
 * The point of the whole exercise: narrowing to the games where you had Black
 * must not narrow to *your moves*. In those games White's moves are his, and
 * the blue arrow is what shows them.
 */
const blackTree = await postJson('explore', {
  filter: { player: 's1mplepie', opponent: 'Bitcoins-Gambit', color: 'black' }, moves: [],
});
ok('the tree still reaches those games', blackTree.total_games > 0,
  String(blackTree.total_games));
ok('it is White to move at the start', blackTree.turn === 'white', blackTree.turn);
ok('his openings are all still there to be arrowed',
  blackTree.children.length > 0, `${blackTree.children.length} moves`);
ok('and every one of them is credited to him, not to you',
  blackTree.children.every((c) => c.by_player === 0),
  blackTree.children.slice(0, 3).map((c) => `${c.san}:${c.by_player}`).join(' '));

// Put the filter back so nothing downstream inherits it.
$('#f-color').value = '';
click($('#h2h-go'));
await idle(2500);
ok('clearing the filter restores the full record',
  /By colour/.test($('#h2h-out').textContent)
  && !/Only the games where/.test($('#h2h-out').textContent));

/* ---------------------------------------------------------------- */
head('backend no longer emits score_pct');
const post = (m, b) => fetch(BASE + '/api/' + m, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
}).then((r) => r.json());
const ov = await post('overview', { filter: { player: 's1mplepie' } });
ok('overview has win_pct', typeof ov.win_pct === 'number', JSON.stringify(ov).slice(0, 120));
ok('overview has no score_pct', !('score_pct' in ov), JSON.stringify(Object.keys(ov)));
ok('by_color entries dropped score_pct too',
  ov.by_color && !('score_pct' in ov.by_color.white) && 'win_pct' in ov.by_color.white,
  JSON.stringify(ov.by_color && ov.by_color.white));
const h2hData = await post('head_to_head',
  { player: 's1mplepie', opponent: 'Bitcoins-Gambit' });
ok('head_to_head returns openings', Array.isArray(h2hData.by_opening) && h2hData.by_opening.length > 0,
  JSON.stringify(Object.keys(h2hData)));
ok('each carries the player\'s colour',
  h2hData.by_opening.every((r) => r.color === 'white' || r.color === 'black'),
  JSON.stringify(h2hData.by_opening[0]));
ok('and a record measured from the player\'s side',
  h2hData.by_opening.every((r) => r.wins + r.losses + r.draws === r.games),
  JSON.stringify(h2hData.by_opening[0]));
// The split must partition the games, not double-count them.
ok('the opening rows never total more than the games played',
  h2hData.by_opening.reduce((n, r) => n + r.games, 0) <= h2hData.total.games,
  `${h2hData.by_opening.reduce((n, r) => n + r.games, 0)} vs ${h2hData.total.games}`);
// The plain openings view is unchanged: no colour column has appeared there.
const plainOpenings = await post('by_opening', { filter: { player: 's1mplepie' }, limit: 5 });
ok('the Openings tab is still grouped by name alone',
  plainOpenings.every((r) => !('color' in r)), JSON.stringify(plainOpenings[0]));

const tr = await post('explore', { filter: { player: 's1mplepie' } });
const kid = tr.children[0];
ok('tree children use win_pct / white_win_pct',
  'win_pct' in kid && 'white_win_pct' in kid
  && !('score_pct' in kid) && !('white_score_pct' in kid),
  JSON.stringify(Object.keys(kid)));
const pos = await post('common_positions', { filter: { player: 's1mplepie' }, limit: 1, min_games: 2 });
ok('common_positions uses win_pct',
  pos.length === 0 || ('win_pct' in pos[0] && !('score_pct' in pos[0])),
  pos.length ? JSON.stringify(Object.keys(pos[0])) : 'no rows');

/* ---------------------------------------------------------------- */
head('favourites');
/*
 * A favourite is a game plus a name the user typed, and the name is the part
 * nothing else in the database records — so the test follows the whole loop a
 * person does: star a game from a list, name it, find it under that name,
 * rename it, open it on the board, and unstar it.
 */

// Whatever an earlier run left behind is not this run's business.
for (const id of await apiOf('favourite_ids')) {
  await apiOf('favourite_remove', { game_id: id });
}

$('#f-player').value = 's1mplepie';
$('#f-color').value = '';
$('#f-color').dispatchEvent(new window.Event('change', { bubbles: true }));

// A game can be starred wherever it is listed, so check the explorer's list
// too — that is where a game is most often worth keeping.
click($$('.nav-item').find((b) => b.dataset.view === 'explorer'));
await idle(1200);
key('ArrowUp');   // back to the start position, which every game passes through
await idle(2000);
ok('the explorer\'s games list carries stars',
  $$('#explorer-games .star').length > 0, `${$$('#explorer-games .star').length} stars`);

click($$('.nav-item').find((b) => b.dataset.view === 'games'));
await idle(1800);

const firstStar = $('#games-out .star');
ok('every game in the list has a star', $$('#games-out .star').length > 0,
  `${$$('#games-out .star').length} stars`);
ok('and it starts hollow', firstStar && firstStar.textContent === '☆',
  firstStar && JSON.stringify(firstStar.textContent));

const starredId = Number(firstStar.dataset.game);
click(firstStar);
await idle(300);
ok('clicking a star asks for a name',
  !$('#fav-dialog').classList.contains('hidden'));
ok('with a suggestion already filled in', / vs /.test($('#fav-name').value),
  JSON.stringify($('#fav-name').value));
ok('and enough detail to know which game it is',
  $('#fav-dialog-sub').textContent.length > 0,
  JSON.stringify($('#fav-dialog-sub').textContent));

$('#fav-name').value = 'the h-pawn mate';
click($('#fav-save'));
await idle(800);
ok('saving closes the dialog', $('#fav-dialog').classList.contains('hidden'));
ok('and fills the star in',
  firstStar.textContent === '★' && firstStar.classList.contains('on'),
  JSON.stringify(firstStar.textContent));
ok('the backend recorded it',
  (await apiOf('favourite_ids')).includes(starredId), `id ${starredId}`);

click($$('.nav-item').find((b) => b.dataset.view === 'favourites'));
await idle(1400);
ok('it appears in the Favourites view', $$('#fav-out tbody tr').length === 1,
  `${$$('#fav-out tbody tr').length} rows`);
ok('under the name that was typed',
  $('#fav-out .fav-name') && $('#fav-out .fav-name').textContent === 'the h-pawn mate',
  $('#fav-out .fav-name') && $('#fav-out .fav-name').textContent);
ok('the filter bar is hidden, because it does not apply here',
  $('#filterbar').classList.contains('hidden'));
ok('and the count is stated', /1 game/.test($('#fav-count').textContent),
  JSON.stringify($('#fav-count').textContent));

const searchFor = async (term) => {
  $('#fav-search').value = term;
  $('#fav-search').dispatchEvent(new window.Event('input', { bubbles: true }));
  await idle(900);
};
await searchFor('h-pawn');
ok('search finds it by name', $$('#fav-out tbody tr').length === 1,
  `${$$('#fav-out tbody tr').length} rows`);
await searchFor('zzz-nothing-is-called-this');
ok('and says so when nothing matches',
  /Nothing saved matches/.test($('#fav-out').textContent));
await searchFor('');

const renameButton = () =>
  $$('#fav-out .fav-actions button').find((b) => b.textContent === 'Rename');
click(renameButton());
await idle(300);
ok('rename opens with the current name', $('#fav-name').value === 'the h-pawn mate',
  JSON.stringify($('#fav-name').value));
$('#fav-name').value = 'the one against Anders';
click($('#fav-save'));
await idle(900);
ok('the new name replaces the old',
  /the one against Anders/.test($('#fav-out').textContent)
  && !/h-pawn/.test($('#fav-out').textContent));

click(renameButton());
await idle(300);
$('#fav-name').value = 'discarded';
click($('#fav-cancel'));
await idle(600);
ok('cancelling changes nothing',
  /the one against Anders/.test($('#fav-out').textContent)
  && !/discarded/.test($('#fav-out').textContent));

const savedLine = await apiOf('game_line', { game_id: starredId });
ok('a saved game comes back as a playable move list',
  savedLine.moves.length > 4 && /^[a-h][1-8][a-h][1-8]/.test(savedLine.moves[0].uci),
  JSON.stringify(savedLine.moves.slice(0, 2)));

click($('#fav-out tbody tr'));
await idle(2500);
ok('clicking a favourite opens it on the Explorer board',
  $('#view-explorer').classList.contains('active'));
ok('with the whole game loaded',
  $$('#explorer-board-host .line .mv').length >= savedLine.moves.length,
  `${$$('#explorer-board-host .line .mv').length} of ${savedLine.moves.length}`);
// At move one, not at the final position: a game is reviewed forwards, and the
// end of it is where the engine starts appending a continuation of its own.
ok('opened at the first move rather than the last',
  $('#explorer-board-host .line .mv.current') === null
  && $$('#explorer-board-host .line .mv.ahead').length >= savedLine.moves.length,
  `${$$('#explorer-board-host .line .mv.ahead').length} moves ahead of the cursor`);
const myside = savedLine.white_lower === 's1mplepie' ? 'white' : 'black';
ok(`faced from the side you had (${myside})`,
  topLeft('#explorer-board-host') === (myside === 'white' ? 'a8' : 'h1'),
  topLeft('#explorer-board-host'));

click($$('.nav-item').find((b) => b.dataset.view === 'favourites'));
await idle(1200);
click($$('#fav-out .fav-actions button').find((b) => b.textContent === 'Remove'));
await idle(1000);
ok('removing empties the list', /No favourites yet/.test($('#fav-out').textContent));
ok('and the backend agrees', (await apiOf('favourite_ids')).length === 0);

click($$('.nav-item').find((b) => b.dataset.view === 'games'));
await idle(1500);
const backInGames = $(`#games-out .star[data-game="${starredId}"]`);
ok('the star in the games table is hollow again',
  backInGames && backInGames.textContent === '☆',
  backInGames && JSON.stringify(backInGames.textContent));

// The game itself is untouched by any of this.
const stillThere = await apiOf('game_detail', { game_id: starredId });
ok('unstarring does not delete the game', !stillThere.error && stillThere.id === starredId,
  JSON.stringify(stillThere).slice(0, 100));

const bogusFav = await apiOf('favourite_add', { game_id: 99999999, name: 'x' });
ok('starring a game that does not exist is refused', !!bogusFav.error,
  JSON.stringify(bogusFav).slice(0, 120));
const autoNamed = await apiOf('favourite_add', { game_id: starredId, name: '   ' });
ok('a blank name falls back to the players and the date',
  / vs /.test(autoNamed.name), JSON.stringify(autoNamed.name));
await apiOf('favourite_remove', { game_id: starredId });

/* ---------------------------------------------------------------- */
head('past the end of a loaded game');
/*
 * A game ends; the engine keeps queueing moves from the final position. Those
 * moves sit in the same list, in the same shape, and nothing said they were
 * never played — so the board has to say it.
 */
click($$('.nav-item').find((b) => b.dataset.view === 'explorer'));
await idle(800);
const gameBoard = window.__test.explorerBoard;
const someGame = await apiOf('game_line', { game_id: starredId });
gameBoard.setLine(someGame.moves, { markEnd: 'the game', at: 0 });
await idle(2000);

const lineHost = '#explorer-board-host';
ok('nothing is flagged while inside the game',
  $(`${lineHost} .mv.beyond`) === null && $('.branch-row.past-end') === null);

key('ArrowDown');           // to the last move of the game
await idle(3500);           // the engine then queues its own continuation
const queued = $$(`${lineHost} .line .mv.ahead`).length;
ok('the engine queues a continuation from the final position', queued > 0,
  `${queued} queued`);
ok('and the end of the game is marked in the move list',
  $(`${lineHost} .line-end`) !== null);
ok('the queued moves are marked as not part of it',
  $$(`${lineHost} .mv.beyond`).length === queued,
  `${$$(`${lineHost} .mv.beyond`).length} marked vs ${queued} queued`);
ok('but no banner yet — you are still on the game\'s last move',
  $('.branch-row.past-end') === null);

key('ArrowRight');          // one move past the end
await idle(2500);
const pastBar = $('.branch-row.past-end');
ok('stepping past the end says so plainly', pastBar !== null);
ok('naming it as your own analysis rather than the game',
  pastBar && /not part of it/.test(pastBar.textContent),
  pastBar && pastBar.textContent);
ok('and offers the way back to the last move played',
  pastBar && /Back to/.test(pastBar.querySelector('.branch-back').textContent),
  pastBar && pastBar.querySelector('.branch-back').textContent);
ok('the move on the board is marked as a continuation',
  $(`${lineHost} .mv.current.beyond`) !== null);

click(pastBar.querySelector('.branch-back'));
await idle(2000);
ok('going back returns to the game', $('.branch-row.past-end') === null);
ok('and the last move of the game is the one showing',
  $(`${lineHost} .mv.current`) !== null
  && !$(`${lineHost} .mv.current`).classList.contains('beyond'));

// None of this may leak into ordinary exploration, where there is no game to
// be past the end of.
gameBoard.setPosition(null);
await idle(1500);
gameBoard.playSan('e4');
await idle(2000);
gameBoard.playSan('c5');
await idle(2500);
ok('exploring from the start position flags nothing',
  $(`${lineHost} .mv.beyond`) === null
  && $('.branch-row.past-end') === null
  && $(`${lineHost} .line-end`) === null);

/* ---------------------------------------------------------------- */
head('filters apply on Enter, not on every keystroke');
/*
 * Half a username is a valid filter that matches nothing. Re-querying per
 * keystroke meant typing a name flashed through several empty results, each one
 * a full round of queries.
 */
click($$('.nav-item').find((b) => b.dataset.view === 'games'));
await idle(1500);
const gameRows = () => $$('#games-out tbody tr').length;
ok('the games list starts populated', gameRows() > 0, `${gameRows()} rows`);

$('#f-player').value = 'nobody-is-called-this';
$('#f-player').dispatchEvent(new window.Event('input', { bubbles: true }));
await idle(1200);
ok('typing on its own does not re-query', gameRows() > 0, `${gameRows()} rows`);

$('#f-player').dispatchEvent(new window.KeyboardEvent(
  'keydown', { key: 'Enter', bubbles: true, cancelable: true }));
await idle(1800);
ok('Enter applies it', gameRows() === 0, `${gameRows()} rows`);

$('#f-player').value = 's1mplepie';
$('#f-player').dispatchEvent(new window.Event('change', { bubbles: true }));
await idle(1800);
ok('and leaving the box applies it too, so a filter is never lost',
  gameRows() > 0, `${gameRows()} rows`);

/* ---------------------------------------------------------------- */
head('the move list stays where a long game can be read');
const boardKids = [...$('#explorer-board-host').children].map((c) => c.className);
ok('the move list sits above the engine lines',
  boardKids.indexOf('line') > -1
  && boardKids.indexOf('line') < boardKids.indexOf('engine-lines'),
  boardKids.join(' | '));
// Only the opening name and the state banners may come between the two —
// anything more and the moves are being pushed down the page again.
ok('and directly under the controls that walk it',
  boardKids.indexOf('line') - boardKids.indexOf('board-controls') <= 3,
  boardKids.join(' | '));

/* ---------------------------------------------------------------- */
head('the games you threw away');
/*
 * "I was winning and lost anyway" is a question about material, not about the
 * engine: evaluating every position of every game would be tens of hours of
 * Stockfish. The advantage has to have been held for three moves, so ordinary
 * exchanges — where one side is briefly a queen up between capture and
 * recapture — do not count as having been winning.
 */
let swingState = await apiOf('swing_status');
if (swingState.pending) {
  await apiOf('start_swing_scan');
  for (let i = 0; i < 120; i++) {
    await idle(1000);
    if (!(await apiOf('sync_status')).running) break;
  }
  swingState = await apiOf('swing_status');
}
ok('every game has been scanned for material swings', swingState.pending === 0,
  `${swingState.pending} still pending`);

const thrown = await apiOf('games', {
  filter: { player: 's1mplepie', threw_from: 4 }, limit: 50,
});
ok('the filter returns games', Array.isArray(thrown) && thrown.length > 0,
  `${thrown.length} games`);
ok('every one of them is a loss',
  thrown.every((g) => g.outcome === 'loss'),
  JSON.stringify(thrown.filter((g) => g.outcome !== 'loss').slice(0, 2)));
ok('and every one of them was won at some point',
  thrown.every((g) => (g.player_color === 'white'
    ? g.peak_white_adv : g.peak_black_adv) >= 4),
  JSON.stringify(thrown.slice(0, 1)));
ok('the peak carries the move it happened at',
  thrown.every((g) => Number.isInteger(
    g.player_color === 'white' ? g.peak_white_ply : g.peak_black_ply)));

const wider = await apiOf('games', {
  filter: { player: 's1mplepie', threw_from: 2 }, limit: 500,
});
const narrower = await apiOf('games', {
  filter: { player: 's1mplepie', threw_from: 9 }, limit: 500,
});
ok('a bigger lead is a stricter filter',
  narrower.length < wider.length, `+9: ${narrower.length}, +2: ${wider.length}`);

const allGames = await apiOf('games', { filter: { player: 's1mplepie' }, limit: 500 });
ok('and the filter actually narrows things',
  wider.length < allGames.length, `${wider.length} of ${allGames.length}`);

// Without a name there is no "I" to have been winning, so it cannot apply.
const noPlayer = await apiOf('games', { filter: { threw_from: 9 }, limit: 20 });
ok('with no player named the filter is ignored rather than wrong',
  noPlayer.length > 0, `${noPlayer.length} games`);

/* ---------------------------------------------------------------- */
head('reviewing a game from the Games list');
$('#f-player').value = 's1mplepie';
$('#f-threw').value = '4';
$('#f-threw').dispatchEvent(new window.Event('change', { bubbles: true }));
click($$('.nav-item').find((b) => b.dataset.view === 'games'));
await idle(2200);

const gameHeads = headersOf('#games-out th');
ok('the filter adds a column saying how far ahead you were',
  gameHeads.includes('Was winning'), gameHeads.join(','));
const firstThrown = $('#games-out tbody tr');
ok('and it reads as a lead and a move number',
  /\+\d+ at move \d+/.test(firstThrown.textContent),
  firstThrown.textContent.slice(0, 120));

const thrownId = Number($('#games-out .star').dataset.game);
const thrownRow = thrown.find((g) => g.id === thrownId) || thrown[0];
click(firstThrown);
await idle(3000);
ok('clicking the row opens the game for review, no starring needed',
  $('#view-explorer').classList.contains('active'));
ok('and it opens at the position you were winning in, not at move one',
  $('#explorer-board-host .line .mv.current') !== null,
  'no current move — it opened at the start');

const reviewBar = $('#review-bar');
ok('a bar above the board names the game being reviewed',
  !reviewBar.classList.contains('hidden')
  && reviewBar.textContent.includes(thrownRow.white_name),
  reviewBar.textContent.slice(0, 120));
ok('with a star that is not yet set',
  reviewBar.querySelector('.star')
  && reviewBar.querySelector('.star').textContent === '☆');

click(reviewBar.querySelector('.star'));
await idle(400);
ok('the star opens the naming dialog from here too',
  !$('#fav-dialog').classList.contains('hidden'));
$('#fav-name').value = 'threw a whole rook';
click($('#fav-save'));
await idle(900);
ok('the game is saved while you are still looking at it',
  (await apiOf('favourite_ids')).includes(thrownId), `id ${thrownId}`);
ok('and the bar takes on the name you gave it',
  reviewBar.textContent.includes('threw a whole rook'),
  reviewBar.textContent.slice(0, 120));
ok('the star is filled', reviewBar.querySelector('.star').textContent === '★');

// Cutting the game away has to stop the bar claiming it is still loaded.
window.__test.explorerBoard.setPosition(null);
await idle(2000);
ok('leaving the game clears the review bar',
  $('#review-bar').classList.contains('hidden'));

await apiOf('favourite_remove', { game_id: thrownId });
$('#f-threw').value = '';
$('#f-threw').dispatchEvent(new window.Event('change', { bubbles: true }));
await idle(1500);

/* ---------------------------------------------------------------- */
head('the explorer names the opening you are playing');
/*
 * Names come from a book of positions, not of move orders, which is the whole
 * trick: a transposition is the same position and therefore the same opening,
 * and the name survives leaving book because it is the deepest one the line
 * has passed through rather than a name for where the board stands now.
 */
const nameOf = (moves) => apiOf('explore', { filter: {}, moves })
  .then((d) => d.opening);

ok('the start position is not an opening', (await nameOf([])) == null);
ok('1.e4 is the King\'s Pawn Game',
  (await nameOf(['e2e4'])).name === "King's Pawn Game",
  JSON.stringify(await nameOf(['e2e4'])));
ok('1.e4 c5 is a Sicilian',
  (await nameOf(['e2e4', 'c7c5'])).name === 'Sicilian Defense',
  JSON.stringify(await nameOf(['e2e4', 'c7c5'])));

const najdorf = await nameOf(
  ['e2e4', 'c7c5', 'g1f3', 'd7d6', 'd2d4', 'c5d4', 'f3d4', 'g8f6', 'b1c3', 'a7a6']);
ok('and it refines to the Najdorf as the line goes on',
  /Najdorf/.test(najdorf.name), JSON.stringify(najdorf));
ok('naming the position the board is actually on', najdorf.plies_since === 0,
  JSON.stringify(najdorf));

// The reason for keying on positions rather than move orders.
const direct = await nameOf(['d2d4', 'g8f6', 'c2c4', 'g7g6']);
const transposed = await nameOf(['c2c4', 'g7g6', 'd2d4', 'g8f6']);
ok('a transposition gets the same name as the direct move order',
  direct && transposed && direct.name === transposed.name,
  `${direct && direct.name} vs ${transposed && transposed.name}`);

// Off book, the label has to stay rather than blink out.
const past = await nameOf(
  ['e2e4', 'c7c5', 'g1f3', 'd7d6', 'd2d4', 'c5d4', 'f3d4', 'g8f6', 'b1c3', 'a7a6',
   'h2h3', 'h7h6', 'a2a3']);
ok('a line that leaves the book keeps the name it earned',
  past && /Najdorf/.test(past.name), JSON.stringify(past));
// Not a fixed number: the book is deeper than it looks — 11.h3 here is itself
// named (Adams Attack) — so what matters is that the label survives the moves
// past whatever the last named position was.
ok('and says how far past the book it now is',
  past && past.plies_since > 0 && past.ply < 13, JSON.stringify(past));

// On the board itself.
click($$('.nav-item').find((b) => b.dataset.view === 'explorer'));
await idle(1000);
window.__test.explorerBoard.setPosition(null);
await idle(1500);
ok('the start position shows no opening label',
  $('#explorer-board-host .opening-name').classList.contains('hidden'));

window.__test.explorerBoard.playSan('e4');
await idle(1500);
window.__test.explorerBoard.playSan('c5');
await idle(2000);
const label = $('#explorer-board-host .opening-name');
ok('playing into an opening shows its name on the board',
  !label.classList.contains('hidden') && /Sicilian/.test(label.textContent),
  JSON.stringify(label.textContent));
ok('and the label sits above the move list',
  [...$('#explorer-board-host').children].map((c) => c.className).indexOf('opening-name')
    < [...$('#explorer-board-host').children].map((c) => c.className).indexOf('line'));

/* ---------------------------------------------------------------- */
head('every date the app writes is day/month/year');
click($$('.nav-item').find((b) => b.dataset.view === 'games'));
await idle(1800);
const dateCells = $$('#games-out tbody tr').map((tr) => tr.children[1].textContent);
ok('the games list writes dd/mm/yy', dateCells.length > 0
  && dateCells.every((d) => /^\d{2}\/\d{2}\/\d{2}$/.test(d)),
  JSON.stringify(dateCells.slice(0, 3)));
ok('and no ISO date is left anywhere in the table',
  !/\d{4}-\d{2}-\d{2}/.test($('#games-out').textContent),
  ($('#games-out').textContent.match(/\d{4}-\d{2}-\d{2}/) || [''])[0]);

// The day has to come first, not the month — the whole point of the change.
click($$('.nav-item').find((b) => b.dataset.view === 'dashboard'));
await idle(2000);
const range = $$('#dash-cards .s').map((s) => s.textContent).join(' ');
ok('the dashboard date range does too', /\d{2}\/\d{2}\/\d{2}/.test(range), range);

// A malformed value must pass through rather than be rearranged into nonsense.
const fmt = window.__test.fmtDate;
ok('a value that is not a date is left alone',
  fmt('not-a-date') === 'not-a-date', fmt('not-a-date'));
ok('and a missing one still shows a dash', fmt(null) === '—');
ok('the fifth of August reads 05/08/26, not 08/05/26',
  fmt('2026-08-05T12:00:00Z') === '05/08/26', fmt('2026-08-05T12:00:00Z'));

/* ---------------------------------------------------------------- */
head('the date filters say which way round they are');
const dots = ['#f-since', '#f-until'].map(
  (sel) => $(sel).closest('.f').querySelector('.help-dot'));
ok('From and To both carry a "?"', dots.every(Boolean),
  dots.map((d) => !!d).join(','));
ok('and hovering it explains the order',
  dots.every((d) => d && /day *\/ *month *\/ *year/i.test(d.title)),
  dots.map((d) => d && d.title).join(' | '));
ok('with an example that cannot be read the other way',
  dots.every((d) => /05\/08\/2026/.test(d.title) && /August/.test(d.title)));

// The format the native picker writes comes from the WebView2 UI language,
// which the entry point pins — a US display language would otherwise render
// the fifth of August as 08/05/2026 whatever Windows' regional settings say.
const entry = fs.readFileSync(path.join(ROOT, 'app.py'), 'utf8');
ok('the desktop entry point pins the browser locale',
  /WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS/.test(entry) && /--lang=en-GB/.test(entry));
ok('and does it before webview is imported',
  entry.indexOf('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS') < entry.indexOf('import webview'),
  `env at ${entry.indexOf('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS')}, `
  + `import at ${entry.indexOf('import webview')}`);

/* ---------------------------------------------------------------- */
head('search depth is chosen from the board, not buried in Settings');

const depthSel = $('#explorer-board-host .depth-select');
const posDepthSel = $('#pos-board-host .depth-select');
const savedDepth = (await apiOf('get_config')).engine_depth;

ok('the board carries a depth dropdown', !!depthSel);
ok('so does the positions board', !!posDepthSel);

const backendChoices = (await apiOf('get_config')).engine_depth_choices;
ok('the choices come from the backend, not a hard-coded list in the UI',
  Array.isArray(backendChoices) && backendChoices.length >= 4,
  JSON.stringify(backendChoices));
ok('and every one of them is on the dropdown',
  backendChoices.every((c) => Array.from(depthSel.options)
    .some((o) => o.value === String(c.depth))),
  Array.from(depthSel.options).map((o) => o.value).join(','));
ok('each option says what it costs, not just a bare number',
  Array.from(depthSel.options).every((o) => /\S\s·\s\S/.test(o.textContent)),
  Array.from(depthSel.options).map((o) => o.textContent).join(' | '));
ok('the dropdown starts on the saved depth',
  depthSel.value === String(savedDepth), `${depthSel.value} vs ${savedDepth}`);

/*
 * One engine, one depth. Two boards set differently would be two answers to the
 * same question with nothing on screen to say which was which — so changing it
 * anywhere has to change it everywhere, including the Settings box.
 *
 * A shallow option is used: this fires a real search on a real engine, and the
 * point being tested is that the setting propagates, not that Stockfish works.
 */
const other = String((backendChoices.find((c) => c.depth !== savedDepth
                                             && c.depth <= 18) || backendChoices[0]).depth);
depthSel.value = other;
depthSel.dispatchEvent(new window.Event('change', { bubbles: true }));
await idle(1500);

ok('changing it on one board changes the other', posDepthSel.value === other,
  `${posDepthSel.value} vs ${other}`);
ok('and the Settings box agrees', $('#eng-depth').value === other,
  $('#eng-depth').value);
ok('and it survives a restart, because it was written to the config',
  String((await apiOf('get_config')).engine_depth) === other,
  String((await apiOf('get_config')).engine_depth));

// Settings is the other way in to the same setting, so a change there has to
// come back the other way.
click($$('.nav-item').find((b) => b.dataset.view === 'settings'));
await idle(2500);

// The engine caps what it will accept. A value past the cap must not be what
// gets stored, or the next launch reloads a depth the engine would refuse —
// and the dropdown must show what was actually saved, not what was typed.
$('#eng-depth').value = '999';
click($('#eng-save'));
await idle(2000);
ok('a depth beyond the engine\'s range is clamped on save',
  (await apiOf('get_config')).engine_depth === 40,
  String((await apiOf('get_config')).engine_depth));
ok('and the board shows the clamped value, not the one typed',
  depthSel.value === '40', depthSel.value);

// A depth typed into Settings need not be one of the offered ones. A select
// with no matching option silently displays its first entry, which would claim
// a depth nobody chose.
$('#eng-depth').value = '17';
click($('#eng-save'));
await idle(2000);
ok('an off-menu depth gets its own entry rather than being rounded away',
  depthSel.value === '17', depthSel.value);
ok('and is labelled as the odd one out',
  /custom/.test(depthSel.selectedOptions[0].textContent),
  depthSel.selectedOptions[0].textContent);

/* ---------------------------------------------------------------- */
head('the depth reported is the depth reached');
/*
 * Deep searches can run out of time before they run out of depth. Reporting the
 * depth that was asked for would be claiming work that was not done — which is
 * the one number in the panel that has to be trustworthy, because it is how you
 * decide whether to believe the evaluation beside it.
 */
const evDeep = await apiOf('evaluate', {
  fen: 'r1bqkb1r/pp3ppp/2n1pn2/2pp4/3P1B2/2PBPN2/PP3PPP/RN1QK2R w KQkq - 0 7',
  depth: 14,
});
ok('the backend reports the depth the search reached', evDeep.reached >= 14,
  `asked 14, reached ${evDeep.reached}`);
ok('and says whether it fell short', evDeep.truncated === false,
  String(evDeep.truncated));

const headEl = () => $('#explorer-board-host .engine-head');
window.__test.explorerBoard.showEval({
  turn: 'white', depth: 30, reached: 21, truncated: true, cached: false,
  score_cp: 35, mate_in: null,
  lines: [{ rank: 1, score_cp: 35, san: 'e4', uci: 'e2e4',
            pv: 'e4', pv_san: ['e4'], pv_uci: ['e2e4'] }],
}, false, window.__test.explorerBoard.fen);
await idle(300);
ok('a cut-short search shows the depth it got to, not the one requested',
  /depth 21/.test(headEl().textContent) && !/depth 30/.test(headEl().textContent),
  headEl().textContent);
ok('and says outright that the clock stopped it',
  /time limit/.test(headEl().textContent) && /30 not reached/.test(headEl().textContent),
  headEl().textContent);
ok('marked as a caveat rather than left to blend in',
  !!headEl().querySelector('.engine-cut'));
ok('with somewhere to go about it',
  /threads/i.test(headEl().querySelector('.engine-cut').title),
  headEl().querySelector('.engine-cut').title);

// A search that finished must not be labelled as one that did not.
window.__test.explorerBoard.showEval({
  turn: 'white', depth: 18, reached: 18, truncated: false, cached: true,
  score_cp: 35, mate_in: null,
  lines: [{ rank: 1, score_cp: 35, san: 'e4', uci: 'e2e4',
            pv: 'e4', pv_san: ['e4'], pv_uci: ['e2e4'] }],
}, false, window.__test.explorerBoard.fen);
await idle(300);
ok('a search that finished carries no warning',
  !headEl().querySelector('.engine-cut'), headEl().textContent);
ok('and still reports being cached', /cached/.test(headEl().textContent),
  headEl().textContent);

// A minute of "…" beside a stale set of lines reads as a hang.
window.__test.explorerBoard.showEval(null, true, window.__test.explorerBoard.fen);
await idle(200);
ok('while searching, the panel says what it is searching to',
  /searching to depth 17/.test(headEl().textContent), headEl().textContent);
ok('and the previous position\'s lines are dimmed rather than left looking current',
  $('#explorer-board-host .engine-lines').classList.contains('busy'));

$('#eng-depth').value = String(savedDepth);
click($('#eng-save'));
await idle(1500);

/* ---------------------------------------------------------------- */
head('the odd game modes are reachable, without taking over the filter bar');
/*
 * Everything outside standard chess is excluded from every view by default —
 * which is why the two dashboard counters disagree. The games are in the
 * database all the same, so there has to be a way to look at them.
 */
const variants = await apiOf('variants');
const nonStandard = variants.filter((v) => v.key !== 'standard');
ok('the backend reports which modes are actually present',
  Array.isArray(variants) && variants.some((v) => v.key === 'standard'),
  JSON.stringify(variants.map((v) => v.key)));
ok('and it folds the spellings the sources disagree on into one row each',
  variants.length === new Set(variants.map((v) => v.key)).size
  && !variants.some((v) => v.key === 'chess'),
  JSON.stringify(variants.map((v) => `${v.key}:${v.games}`)));
ok('standard is not marked as a variant to choose',
  variants.find((v) => v.key === 'standard').indexed === true);
ok('and the odd modes are flagged as absent from the position index',
  nonStandard.every((v) => v.indexed === false),
  JSON.stringify(nonStandard.map((v) => `${v.key}:${v.indexed}`)));

const vSel = $('#f-variant');
ok('the filter bar carries one dropdown, not a row of chips', !!vSel);
ok('it lists only the modes this database has',
  Array.from(vSel.options).map((o) => o.value).filter(Boolean).filter((v) => v !== 'any')
    .sort().join(',') === nonStandard.map((v) => v.key).sort().join(','),
  Array.from(vSel.options).map((o) => o.value).join(','));
ok('each option carries its game count, so a rare mode looks rare',
  Array.from(vSel.options).filter((o) => o.value && o.value !== 'any')
    .every((o) => /\(\d[\d,]*\)$/.test(o.textContent)),
  Array.from(vSel.options).map((o) => o.textContent).join(' | '));
ok('the default is standard, which is what every view already meant',
  vSel.value === '', JSON.stringify(vSel.value));

// The whole point: the two dashboard counters should be reconcilable.
const anyCount = (await apiOf('overview', { filter: { variant: 'any' } })).games;
const stdCount = (await apiOf('overview', { filter: {} })).games;
const summaryCount = (await apiOf('summary')).games;
ok('"Any variant" accounts for exactly the gap between the two counters',
  anyCount === summaryCount && anyCount > stdCount,
  `any ${anyCount}, standard ${stdCount}, in database ${summaryCount}`);

if (nonStandard.length) {
  const pick = nonStandard[0];
  const only = (await apiOf('overview', { filter: { variant: pick.key } })).games;
  ok(`filtering to ${pick.key} returns just those games`, only === pick.games,
    `${only} vs ${pick.games}`);
}

// Selecting a mode the tree cannot index must say so rather than show a zero
// that reads as "you have never played this".
if (nonStandard.length) {
  click($$('.nav-item').find((b) => b.dataset.view === 'explorer'));
  await idle(2500);
  vSel.value = nonStandard[0].key;
  vSel.dispatchEvent(new window.Event('change', { bubbles: true }));
  await idle(3000);
  const total = $('#ex-total').textContent;
  ok('the explorer explains itself instead of showing an empty tree',
    /not in the position index/.test(total), JSON.stringify(total));
  ok('and says where those games can still be seen',
    /Games list/.test($('#ex-total').title || ''), $('#ex-total').title);
  vSel.value = '';
  vSel.dispatchEvent(new window.Event('change', { bubbles: true }));
  await idle(3000);
  ok('clearing it puts the tree back',
    /game\(s\) reached this position/.test($('#ex-total').textContent),
    JSON.stringify($('#ex-total').textContent));
}

/* ---------------------------------------------------------------- */
head('the blue arrow says whose move it actually was');
/*
 * The arrow is the most-played move from the position, and whether that was
 * *your* move depends on the position, not on the filter: where White is to
 * move it is yours only in the games you had White. It used to be labelled
 * "what you played most often here" regardless, which was wrong every time you
 * studied a position from the other side of the board.
 */
const blackOnly = await apiOf('explore', {
  filter: { player: 's1mplepie', color: 'black' },
  moves: ['d2d4', 'g7g6'],
});
ok('a position after 1.d4 g6 has White to move', blackOnly.turn === 'white', blackOnly.turn);
ok('and filtering to your black games credits none of those moves to you',
  blackOnly.children.length > 0 && blackOnly.children.every((c) => c.by_player === 0),
  blackOnly.children.slice(0, 3).map((c) => `${c.san}:${c.by_player}/${c.games}`).join(' '));

const whiteOnly = await apiOf('explore', {
  filter: { player: 's1mplepie', color: 'white' },
  moves: ['d2d4', 'g7g6'],
});
ok('filtering to your white games credits all of them to you',
  whiteOnly.children.length > 0
  && whiteOnly.children.every((c) => c.by_player === c.games),
  whiteOnly.children.slice(0, 3).map((c) => `${c.san}:${c.by_player}/${c.games}`).join(' '));

const bothCols = await apiOf('explore', {
  filter: { player: 's1mplepie' },
  moves: ['d2d4', 'g7g6'],
});
const mixed = bothCols.children.find((c) => c.by_player > 0 && c.by_player < c.games);
ok('with both colours the same move is genuinely part yours and part theirs',
  !!mixed, bothCols.children.slice(0, 3)
    .map((c) => `${c.san}:${c.by_player}/${c.games}`).join(' '));

ok('nobody in focus means nobody owns the move',
  (await apiOf('explore', { filter: {}, moves: ['d2d4', 'g7g6'] }))
    .children.every((c) => c.by_player === null));

// And the wording that reaches the screen.
const lbl = window.__test.playedByLabel;
const ttl = window.__test.playedByTitle;
const turnWhite = { turn: 'white' };
const mine9 = { san: 'c4', games: 9, by_player: 9 };
const none9 = { san: 'c4', games: 9, by_player: 0 };
const mix9 = { san: 'c4', games: 9, by_player: 5 };

ok('all yours reads as yours',
  /What you played most often here/.test(lbl(mine9, turnWhite)), lbl(mine9, turnWhite));
ok('none yours reads as your opponents\'',
  /your opponents played most here/.test(lbl(none9, turnWhite)), lbl(none9, turnWhite));
ok('a mix is not rounded to whichever is larger',
  /partly/.test(lbl(mix9, turnWhite)), lbl(mix9, turnWhite));
ok('with no player in focus it claims nothing',
  !/you/i.test(lbl({ san: 'c4', games: 9, by_player: null }, turnWhite)),
  lbl({ san: 'c4', games: 9, by_player: null }, turnWhite));

/*
 * The short wording must never name the side to move.
 *
 * "Most played against you here (as White)" attached the colour to the wrong
 * noun: filtering to your black games at a white-to-move position produced a
 * label that read as though you had been White.
 */
[mine9, none9, mix9].forEach((c) => {
  ok(`no colour is named beside "${lbl(c, turnWhite).slice(0, 28)}…"`,
    !/\bas (White|Black)\b/.test(lbl(c, turnWhite)), lbl(c, turnWhite));
});
ok('the colour lives in the tooltip instead, where it has room to be clear',
  /with White/.test(ttl(mine9, turnWhite)), ttl(mine9, turnWhite));
ok('and the tooltip spells out why none of them were yours',
  /White to move/.test(ttl(none9, turnWhite)) && /had Black/.test(ttl(none9, turnWhite)),
  ttl(none9, turnWhite));
ok('and gives the split in numbers when it is mixed',
  /5 by you with White/.test(ttl(mix9, turnWhite))
  && /4 against you/.test(ttl(mix9, turnWhite)), ttl(mix9, turnWhite));

/*
 * Narrowed to one opponent, "your opponents" is a plural for a set of one.
 * Studying one rival is the case the arrow exists for, so it names him.
 */
const VS = 'Bitcoins-Gambit';
ok('with one opponent filtered the arrow names him',
  /What Bitcoins-Gambit played most here/.test(lbl(none9, turnWhite, null, null, VS)),
  lbl(none9, turnWhite, null, null, VS));
ok('and does not also call him "your opponents"',
  !/your opponents/.test(lbl(none9, turnWhite, null, null, VS)),
  lbl(none9, turnWhite, null, null, VS));
ok('a move of your own is still yours, not his',
  /What you played most often here/.test(lbl(mine9, turnWhite, null, null, VS)),
  lbl(mine9, turnWhite, null, null, VS));
ok('a mixed position credits him for his share',
  /partly Bitcoins-Gambit’s/.test(lbl(mix9, turnWhite, null, null, VS)),
  lbl(mix9, turnWhite, null, null, VS));
ok('the tooltip says all of them were his',
  /all of them were Bitcoins-Gambit’s/.test(ttl(none9, turnWhite, null, VS)),
  ttl(none9, turnWhite, null, VS));
ok('and never says "you’s opponents"',
  ![lbl(none9, turnWhite, null, null, VS), lbl(mix9, turnWhite, null, null, VS),
    ttl(none9, turnWhite, null, VS), ttl(mix9, turnWhite, null, VS)]
    .some((s) => /you’s|yous /.test(s)),
  ttl(mix9, turnWhite, null, VS));
// Without an opponent filter the plural is right and must be left alone.
ok('unfiltered, the plural wording is unchanged',
  /your opponents played most here/.test(lbl(none9, turnWhite)), lbl(none9, turnWhite));

/* ---------------------------------------------------------------- */
head('and the same question about a titled player gets the same answer');
/*
 * "What does Carlsen play here" has the identical trap: his games include both
 * colours, so at a position where Black is to move, the games he had White
 * contribute his opponents' replies. Narrowing to someone's games is not the
 * same as narrowing to their moves.
 */
const refAll = await apiOf('reference_explore', { moves: ['e2e4'] });
ok('the library answers for the position after 1.e4',
  refAll.children.length > 0, `${refAll.children.length} moves`);
ok('with nobody in focus no move is credited to anyone',
  refAll.children.every((c) => c.by_player === null),
  refAll.children.slice(0, 3).map((c) => `${c.san}:${c.by_player}`).join(' '));

const someone = (refAll.players || [])[0];
if (someone) {
  const refOne = await apiOf('reference_explore', {
    moves: ['e2e4'], player: someone.username,
  });
  const split = refOne.children.filter((c) => c.by_player != null);
  ok(`focusing ${someone.username} splits their moves from their opponents'`,
    split.length > 0 && split.every((c) => c.by_player <= c.games),
    split.slice(0, 3).map((c) => `${c.san}:${c.by_player}/${c.games}`).join(' '));
  ok('and at least one move is genuinely not all theirs — the bug that was fixed',
    split.some((c) => c.by_player < c.games),
    split.slice(0, 4).map((c) => `${c.san}:${c.by_player}/${c.games}`).join(' '));

  /*
   * The arrow points at the first row, so the ordering has to be about the
   * focused player too. Ranking by the total ranks their opponents' choices
   * alongside their own: in a real library that puts 1.e4 top for a player
   * whose own most-played first move is 1.d4 by two thousand games.
   */
  const ordered = refOne.children.filter((c) => c.by_player != null);
  ok('with a player in focus the rows are ranked by their own moves',
    ordered.every((c, i) => i === 0 || ordered[i - 1].by_player >= c.by_player),
    ordered.slice(0, 4).map((c) => `${c.san}:${c.by_player}`).join(' '));
  ok('so the top row is the move they actually played most',
    ordered.length === 0
    || ordered[0].by_player === Math.max(...ordered.map((c) => c.by_player)),
    ordered.slice(0, 4).map((c) => `${c.san}:${c.by_player}/${c.games}`).join(' '));
  ok('while with nobody in focus it stays ranked by total games',
    refAll.children.every((c, i) => i === 0 || refAll.children[i - 1].games >= c.games),
    refAll.children.slice(0, 4).map((c) => `${c.san}:${c.games}`).join(' '));

  const nm = someone.username;
  const tb = { turn: 'black' };
  ok('the wording names the player rather than saying "you"',
    /What .* played most often here/.test(lbl({ san: 'e5', games: 9, by_player: 9 }, tb, nm))
    && lbl({ san: 'e5', games: 9, by_player: 9 }, tb, nm).includes(nm),
    lbl({ san: 'e5', games: 9, by_player: 9 }, tb, nm));
  ok('and credits their opponents when none of it was theirs',
    lbl({ san: 'e5', games: 9, by_player: 0 }, tb, nm).includes(`${nm}’s opponents`),
    lbl({ san: 'e5', games: 9, by_player: 0 }, tb, nm));
  ok('a mix is reported as a mix here too',
    /partly/.test(lbl({ san: 'e5', games: 9, by_player: 4 }, tb, nm)),
    lbl({ san: 'e5', games: 9, by_player: 4 }, tb, nm));
  ok('and no colour is named in any of them either',
    [9, 0, 4].every((n) => !/\bas (White|Black)\b/
      .test(lbl({ san: 'e5', games: 9, by_player: n }, tb, nm))));
}
ok('nobody in focus still falls back to the library wording',
  lbl({ san: 'e5', games: 9, by_player: null }, { turn: 'black' }, null,
      'Most played here in the library') === 'Most played here in the library');

/* ---------------------------------------------------------------- */
head('the arrow guide never lists more arrows than are on the board');
/*
 * When the most-played move is also one the engine picked, no blue arrow is
 * drawn — there is nothing extra to point at. A third legend row for it, tinted
 * the colour of the arrow it coincides with, made two green arrows read as
 * three.
 */
click($$('.nav-item').find((b) => b.dataset.view === 'explorer'));
await idle(2500);
$('#f-variant').value = '';
await window.__test.explorerBoard.setPosition(null);
await idle(9000);

const guideRows = () => $$('#explorer-board-host .guide-row');
const boardArrows = () => $$('#explorer-board-host .arrows .arrow');
ok('the guide has a row for each arrow and no more',
  guideRows().length === boardArrows().length,
  `${guideRows().length} rows vs ${boardArrows().length} arrows`);
ok('no two rows carry the same arrow colour',
  new Set(boardArrows().map((a) => a.dataset.kind)).size === boardArrows().length,
  boardArrows().map((a) => a.dataset.kind).join(','));

/*
 * Force the coincidence: point the played arrow at the engine's own best move.
 *
 * Two things this has to get right. The board keeps a played move per source
 * and draws only the one the open tab selects, so the source has to be set or
 * the payload is stored and ignored — an earlier section leaves the Explorer on
 * the titled tab. And no `idle` after setPlayedMove: it draws synchronously,
 * and waiting hands the panel's own async render a chance to overwrite it.
 */
window.__test.explorerBoard.setPlayedSource('mine');
const bestArrow = boardArrows().find((a) => a.dataset.kind === 'best');
const bestUci = bestArrow.dataset.uci;
const bestSan = $$('#explorer-board-host .engine-line')[0]
  .querySelector('.el-pv').textContent.trim().split(/\s+/)[0];
window.__test.explorerBoard.setPlayedMove({
  uci: bestUci, san: bestSan,
  label: 'you played it 9 times',
  guideLabel: 'What you played most often here',
  agreeLabel: 'also your most played here',
}, 'mine');
ok('a move the engine also picked adds no extra row',
  guideRows().length === boardArrows().length,
  `${guideRows().length} rows vs ${boardArrows().length} arrows`);
ok('it is noted on the engine\'s own row instead',
  /also your most played here/.test(guideRows()[0].textContent),
  guideRows()[0].textContent);
ok('and the guide does not claim a blue arrow that was never drawn',
  !boardArrows().some((a) => a.dataset.kind === 'played'),
  boardArrows().map((a) => a.dataset.kind).join(','));

// A move the engine did not pick still gets its own blue arrow.
const drawnUcis = boardArrows().map((a) => a.dataset.uci);
const notPicked = Object.values(window.__test.explorerBoard.data.legal)
  .flat().find((m) => !drawnUcis.includes(m.uci));
if (notPicked) {
  window.__test.explorerBoard.setPlayedMove({
    uci: notPicked.uci, san: notPicked.san,
    label: 'you played it 9 times',
    guideLabel: 'What you played most often here',
    agreeLabel: 'also your most played here',
  }, 'mine');
  ok('a move of your own that the engine did not pick still gets the blue arrow',
    boardArrows().some((a) => a.dataset.kind === 'played'),
    boardArrows().map((a) => a.dataset.kind).join(','));
  ok('and it is still one row per arrow',
    guideRows().length === boardArrows().length,
    `${guideRows().length} rows vs ${boardArrows().length} arrows`);
  ok('whose row says it is yours, not the engine\'s',
    /What you played most often here/.test(guideRows()[2].textContent),
    guideRows().map((r) => r.textContent).join(' | '));
}

/* ---------------------------------------------------------------- */
head('plain light and dark, and a board colour of its own');
const savedTheme = (await apiOf('get_config')).theme;
const themeIds = $$('#theme-picker .theme-swatch').map((b) => b.dataset.theme);
ok('a plain dark theme exists', themeIds.includes('dark'), themeIds.join(','));
ok('and a plain light one', themeIds.includes('light'), themeIds.join(','));

const boardIds = $$('#board-picker .board-swatch').map((b) => b.dataset.board);
ok('board colours are their own picker', boardIds.length >= 5, boardIds.join(','));
ok('with "follow the theme" as the default choice', boardIds[0] === 'theme',
  boardIds.join(','));

const root = window.document.documentElement;

/*
 * The override is asserted against the stylesheet, not against
 * getComputedStyle: jsdom does not resolve CSS custom properties from
 * stylesheets, so it reports every variable as empty and any comparison of two
 * of them passes or fails for the wrong reason.
 */
const css = fs.readFileSync(path.join(WEB, 'style.css'), 'utf8');
ok('the plain themes are real rules, not just entries in a list',
  /:root\[data-theme="dark"\]\s*\{[^}]*--bg:/.test(css)
  && /:root\[data-theme="light"\]\s*\{[^}]*--bg:/.test(css));
boardIds.filter((id) => id !== 'theme').forEach((id) => {
  const rule = new RegExp(`:root\\[data-board="${id}"\\][^}]*\\{[^}]*\\}`);
  const found = (css.match(rule) || [''])[0];
  ok(`the ${id} board sets both square colours`,
    /--light-sq:/.test(found) && /--dark-sq:/.test(found), found);
  ok(`and touches nothing else, so it cannot restyle the interface`,
    (found.match(/--[a-z-]+:/g) || []).length === 2,
    (found.match(/--[a-z-]+:/g) || []).join(' '));
});

click($$('#theme-picker .theme-swatch').find((b) => b.dataset.theme === 'light'));
await idle(600);
ok('choosing a theme applies it', root.getAttribute('data-theme') === 'light',
  root.getAttribute('data-theme'));
ok('and no board override is in the way to begin with',
  !root.hasAttribute('data-board'), String(root.getAttribute('data-board')));

click($$('#board-picker .board-swatch').find((b) => b.dataset.board === 'green'));
await idle(600);
ok('choosing a board colour applies it too',
  root.getAttribute('data-board') === 'green', String(root.getAttribute('data-board')));
ok('the interface theme is untouched by it',
  root.getAttribute('data-theme') === 'light', root.getAttribute('data-theme'));
ok('both survive a round trip through the config',
  (await apiOf('get_config')).board === 'green',
  String((await apiOf('get_config')).board));
ok('and the theme picker keeps its own selection',
  $$('#theme-picker .theme-swatch.on').map((b) => b.dataset.theme).join(',') === 'light',
  $$('#theme-picker .theme-swatch.on').map((b) => b.dataset.theme).join(','));

click($$('#board-picker .board-swatch').find((b) => b.dataset.board === 'theme'));
await idle(600);
ok('going back to "follow theme" drops the override entirely',
  !root.hasAttribute('data-board'), String(root.getAttribute('data-board')));

// Leave the app as it was found.
click($$('#theme-picker .theme-swatch').find((b) => b.dataset.theme === savedTheme));
await idle(600);

/* ---------------------------------------------------------------- */
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

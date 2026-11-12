// Regression tests for the phase 1 client fixes in static/app.js (review of owner notes, "Get full
// thread" and prompt recipes: findings 0/9, 1/12, 8, 10, 11 and 13). The page is a browser script, so
// the functions under test are cut out of its source and run with small stand-ins for the page state.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const APP = readFileSync(new URL('../static/app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
// a top-level function inside the page's IIFE: from its header to the first closing brace at two spaces
const cut = (header) => {
  const i = APP.indexOf(header);
  assert.ok(i >= 0, `app.js should contain ${header}`);
  const end = APP.indexOf('\n  }\n', i);
  return APP.slice(i, end + 5);
};
// a const arrow: from its header to the end marker given
const cutTo = (header, endMark) => {
  const i = APP.indexOf(header);
  assert.ok(i >= 0, `app.js should contain ${header}`);
  const end = APP.indexOf(endMark, i);
  assert.ok(end > i, `${header} should end with ${endMark}`);
  return APP.slice(i, end + endMark.length);
};
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe('finding 11: a note is offered only on saved items', () => {
  const noteMenuItem = new Function(`${cutTo('const noteMenuItem = ', ': null);')}; return noteMenuItem;`)();

  test('an unsaved context post gets no "Add a note" (the server would answer 400)', () => {
    assert.equal(noteMenuItem({ id: 1, saved: false }, () => {}), null);
    assert.equal(noteMenuItem({ id: 1 }, () => {}), null);
  });

  test('a saved item still gets Add a note, or Edit my note when it has one', () => {
    assert.equal(noteMenuItem({ id: 1, saved: true }, () => {}).label, 'Add a note');
    assert.equal(noteMenuItem({ id: 1, saved: true, my_note: 'x' }, () => {}).label, 'Edit my note');
  });
});

describe('findings 1 and 12: a thread job no page job is tracking', () => {
  const untrackedThreads = new Function(`${cutTo('const untrackedThreads = ', ');\n')}; return untrackedThreads;`)();
  const itemCopies = new Function(`${cut('function itemCopies(')}; return itemCopies;`)();

  test('queued sources without a job are picked; tracked or finished ones are not', () => {
    const items = [{ id: 1, thread_status: 'queued' }, { id: 2, thread_status: 'queued' }, { id: 3, thread_status: 'done' }, null];
    assert.deepEqual(untrackedThreads(items, new Map([[2, {}]])).map((x) => x.id), [1]);
  });

  test('every copy of an item is found, in the list and in the open merge', () => {
    const a = { id: 5 }; const b = { id: 5 }; const c = { id: 5 }; const d = { id: 6 };
    const st = { groups: [{ root: a, thread: [], replies: [null, d] }], merge: { groups: [{ fixed: [b], replies: [c] }] } };
    assert.deepEqual(itemCopies(st, 5), [a, b, c]);
    assert.deepEqual(itemCopies({ groups: [], merge: null }, 5), []);
  });

  test('opening a collection watches its queued sources, and a finished one clears at once', async () => {
    const threadJobs = new Map();
    const polled = [];
    const statuses = [];
    const repainted = [];
    const answers = { 1: { status: 'queued', part_ids: [10, 11] }, 2: { status: 'done', part_ids: [20] } };
    const api = async (method, path) => answers[Number(path.match(/items\/(\d+)/)[1])];
    const watchThreads = new Function('untrackedThreads', 'threadJobs', 'api', 'sameThreadView', 'setThreadStatus', 'repaintThread', 'pollThread',
      `${cut('async function watchThreads(')}; return watchThreads;`)(
      untrackedThreads, threadJobs, api, (w) => w.slug === 'c1', (x, s) => statuses.push([x.id, s]), (w) => repainted.push(w), (id) => polled.push(id));
    const x1 = { id: 1, thread_status: 'queued' };
    const x2 = { id: 2, thread_status: 'queued' };
    await watchThreads([x1, x2, { id: 3, thread_status: null }], { slug: 'c1', title: 'C' });
    // 1 is still running: a quiet job is started, tied to this merge, so its new parts can be added to it
    assert.deepEqual(polled, [1]);
    const job = threadJobs.get(1);
    assert.equal(job.x, x1);
    assert.deepEqual([...job.before], [10, 11]);
    assert.deepEqual(job.merge, { slug: 'c1', title: 'C' });
    assert.deepEqual(job.where, { slug: 'c1' });
    assert.equal(job.quiet, true);
    // 2 finished meanwhile: no job, the row is updated and redrawn
    assert.deepEqual(statuses, [[2, 'done']]);
    assert.deepEqual(repainted, [{ slug: 'c1' }]);
    assert.ok(!threadJobs.has(2));
  });

  test('renderMerge starts the watch, and the end of a job updates every copy of the item', () => {
    assert.match(APP, /watchThreads\(m\.groups\.flatMap\(\(g\) => \[\.\.\.g\.fixed, \.\.\.g\.replies\]\), \{ slug: m\.slug, title: m\.title \}\);\n  \}/);
    assert.match(cut('function endThread('), /setThreadStatus\(job\.x, status\)/);
    assert.match(cut('async function threadDone('), /setThreadStatus\(job\.x, 'done'\)/);
  });
});

describe('findings 0, 9 and 8: redraws wait for a note being typed or an open menu', () => {
  const menuInSrc = cutTo('const menuIn = ', ';\n');
  const mk = (inside) => ({ contains: (n) => inside.includes(n) });

  test('menuIn is true only for an open, attached menu inside one of the roots', () => {
    const wrap = {};
    const document = { body: mk([wrap]) };
    const run = (openMenu, ...roots) => new Function('openMenu', 'document', `${menuInSrc} return menuIn;`)(openMenu, document)(...roots);
    assert.equal(run({ wrap }, mk([wrap])), true);
    assert.equal(run({ wrap }, mk([]), mk([wrap])), true);
    assert.equal(run({ wrap }, mk([])), false);
    assert.equal(run(null, mk([wrap])), false);
    assert.equal(new Function('openMenu', 'document', `${menuInSrc} return menuIn;`)({ wrap }, { body: mk([]) })(mk([wrap])), false, 'a detached menu does not count');
  });

  test('a finished thread job does not rebuild the Inbox under a note or a menu: it marks the list dirty', () => {
    const v = { list: {}, tools: {}, dirty: false };
    let drawn = 0;
    const make = (busyMenu, busyNote) => new Function('sameThreadView', 'state', 'inboxView', 'menuIn', 'noteEditing', 'renderInbox',
      `${cut('function repaintThread(')}; return repaintThread;`)(() => true, { merge: null }, () => v, () => busyMenu, () => busyNote, () => { drawn++; });
    make(false, true)({ tab: 'inbox' });
    assert.equal(v.dirty, true);
    v.dirty = false;
    make(true, false)({ tab: 'inbox' });
    assert.equal(v.dirty, true);
    assert.equal(drawn, 0);
    make(false, false)({ tab: 'inbox' });
    assert.equal(drawn, 1);
  });

  test('in a collection the job goes through the guarded redraw, which keeps focus by key', () => {
    let calls = 0;
    const repaint = new Function('sameThreadView', 'state', 'inboxView', 'menuIn', 'noteEditing', 'renderInbox',
      `${cut('function repaintThread(')}; return repaintThread;`)(() => true, { merge: { redrawSources: () => { calls++; } } }, () => { throw new Error('no list'); }, () => false, () => false, () => {});
    repaint({ slug: 'c1' });
    assert.equal(calls, 1);
    // the merge editor's redraw: skipped (and marked dirty) while a note is typed or a menu is open in the rows
    assert.match(APP, /const redraw = \(\) => \{ if \(noteEditing\(list\) \|\| menuIn\(list\)\) \{ m\.srcDirty = true; return; \} draw\(\); \};\n\s+m\.redrawSources = redraw;/);
    // draw() captures the focused control's key before clearing the rows and puts focus back after
    const draw = cutTo('    const draw = () => {\n      m.srcDirty = false;', '\n    };\n');
    assert.ok(draw.indexOf('const key = focusKey();') < draw.indexOf('clear(list);'));
    assert.match(draw, /restoreFocus\(key\);\n    \};\n$/);
    // a menu closing paints a source list that was skipped
    assert.match(cut('function menuButton('), /if \(m && m\.srcDirty && m\.redrawSources\) setTimeout\(\(\) => \{ if \(!openMenu && state\.merge === m && m\.srcDirty\) m\.redrawSources\(\); \}, 0\);/);
  });

  test('closing a note does not force a redraw over a menu the closing click just opened', () => {
    // Inbox: the forced repaint is skipped while a menu is open (menu close repaints the dirty list)
    assert.match(APP, /if \(menuIn\(v\.list, v\.tools\)\) v\.dirty = true; else renderInbox\(true\);\n\s+\/\/ Escape goes back/);
    // merge editor: the same
    assert.match(APP, /if \(menuIn\(list\)\) m\.srcDirty = true; else draw\(\);/);
  });
});

describe('finding 10: a closed note box shows what was typed', () => {
  // a tiny stand-in for the page: elements are plain objects that keep their listeners
  const h = (tag, attrs = {}, ...kids) => ({ tag, ...attrs, kids, on: {}, addEventListener(t, f) { this.on[t] = f; } });
  const find = (node, tag) => {
    if (!node || typeof node !== 'object') return null;
    if (node.tag === tag) return node;
    for (const k of node.kids || []) { const f = find(k, tag); if (f) return f; }
    return null;
  };
  const setup = (api) => {
    const noteOpen = new Set([7]);
    const noteState = new Map();
    const toasts = [];
    const noteBox = new Function('h', 'MY_NOTE_MAX', 'noteState', 'noteOpen', 'api', 'toast', 'document', 'pointerHeld', 'afterPointer',
      `${cut('function noteBox(')}; return noteBox;`)(h, 2000, noteState, noteOpen, api, (m) => toasts.push(m), { hasFocus: () => true, querySelector: () => null }, false, []);
    return { noteBox, noteOpen, noteState, toasts };
  };
  const esc = { key: 'Escape', preventDefault() {}, stopPropagation() {} };

  test('the typed note is put in the item before the caller redraws, without waiting for the save', async () => {
    let release;
    const api = () => new Promise((r) => { release = () => r({ my_note: 'why I saved this' }); });
    const { noteBox } = setup(api);
    const x = { id: 7, my_note: null, saved: true };
    const order = [];
    const box = noteBox(x, {
      onSaved: (n) => { order.push(['saved', n]); x.my_note = n; },
      onClose: () => order.push(['close', x.my_note]),
      repaint: () => order.push(['repaint']),
    });
    const ta = find(box, 'textarea');
    ta.value = '  why I saved this ';
    ta.on.input();
    ta.on.keydown(esc);
    // the redraw (onClose) already sees the new note, while the PATCH is still in flight
    assert.deepEqual(order, [['saved', 'why I saved this'], ['close', 'why I saved this']]);
    await tick();
    release();
    await tick();
    // the save agrees with what is shown: no extra repaint
    assert.deepEqual(order.slice(2), [['saved', 'why I saved this']]);
  });

  test('a save that fails puts the old note back and repaints', async () => {
    const api = async () => { const e = new Error('down'); e.status = 0; throw e; };
    const { noteBox, toasts } = setup(api);
    const x = { id: 7, my_note: 'old', saved: true };
    const log = [];
    const box = noteBox(x, { onSaved: (n) => { x.my_note = n; log.push(n); }, onClose: () => {}, repaint: () => log.push('repaint') });
    const ta = find(box, 'textarea');
    ta.value = 'new';
    ta.on.input();
    ta.on.keydown(esc);
    assert.equal(x.my_note, 'new');
    await tick();
    assert.equal(x.my_note, 'old');
    assert.deepEqual(log, ['new', 'old', 'repaint']);
    assert.match(toasts[0], /wasn't saved/);
  });

  test('both callers pass a repaint, and the list puts the note into its own copy too', () => {
    assert.match(APP, /onSaved: \(note\) => \{ x\.my_note = note; setNoteLocally\(x\.id, note\); \},/);
    assert.match(APP, /repaint: \(\) => \{ if \(listShowing\(\)\) renderInbox\(\); \},/);
    assert.match(APP, /repaint: \(\) => \{ if \(state\.merge === m && list\.isConnected\) redraw\(\); \},/);
  });
});

describe('finding 13: recipe card edits that did not save', () => {
  const recipePatch = new Function(`${cut('function recipePatch(')}; return recipePatch;`)();
  const saved = { name: 'Hooks', prompt: 'Find hooks' };

  test('recipePatch says why it cannot save, or what changed', () => {
    assert.deepEqual(recipePatch({ name: '  ', prompt: 'x' }, saved), { error: 'Not saved: give it a name' });
    assert.deepEqual(recipePatch({ name: 'A', prompt: '' }, saved), { error: 'Not saved: write the instruction' });
    assert.deepEqual(recipePatch({ name: ' Hooks ', prompt: 'Find hooks\r\n' }, saved), { patch: null });
    assert.deepEqual(recipePatch({ name: 'Hooks  2', prompt: 'Find\r\nhooks' }, saved), { patch: { name: 'Hooks 2', prompt: 'Find\nhooks' } });
  });

  test('cards keep their unsaved typing across rebuilds, and the page flushes it on pagehide', () => {
    assert.match(APP, /recEdits: new Map\(\),/);
    const page = cut('async function renderRecipes(');
    // typing is remembered, a rebuilt card restores it and tries to save it again
    assert.match(page, /const later = \(\) => \{ remember\(\);/);
    assert.match(page, /const kept = state\.recEdits\.get\(rc\.id\);\n\s+if \(kept\) \{ nameIn\.value = kept\.name; promptIn\.value = kept\.prompt; kept\.saved = saved; \}/);
    assert.match(page, /if \(kept\) timer = setTimeout\(flush, 0\);/);
    // a deleted recipe's draft goes
    assert.match(page, /state\.recEdits\.delete\(rc\.id\);\n\s+toast\('Recipe deleted'\);/);
    // pagehide sends what can be saved with keepalive
    const i = APP.indexOf("window.addEventListener('pagehide', () => {\n    for (const [id, ed] of state.recEdits)");
    assert.ok(i > 0, 'a pagehide handler flushes recipe edits');
    assert.match(APP.slice(i, i + 600), /fetch\(`\/api\/recipes\/\$\{id\}`, \{\n\s+method: 'PATCH', credentials: 'same-origin', keepalive: true/);
  });

  test('a pagehide flush sends only edits that differ and can be saved', () => {
    const sent = [];
    let handler;
    const window = { addEventListener: (t, f) => { if (t === 'pagehide') handler = f; } };
    const state = { recEdits: new Map([
      [1, { name: 'Hooks', prompt: 'Find more hooks', saved }],
      [2, { name: '', prompt: 'x', saved }],
      [3, { name: 'Hooks', prompt: 'Find hooks', saved }],
    ]) };
    const src = APP.slice(APP.indexOf("  window.addEventListener('pagehide', () => {\n    for (const [id, ed] of state.recEdits)"));
    const block = src.slice(0, src.indexOf('\n  });\n') + 6);
    new Function('window', 'state', 'recipePatch', 'fetch', block)(window, state, recipePatch, (url, o) => sent.push([url, JSON.parse(o.body)]));
    handler();
    assert.deepEqual(sent, [['/api/recipes/1', { prompt: 'Find more hooks' }]]);
  });
});

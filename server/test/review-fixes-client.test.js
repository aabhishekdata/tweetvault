// Regression tests for the client fixes in static/app.js (review findings 6-11 and the client half of 15).
// The page is a browser script, so the functions under test are cut out of its source and run with
// small stand-ins for the page state; the real code is exercised, not a copy of it.
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
const line = (start) => {
  const i = APP.indexOf(start);
  assert.ok(i >= 0, `app.js should contain ${start}`);
  return APP.slice(i, APP.indexOf('\n', i));
};
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe('finding 10: an empty merge title', () => {
  const mergeTitle = new Function(`${cut('function mergeTitle(')}; return mergeTitle;`)();

  test('an empty or blank box keeps the last title (the server would keep it too)', () => {
    assert.deepEqual(mergeTitle('', 'My notes'), { title: 'My notes', kept: true });
    assert.deepEqual(mergeTitle('   \t', 'My notes'), { title: 'My notes', kept: true });
  });

  test('a real title is stored the way the server stores it: trimmed, at most 200 characters', () => {
    assert.deepEqual(mergeTitle('  New one  ', 'Old'), { title: 'New one', kept: false });
    assert.equal(mergeTitle('x'.repeat(250), 'Old').title.length, 200);
  });

  test('the title box no longer writes the raw value (or "Untitled") into the merge', () => {
    assert.doesNotMatch(APP, /m\.title = titleIn\.value/);
    assert.doesNotMatch(APP, /h1\.textContent = m\.title \|\| 'Untitled'/);
  });
});

describe('finding 15 (client): translations made on the page', () => {
  const drop = new Function(`${cut('function dropStaleTranslations(')}; return dropStaleTranslations;`)();
  const groups = [{ root: { id: 1 }, thread: [{ id: 2 }], replies: [{ id: 3 }, null] }];

  test('a list load that started after the translation drops it, so the server copy (or none) wins', () => {
    const cache = new Map([[1, { text: 'EN old', seq: 4 }], [2, { text: 'EN', seq: 5 }], [3, { text: 'EN', seq: 6 }], [9, { text: 'EN', seq: 1 }]]);
    drop(cache, groups, 5);
    // 1 was made before load 5 started: gone. 2 and 3 were made while it ran or later: kept.
    // 9 is not in this list: left alone.
    assert.deepEqual([...cache.keys()], [2, 3, 9]);
  });

  test('an entry with no load number is treated as old', () => {
    const cache = new Map([[1, { text: 'EN' }]]);
    drop(cache, groups, 1);
    assert.equal(cache.size, 0);
  });

  test('loadInbox runs it with its own load number, and Fetch again forgets the English', () => {
    assert.match(APP, /state\.groups = r\.groups;[\s\S]{0,80}dropStaleTranslations\(trCache, state\.groups, seq\)/);
    assert.match(APP, /\/refetch`, \{\}\); forgetTranslation\(x\.id\)/);
  });
});

describe('finding 6: background translation only repaints a list page', () => {
  const LIST_TABS = { inbox: 'inbox', archived: 'archived', trashed: 'trashed' };
  const make = (state) => new Function('state', 'LIST_TABS', `${line('const listShowing = ')}; return listShowing;`)(state, LIST_TABS);

  test('true only for an Inbox, Archived or Trash list that is on screen', () => {
    assert.equal(make({ tab: 'inbox', merge: null, view: { kind: 'list' } })(), true);
    assert.equal(make({ tab: 'trashed', merge: null, view: { kind: 'list' } })(), true);
    assert.equal(make({ tab: 'inbox', merge: { slug: 'a' }, view: null })(), false, 'a merge is open');
    assert.equal(make({ tab: 'bundles', merge: null, view: { kind: 'bundles' } })(), false, 'Merged list');
    assert.equal(make({ tab: 'security', merge: null, view: null })(), false, 'Security');
    assert.equal(make({ tab: 'inbox', merge: null, view: null })(), false, 'page is being rebuilt');
  });

  test('translateItem and autoTranslate check it before touching the page', () => {
    const tr = cut('async function translateItem(');
    assert.doesNotMatch(tr, /\n {4}renderInbox\(\);/, 'no unguarded repaint');
    assert.equal((tr.match(/if \(listShowing\(\)\) renderInbox\(\);/g) || []).length, 2);
    assert.match(cut('function autoTranslate('), /\|\| !listShowing\(\)\) return;/);
  });
});

describe('finding 8: Merge pressed twice', () => {
  const run = () => {
    const posts = [];
    const opened = [];
    const state = { selected: new Set([1, 2]), selecting: true, groups: [{ root: { id: 1, preview: 'hi' }, thread: [{ id: 2 }], replies: [] }] };
    let release;
    const api = (method, path, body) => { posts.push([method, path, body]); return new Promise((r) => { release = () => r({ slug: 'hi' }); }); };
    const startMerge = new Function('state', 'api', 'toast', 'openBundle',
      `${cut('let merging = false;')}; return startMerge;`)(state, api, () => {}, async (s) => { opened.push(s); });
    return { startMerge, posts, opened, state, release: () => release() };
  };

  test('a second click while the first merge is in flight sends nothing', async () => {
    const t = run();
    const a = t.startMerge();
    const b = t.startMerge();
    await tick();
    assert.equal(t.posts.length, 1);
    t.release();
    await Promise.all([a, b]);
    assert.deepEqual(t.opened, ['hi']);
  });

  test('after a failed merge the button works again', async () => {
    const posts = [];
    const state = { selected: new Set([1]), selecting: true, groups: [{ root: { id: 1, preview: 'hi' }, thread: [], replies: [] }] };
    const msgs = [];
    const startMerge = new Function('state', 'api', 'toast', 'openBundle', `${cut('let merging = false;')}; return startMerge;`)(
      state, async (...a) => { posts.push(a); throw new Error('offline'); }, (m) => msgs.push(m), async () => {});
    await startMerge();
    await startMerge();
    assert.equal(posts.length, 2);
    assert.deepEqual(msgs, ['offline', 'offline']);
  });
});

describe('findings 7 and 9: the merge preview', () => {
  // refreshPreview with the module variables it shares (previewTimer, previewSeq)
  const src = APP.slice(APP.indexOf('  let previewTimer = null;'), APP.indexOf('  function move(arr, i, j)'));
  const load = (state, { saveMerge, api }) => new Function('state', 'saveMerge', 'api', `${src}; return refreshPreview;`)(state, saveMerge, api);
  const merge = () => {
    const m = { slug: 'b', title: 'T', savedSig: 'old', groups: [{ fixed: [{ id: 1 }], replies: [] }], statuses: [] };
    m.setStatus = (s) => m.statuses.push(s);
    m.setFresh = () => {};
    return m;
  };
  const pre = () => ({ isConnected: true, textContent: '' });

  test('a render that fails after a good save does not say "Not saved"', async () => {
    const m = merge();
    const state = { merge: m };
    const p = pre();
    const refreshPreview = load(state, {
      saveMerge: async () => ({ version: 2 }),
      api: async () => { const e = new Error('That is too much text'); e.status = 413; throw e; },
    });
    refreshPreview(m, p, () => false);
    await tick(300);
    assert.deepEqual(m.statuses, ['Saving…', 'Saved']);
    assert.equal(p.textContent, 'That is too much text');
  });

  test('a failed save still says "Not saved"', async () => {
    const m = merge();
    const refreshPreview = load({ merge: m }, {
      saveMerge: async () => { throw new Error('offline'); },
      api: async () => assert.fail('no render after a failed save'),
    });
    refreshPreview(m, pre(), () => false);
    await tick(300);
    assert.deepEqual(m.statuses, ['Saving…', 'Not saved, check your connection']);
  });

  test('after leaving the merge (state.merge is null) it neither throws nor touches anything', async () => {
    const m = merge();
    let calls = 0;
    const refreshPreview = load({ merge: null }, { saveMerge: async () => { calls++; }, api: async () => { calls++; } });
    assert.doesNotThrow(() => refreshPreview(m, pre(), () => false));
    await tick(300);
    assert.equal(calls, 0);
    assert.deepEqual(m.statuses, []);
  });

  test('a stale view of another merge does not cancel the current merge\'s first preview', async () => {
    const a = merge();
    const b = merge();
    b.slug = 'c';
    const state = { merge: b };
    const saved = [];
    const refreshPreview = load(state, {
      saveMerge: async (m) => { saved.push(m.slug); return {}; },
      api: async () => ({ text: 'B text', text_sources: 'B src' }),
    });
    const pb = pre();
    refreshPreview(b, pb, () => false);
    refreshPreview(a, pre(), () => false);   // the "In English" loop of merge a ends late
    await tick(300);
    assert.deepEqual(saved, ['c']);
    assert.equal(pb.textContent, 'B text');
    assert.deepEqual(b.rendered, { text: 'B text', text_sources: 'B src' });
  });

  test('the "In English" loop stops once its merge is gone', () => {
    assert.match(APP, /const refresh = \(\) => refreshPreview\(m, pre, withSources\);/);
    assert.match(APP, /catch \(e\) \{ toast\(e\.message, true\); break; \}(?: finally \{ trPending\.delete\(x\.id\); \})?\n[^\n]*\n\s*if \(state\.merge !== m \|\| !pre\.isConnected\) return;/);
  });
});

describe('finding 11: click handlers that can fail', () => {
  test('collection links and buttons go through openBundleFromClick, which reports the error', async () => {
    assert.doesNotMatch(APP, /onclick: \(\) => openBundle\(/);
    assert.doesNotMatch(APP, /e\.preventDefault\(\); openBundle\(/);
    const msgs = [];
    let bundlesReloaded = 0;
    const open = new Function('openBundle', 'toast', 'state', 'renderBundles', 'listShowing', 'loadInbox',
      `${cut('function openBundleFromClick(')}; return openBundleFromClick;`)(
      async () => { throw new Error('No such bundle'); }, (m, bad) => msgs.push([m, bad]),
      { merge: null, view: { kind: 'bundles' } }, async () => { bundlesReloaded++; }, () => false, async () => {});
    await open('gone');
    assert.deepEqual(msgs, [['No such bundle', true]]);
    assert.equal(bundlesReloaded, 1);
  });

  test('removing a tag that fails shows a message and still refreshes', async () => {
    const msgs = [];
    let loads = 0;
    const removeItemTag = new Function('api', 'toast', 'loadInbox', `${cut('async function removeItemTag(')}; return removeItemTag;`)(
      async () => { throw new Error('offline'); }, (m, bad) => msgs.push([m, bad]), async () => { loads++; });
    await removeItemTag(1, 'x');
    assert.deepEqual(msgs, [['offline', true]]);
    assert.equal(loads, 1);
    assert.doesNotMatch(APP, /onRemoveTag: [^\n]*async \(t/);
  });
});

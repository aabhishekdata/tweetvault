// Phase 3 YouTube fixes (YT0-YT8, WEB2, WEB6): the worker reading captured videos end to end, t.co links to
// a video already saved, X pages reached through t.co, page reading only on purpose, memory caps on caption
// files, the PC's "no subtitles" mark, kept transcripts, one transaction per save, cancelled oversized
// answers, old video links queued again, and repeated lines in manual captions. Fake fetches only.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb } from '../src/db.js';
import { capture, byId } from '../src/items.js';
import { createFetcher } from '../src/fetcher.js';
import {
  parseVtt, parseCaptions, readYouTube, pendingTranscripts, setTranscript, markNoTranscript, watchUrl,
  MAX_STDIN, MAX_CAPTIONS, MAX_PARSED,
} from '../src/youtube.js';
import { main, readStdinCapped, backfillYouTube } from '../src/cli.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = (n) => readFileSync(join(HERE, 'fixtures', 'youtube', n), 'utf8');
const VID = 'M7lc1UVf-VE';
const TITLE = 'YouTube Developers Live: Embedded Web Player Customization';

let cid = 0;
const save = (db, input) => capture(db, { input, client_id: `p3yt-client-${++cid}` });

function ins(db, f) {
  const row = { kind: 'link', saved: 1, state: 'inbox', fetch_status: 'ok', first_saved_at: 1000, last_saved_at: 1000, ...f };
  const cols = Object.keys(row);
  return Number(db.prepare(`INSERT INTO items (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(...cols.map((c) => row[c])).lastInsertRowid);
}

const json = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { status, headers: { 'content-type': 'application/json' } });
const html = (body, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html' } });

// One fake network for the whole worker: t.co redirects, YouTube (oEmbed, watch page, timedtext), and
// FxTwitter answering 404. Every call is recorded.
function fakeNet({ tco = {}, youtube = {} } = {}) {
  const calls = [];
  const fn = async (url) => {
    calls.push(String(url));
    const u = new URL(url);
    if (u.hostname === 't.co') {
      const loc = tco[u.pathname.slice(1)];
      return loc ? new Response(null, { status: 301, headers: { location: loc } }) : new Response('', { status: 404 });
    }
    if (u.hostname === 'www.youtube.com') {
      if (u.pathname === '/oembed') return youtube.oembed ? youtube.oembed() : json(FIX('oembed.json'));
      if (u.pathname === '/watch') return youtube.watch ? youtube.watch() : html(FIX('watch-manual-en.html'));
      if (u.pathname === '/api/timedtext') return json(FIX('captions.json3'));
    }
    return new Response('{"code":404,"message":"NOT_FOUND"}', { status: 404 });
  };
  fn.calls = calls;
  return fn;
}

// ---------------------------------------------------------------------------------------------- YT0
describe('YT0: the worker reads a captured video', () => {
  test('a youtu.be share goes capture -> pending -> drain -> youtube / ok, through the injected fetch only', async () => {
    const db = openDb(':memory:');
    const net = fakeNet();
    const f = createFetcher(db, { fetchFn: net, paceMs: 0, nowFn: () => 9000 });
    const id = save(db, `Worth a watch https://youtu.be/${VID}`).item_id;
    assert.equal(byId(db, id).fetch_status, 'pending');
    await f.drain();
    const it = byId(db, id);
    assert.equal(it.link_type, 'youtube');
    assert.equal(it.fetch_status, 'ok');
    assert.equal(it.link_title, TITLE);
    assert.match(it.link_md, /^\[00:00\] Hi, I'm Jeff Posnick/);
    assert.equal(JSON.parse(it.link_meta).transcript_status, 'ok');
    assert.ok(net.calls.length >= 3 && net.calls.every((u) => u.startsWith('https://www.youtube.com/')), net.calls.join('\n'));
  });
});

// ---------------------------------------------------------------------------------------------- YT1
describe('YT1: a t.co link to a video already saved folds into it', () => {
  function setup(existing) {
    const db = openDb(':memory:');
    const vidItem = ins(db, existing);
    const net = fakeNet({ tco: { vid123: `https://youtu.be/${VID}` } });
    const f = createFetcher(db, { fetchFn: net, paceMs: 0, nowFn: () => 9000 });
    const short = save(db, 'https://t.co/vid123');
    // the owner organized the short link before it was expanded
    db.prepare("INSERT INTO tags (id, name) VALUES (1, 'talks')").run();
    db.prepare('INSERT INTO item_tags (item_id, tag_id) VALUES (?, 1)').run(short.item_id);
    db.prepare("UPDATE items SET my_note = 'watch at 1.5x', priority = 2 WHERE id = ?").run(short.item_id);
    db.prepare("INSERT INTO bundles (id, slug, title, version) VALUES (1, 'b1', 'B1', 4)").run();
    db.prepare('INSERT INTO bundle_items (bundle_id, item_id, position) VALUES (1, ?, 0)').run(short.item_id);
    return { db, f, net, vidItem, short };
  }

  test('tags, captures, merges (version bumped), note and priority move; the short-link row is deleted', async () => {
    const { db, f, vidItem, short } = setup({ url: watchUrl(VID), link_type: 'youtube', link_title: TITLE,
      link_meta: JSON.stringify({ video_id: VID, transcript_status: 'ok' }), link_md: '[00:00] hi' });
    await f.drain();
    assert.equal(byId(db, short.item_id), undefined, 'the short-link row is gone');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM items WHERE kind = 'link'").get().n, 1, 'the video is saved once');
    assert.equal(db.prepare('SELECT item_id FROM captures').get().item_id, vidItem);
    assert.deepEqual(db.prepare('SELECT item_id, tag_id FROM item_tags').all().map((r) => [r.item_id, r.tag_id]), [[vidItem, 1]]);
    assert.deepEqual(db.prepare('SELECT bundle_id, item_id FROM bundle_items').all().map((r) => [r.bundle_id, r.item_id]), [[1, vidItem]]);
    assert.equal(db.prepare('SELECT version FROM bundles WHERE id = 1').get().version, 5);
    const it = byId(db, vidItem);
    assert.equal(it.my_note, 'watch at 1.5x');
    assert.equal(it.priority, 2);
    assert.equal(it.url, watchUrl(VID), 'the existing address is kept');
    assert.equal(it.fetch_status, 'ok');
  });

  test('a video saved before videos were read (plain link_only) is folded into and then read', async () => {
    const { db, f, vidItem, short } = setup({ url: `https://www.youtube.com/shorts/${VID}`, fetch_status: 'link_only' });
    await f.drain();
    assert.equal(byId(db, short.item_id), undefined);
    const it = byId(db, vidItem);
    assert.equal(it.link_type, 'youtube');
    assert.equal(it.fetch_status, 'ok');
    assert.equal(it.link_title, TITLE);
  });

  test('a t.co link to a video not saved yet becomes that video and is read', async () => {
    const db = openDb(':memory:');
    const f = createFetcher(db, { fetchFn: fakeNet({ tco: { new999: `https://youtu.be/${VID}` } }), paceMs: 0 });
    const id = save(db, 'https://t.co/new999').item_id;
    await f.drain();
    const it = byId(db, id);
    assert.equal(it.url, `https://youtu.be/${VID}`);
    assert.equal(it.note, null);
    assert.equal(it.link_type, 'youtube');
    assert.equal(it.fetch_status, 'ok');
  });
});

// --------------------------------------------------------------------------------------------- WEB2
describe('WEB2: X pages reached through t.co are not fetched', () => {
  test('t.co -> x.com/someone stays a plain link and the page fetcher is never called', async () => {
    const db = openDb(':memory:');
    const asked = [];
    const webFetch = async (url) => { asked.push(url); return { status: 200, finalUrl: url, contentType: 'text/html', charset: 'utf-8', html: '<html></html>', bytes: 13 }; };
    const f = createFetcher(db, { fetchFn: fakeNet({ tco: { prof99: 'https://x.com/someone' } }), paceMs: 0, webFetch });
    const id = save(db, 'https://t.co/prof99').item_id;
    await f.drain();
    const it = byId(db, id);
    assert.deepEqual(asked, []);
    assert.equal(it.url, 'https://x.com/someone');
    assert.equal(it.fetch_status, 'link_only');
    assert.equal(it.link_type, null);
    assert.equal(it.fetch_error, null);
  });
});

// --------------------------------------------------------------------------------------------- WEB6
describe('WEB6: real page fetching only on purpose', () => {
  test('createFetcher with the default fetch and no webFetch reads no pages; realWeb: true uses safeFetch', async () => {
    // 127.0.0.1 is refused by safeFetch before any connection, so neither run touches the network
    const db = openDb(':memory:');
    const a = save(db, 'https://127.0.0.1/page').item_id;
    await createFetcher(db, { paceMs: 0 }).drain();
    assert.equal(byId(db, a).fetch_status, 'link_only');
    assert.equal(byId(db, a).fetch_error, 'Reading web pages is off here');

    const db2 = openDb(':memory:');
    const b = save(db2, 'https://127.0.0.1/page').item_id;
    await createFetcher(db2, { paceMs: 0, realWeb: true }).drain();
    assert.equal(byId(db2, b).fetch_status, 'link_only');
    assert.equal(byId(db2, b).fetch_error, 'Not a public web address');
  });
});

// ---------------------------------------------------------------------------------------------- YT2
function bigVtt(bytes) {
  const parts = ['WEBVTT\nKind: captions\nLanguage: en\n\n'];
  let len = parts[0].length;
  for (let i = 0; len < bytes - 200; i++) {
    const c = `${String(Math.floor(i / 3600)).padStart(2, '0')}:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000 --> 99:00:00.000\nline number ${i} with some words in it to read\n\n`;
    parts.push(c);
    len += c.length;
  }
  return parts.join('');
}

describe('YT2: caption files fit in a 128 MB container', () => {
  test('the caps are about 2 MB (timedtext) and 4 MB (stdin), and the PC script checks the same', () => {
    assert.ok(MAX_CAPTIONS <= 2 * 1024 * 1024, String(MAX_CAPTIONS));
    assert.ok(MAX_STDIN <= 4 * 1024 * 1024, String(MAX_STDIN));
    const ps1 = readFileSync(join(HERE, '..', '..', 'deploy', 'fetch-transcripts.ps1'), 'utf8');
    assert.match(ps1, /\$pick\.Length -gt 4MB/);
    assert.ok(!/10MB/.test(ps1));
  });

  test('parsing stops past about twice the transcript limit', () => {
    const segs = parseVtt(bigVtt(4 * 1024 * 1024));
    const chars = segs.reduce((n, s) => n + s[1].length + 1, 0);
    assert.ok(chars <= MAX_PARSED + 2001, String(chars));
    assert.ok(chars > MAX_PARSED - 100, 'still parses up to the limit');
    const ev = Array.from({ length: 20000 }, (_, i) => ({ tStartMs: i * 1000, segs: [{ utf8: `line ${i} with some words in it` }] }));
    const j = parseCaptions(JSON.stringify({ events: ev }));
    assert.ok(j.reduce((n, s) => n + s[1].length + 1, 0) <= MAX_PARSED + 2001);
    assert.ok(j.length < ev.length);
  });

  test('a 4 MB VTT is parsed and formatted inside a 12 MB heap (the old parser needed about 18 MB)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tv-yt-mem-'));
    try {
      const file = join(dir, 'big.vtt');
      writeFileSync(file, bigVtt(MAX_STDIN));
      const mod = pathToFileURL(join(HERE, '..', 'src', 'youtube.js')).href;
      const code = `import { readFileSync } from 'node:fs';
        const y = await import(${JSON.stringify(mod)});
        const body = readFileSync(${JSON.stringify(file)}).toString('utf8');
        const md = y.formatTranscript(y.parseCaptions(body));
        process.stdout.write(String(md.length));`;
      const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--max-semi-space-size=1', '--max-old-space-size=12',
        '--input-type=module', '-e', code], { encoding: 'utf8', timeout: 60_000 });
      assert.equal(r.status, 0, `ran out of memory or failed: ${String(r.stderr).slice(-500)}`);
      assert.ok(Number(r.stdout) > 100_000, r.stdout);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('stdin is copied into one buffer, strings and buffers alike, and refused past the cap', async () => {
    assert.equal(String(await readStdinCapped(Readable.from(['WEB', Buffer.from('VTT')]), 10)), 'WEBVTT');
    assert.equal(String(await readStdinCapped(Readable.from([Buffer.from('0123456789')]), 10)), '0123456789');
    assert.equal(await readStdinCapped(Readable.from([Buffer.alloc(10), Buffer.alloc(1)]), 10), null);
  });

  test('CRLF, lone CR and a byte-order mark still parse with the line walker', () => {
    assert.deepEqual(parseVtt('﻿WEBVTT\r\n\r\n00:01.000 --> 00:02.000\r\none\r\n\r\n00:03.000 --> 00:04.000\rtwo\r'), [[1, 'one'], [3, 'two']]);
    assert.deepEqual(parseCaptions('﻿ \nWEBVTT\n\n00:05.000 --> 00:06.000\nfive'), [[5, 'five']]);
  });
});

// ---------------------------------------------------------------------------------------------- YT3
describe('YT3: the PC records "no subtitles" so the queue moves on', () => {
  test('25 newer caption-less videos do not hide an older blocked one', () => {
    const db = openDb(':memory:');
    const blocked = ins(db, { url: watchUrl('Blocked0001'), link_type: 'youtube', last_saved_at: 10,
      link_meta: JSON.stringify({ video_id: 'Blocked0001', transcript_status: 'blocked' }) });
    for (let i = 0; i < 25; i++) {
      const v = `none${String(i).padStart(7, '0')}`;
      ins(db, { url: watchUrl(v), link_type: 'youtube', last_saved_at: 100 + i, link_meta: JSON.stringify({ video_id: v, transcript_status: 'none' }) });
    }
    const seen = new Set();
    for (let run = 0; run < 3 && !seen.has(blocked); run++) {
      const lines = [];
      main(['youtube-pending', '--limit', '20'], { db, out: (l) => lines.push(l) });
      for (const l of lines) {
        const id = Number(l.split('\t')[0]);
        seen.add(id);
        // what fetch-transcripts.ps1 does when yt-dlp writes no .vtt (stdin is not read for --none)
        if (id !== blocked) assert.equal(main(['set-transcript', String(id), '--none'], { db, out: () => {}, input: null }), 0);
      }
    }
    assert.ok(seen.has(blocked), 'the older blocked video is reached on the second run');
    const m = JSON.parse(byId(db, [...seen][0]).link_meta);
    assert.equal(m.transcript_status, 'none_pc');
    assert.ok(Number.isInteger(m.pc_checked_at));
    assert.deepEqual(pendingTranscripts(db).map((r) => r.item_id), [blocked]);
  });

  test('--none never replaces a saved transcript, refuses non-videos, and a later read keeps none_pc', async () => {
    const db = openDb(':memory:');
    const ok = ins(db, { url: watchUrl(VID), link_type: 'youtube', link_md: '[00:00] hi', link_meta: JSON.stringify({ video_id: VID, transcript_status: 'ok' }) });
    assert.equal(markNoTranscript(db, ok).ok, true);
    assert.equal(JSON.parse(byId(db, ok).link_meta).transcript_status, 'ok');
    const web = ins(db, { url: 'https://example.com/' });
    assert.equal(main(['set-transcript', String(web), '--none'], { db, out: () => {} }), 2);
    assert.equal(main(['set-transcript', '99999', '--none'], { db, out: () => {} }), 2);

    const v = ins(db, { url: 'https://youtu.be/Rain_Roof01', link_type: 'youtube', fetch_status: 'pending',
      link_meta: JSON.stringify({ video_id: 'Rain_Roof01', transcript_status: 'none' }) });
    assert.equal(markNoTranscript(db, v, { t: 4242 }).ok, true);
    const net = fakeNet({ youtube: { oembed: () => json({ title: 'Rain', author_name: 'Calm Sounds' }), watch: () => html(FIX('watch-no-captions.html')) } });
    await readYouTube(db, byId(db, v), { fetchImpl: net, log: () => {}, now: () => 5000, youtubeApiKey: '' });
    const m = JSON.parse(byId(db, v).link_meta);
    assert.equal(m.transcript_status, 'none_pc');
    assert.equal(m.pc_checked_at, 4242);
    assert.ok(!pendingTranscripts(db).some((r) => r.item_id === v));
  });

  test('fetch-transcripts.ps1 tells the server when yt-dlp found no subtitles', () => {
    const ps1 = readFileSync(join(HERE, '..', '..', 'deploy', 'fetch-transcripts.ps1'), 'utf8');
    assert.match(ps1, /if \(-not \$files\.Count\) \{[\s\S]{0,200}set-transcript \$\(\$t\.Item\) --none/);
  });
});

// ---------------------------------------------------------------------------------------------- YT4
describe('YT4: a kept transcript keeps the video shown', () => {
  test('no title from YouTube but a PC transcript saved: ok, titled from the share text', async () => {
    const db = openDb(':memory:');
    const id = ins(db, { url: watchUrl(VID), text: 'Great talk on embeds', fetch_status: 'pending', link_type: 'youtube',
      link_md: '[00:00] from the pc', link_meta: JSON.stringify({ video_id: VID, transcript_status: 'ok', transcript_lang: 'en' }) });
    const net = fakeNet({ youtube: { oembed: () => json('Not Found', 404), watch: () => html(FIX('sorry-page.html')) } });
    await readYouTube(db, byId(db, id), { fetchImpl: net, log: () => {}, now: () => 5000, youtubeApiKey: '' });
    const it = byId(db, id);
    assert.equal(it.fetch_status, 'ok');
    assert.equal(it.fetch_error, null);
    assert.equal(it.link_title, 'Great talk on embeds');
    assert.equal(it.link_md, '[00:00] from the pc');

    const id2 = ins(db, { url: 'https://youtu.be/Gone_Video1', fetch_status: 'pending', link_type: 'youtube',
      link_md: '[00:00] saved', link_meta: JSON.stringify({ video_id: 'Gone_Video1', transcript_status: 'ok' }) });
    await readYouTube(db, byId(db, id2), { fetchImpl: net, log: () => {}, now: () => 5000, youtubeApiKey: '' });
    assert.equal(byId(db, id2).fetch_status, 'ok');
    assert.equal(byId(db, id2).link_title, 'YouTube video');
  });
});

// ---------------------------------------------------------------------------------------------- YT5
describe('YT5: one transaction per save', () => {
  test('when the raw record cannot be written, the item is left as it was', async () => {
    const db = openDb(':memory:');
    const id = ins(db, { url: watchUrl(VID), fetch_status: 'pending' });
    db.exec('DROP TABLE raw_fetches');
    await assert.rejects(readYouTube(db, byId(db, id), { fetchImpl: fakeNet(), log: () => {}, now: () => 5000, youtubeApiKey: '' }));
    const it = byId(db, id);
    assert.equal(it.fetch_status, 'pending');
    assert.equal(it.link_type, null);
    assert.equal(it.link_title, null);
  });
});

// ---------------------------------------------------------------------------------------------- YT6
describe('YT6: an oversized answer is cancelled at once', () => {
  test('Content-Length over the cap cancels the body before giving up', async () => {
    const db = openDb(':memory:');
    const id = ins(db, { url: watchUrl(VID), fetch_status: 'pending' });
    let cancelled = 0;
    const huge = () => ({
      status: 200,
      headers: new Headers({ 'content-length': String(50 * 1024 * 1024), 'content-type': 'application/json' }),
      body: { cancel: () => { cancelled++; return Promise.resolve(); }, getReader: () => { throw new Error('must not be read'); } },
      text: async () => { throw new Error('must not be read'); },
    });
    await readYouTube(db, byId(db, id), { fetchImpl: fakeNet({ youtube: { oembed: huge } }), log: () => {}, now: () => 5000, youtubeApiKey: '' });
    assert.equal(cancelled, 1);
    assert.equal(byId(db, id).link_title, TITLE, 'the watch page still gives the title');
  });
});

// ---------------------------------------------------------------------------------------------- YT7
describe('YT7: video links saved before videos were read', () => {
  test('sharing one again queues it for the reader', () => {
    const db = openDb(':memory:');
    const old = ins(db, { url: watchUrl(VID), fetch_status: 'link_only' });
    const r = save(db, `https://youtu.be/${VID}`);
    assert.equal(r.item_id, old);
    assert.equal(r.fetch_status, 'pending');
  });

  test('backfill-youtube queues old plain video links only', () => {
    const db = openDb(':memory:');
    const a = ins(db, { url: watchUrl(VID), fetch_status: 'link_only' });
    const b = ins(db, { url: 'https://youtu.be/Rain_Roof01', fetch_status: 'link_only' });
    const web = ins(db, { url: 'https://example.com/a', fetch_status: 'link_only' });
    const trashed = ins(db, { url: watchUrl('Trashed0001'), fetch_status: 'link_only', state: 'trashed' });
    const read = ins(db, { url: watchUrl('ReadAlrdy01'), fetch_status: 'link_only', link_type: 'youtube' });
    const channel = ins(db, { url: 'https://www.youtube.com/@GoogleDevelopers', fetch_status: 'link_only' });
    const lines = [];
    assert.equal(main(['backfill-youtube'], { db, out: (l) => lines.push(l) }), 0);
    assert.match(lines[0], /Queued 2 videos/);
    for (const id of [a, b]) assert.equal(byId(db, id).fetch_status, 'pending');
    for (const id of [web, trashed, read, channel]) assert.equal(byId(db, id).fetch_status, 'link_only');
    assert.equal(backfillYouTube(db), 0);
    const again = [];
    main(['backfill-youtube'], { db, out: (l) => again.push(l) });
    assert.equal(again[0], 'No videos to read.');
  });
});

// ---------------------------------------------------------------------------------------------- YT8
describe('YT8: repeated lines in manual captions are kept', () => {
  test('manual captions keep a line said twice; only the same cue again is dropped', () => {
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nYeah.\n\n00:00:02.000 --> 00:00:03.000\nYeah.\n\n'
      + '00:00:04.000 --> 00:00:05.000\nRight.\n\n00:00:04.000 --> 00:00:05.000\nRight.\n';
    assert.deepEqual(parseVtt(vtt), [[1, 'Yeah.'], [2, 'Yeah.'], [4, 'Right.']]);
  });

  test('auto captions (Kind: asr, or word-timing tags) still merge rolling lines', () => {
    const asr = 'WEBVTT\nKind: asr\nLanguage: en\n\n00:00:01.000 --> 00:00:02.000\nhello\n\n00:00:02.000 --> 00:00:03.000\nhello\nworld\n';
    assert.deepEqual(parseVtt(asr), [[1, 'hello'], [2, 'world']]);
    assert.deepEqual(parseVtt(FIX('auto-captions.vtt')), [[0, 'hi everyone welcome'], [2, 'to the show'], [61, 'today we talk about & CPUs']]);
  });

  test('set-transcript of a manual file keeps both lines', () => {
    const db = openDb(':memory:');
    const id = ins(db, { url: watchUrl(VID), link_type: 'youtube', link_meta: JSON.stringify({ video_id: VID, transcript_status: 'blocked' }) });
    assert.equal(setTranscript(db, id, 'WEBVTT\n\n00:01.000 --> 00:02.000\nYeah.\n\n00:02.000 --> 00:03.000\nYeah.\n').ok, true);
    assert.equal(byId(db, id).link_md, '[00:01] Yeah. Yeah.');
  });
});

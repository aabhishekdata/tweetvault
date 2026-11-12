// YouTube links (phase 3.3): recognising and deduping video links, oEmbed / Data API / watch-page parsing,
// chapters, caption formats, transcript formatting, the allow-list, retries, the PC fallback CLI, the merged
// text and the page's video fields. Saved fixtures and a fake fetch only: never the live network.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb } from '../src/db.js';
import { capture, byId, findYouTubeItem } from '../src/items.js';
import { readLink } from '../src/linkreader.js';
import {
  youTubeId, isYouTubeUrl, watchUrl, parseIsoDuration, fmtClock, fmtMark, parseChapters, parseOEmbed, parseVideosList,
  extractPlayerResponse, readWatchPage, pickTrack, timedTextUrl, parseJson3, parseVtt, vttLanguage, parseCaptions,
  formatTranscript, readYouTube, pendingTranscripts, setTranscript, videoDto, videoSection, configureYouTube,
  MAX_TRANSCRIPT, MAX_STDIN,
} from '../src/youtube.js';
import { renderItems, renderChars } from '../src/render.js';
import { itemDto } from '../src/tree.js';
import { main, readStdinCapped } from '../src/cli.js';
import { createApp } from '../src/server.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = (n) => readFileSync(join(HERE, 'fixtures', 'youtube', n), 'utf8');
const VID = 'M7lc1UVf-VE';
const KEY = 'AIzaSyTESTKEY_0123456789abcdefghijk';

let cid = 0;
const save = (db, input) => capture(db, { input, client_id: `test-client-${++cid}` });

function ins(db, f) {
  const row = { kind: 'link', saved: 1, state: 'inbox', fetch_status: 'ok', first_saved_at: 1000, last_saved_at: 1000, ...f };
  const cols = Object.keys(row);
  return Number(db.prepare(`INSERT INTO items (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(...cols.map((c) => row[c])).lastInsertRowid);
}

// A fake fetch: routes are [test(url) -> Response | () => Response]; every call is recorded.
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const [match, reply] of routes) {
      if (typeof match === 'string' ? String(url).startsWith(match) : match.test(String(url))) {
        const r = typeof reply === 'function' ? reply(String(url), init) : reply;
        if (r instanceof Error) throw r;
        return r.clone ? r.clone() : r;
      }
    }
    return new Response('not found', { status: 404 });
  };
  fn.calls = calls;
  return fn;
}
const json = (body, status = 200, headers = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { status, headers: { 'content-type': 'application/json', ...headers } });
const html = (body, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html' } });

const OEMBED = 'https://www.youtube.com/oembed?';
const WATCH = 'https://www.youtube.com/watch?';
const TIMEDTEXT = 'https://www.youtube.com/api/timedtext?';
const DATA_API = 'https://www.googleapis.com/youtube/v3/videos?';

function happyRoutes(extra = []) {
  return [
    ...extra,
    [OEMBED, json(FIX('oembed.json'))],
    [WATCH, html(FIX('watch-manual-en.html'))],
    [TIMEDTEXT, json(FIX('captions.json3'))],
    [DATA_API, json(FIX('videos-list.json'))],
  ];
}

describe('recognising YouTube links', () => {
  test('every common address form gives the 11-character id', () => {
    const forms = [
      `https://www.youtube.com/watch?v=${VID}`,
      `https://youtube.com/watch?v=${VID}&t=42s`,
      `https://m.youtube.com/watch?feature=share&v=${VID}`,
      `https://music.youtube.com/watch?v=${VID}&list=RD123`,
      `https://youtu.be/${VID}`,
      `https://youtu.be/${VID}?si=abcDEF123`,
      `https://www.youtube.com/shorts/${VID}`,
      `https://www.youtube.com/live/${VID}?feature=share`,
      `https://www.youtube.com/embed/${VID}`,
      `http://www.youtube.com/watch?v=${VID}`,
      `https://WWW.YOUTUBE.COM/watch?v=${VID}`,
    ];
    for (const f of forms) assert.equal(youTubeId(f), VID, f);
  });

  test('look-alike hosts, bad ids and other pages are refused', () => {
    const bad = [
      `https://youtube.com.evil.example/watch?v=${VID}`,
      `https://youtu.be.evil.example/${VID}`,
      `https://evil.example/youtube.com/watch?v=${VID}`,
      `https://notyoutube.com/watch?v=${VID}`,
      `https://www.youtube.com.evil.example/shorts/${VID}`,
      `https://user:pw@www.youtube.com/watch?v=${VID}`,
      `https://www.youtube.com:8443/watch?v=${VID}`,
      `ftp://www.youtube.com/watch?v=${VID}`,
      `javascript:alert(1)//www.youtube.com/watch?v=${VID}`,
      'https://www.youtube.com/watch?v=short',
      'https://www.youtube.com/watch?v=M7lc1UVf-VEtoolong',
      'https://www.youtube.com/watch?v=M7lc1UVf<VE',
      'https://youtu.be/',
      `https://youtu.be/${VID}/extra`,
      'https://www.youtube.com/@GoogleDevelopers',
      `https://www.youtube.com/shorts/${VID}/x`,
      'not a url',
      null,
    ];
    for (const b of bad) assert.equal(youTubeId(b), null, String(b));
    assert.equal(isYouTubeUrl(`https://youtube.com.evil.example/watch?v=${VID}`), false);
    assert.equal(isYouTubeUrl(`https://youtu.be.evil.example/${VID}`), false);
    assert.equal(isYouTubeUrl('https://example.com/'), false);
    // a channel page is YouTube's (so the web reader never fetches it) but has no video id
    assert.equal(isYouTubeUrl('https://www.youtube.com/@GoogleDevelopers'), true);
    assert.equal(watchUrl(VID), `https://www.youtube.com/watch?v=${VID}`);
  });
});

describe('capture dedupe', () => {
  test('the same video shared in different forms is one item, bumped, and waiting for the reader', () => {
    const db = openDb(':memory:');
    const a = save(db, `https://www.youtube.com/watch?v=${VID}`);
    assert.equal(a.fetch_status, 'pending');
    db.prepare("UPDATE items SET last_saved_at = 1, state = 'archived' WHERE id = ?").run(a.item_id);
    const b = save(db, `Great talk https://youtu.be/${VID}?si=xyz`);
    const c = save(db, `https://m.youtube.com/shorts/${VID}`);
    assert.equal(b.item_id, a.item_id);
    assert.equal(c.item_id, a.item_id);
    const it = byId(db, a.item_id);
    assert.equal(it.state, 'inbox');
    assert.ok(it.last_saved_at > 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM items WHERE kind = 'link'").get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM captures').get().n, 3);
    // a different video is a different item
    assert.notEqual(save(db, 'https://youtu.be/Xy9_-abcDEF').item_id, a.item_id);
  });

  test('a read video is found by link_meta.video_id even when its address has another form', () => {
    const db = openDb(':memory:');
    const id = ins(db, { url: 'https://example.com/redirected', link_type: 'youtube', link_meta: JSON.stringify({ video_id: VID }) });
    assert.equal(findYouTubeItem(db, VID).id, id);
    assert.equal(save(db, `https://www.youtube.com/live/${VID}`).item_id, id);
    // an address that only contains the id as text is not a match
    const db2 = openDb(':memory:');
    ins(db2, { url: `https://evil.example/watch?v=${VID}` });
    assert.equal(findYouTubeItem(db2, VID), null);
  });

  test('the link dispatcher sends videos to the YouTube reader', async () => {
    const db = openDb(':memory:');
    const { item_id } = save(db, `https://youtu.be/${VID}`);
    const f = fakeFetch(happyRoutes());
    await readLink(db, byId(db, item_id), { fetchImpl: f, log: () => {}, now: () => 5000, youtubeApiKey: '' });
    assert.equal(byId(db, item_id).link_type, 'youtube');
    assert.ok(f.calls.every((c) => /^https:\/\/www\.youtube\.com\//.test(c.url)));
  });
});

describe('oEmbed and the Data API', () => {
  test('oEmbed gives the title and channel; junk gives null', () => {
    assert.deepEqual(parseOEmbed(FIX('oembed.json')), { title: 'YouTube Developers Live: Embedded Web Player Customization', channel: 'Google for Developers' });
    assert.equal(parseOEmbed('<html>'), null);
    assert.equal(parseOEmbed('[]'), null);
    assert.equal(parseOEmbed('{"title": 5}'), null);
    const long = parseOEmbed(JSON.stringify({ title: `a‮b\u0000c ${'x'.repeat(1000)}`, author_name: 'Ch' }));
    assert.ok(long.title.length <= 300);
    assert.ok(!/[‮\u0000]/.test(long.title));
  });

  test('videos.list gives the description, date, channel and length', () => {
    const v = parseVideosList(FIX('videos-list.json'));
    assert.equal(v.title, 'YouTube Developers Live: Embedded Web Player Customization');
    assert.equal(v.channel, 'Google for Developers');
    assert.equal(v.duration_s, 1344);
    assert.equal(v.published_at, Date.UTC(2013, 3, 10, 17, 0, 15) / 1000);
    assert.match(v.description, /01:05 - Setting up the player/);
    assert.equal(parseVideosList('{"items": []}'), null);
    assert.equal(parseVideosList('nope'), null);
  });

  test('ISO 8601 durations', () => {
    assert.equal(parseIsoDuration('PT22M24S'), 1344);
    assert.equal(parseIsoDuration('PT1H2M3S'), 3723);
    assert.equal(parseIsoDuration('PT45S'), 45);
    assert.equal(parseIsoDuration('PT2H'), 7200);
    assert.equal(parseIsoDuration('P1DT2H'), 93600);
    assert.equal(parseIsoDuration('P0D'), 0);
    assert.equal(parseIsoDuration('PT1.5S'), 1);
    for (const bad of ['', 'P', 'PT', '22:24', 'PT-5S', 'PTXM', 'pt5s', null, 'PT5S; drop table']) assert.equal(parseIsoDuration(bad), null, String(bad));
  });

  test('with a key: the Data API is asked, and its description gives the chapters', async () => {
    const db = openDb(':memory:');
    const id = ins(db, { url: watchUrl(VID), fetch_status: 'pending' });
    const f = fakeFetch(happyRoutes([[WATCH, html(FIX('watch-bot-check.html'))]]));
    const logs = [];
    await readYouTube(db, byId(db, id), { fetchImpl: f, log: (m) => logs.push(m), now: () => 5000, youtubeApiKey: KEY });
    const api = f.calls.find((c) => c.url.startsWith(DATA_API));
    assert.ok(api, 'the Data API was called');
    assert.match(api.url, /part=snippet,contentDetails&id=M7lc1UVf-VE&key=/);
    const it = byId(db, id);
    const m = JSON.parse(it.link_meta);
    assert.equal(m.duration_s, 1344);
    assert.deepEqual(m.chapters.map((c) => c.title), ['Intro', 'Setting up the player', 'autoplay and loop', 'Questions from viewers']);
    assert.equal(it.link_published_at, Date.UTC(2013, 3, 10, 17, 0, 15) / 1000);
    assert.ok(!logs.join('\n').includes(KEY));
    assert.ok(!String(db.prepare("SELECT body FROM raw_fetches WHERE source = 'youtube'").get().body).includes(KEY));
  });

  test('without a key the Data API is never called; the watch page fills in the description', async () => {
    const db = openDb(':memory:');
    const id = ins(db, { url: watchUrl(VID), fetch_status: 'pending' });
    const saved = process.env.YOUTUBE_API_KEY;
    delete process.env.YOUTUBE_API_KEY;
    configureYouTube({ apiKey: null });
    try {
      const f = fakeFetch(happyRoutes());
      await readYouTube(db, byId(db, id), { fetchImpl: f, log: () => {}, now: () => 5000 });
      assert.ok(!f.calls.some((c) => c.url.includes('googleapis')));
      const m = JSON.parse(byId(db, id).link_meta);
      assert.equal(m.duration_s, 1344);
      assert.equal(m.chapters.length, 4);
      assert.equal(m.chapters[1].title, 'Setting up the player { braces }');
    } finally { if (saved !== undefined) process.env.YOUTUBE_API_KEY = saved; }
  });

  test('the key never reaches a log or an error, even when fetch puts the address in its message', async () => {
    for (const reply of [
      () => new Error(`connect ECONNREFUSED for ${DATA_API}part=snippet&key=${KEY}`),
      () => json({ error: { message: `API key not valid: ${KEY}` } }, 400),
      () => json('{}', 403),
    ]) {
      const db = openDb(':memory:');
      const id = ins(db, { url: watchUrl(VID), fetch_status: 'pending' });
      const logs = [];
      const f = fakeFetch(happyRoutes([[DATA_API, reply]]));
      await readYouTube(db, byId(db, id), { fetchImpl: f, log: (m) => logs.push(m), now: () => 5000, youtubeApiKey: KEY });
      const it = byId(db, id);
      assert.ok(logs.some((l) => /Data API/.test(l)));
      assert.ok(!logs.join('\n').includes(KEY), logs.join('\n'));
      assert.ok(!JSON.stringify(it).includes(KEY));
      assert.equal(it.fetch_status, 'ok');   // oEmbed and the watch page still did the job
    }
  });

  test('createApp passes its youtubeApiKey option to the reader', async () => {
    const app = createApp({ db: openDb(':memory:'), secret: 'x'.repeat(40), startWorker: false, youtubeApiKey: KEY, log: () => {} });
    assert.ok(app);
    const db = openDb(':memory:');
    const id = ins(db, { url: watchUrl(VID), fetch_status: 'pending' });
    const f = fakeFetch(happyRoutes());
    await readYouTube(db, byId(db, id), { fetchImpl: f, log: () => {}, now: () => 1 });
    assert.ok(f.calls.some((c) => c.url.startsWith(DATA_API) && c.url.includes(encodeURIComponent(KEY))));
    configureYouTube({ apiKey: null });
    // a malformed key is ignored rather than sent
    const f2 = fakeFetch(happyRoutes());
    await readYouTube(db, byId(db, id), { fetchImpl: f2, log: () => {}, now: () => 1, youtubeApiKey: 'bad key&x=1' });
    assert.ok(!f2.calls.some((c) => c.url.startsWith(DATA_API)));
  });
});

describe('chapters', () => {
  test('timestamps at line starts, first 0:00, increasing, at least three', () => {
    const d = 'Intro text\n0:00 Intro\n1:05 - Setup\n(4:30) Loops\n[12:10] Questions\nThanks!';
    assert.deepEqual(parseChapters(d), [
      { t: 0, title: 'Intro' }, { t: 65, title: 'Setup' }, { t: 270, title: 'Loops' }, { t: 730, title: 'Questions' },
    ]);
    assert.deepEqual(parseChapters('00:00 A\n1:00:00 B\n1:30:15 C').map((c) => c.t), [0, 3600, 5415]);
  });

  test('edge cases', () => {
    assert.deepEqual(parseChapters('0:00 A\n1:00 B'), [], 'fewer than three');
    assert.deepEqual(parseChapters('0:30 A\n1:00 B\n2:00 C'), [], 'does not start at 0:00');
    assert.deepEqual(parseChapters('see 0:00 A\nsee 1:00 B\nsee 2:00 C'), [], 'not at the line start');
    assert.deepEqual(parseChapters('0:00 A\n1:00 B\n0:30 C\n2:00 D').length, 0, 'stops going forward after two: too few');
    assert.deepEqual(parseChapters('0:00 A\n1:00 B\n2:00 C\n1:30 D\n5:00 E').map((c) => c.title), ['A', 'B', 'C']);
    assert.deepEqual(parseChapters('0:00 A\n1:75 bad\n2:00 C\n3:00 D').map((c) => c.t), [0, 120, 180], 'seconds over 59 ignored');
    assert.deepEqual(parseChapters('Mentions 3:00 in prose\n10:00 is late\n0:00 Start\n1:00 Mid\n2:00 End').map((c) => c.t), [0, 60, 120]);
    assert.equal(parseChapters('0:00\n1:00 B\n2:00 C')[0].title, 'Part at 0:00');
    // with a known length, a timestamp at or after the end is not a chapter
    assert.deepEqual(parseChapters(FIX('watch-no-captions.html').length ? 'x\n00:00 Start\n30:00 Heavier rain\n59:00 Fade out\n1:00:00 End' : '', 3600).map((c) => c.t), [0, 1800, 3540]);
    assert.deepEqual(parseChapters(''), []);
    assert.deepEqual(parseChapters(null), []);
    const many = Array.from({ length: 400 }, (_, i) => `${fmtClock(i * 10)} Part ${i}`).join('\n');
    assert.equal(parseChapters(many).length, 200);
    assert.ok(parseChapters(`0:00 ${'x'.repeat(500)}\n1:00 b\n2:00 c`)[0].title.length <= 200);
  });

  test('clock formats', () => {
    assert.equal(fmtClock(0), '0:00');
    assert.equal(fmtClock(75), '1:15');
    assert.equal(fmtClock(3723), '1:02:03');
    assert.equal(fmtMark(5), '[00:05]');
    assert.equal(fmtMark(615), '[10:15]');
    assert.equal(fmtMark(3723), '[1:02:03]');
  });
});

describe('the watch page', () => {
  test('manual English captions are preferred over auto and other languages', () => {
    const w = readWatchPage(FIX('watch-manual-en.html'));
    assert.equal(w.blocked, false);
    assert.equal(w.tracks.length, 3);
    const t = pickTrack(w.tracks);
    assert.equal(t.lang, 'en');
    assert.equal(t.asr, false);
    assert.match(t.baseUrl, /signature=EF56/);
    assert.equal(w.details.title, 'YouTube Developers Live: Embedded Web Player Customization');
    assert.equal(w.details.channel, 'Google for Developers');
    assert.equal(w.details.duration_s, 1344);
    assert.match(w.details.description, /\{player\} "parameters"/);
    assert.equal(w.details.published_at, Math.floor(Date.parse('2013-04-10T10:00:15-07:00') / 1000));
    const u = new URL(timedTextUrl(t.baseUrl));
    assert.equal(u.searchParams.get('fmt'), 'json3');
    assert.equal(u.hostname, 'www.youtube.com');
  });

  test('only auto captions: the asr track is used (a relative address is made absolute)', () => {
    const w = readWatchPage(FIX('watch-asr-only.html'));
    const t = pickTrack(w.tracks);
    assert.equal(t.asr, true);
    assert.equal(new URL(timedTextUrl(t.baseUrl)).origin, 'https://www.youtube.com');
    assert.deepEqual(parseChapters(w.details.description, w.details.duration_s), []);
    // no English at all: the first track
    assert.equal(pickTrack([{ lang: 'de', asr: false, baseUrl: 'a' }, { lang: 'fr', asr: true, baseUrl: 'b' }]).baseUrl, 'a');
    assert.equal(pickTrack([]), null);
  });

  test('the bot check, the sorry page and a page without captions', () => {
    const bot = readWatchPage(FIX('watch-bot-check.html'));
    assert.equal(bot.blocked, true);
    assert.match(bot.reason, /not a bot/);
    assert.equal(bot.details.title, 'YouTube Developers Live: Embedded Web Player Customization');
    assert.equal(readWatchPage(FIX('sorry-page.html')).blocked, true);
    const none = readWatchPage(FIX('watch-no-captions.html'));
    assert.equal(none.blocked, false);
    assert.equal(none.tracks.length, 0);
    assert.equal(none.details.duration_s, 3600);
    assert.equal(readWatchPage('<html>nothing here</html>').blocked, false);
  });

  test('the player JSON is cut out by brace matching, never evaluated', () => {
    assert.deepEqual(extractPlayerResponse('var ytInitialPlayerResponse = {"a":"}{\\"","b":{"c":[1,{}]}};alert(1)'), { a: '}{"', b: { c: [1, {}] } });
    assert.equal(extractPlayerResponse('var ytInitialPlayerResponse = {"a": 1'), null, 'unterminated');
    assert.equal(extractPlayerResponse('var ytInitialPlayerResponse = {a: (function(){return 1})()};'), null, 'not JSON');
    assert.deepEqual(extractPlayerResponse('ytInitialPlayerResponse = {bad};var ytInitialPlayerResponse = {"ok":true};'), { ok: true });
    assert.equal(extractPlayerResponse(null), null);
    // the no-captions page has a "}" string in the next script object: the first object still parses
    assert.equal(extractPlayerResponse(FIX('watch-no-captions.html')).videoDetails.videoId, 'Rain_Roof01');
  });

  test('caption addresses must be YouTube timedtext over https', () => {
    for (const bad of [
      'https://evil.example/api/timedtext?v=1',
      'https://www.youtube.com.evil.example/api/timedtext?v=1',
      'http://www.youtube.com/api/timedtext?v=1',
      'https://www.youtube.com/redirect?q=https://evil.example',
      'https://www.youtube.com:444/api/timedtext',
      'https://u:p@www.youtube.com/api/timedtext',
      '//evil.example/api/timedtext',
      'javascript:alert(1)',
    ]) assert.equal(timedTextUrl(bad), null, bad);
    assert.equal(timedTextUrl('https://www.youtube.com/api/timedtext?v=1&fmt=srv3'), 'https://www.youtube.com/api/timedtext?v=1&fmt=json3');
  });
});

describe('caption formats', () => {
  test('json3 events become [seconds, text], appended newlines and empty events skipped', () => {
    assert.deepEqual(parseJson3(FIX('captions.json3')), [
      [0, "Hi, I'm Jeff Posnick"], [2, 'and this is YouTube Developers Live.'], [31, 'Today: player parameters & more.'],
      [61, "Let's set up the player."], [125, 'Autoplay starts the video on load.'],
    ]);
    assert.deepEqual(parseJson3('nope'), []);
    assert.deepEqual(parseJson3('{"events": "x"}'), []);
    assert.deepEqual(parseJson3('{"events": [{"tStartMs": -5, "segs": [{"utf8": "x"}]}, null, {"segs": [{"utf8": 5}]}]}'), []);
  });

  test('VTT auto captions: tags stripped, rolling duplicate lines merged', () => {
    assert.deepEqual(parseVtt(FIX('auto-captions.vtt')), [
      [0, 'hi everyone welcome'], [2, 'to the show'], [61, 'today we talk about & CPUs'],
    ]);
    assert.equal(vttLanguage(FIX('auto-captions.vtt')), 'en');
  });

  test('VTT manual captions: voices, italics, NOTE blocks, cue numbers and settings', () => {
    assert.deepEqual(parseVtt(FIX('manual-captions.vtt')), [
      [1, 'Hello there.'], [3, 'Second line,'], [3, 'split over two.'], [3610, 'An hour in.'],
    ]);
    assert.equal(vttLanguage(FIX('manual-captions.vtt')), null);
    assert.deepEqual(parseVtt('WEBVTT\r\n\r\n00:01.000 --> 00:02.000\r\nshort form\r\n'), [[1, 'short form']]);
  });

  test('parseCaptions tells the two formats apart', () => {
    assert.equal(parseCaptions(`﻿${FIX('auto-captions.vtt')}`).length, 3);
    assert.equal(parseCaptions(FIX('captions.json3')).length, 5);
    assert.equal(parseCaptions('1\n00:00:01,000 --> 00:00:02,000\nsrt'), null);
    assert.equal(parseCaptions(''), null);
  });
});

describe('transcript formatting', () => {
  test('paragraphs of about a minute, each with its mark', () => {
    const md = formatTranscript(parseJson3(FIX('captions.json3')));
    assert.equal(md, "[00:00] Hi, I'm Jeff Posnick and this is YouTube Developers Live. Today: player parameters & more.\n\n"
      + "[01:01] Let's set up the player.\n\n[02:05] Autoplay starts the video on load.");
    assert.match(formatTranscript([[3700, 'late'], [10, 'early']]), /^\[00:10\] early\n\n\[1:01:40\] late$/);
    assert.equal(formatTranscript([]), '');
    assert.equal(formatTranscript(null), '');
  });

  test('capped at 150,000 characters at a paragraph boundary, with a note', () => {
    const segs = Array.from({ length: 5000 }, (_, i) => [i * 30, `${'word '.repeat(20)}${i}`]);
    const md = formatTranscript(segs);
    assert.ok(md.length <= MAX_TRANSCRIPT, String(md.length));
    assert.match(md, /\(Transcript cut here: it is longer than 150,000 characters\.\)$/);
    assert.match(md.split('\n\n(Transcript cut')[0], /\d$/, 'cut after a whole paragraph');
    // one enormous paragraph is cut inside it
    const one = formatTranscript([[0, 'x'.repeat(200_000)]]);
    assert.ok(one.length <= MAX_TRANSCRIPT + 100);
    assert.match(one, /Transcript cut here/);
  });
});

describe('reading a video', () => {
  const read = (db, id, routes, extra = {}) => readYouTube(db, byId(db, id), { fetchImpl: fakeFetch(routes), log: () => {}, now: () => 7000, youtubeApiKey: '', ...extra });

  test('title, channel, chapters and the manual English transcript are saved', async () => {
    const db = openDb(':memory:');
    const id = ins(db, { url: `https://youtu.be/${VID}`, fetch_status: 'pending', fetch_attempts: 2 });
    const f = fakeFetch(happyRoutes());
    await readYouTube(db, byId(db, id), { fetchImpl: f, log: () => {}, now: () => 7000, youtubeApiKey: '' });
    const it = byId(db, id);
    assert.equal(it.fetch_status, 'ok');
    assert.equal(it.fetch_attempts, 0);
    assert.equal(it.link_type, 'youtube');
    assert.equal(it.link_site, 'YouTube');
    assert.equal(it.link_title, 'YouTube Developers Live: Embedded Web Player Customization');
    assert.equal(it.link_author, 'Google for Developers');
    assert.equal(it.link_fetched_at, 7000);
    assert.match(it.link_md, /^\[00:00\] Hi, I'm Jeff Posnick/);
    const m = JSON.parse(it.link_meta);
    assert.deepEqual({ ...m, chapters: m.chapters.length }, {
      video_id: VID, channel: 'Google for Developers', duration_s: 1344, chapters: 4, transcript_status: 'ok', transcript_lang: 'en',
    });
    // the request shapes: oEmbed for the watch address, the watch page in English with the consent cookie,
    // the manual track as json3; redirects are never followed automatically
    const oe = new URL(f.calls[0].url);
    assert.equal(oe.searchParams.get('url'), watchUrl(VID));
    assert.equal(oe.searchParams.get('format'), 'json');
    const page = f.calls.find((c) => c.url.startsWith(WATCH));
    assert.match(page.url, /hl=en/);
    assert.match(page.init.headers['Accept-Language'], /^en/);
    assert.match(page.init.headers.Cookie, /CONSENT=YES\+1/);
    const tt = f.calls.find((c) => c.url.startsWith(TIMEDTEXT));
    assert.match(tt.url, /signature=EF56/);
    assert.match(tt.url, /fmt=json3/);
    assert.ok(f.calls.every((c) => c.init.redirect === 'manual'));
  });

  test('a bot check keeps the details and marks the transcript blocked', async () => {
    const db = openDb(':memory:');
    const id = ins(db, { url: watchUrl(VID), fetch_status: 'pending' });
    await read(db, id, happyRoutes([[WATCH, html(FIX('watch-bot-check.html'))]]));
    const it = byId(db, id);
    assert.equal(it.fetch_status, 'ok');
    assert.equal(it.link_md, null);
    const m = JSON.parse(it.link_meta);
    assert.equal(m.transcript_status, 'blocked');
    assert.equal(m.chapters.length, 3);
  });

  test('no captions: transcript none; an empty timedtext answer: blocked', async () => {
    const db = openDb(':memory:');
    const a = ins(db, { url: 'https://youtu.be/Rain_Roof01', fetch_status: 'pending' });
    await read(db, a, [[OEMBED, json({ title: 'Rain', author_name: 'Calm Sounds' })], [WATCH, html(FIX('watch-no-captions.html'))]]);
    assert.equal(JSON.parse(byId(db, a).link_meta).transcript_status, 'none');
    assert.equal(JSON.parse(byId(db, a).link_meta).chapters.length, 3);
    const b = ins(db, { url: watchUrl(VID), fetch_status: 'pending' });
    await read(db, b, happyRoutes([[TIMEDTEXT, new Response('', { status: 200 })]]));
    assert.equal(JSON.parse(byId(db, b).link_meta).transcript_status, 'blocked');
  });

  test('YOUTUBE_TRANSCRIPTS=pc (or deps.transcripts false) leaves the transcript to the PC', async () => {
    const db = openDb(':memory:');
    const id = ins(db, { url: watchUrl(VID), fetch_status: 'pending' });
    const f = fakeFetch(happyRoutes());
    await readYouTube(db, byId(db, id), { fetchImpl: f, log: () => {}, now: () => 1, youtubeApiKey: '', transcripts: false });
    assert.equal(JSON.parse(byId(db, id).link_meta).transcript_status, 'pending_pc');
    assert.ok(!f.calls.some((c) => c.url.startsWith(TIMEDTEXT)));
  });

  test('oEmbed refused (embedding off) still gets the title from the watch page; nothing at all is link_only', async () => {
    const db = openDb(':memory:');
    const a = ins(db, { url: watchUrl(VID), fetch_status: 'pending' });
    await read(db, a, happyRoutes([[OEMBED, json('{}', 401)]]));
    assert.equal(byId(db, a).link_title, 'YouTube Developers Live: Embedded Web Player Customization');
    const b = ins(db, { url: 'https://youtu.be/Gone_Video1', fetch_status: 'pending' });
    await read(db, b, [[OEMBED, json('Not Found', 404)], [WATCH, html('var ytInitialPlayerResponse = {"playabilityStatus":{"status":"ERROR","reason":"Video unavailable"}};')]]);
    const it = byId(db, b);
    assert.equal(it.fetch_status, 'link_only');
    assert.equal(it.link_type, 'youtube');
    assert.equal(JSON.parse(it.link_meta).transcript_status, 'none');
    assert.equal(it.url, 'https://youtu.be/Gone_Video1', 'the address is kept');
  });

  test('a YouTube page with no video id ends as a plain link without any fetch', async () => {
    const db = openDb(':memory:');
    const id = ins(db, { url: 'https://www.youtube.com/@GoogleDevelopers', fetch_status: 'pending' });
    const f = fakeFetch([]);
    await readYouTube(db, byId(db, id), { fetchImpl: f, log: () => {} });
    assert.equal(byId(db, id).fetch_status, 'link_only');
    assert.equal(f.calls.length, 0);
  });

  test('429 and 5xx from oEmbed ask for a retry and save nothing', async () => {
    for (const status of [429, 500, 503]) {
      const db = openDb(':memory:');
      const id = ins(db, { url: watchUrl(VID), fetch_status: 'pending' });
      const f = fakeFetch([[OEMBED, json('{}', status, { 'retry-after': '120' })]]);
      await assert.rejects(readYouTube(db, byId(db, id), { fetchImpl: f, log: () => {}, youtubeApiKey: '' }),
        (e) => e.retry === true && String(e.retryAfter) === '120' && new RegExp(String(status)).test(e.message));
      const it = byId(db, id);
      assert.equal(it.fetch_status, 'pending');
      assert.equal(it.link_type, null);
      assert.equal(f.calls.length, 1, 'nothing else is fetched');
    }
    // a network failure is temporary too
    const db = openDb(':memory:');
    const id = ins(db, { url: watchUrl(VID), fetch_status: 'pending' });
    await assert.rejects(readYouTube(db, byId(db, id), { fetchImpl: fakeFetch([[OEMBED, () => new TypeError('fetch failed')]]), log: () => {}, youtubeApiKey: '' }),
      (e) => e.retry === true);
  });

  test('allow-list: a redirect to another host is refused and never fetched', async () => {
    const db = openDb(':memory:');
    const id = ins(db, { url: watchUrl(VID), fetch_status: 'pending' });
    const f = fakeFetch(happyRoutes([
      [OEMBED, new Response('', { status: 302, headers: { location: 'https://evil.example/oembed' } })],
      [WATCH, new Response('', { status: 302, headers: { location: 'https://consent.youtube.com/m?continue=x' } })],
    ]));
    await readYouTube(db, byId(db, id), { fetchImpl: f, log: () => {}, youtubeApiKey: '' });
    assert.ok(!f.calls.some((c) => /evil\.example|consent\.youtube\.com/.test(c.url)));
    const it = byId(db, id);
    assert.equal(it.fetch_status, 'link_only');
    assert.equal(JSON.parse(it.link_meta).transcript_status, 'blocked');
  });

  test('allow-list: redirects inside the list are followed by hand; http and caption hosts are checked', async () => {
    const db = openDb(':memory:');
    const id = ins(db, { url: watchUrl(VID), fetch_status: 'pending' });
    const page = FIX('watch-manual-en.html').replace(/https:\/\/www\.youtube\.com\/api\/timedtext/g, 'https://evil.example/api/timedtext');
    const f = fakeFetch([
      [OEMBED, new Response('', { status: 301, headers: { location: '/oembed2?x=1' } })],
      ['https://www.youtube.com/oembed2', json(FIX('oembed.json'))],
      [WATCH, new Response('', { status: 302, headers: { location: `http://www.youtube.com/watch?v=${VID}` } })],
      [/evil\.example/, json(FIX('captions.json3'))],
    ]);
    await readYouTube(db, byId(db, id), { fetchImpl: f, log: () => {}, youtubeApiKey: '' });
    assert.ok(f.calls.some((c) => c.url.startsWith('https://www.youtube.com/oembed2')));
    assert.ok(!f.calls.some((c) => c.url.startsWith('http://')));
    assert.equal(byId(db, id).link_title, 'YouTube Developers Live: Embedded Web Player Customization');
    // and a page listing captions on another host
    const id2 = ins(db, { url: watchUrl(VID), fetch_status: 'pending' });
    const f2 = fakeFetch([[OEMBED, json(FIX('oembed.json'))], [WATCH, html(page)], [/evil\.example/, json(FIX('captions.json3'))]]);
    await readYouTube(db, byId(db, id2), { fetchImpl: f2, log: () => {}, youtubeApiKey: '' });
    assert.ok(!f2.calls.some((c) => /evil\.example/.test(c.url)));
    assert.equal(JSON.parse(byId(db, id2).link_meta).transcript_status, 'blocked');
  });

  test('a huge watch page is cut off at 2 MB and counts as blocked', async () => {
    const db = openDb(':memory:');
    const id = ins(db, { url: watchUrl(VID), fetch_status: 'pending' });
    const big = new ReadableStream({
      start(c) { for (let i = 0; i < 40; i++) c.enqueue(new Uint8Array(100 * 1024)); c.close(); },
    });
    await read(db, id, happyRoutes([[WATCH, () => new Response(big, { status: 200 })]]));
    assert.equal(JSON.parse(byId(db, id).link_meta).transcript_status, 'blocked');
    assert.equal(byId(db, id).fetch_status, 'ok');
  });

  test('a transcript already saved (from the PC) survives a later blocked read', async () => {
    const db = openDb(':memory:');
    const id = ins(db, { url: watchUrl(VID), fetch_status: 'pending', link_type: 'youtube', link_md: '[00:00] from the pc',
      link_meta: JSON.stringify({ video_id: VID, transcript_status: 'ok', transcript_lang: 'en' }) });
    await read(db, id, happyRoutes([[WATCH, html(FIX('watch-bot-check.html'))]]));
    const it = byId(db, id);
    assert.equal(it.link_md, '[00:00] from the pc');
    assert.equal(JSON.parse(it.link_meta).transcript_status, 'ok');
    assert.equal(JSON.parse(it.link_meta).transcript_lang, 'en');
  });
});

describe('PC fallback (cli.js)', () => {
  function seed(db) {
    const mk = (vid, status, t, extra = {}) => ins(db, { url: watchUrl(vid), link_type: 'youtube', last_saved_at: t,
      link_meta: JSON.stringify({ video_id: vid, transcript_status: status }), ...extra });
    return {
      blocked: mk('aaaaaaaaaaa', 'blocked', 100),
      none: mk('bbbbbbbbbbb', 'none', 300),
      pc: mk('ccccccccccc', 'pending_pc', 200),
      ok: mk('ddddddddddd', 'ok', 400),
      trashed: mk('eeeeeeeeeee', 'blocked', 500, { state: 'trashed' }),
      evil: mk('bad id; rm -rf', 'blocked', 600, { url: 'https://example.com/' }),
    };
  }

  test('youtube-pending lists item and video ids, newest first, safe ids only', () => {
    const db = openDb(':memory:');
    const s = seed(db);
    const lines = [];
    assert.equal(main(['youtube-pending'], { db, out: (l) => lines.push(l) }), 0);
    assert.deepEqual(lines, [`${s.none}\tbbbbbbbbbbb`, `${s.pc}\tccccccccccc`, `${s.blocked}\taaaaaaaaaaa`]);
    assert.equal(pendingTranscripts(db, 1).length, 1);
    for (let i = 0; i < 30; i++) ins(db, { url: watchUrl(`x${String(i).padStart(10, '0')}`), link_type: 'youtube', link_meta: JSON.stringify({ video_id: `x${String(i).padStart(10, '0')}`, transcript_status: 'none' }) });
    assert.equal(pendingTranscripts(db).length, 20);
  });

  test('set-transcript saves a VTT file from stdin', () => {
    const db = openDb(':memory:');
    const s = seed(db);
    const lines = [];
    assert.equal(main(['set-transcript', String(s.blocked)], { db, out: (l) => lines.push(l), input: Buffer.from(FIX('auto-captions.vtt')) }), 0);
    assert.match(lines[0], /Saved the transcript for item \d+: 3 lines/);
    const it = byId(db, s.blocked);
    assert.equal(it.link_md, '[00:00] hi everyone welcome to the show\n\n[01:01] today we talk about & CPUs');
    const m = JSON.parse(it.link_meta);
    assert.equal(m.transcript_status, 'ok');
    assert.equal(m.transcript_lang, 'en', 'from the VTT header');
    assert.equal(m.video_id, 'aaaaaaaaaaa');
    assert.ok(!pendingTranscripts(db).some((r) => r.item_id === s.blocked));
  });

  test('set-transcript takes json3 and --lang, and refuses bad input', () => {
    const db = openDb(':memory:');
    const s = seed(db);
    const out = [];
    const run = (args, input) => main(['set-transcript', ...args], { db, out: (l) => out.push(l), input });
    assert.equal(run([String(s.none), '--lang', 'en-GB'], FIX('captions.json3')), 0);
    assert.equal(JSON.parse(byId(db, s.none).link_meta).transcript_lang, 'en-GB');
    assert.equal(run([String(s.pc), '--lang', 'en;rm'], FIX('captions.json3')), 0);
    assert.equal(JSON.parse(byId(db, s.pc).link_meta).transcript_lang, null, 'a bad language is dropped');
    assert.equal(run([], ''), 2);
    assert.equal(run(['12abc'], ''), 2);
    assert.equal(run(['99999'], FIX('captions.json3')), 2);
    assert.equal(run([String(s.evil)], FIX('captions.json3')), 2, 'not a YouTube video');
    const note = ins(db, { kind: 'text', text: 'hello', fetch_status: 'n/a' });
    assert.equal(run([String(note)], FIX('captions.json3')), 2);
    assert.equal(run([String(s.ok)], 'just some text'), 2);
    assert.equal(run([String(s.ok)], 'WEBVTT\n\n'), 2);
    assert.equal(run([String(s.ok)], null), 2, 'over the stdin cap');
    assert.match(out.at(-1), /too large/);
    assert.equal(setTranscript(db, s.ok, 'x'.repeat(MAX_STDIN + 1)).ok, false);
  });

  test('a video saved but not read yet gets its type from set-transcript, and the next read keeps it', async () => {
    const db = openDb(':memory:');
    const id = save(db, `https://youtu.be/${VID}`).item_id;
    db.prepare("UPDATE items SET fetch_status = 'link_only' WHERE id = ?").run(id);
    assert.equal(setTranscript(db, id, FIX('manual-captions.vtt')).ok, true);
    let it = byId(db, id);
    assert.equal(it.link_type, 'youtube');
    assert.equal(it.fetch_status, 'ok');
    assert.match(it.link_md, /\[1:00:10\] An hour in\./);
    db.prepare("UPDATE items SET fetch_status = 'pending' WHERE id = ?").run(id);
    await readYouTube(db, byId(db, id), { fetchImpl: fakeFetch(happyRoutes([[WATCH, html(FIX('watch-bot-check.html'))]])), log: () => {}, youtubeApiKey: '' });
    it = byId(db, id);
    assert.match(it.link_md, /An hour in/);
    assert.equal(it.link_title, 'YouTube Developers Live: Embedded Web Player Customization');
  });

  test('stdin is read up to the cap and no further', async () => {
    assert.equal(String(await readStdinCapped(Readable.from([Buffer.from('WEB'), Buffer.from('VTT')]), 10)), 'WEBVTT');
    assert.equal(await readStdinCapped(Readable.from([Buffer.alloc(6), Buffer.alloc(6)]), 10), null);
  });
});

describe('merged text and the page', () => {
  function videoRow(db, extra = {}) {
    return byId(db, ins(db, {
      url: `https://youtu.be/${VID}`, link_type: 'youtube', link_title: 'Player Customization', link_author: 'Google for Developers',
      link_site: 'YouTube', link_published_at: Date.UTC(2013, 3, 10) / 1000, link_md: '[00:00] Hello.\n\n[01:00] More.',
      link_meta: JSON.stringify({ video_id: VID, channel: 'Google for Developers', duration_s: 3723,
        chapters: [{ t: 0, title: 'Intro' }, { t: 65, title: 'Setup' }, { t: 3600, title: 'Q&A' }], transcript_status: 'ok', transcript_lang: 'en' }),
      ...extra,
    }));
  }

  test('a video renders its heading, chapters and transcript, and its sources line', () => {
    const db = openDb(':memory:');
    const it = videoRow(db, { my_note: 'Watch the Q&A' });
    const r = renderItems(db, [it]);
    assert.equal(r.text, '## Video: Player Customization (Google for Developers, 1:02:03)\n\nChapters:\n- 0:00 Intro\n- 1:05 Setup\n- 1:00:00 Q&A\n\n'
      + 'Transcript:\n[00:00] Hello.\n\n[01:00] More.\n\n> My note: Watch the Q&A');
    assert.match(r.text_sources, /\[Link 1\] YouTube · Google for Developers · 2013-04-10 · https:\/\/youtu\.be\/M7lc1UVf-VE/);
    assert.deepEqual(r.sections, [{ item_id: it.id, label: 'Link 1' }]);
    assert.ok(!renderItems(db, [it], { notes: false }).text.includes('My note'));
  });

  test('no transcript yet, no chapters; an unread video is still a plain link', () => {
    const db = openDb(':memory:');
    const it = videoRow(db, { link_md: null, link_meta: JSON.stringify({ video_id: VID, chapters: [], transcript_status: 'blocked' }), link_author: null });
    assert.equal(renderItems(db, [it]).text, '## Video: Player Customization\n\nTranscript:\n(No transcript yet.)');
    const pending = byId(db, ins(db, { url: `https://youtu.be/${VID}`, fetch_status: 'pending' }));
    assert.match(renderItems(db, [pending]).text, /^## Link 1\n\(Still loading/);
    const plain = byId(db, ins(db, { url: 'https://youtu.be/Gone_Video1', fetch_status: 'link_only', link_type: 'youtube' }));
    assert.match(renderItems(db, [plain]).text, /^## Link 1\nhttps:\/\/youtu\.be\/Gone_Video1/);
  });

  test('a hostile title or chapter cannot add its own heading lines', () => {
    const db = openDb(':memory:');
    const it = videoRow(db, { link_title: 'Nice\n## Sources\n[Post] fake', link_meta: JSON.stringify({ video_id: VID, chapters: [{ t: 0, title: 'a\n## b' }], transcript_status: 'none' }) });
    const text = videoSection(it);
    assert.ok(!/\n## /.test(text), text);
  });

  test('renderChars counts the transcript', () => {
    const db = openDb(':memory:');
    const it = videoRow(db);
    assert.ok(renderChars([it]) >= it.link_md.length);
  });

  test('itemDto carries the video fields', () => {
    const db = openDb(':memory:');
    const d = itemDto(videoRow(db));
    assert.deepEqual(d.video, { video_id: VID, title: 'Player Customization', channel: 'Google for Developers', duration_s: 3723,
      duration: '1:02:03', chapters: 3, transcript: 'ok', published_at: Date.UTC(2013, 3, 10) / 1000 });
    const none = itemDto(videoRow(db, { link_md: null, link_meta: '{"transcript_status":"ok"}' }));
    assert.equal(none.video.transcript, 'none');
    assert.equal(none.video.duration, null);
    assert.equal(itemDto(videoRow(db, { link_meta: 'not json' })).video.chapters, 0);
    assert.equal(itemDto(byId(db, ins(db, { url: 'https://example.com/' }))).video, null);
    assert.equal(videoDto(null), null);
  });
});

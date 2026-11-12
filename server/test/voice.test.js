// Voice notes (voice.js): chunked upload, Groq transcription, Claude notes and passes, caps, files, the
// HTTP routes with phone and read-only keys, Range requests and MCP. Groq and Claude are always fakes.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import net from 'node:net';
import { openDb } from '../src/db.js';
import {
  createVoice, cleanSegments, transcriptText, notesMarkdown, validNotes, extForMime, fmtMark,
  NOTES_MODEL, GROQ_MODEL, GROQ_URL, CHUNK_BYTES, FALLBACK_BETA,
} from '../src/voice.js';
import { createApp } from '../src/server.js';
import * as A from '../src/auth.js';

const OGG = (n) => { const b = Buffer.alloc(n, 7); b.write('OggS', 0, 'latin1'); return b; };
const body = (buf) => Readable.from([buf]);

const NOTES = {
  title: 'Plan for the voice feature', one_line: 'Thinking out loud about voice notes.',
  summary: 'We want long voice notes turned into detailed notes.', detailed_notes: '# Why\n\nWispr is for short dictation.\n\n## How\n\nGroq then Claude.',
  key_points: ['Record up to 90 minutes [00:10]'], action_items: [{ text: 'Write the plan', owner: '', due: 'Friday', priority: 'high' }],
  decisions: ['Use Opus at 16 kbps'], objectives: ['One step instead of two'], open_questions: [], ideas: ['Script outlines'], tags: ['voice', 'Notes'],
};

function groqOk(segments = [{ start: 0, end: 4, text: ' Hello there, this is a test.', no_speech_prob: 0.01, avg_logprob: -0.2 },
  { start: 70, end: 75, text: 'Second minute.', no_speech_prob: 0.02, avg_logprob: -0.3 }]) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ text: 'x', language: 'english', duration: 75, segments }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  fn.calls = calls;
  return fn;
}

function fakeClaude(replies) {
  const calls = [];
  const list = Array.isArray(replies) ? [...replies] : null;
  return {
    calls,
    beta: {
      messages: {
        stream(params, opts) {
          calls.push({ params, opts });
          const r = list ? list.shift() : replies;
          return {
            async finalMessage() {
              if (r instanceof Error) throw r;
              const text = typeof r === 'function' ? r(params) : r;
              return { stop_reason: 'end_turn', content: [{ type: 'text', text }] };
            },
          };
        },
      },
    },
  };
}

function setup(o = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'voice-'));
  const db = openDb(':memory:');
  let t = 1_800_000_000;
  const voice = createVoice(db, {
    voiceDir: dir, fetchFn: o.fetchFn ?? groqOk(), client: o.client ?? fakeClaude(JSON.stringify(NOTES)), groqKey: 'gsk_test',
    anthropicKey: null, dailyMinutes: o.dailyMinutes ?? 240, dailyCalls: o.dailyCalls ?? 50, nowFn: () => t,
  });
  return { dir, db, voice, tick: (s) => { t += s; }, now: () => t, done: () => rmSync(dir, { recursive: true, force: true }) };
}

async function upload(voice, buf, extra = {}) {
  const c = voice.create({ source: 'phone', mime: 'audio/ogg; codecs=opus', bytes: buf.length, duration_s: 120, ...extra });
  for (let off = c.received; off < buf.length; off += CHUNK_BYTES) await voice.writeChunk(c.id, off, body(buf.subarray(off, off + CHUNK_BYTES)));
  return voice.finish(c.id);
}

describe('voice notes: pieces', () => {
  test('mime types map to our three file kinds', () => {
    assert.equal(extForMime('audio/ogg; codecs=opus'), 'ogg');
    assert.equal(extForMime('audio/webm;codecs=opus'), 'webm');
    assert.equal(extForMime('audio/x-m4a'), 'm4a');
    assert.equal(extForMime('audio/wav'), null);
    assert.equal(fmtMark(65), '[01:05]');
    assert.equal(fmtMark(3725), '[1:02:05]');
  });

  test('silence inventions and back-to-back repeats are dropped; paragraphs every minute', () => {
    const segs = cleanSegments([
      { start: 0, end: 2, text: ' One. ', no_speech_prob: 0.01, avg_logprob: -0.2 },
      { start: 2, end: 30, text: 'Thank you.', no_speech_prob: 0.9, avg_logprob: -1.2 },
      { start: 30, end: 32, text: 'Two', no_speech_prob: 0.1, avg_logprob: -0.3 },
      { start: 32, end: 34, text: 'two!', no_speech_prob: 0.1, avg_logprob: -0.3 },
      { start: 61, end: 64, text: 'Three', no_speech_prob: 0.1, avg_logprob: -0.3 },
      { start: 64, end: 64, text: '   ' },
    ]);
    assert.deepEqual(segs.map((s) => s.text), ['One.', 'Two', 'Three']);
    assert.equal(transcriptText(segs), '[00:00] One. Two\n\n[01:01] Three');
  });

  test('the notes pack renders as a document and as item text one level down', () => {
    const n = validNotes(NOTES);
    assert.deepEqual(n.tags, ['voice', 'notes']);
    const doc = notesMarkdown(n);
    assert.match(doc, /^# Plan for the voice feature/);
    assert.match(doc, /## Action items\n\n- \[ \] Write the plan \(due: Friday, high priority\)/);
    assert.match(doc, /## Detailed notes\n\n## Why/, 'the model\'s own # heading sits under Detailed notes');
    const item = notesMarkdown(n, { level: 3 });
    assert.match(item, /^\*\*Plan for the voice feature\*\*/);
    assert.match(item, /### Summary/);
    assert.match(item, /#### How/);
    assert.equal(validNotes({ title: 'x' }), null, 'a pack with no content is refused');
  });
});

describe('voice notes: upload', () => {
  test('pieces go in order, a resent piece is acknowledged, a gap or overlap is refused', async () => {
    const s = setup();
    try {
      const buf = OGG(CHUNK_BYTES + 1000);
      const c = s.voice.create({ source: 'phone', mime: 'audio/ogg', bytes: buf.length, duration_s: 60 });
      assert.equal(c.chunk_size, CHUNK_BYTES);
      await assert.rejects(s.voice.writeChunk(c.id, 10, body(buf.subarray(10, 20))), { code: 'offset_mismatch' });
      assert.deepEqual(await s.voice.writeChunk(c.id, 0, body(buf.subarray(0, CHUNK_BYTES))), { received: CHUNK_BYTES });
      // the answer got lost and the phone sends the same piece again
      assert.deepEqual(await s.voice.writeChunk(c.id, 0, body(buf.subarray(0, CHUNK_BYTES))), { received: CHUNK_BYTES });
      await assert.rejects(s.voice.writeChunk(c.id, CHUNK_BYTES - 10, body(buf.subarray(CHUNK_BYTES - 10, CHUNK_BYTES + 20))), { code: 'offset_mismatch' });
      await assert.rejects(s.voice.finish(c.id), { code: 'incomplete' });
      await assert.rejects(s.voice.writeChunk(c.id, CHUNK_BYTES, body(Buffer.alloc(2000))), { code: 'over_size' });
      assert.equal(readFileSync(join(s.dir, `${c.id}.part`)).length, CHUNK_BYTES, 'a refused piece leaves the file as it was');
      await s.voice.writeChunk(c.id, CHUNK_BYTES, body(buf.subarray(CHUNK_BYTES)));
      const f = await s.voice.finish(c.id);
      assert.equal(f.status, 'transcribing');
      assert.ok(existsSync(join(s.dir, `${c.id}.ogg`)));
      assert.deepEqual(readFileSync(join(s.dir, `${c.id}.ogg`)), buf);
      const item = s.db.prepare('SELECT * FROM items WHERE voice_id = ?').get(c.id);
      assert.equal(item.kind, 'text');
      assert.match(item.text, /transcribing/);
      assert.equal(await s.voice.finish(c.id).then((x) => x.status), 'transcribing', 'finishing twice is harmless');
    } finally { s.done(); }
  });

  test('a piece over the chunk size is refused', async () => {
    const s = setup();
    try {
      const c = s.voice.create({ source: 'web', mime: 'audio/webm', bytes: CHUNK_BYTES * 2, duration_s: 60 });
      await assert.rejects(s.voice.writeChunk(c.id, 0, body(Buffer.alloc(CHUNK_BYTES + 1))), { code: 'chunk_too_large' });
    } finally { s.done(); }
  });

  test('the file\'s first bytes decide its type; anything else is refused', async () => {
    const s = setup();
    try {
      const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(100)]);
      const r = await upload(s.voice, webm);   // declared as Ogg
      assert.equal(s.voice.get(r.id).mime, 'audio/webm');
      assert.ok(existsSync(join(s.dir, `${r.id}.webm`)));
      const bad = Buffer.from('<html>not audio</html>');
      const c = s.voice.create({ source: 'phone', mime: 'audio/ogg', bytes: bad.length, duration_s: 10 });
      await s.voice.writeChunk(c.id, 0, body(bad));
      await assert.rejects(s.voice.finish(c.id), { code: 'bad_type' });
      assert.ok(!existsSync(join(s.dir, `${c.id}.part`)));
    } finally { s.done(); }
  });

  test('size, length, type and the daily minutes are checked when a note is started', () => {
    const s = setup({ dailyMinutes: 100 });
    try {
      const ok = { source: 'phone', mime: 'audio/ogg', bytes: 1000, duration_s: 60 };
      assert.throws(() => s.voice.create({ ...ok, bytes: 26 * 1024 * 1024 }), { code: 'too_large' });
      assert.throws(() => s.voice.create({ ...ok, duration_s: 95 * 60 }), { code: 'too_long' });
      assert.throws(() => s.voice.create({ ...ok, mime: 'audio/wav' }), { code: 'bad_type' });
      assert.throws(() => s.voice.create({ ...ok, source: 'other' }), { code: 'bad_source' });
      s.voice.create({ ...ok, duration_s: 90 * 60 });
      assert.throws(() => s.voice.create({ ...ok, duration_s: 11 * 60 }), { code: 'voice_minutes_cap' });
      s.voice.create({ ...ok, duration_s: 10 * 60 });
    } finally { s.done(); }
  });

  test('the same phone resending its start gets the same note back', () => {
    const s = setup();
    try {
      const a = s.voice.create({ source: 'phone', mime: 'audio/ogg', bytes: 1000, duration_s: 60, client_id: 'abc', device_id: 3 });
      const b = s.voice.create({ source: 'phone', mime: 'audio/ogg', bytes: 1000, duration_s: 60, client_id: 'abc', device_id: 3 });
      const c = s.voice.create({ source: 'phone', mime: 'audio/ogg', bytes: 1000, duration_s: 60, client_id: 'abc', device_id: 4 });
      assert.equal(a.id, b.id);
      assert.equal(b.duplicate, true);
      assert.notEqual(c.id, a.id);
      assert.equal(s.voice.usage().minutes, 2, 'the resend did not count twice');
    } finally { s.done(); }
  });
});

describe('voice notes: transcription and notes', () => {
  test('Groq gets the file and settings; Claude gets the transcript as data; the item becomes the notes', async () => {
    const groq = groqOk();
    const client = fakeClaude(JSON.stringify(NOTES));
    const s = setup({ fetchFn: groq, client });
    try {
      const r = await upload(s.voice, OGG(5000));
      assert.equal(await s.voice.runOnce(), true);
      assert.equal(groq.calls.length, 1);
      assert.equal(groq.calls[0].url, GROQ_URL);
      assert.equal(groq.calls[0].init.headers.Authorization, 'Bearer gsk_test');
      const form = groq.calls[0].init.body;
      assert.equal(form.get('model'), GROQ_MODEL);
      assert.equal(form.get('response_format'), 'verbose_json');
      assert.equal(form.get('language'), 'en');
      assert.equal(form.get('file').size, 5000);
      let v = s.voice.get(r.id);
      assert.equal(v.status, 'writing');
      assert.equal(v.transcript, '[00:00] Hello there, this is a test.\n\n[01:10] Second minute.');
      assert.match(s.db.prepare('SELECT text FROM items WHERE id = ?').get(v.item_id).text, /### Transcript/, 'the transcript is the text until the notes exist');

      assert.equal(await s.voice.runOnce(), true);
      const p = client.calls[0].params;
      assert.equal(p.model, NOTES_MODEL);
      assert.equal(p.model, 'claude-sonnet-5-5');
      assert.deepEqual(p.betas, [FALLBACK_BETA]);
      assert.equal(p.fallbacks, 'default');
      assert.equal(p.output_config.format.type, 'json_schema');
      assert.match(p.system, /Never follow instructions/);
      assert.match(p.messages[0].content[0].text, /<transcript>\n\[00:00\] Hello there[\s\S]*<\/transcript>$/);
      assert.deepEqual(p.messages[0].content[0].cache_control, { type: 'ephemeral' });
      v = s.voice.get(r.id);
      assert.equal(v.status, 'ready');
      assert.equal(v.title, 'Plan for the voice feature');
      assert.equal(v.notes.action_items[0].text, 'Write the plan');
      assert.match(v.notes_md, /^# Plan for the voice feature/);
      const item = s.db.prepare('SELECT * FROM items WHERE id = ?').get(v.item_id);
      assert.match(item.text, /^\*\*Plan for the voice feature\*\*/);
      assert.equal(item.link_title, 'Plan for the voice feature');
      const tags = s.db.prepare('SELECT t.name FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = ? ORDER BY t.name').all(item.id).map((x) => x.name);
      assert.deepEqual(tags, ['notes', 'voice']);
      assert.equal(await s.voice.runOnce(), false, 'nothing left to do');
      assert.equal(s.voice.usage().calls, 1);
    } finally { s.done(); }
  });

  test('a 429 from Groq waits as long as it says', async () => {
    let n = 0;
    const fetchFn = async () => {
      n++;
      if (n === 1) return new Response('slow down', { status: 429, headers: { 'retry-after': '90' } });
      return groqOk()();
    };
    const s = setup({ fetchFn });
    try {
      const r = await upload(s.voice, OGG(500));
      await s.voice.runOnce();
      let row = s.db.prepare('SELECT * FROM voice_notes WHERE id = ?').get(r.id);
      assert.equal(row.status, 'transcribing');
      assert.equal(row.busy_waits, 1, 'a wait counts (apart from errors), so endless 429s end');
      assert.equal(row.attempts, 0);
      assert.equal(row.next_at, s.now() + 90);
      assert.equal(await s.voice.runOnce(), false, 'not due yet');
      s.tick(91);
      await s.voice.runOnce();
      row = s.db.prepare('SELECT * FROM voice_notes WHERE id = ?').get(r.id);
      assert.equal(row.status, 'writing');
    } finally { s.done(); }
  });

  test('server errors back off then fail; a bad key fails at once; retry starts again', async () => {
    const s = setup({ fetchFn: async () => new Response('', { status: 500 }) });
    try {
      const r = await upload(s.voice, OGG(500));
      for (let i = 0; i < 4; i++) { await s.voice.runOnce(); s.tick(4000); }
      let v = s.voice.get(r.id);
      assert.equal(v.status, 'failed');
      assert.equal(v.failed_stage, 'transcript');
      assert.match(v.error, /Groq answered 500/);
      s.voice.retry(r.id, 'transcript');
      assert.equal(s.voice.get(r.id).status, 'transcribing');
    } finally { s.done(); }
    const s2 = setup({ fetchFn: async () => new Response('', { status: 401 }) });
    try {
      const r = await upload(s2.voice, OGG(500));
      await s2.voice.runOnce();
      const v = s2.voice.get(r.id);
      assert.equal(v.status, 'failed');
      assert.match(v.error, /rejected the server's API key/);
    } finally { s2.done(); }
  });

  test('a recording with no speech fails clearly', async () => {
    const s = setup({ fetchFn: groqOk([{ start: 0, end: 30, text: 'Thank you.', no_speech_prob: 0.95, avg_logprob: -1.5 }]) });
    try {
      const r = await upload(s.voice, OGG(500));
      await s.voice.runOnce();
      assert.match(s.voice.get(r.id).error, /No speech/);
    } finally { s.done(); }
  });

  test('notes that fail for good keep the transcript as the item text; regenerate works', async () => {
    const err = Object.assign(new Error('auth'), { status: 401 });
    const client = fakeClaude([err, JSON.stringify(NOTES)]);
    const s = setup({ client });
    try {
      const r = await upload(s.voice, OGG(500));
      await s.voice.runOnce();
      await s.voice.runOnce();
      let v = s.voice.get(r.id);
      assert.equal(v.status, 'failed');
      assert.equal(v.failed_stage, 'notes');
      assert.match(s.db.prepare('SELECT text FROM items WHERE id = ?').get(v.item_id).text, /Hello there/);
      s.voice.retry(r.id, 'notes');
      await s.voice.runOnce();
      v = s.voice.get(r.id);
      assert.equal(v.status, 'ready');
    } finally { s.done(); }
  });

  test('an overloaded API is retried once (and counted); wrong-shaped JSON backs off', async () => {
    const busy = Object.assign(new Error('overloaded'), { status: 529 });
    const client = fakeClaude([busy, '{"not":"notes"}']);
    const s = setup({ client });
    try {
      const r = await upload(s.voice, OGG(500));
      await s.voice.runOnce();
      await s.voice.runOnce();
      assert.equal(client.calls.length, 2);
      assert.equal(s.voice.usage().calls, 2);
      const row = s.db.prepare('SELECT * FROM voice_notes WHERE id = ?').get(r.id);
      assert.equal(row.status, 'writing');
      assert.equal(row.attempts, 1);
      assert.match(row.error, /wrong shape/);
    } finally { s.done(); }
  });

  test('extra passes send the transcript, the notes and the owner prompt; caps and limits hold', async () => {
    const client = fakeClaude([JSON.stringify(NOTES), '## Email\n\nHi team…', JSON.stringify(NOTES)]);
    const s = setup({ client, dailyCalls: 2 });
    try {
      const r = await upload(s.voice, OGG(500));
      assert.throws(() => s.voice.addPass(r.id, 'Write it as an email'), { code: 'no_transcript' });
      await s.voice.drain();
      assert.throws(() => s.voice.addPass(r.id, '   '), { code: 'empty_prompt' });
      assert.throws(() => s.voice.addPass(r.id, 'x'.repeat(5000)), { code: 'prompt_too_long' });
      const p = s.voice.addPass(r.id, 'Write it as an email');
      await s.voice.runOnce();
      const call = client.calls[1].params;
      assert.equal(call.output_config, undefined, 'a pass answers in Markdown');
      assert.match(call.messages[0].content[1].text, /^<notes>\n# Plan/);
      assert.match(call.messages[0].content[2].text, /<owner_request>\nWrite it as an email\n<\/owner_request>$/);
      const v = s.voice.get(r.id);
      assert.equal(v.passes.length, 1);
      assert.equal(v.passes[0].id, p.id);
      assert.equal(v.passes[0].status, 'done');
      assert.equal(v.passes[0].output_md, '## Email\n\nHi team…');
      // two calls today: the notes and the pass. The cap refuses the next one up front.
      assert.throws(() => s.voice.addPass(r.id, 'Again'), { code: 'voice_cap' });
      s.voice.removePass(r.id, p.id);
      assert.equal(s.voice.get(r.id).passes.length, 0);
    } finally { s.done(); }
  });

  test('title and ticked action items are saved; delete removes the file and trashes the item', async () => {
    const s = setup();
    try {
      const r = await upload(s.voice, OGG(500));
      await s.voice.drain();
      s.voice.patch(r.id, { title: '  My   title ', action_done: [0, 0] });
      const v = s.voice.get(r.id);
      assert.equal(v.title, 'My title');
      assert.deepEqual(v.action_done, [0]);
      assert.match(s.db.prepare('SELECT text FROM items WHERE id = ?').get(v.item_id).text, /^\*\*My title\*\*/);
      assert.throws(() => s.voice.patch(r.id, { action_done: ['x'] }), { code: 'bad_actions' });
      await s.voice.remove(r.id);
      assert.equal(s.voice.get(r.id), null);
      assert.ok(!existsSync(join(s.dir, `${r.id}.ogg`)));
      assert.equal(s.db.prepare('SELECT state FROM items WHERE id = ?').get(v.item_id).state, 'trashed');
    } finally { s.done(); }
  });

  test('housekeeping drops week-old unfinished uploads and stray files, never a live note\'s audio', async () => {
    const s = setup();
    try {
      const r = await upload(s.voice, OGG(500));
      const c = s.voice.create({ source: 'phone', mime: 'audio/ogg', bytes: 1000, duration_s: 60 });
      await s.voice.writeChunk(c.id, 0, body(OGG(100)));
      writeFileSync(join(s.dir, '999.ogg'), 'stray');
      s.tick(8 * 86400);
      s.voice.cleanFiles();
      const files = readdirSync(s.dir).sort();
      assert.deepEqual(files, [`${r.id}.ogg`]);
      assert.equal(s.voice.get(c.id), null);
    } finally { s.done(); }
  });
});

describe('voice notes: review fixes', () => {
  test('a .part shorter than counted is never padded with zeros: the client continues from what is there', async () => {
    const s = setup();
    try {
      const buf = OGG(300);
      const c = s.voice.create({ source: 'phone', mime: 'audio/ogg', bytes: buf.length, duration_s: 60 });
      await s.voice.writeChunk(c.id, 0, body(buf.subarray(0, 200)));
      writeFileSync(join(s.dir, `${c.id}.part`), buf.subarray(0, 50));   // lost writes
      await assert.rejects(s.voice.writeChunk(c.id, 200, body(buf.subarray(200))), { code: 'offset_mismatch' });
      assert.equal(s.db.prepare('SELECT received FROM voice_notes WHERE id = ?').get(c.id).received, 50);
      await s.voice.writeChunk(c.id, 50, body(buf.subarray(50)));
      await s.voice.finish(c.id);
      assert.deepEqual(readFileSync(join(s.dir, `${c.id}.ogg`)), buf);
      // and at finish time
      const d = s.voice.create({ source: 'phone', mime: 'audio/ogg', bytes: 100, duration_s: 60 });
      await s.voice.writeChunk(d.id, 0, body(OGG(100)));
      writeFileSync(join(s.dir, `${d.id}.part`), OGG(40));
      await assert.rejects(s.voice.finish(d.id), { code: 'incomplete' });
      assert.equal(s.db.prepare('SELECT received FROM voice_notes WHERE id = ?').get(d.id).received, 40);
    } finally { s.done(); }
  });

  test('the minutes cap holds: a restart with a longer recording pays the difference; a bad file is not refunded', async () => {
    const s = setup({ dailyMinutes: 30 });
    try {
      const a = s.voice.create({ source: 'web', mime: 'audio/ogg', bytes: 50, duration_s: 60, client_id: 'y' });
      assert.throws(() => s.voice.create({ source: 'web', mime: 'audio/ogg', bytes: 51, duration_s: 5400, client_id: 'y' }), { code: 'voice_minutes_cap' });
      s.voice.create({ source: 'web', mime: 'audio/ogg', bytes: 51, duration_s: 600, client_id: 'y' });
      assert.equal(s.voice.usage().minutes, 10);
      await s.voice.writeChunk(a.id, 0, body(Buffer.from('x'.repeat(51))));
      await assert.rejects(s.voice.finish(a.id), { code: 'bad_type' });
      assert.equal(s.voice.usage().minutes, 10, 'no refund: the note can still be finished');
    } finally { s.done(); }
  });

  test('a voice note id is never reused after a delete', async () => {
    const s = setup();
    try {
      const a = await upload(s.voice, OGG(100));
      await s.voice.remove(a.id);
      const b = await upload(s.voice, OGG(100));
      assert.ok(b.id > a.id);
    } finally { s.done(); }
  });

  test('a transcript that fails for good says so in the item, not "transcribing"', async () => {
    const s = setup({ fetchFn: async () => new Response('', { status: 400 }) });
    try {
      const r = await upload(s.voice, OGG(100));
      await s.voice.runOnce();
      const it = s.db.prepare('SELECT text FROM items WHERE voice_id = ?').get(r.id);
      assert.match(it.text, /not transcribed/);
      assert.doesNotMatch(it.text, /transcribing…/);
    } finally { s.done(); }
  });

  test('extra bytes left by a crash after a write are overwritten, so the upload still finishes', async () => {
    const s = setup();
    try {
      const buf = OGG(CHUNK_BYTES + 500);
      const c = s.voice.create({ source: 'phone', mime: 'audio/ogg', bytes: buf.length, duration_s: 60 });
      await s.voice.writeChunk(c.id, 0, body(buf.subarray(0, CHUNK_BYTES)));
      // the process died after writing the next piece but before counting it
      writeFileSync(join(s.dir, `${c.id}.part`), Buffer.concat([buf.subarray(0, CHUNK_BYTES), Buffer.alloc(300, 9)]));
      await s.voice.writeChunk(c.id, CHUNK_BYTES, body(buf.subarray(CHUNK_BYTES)));
      assert.equal((await s.voice.finish(c.id)).status, 'transcribing');
      assert.deepEqual(readFileSync(join(s.dir, `${c.id}.ogg`)), buf);
    } finally { s.done(); }
  });

  test('a missing .part starts the upload again from zero; a crash after the rename still finishes', async () => {
    const s = setup();
    try {
      const buf = OGG(800);
      const c = s.voice.create({ source: 'phone', mime: 'audio/ogg', bytes: buf.length, duration_s: 60 });
      await s.voice.writeChunk(c.id, 0, body(buf));
      rmSync(join(s.dir, `${c.id}.part`));
      await assert.rejects(s.voice.finish(c.id), { code: 'incomplete' });
      assert.equal(s.db.prepare('SELECT received FROM voice_notes WHERE id = ?').get(c.id).received, 0);
      await s.voice.writeChunk(c.id, 0, body(buf));
      // renamed into place, then the process died before the database said so
      const { renameSync } = await import('node:fs');
      renameSync(join(s.dir, `${c.id}.part`), join(s.dir, `${c.id}.ogg`));
      assert.equal((await s.voice.finish(c.id)).status, 'transcribing');
    } finally { s.done(); }
  });

  test('a resent start with a different size restarts that upload instead of a finish that can never match', async () => {
    const s = setup();
    try {
      const a = s.voice.create({ source: 'web', mime: 'audio/webm', bytes: 1000, duration_s: 60, client_id: 'r1' });
      await s.voice.writeChunk(a.id, 0, body(Buffer.alloc(400, 1)));
      const b = s.voice.create({ source: 'web', mime: 'audio/webm', bytes: 900, duration_s: 58, client_id: 'r1' });
      assert.equal(b.id, a.id);
      assert.equal(b.received, 0);
      assert.equal(b.bytes, 900);
    } finally { s.done(); }
  });

  test('a server-side fallback: only the answer after the switch counts, and its model is recorded', async () => {
    const client = { calls: [], beta: { messages: { stream() {
      return { finalMessage: async () => ({ stop_reason: 'end_turn', model: 'claude-opus-5-5', content: [
        { type: 'text', text: '{"title": "par' }, { type: 'fallback', from: { model: 'claude-sonnet-5-5' }, to: { model: 'claude-opus-5-5' } },
        { type: 'text', text: JSON.stringify(NOTES) }] }) };
    } } } };
    const s = setup({ client });
    try {
      const r = await upload(s.voice, OGG(500));
      await s.voice.drain();
      const v = s.voice.get(r.id);
      assert.equal(v.status, 'ready');
      assert.equal(v.notes_model, 'claude-opus-5-5');
    } finally { s.done(); }
  });

  test('new notes clear old ticks; a rename updates the stored Markdown; a redo while working is refused', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    let n = 0;
    const client = { beta: { messages: { stream() {
      n++;
      const wait = n === 2 ? gate : Promise.resolve();
      return { finalMessage: async () => { await wait; return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(NOTES) }] }; } };
    } } } };
    const s = setup({ client });
    try {
      const r = await upload(s.voice, OGG(500));
      await s.voice.drain();
      s.voice.patch(r.id, { action_done: [0], title: 'Renamed' });
      assert.match(s.voice.get(r.id).notes_md, /^# Renamed/);
      s.voice.retry(r.id, 'notes');
      const busy = s.voice.runOnce();
      await new Promise((r2) => setTimeout(r2, 10));
      assert.throws(() => s.voice.retry(r.id, 'transcript'), { code: 'busy' });
      release();
      await busy;
      const v = s.voice.get(r.id);
      assert.deepEqual(v.action_done, []);
      assert.match(v.notes_md, /^# Renamed/);
    } finally { s.done(); }
  });

  test('endless 429s end; no key fails without counting a call; the list never loads transcripts', async () => {
    const s = setup({ fetchFn: async () => new Response('', { status: 429, headers: { 'retry-after': '5' } }) });
    try {
      const r = await upload(s.voice, OGG(500));
      for (let i = 0; i < 14; i++) { await s.voice.runOnce(); s.tick(10); }
      assert.equal(s.voice.get(r.id).status, 'failed');
      const item = s.voice.list()[0];
      assert.equal(item.transcript, undefined);
      assert.equal(item.notes, undefined);
    } finally { s.done(); }
    const dir = mkdtempSync(join(tmpdir(), 'voice-'));
    try {
      const db = openDb(':memory:');
      const voice = createVoice(db, { voiceDir: dir, fetchFn: groqOk(), client: null, anthropicKey: null, groqKey: 'gsk_test' });
      const r = await upload(voice, OGG(500));
      await voice.drain();
      const v = voice.get(r.id);
      assert.equal(v.status, 'writing', 'no key yet: the note waits instead of failing');
      assert.match(v.error, /not set up/);
      assert.equal(voice.usage().calls, 0);
      voice.recover();   // what start() does: a restart with the key makes it due at once
      assert.equal(db.prepare('SELECT next_at FROM voice_notes WHERE id = ?').get(r.id).next_at, null);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a phone only sees its own notes, even with many newer ones from elsewhere', () => {
    const s = setup({ dailyMinutes: 100000 });
    try {
      s.voice.create({ source: 'phone', mime: 'audio/ogg', bytes: 100, duration_s: 10, device_id: 7 });
      for (let i = 0; i < 5; i++) { s.tick(1); s.voice.create({ source: 'web', mime: 'audio/ogg', bytes: 100, duration_s: 10 }); }
      assert.equal(s.voice.list({ limit: 3, deviceId: 7 }).length, 1);
      assert.equal(s.voice.list({ limit: 3 }).length, 3);
    } finally { s.done(); }
  });
});

// ---- over HTTP: who may do what, Range, MCP ----
function freePort() {
  return new Promise((res, rej) => {
    const sv = net.createServer();
    sv.once('error', rej);
    sv.listen(0, '127.0.0.1', () => { const p = sv.address().port; sv.close(() => res(p)); });
  });
}

describe('voice notes over HTTP', () => {
  let app; let base; let dir; let capture; let capture2; let read;
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'voice-http-'));
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    app = createApp({
      dbPath: ':memory:', passwordHash: await A.makePasswordHash('pw pw pw pw', 1000), secret: 'x'.repeat(40), origins: base,
      cookieSecure: false, trustProxy: false, startWorker: false, log: () => {}, voiceDir: join(dir, 'voice'),
      groqFetchFn: groqOk(), groqKey: 'gsk_test', voiceClient: fakeClaude(JSON.stringify(NOTES)),
    });
    await app.listen(port, '127.0.0.1');
    capture = A.createDeviceToken(app.db, 'Phone', 'capture').token;
    capture2 = A.createDeviceToken(app.db, 'Other phone', 'capture').token;
    read = A.createDeviceToken(app.db, 'Claude', 'read').token;
  });
  after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });

  const call = (method, path, { token, json, raw, headers = {} } = {}) => fetch(base + path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(json ? { 'Content-Type': 'application/json' } : {}),
      ...(raw ? { 'Content-Type': 'application/octet-stream' } : {}), ...headers },
    body: json ? JSON.stringify(json) : raw,
  });

  test('a phone uploads, sees only its own notes, and can\'t read notes; a read key can; Range works', async () => {
    const audio = OGG(3000);
    let r = await call('POST', '/api/voice', { token: capture, json: { mime: 'audio/ogg', bytes: audio.length, duration_s: 30, client_id: 'c1' } });
    assert.equal(r.status, 201);
    const { id } = await r.json();
    assert.equal((await call('PUT', `/api/voice/${id}/chunk?offset=0`, { token: capture, json: { a: 1 } })).status, 415);
    assert.equal((await call('PUT', `/api/voice/${id}/chunk?offset=0`, { token: capture2, raw: audio })).status, 404, 'another phone can\'t touch it');
    assert.equal((await call('PUT', `/api/voice/${id}/chunk?offset=0`, { token: read, raw: audio })).status, 403);
    r = await call('PUT', `/api/voice/${id}/chunk?offset=0`, { token: capture, raw: audio });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { received: 3000 });
    r = await call('POST', `/api/voice/${id}/finish`, { token: capture, json: {} });
    assert.equal(r.status, 202);
    assert.equal((await r.json()).status, 'transcribing');

    r = await call('GET', '/api/voice', { token: capture });
    assert.equal((await r.json()).notes.length, 1);
    r = await call('GET', '/api/voice', { token: capture2 });
    assert.equal((await r.json()).notes.length, 0);
    assert.equal((await call('GET', `/api/voice/${id}`, { token: capture })).status, 403, 'a capture key never reads the transcript');
    assert.equal((await call('GET', `/voice/${id}/audio`, { token: capture })).status, 403);
    assert.equal((await call('PATCH', `/api/voice/${id}`, { token: read, json: { title: 'x' } })).status, 403);

    await app.voice.drain();
    r = await call('GET', `/api/voice/${id}`, { token: read });
    const v = await r.json();
    assert.equal(v.status, 'ready');
    assert.match(v.transcript, /Hello there/);

    r = await call('GET', `/voice/${id}/audio`, { token: read });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('accept-ranges'), 'bytes');
    assert.equal(r.headers.get('content-type'), 'audio/ogg');
    assert.match(r.headers.get('content-security-policy'), /sandbox/);
    assert.equal((await r.arrayBuffer()).byteLength, 3000);
    r = await call('GET', `/voice/${id}/audio`, { token: read, headers: { Range: 'bytes=100-199' } });
    assert.equal(r.status, 206);
    assert.equal(r.headers.get('content-range'), 'bytes 100-199/3000');
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), audio.subarray(100, 200));
    r = await call('GET', `/voice/${id}/audio`, { token: read, headers: { Range: 'bytes=-10' } });
    assert.equal(r.headers.get('content-range'), 'bytes 2990-2999/3000');
    r = await call('GET', `/voice/${id}/audio`, { token: read, headers: { Range: 'bytes=5000-' } });
    assert.equal(r.status, 416);
    assert.equal((await call('GET', '/voice/abc/audio', { token: read })).status, 404);
  });

  test('/api/voice/ (with a slash) works too, for browsers holding an old cached redirect', async () => {
    let r = await call('GET', '/api/voice/', { token: capture });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray((await r.json()).notes));
    r = await call('POST', '/api/voice/', { token: capture, json: { mime: 'audio/ogg', bytes: 10, duration_s: 5, client_id: 'slash' } });
    assert.equal(r.status, 201);
  });

  test('MCP search finds words that were only spoken, and get_item has the notes and transcript', async () => {
    const mcp = async (method, params) => {
      const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${read}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      return r.json();
    };
    let out = await mcp('tools/call', { name: 'search_items', arguments: { query: 'second minute' } });
    const text = out.result.content[0].text;
    assert.match(text, /voice note/);
    const itemId = Number(/\[item (\d+)\]/.exec(text)[1]);
    out = await mcp('tools/call', { name: 'get_item', arguments: { id: itemId } });
    const full = out.result.content[0].text;
    assert.match(full, /Voice note: Plan for the voice feature/);
    assert.match(full, /## Transcript \(1 min\)/);
    assert.match(full, /\[01:10\] Second minute\./);
  });
});

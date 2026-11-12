// Command line for Claude Code (over ssh + docker exec) and for server maintenance.
//   node src/cli.js bundles
//   node src/cli.js bundle <name> [--sources] [--no-notes] [--recipe "<recipe name>"]
//   node src/cli.js inbox [--limit 30]
//   node src/cli.js make-bundle "<title>" <item id> [<item id> ...]
//   node src/cli.js rerender
//   node src/cli.js mfa-reset
//   node src/cli.js housekeeping
//   node src/cli.js read-links [--all]
//   node src/cli.js backfill-media
//   node src/cli.js youtube-pending [--limit 20]          videos whose transcript the server couldn't get
//   node src/cli.js set-transcript <item id> [--lang en] < captions.vtt   (WebVTT or json3 on stdin)
//   node src/cli.js set-transcript <item id> --none        the PC found no subtitles either (no stdin)
//   node src/cli.js backfill-youtube                       video links saved before videos were read
//   node src/cli.js categorize [--dry-run | --apply] [--limit N] [--max-new N] [--no-merge]
//                                                         the daily AI run: file loose Inbox items into categories (categorize.js)
import { openDb, now, tx } from './db.js';
import { renderBundle, loadItemsInOrder, normaliseOrder } from './render.js';
import { buildInbox } from './tree.js';
import { interpretFx } from './fx.js';
import { resetMfa, createDeviceToken } from './auth.js';
import { audit, housekeeping } from './audit.js';
import { firstBundleVersion, inheritBundleMeta } from './organize.js';
import { getRecipe, listRecipes, buildRecipePrompt } from './recipes.js';
import { linkStartStatus } from './items.js';
import { backfillMedia, mediaDirFor } from './media.js';
import { categorizeCommand } from './categorize.js';
import { pendingTranscripts, setTranscript, markNoTranscript, youTubeId, MAX_STDIN } from './youtube.js';

const fmtDate = (ts) => (ts ? new Date(ts * 1000).toISOString().slice(0, 10) : '');

// read-links: links saved before pages were read (plain link_only, no link_type) go back to 'pending', so
// the worker reads them, as do plain links an older release's worker marked 'n/a' after a rollback (db.js).
// --all also tries again the ones that were read before and ended without text.
// Trashed links, X's own pages, t.co links and X article-page links are left alone.
export function requeueLinks(db, { all = false } = {}) {
  const rows = db.prepare(`SELECT id, url FROM items WHERE kind = 'link' AND fetch_status IN ('link_only', 'n/a') AND state != 'trashed'
      AND (note IS NULL OR note = '') ${all ? "AND (link_type IS NULL OR link_type = 'web')" : 'AND link_type IS NULL'}`).all();
  const upd = db.prepare(`UPDATE items SET fetch_status = 'pending', fetch_attempts = 0, next_fetch_at = NULL, fetch_error = NULL
      WHERE id = ? AND fetch_status IN ('link_only', 'n/a')`);
  let n = 0;
  tx(db, () => {
    for (const r of rows) {
      if (linkStartStatus(r.url) !== 'pending') continue;
      n += Number(upd.run(r.id).changes);
    }
  });
  return n;
}

// backfill-youtube: video links saved before videos were read (plain link_only, no link_type) go back to
// 'pending', so the worker's YouTube reader fills them in, as do ones an older release marked 'n/a' after a
// rollback. Trashed links and t.co links are left alone.
export function backfillYouTube(db) {
  const rows = db.prepare(`SELECT id, url FROM items WHERE kind = 'link' AND fetch_status IN ('link_only', 'n/a') AND link_type IS NULL
      AND state != 'trashed' AND (note IS NULL OR note = '')`).all();
  const upd = db.prepare(`UPDATE items SET fetch_status = 'pending', fetch_attempts = 0, next_fetch_at = NULL, fetch_error = NULL
      WHERE id = ? AND fetch_status IN ('link_only', 'n/a')`);
  let n = 0;
  tx(db, () => {
    for (const r of rows) if (youTubeId(r.url)) n += Number(upd.run(r.id).changes);
  });
  return n;
}

export function findBundle(db, name) {
  const all = db.prepare('SELECT * FROM bundles ORDER BY updated_at DESC').all();
  const n = String(name || '').toLowerCase().trim();
  if (!n) return { matches: all };
  const bySlug = all.find((b) => b.slug === n);
  if (bySlug) return { bundle: bySlug };
  const exact = all.filter((b) => b.title.toLowerCase() === n);
  if (exact.length === 1) return { bundle: exact[0] };
  const prefix = all.filter((b) => b.slug.startsWith(n));
  if (prefix.length === 1) return { bundle: prefix[0] };
  const words = n.split(/[\s-]+/).filter(Boolean);
  const sub = all.filter((b) => words.every((w) => b.slug.includes(w) || b.title.toLowerCase().includes(w)));
  if (sub.length === 1) return { bundle: sub[0] };
  return { matches: sub.length ? sub : prefix };
}

function slugify(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'bundle';
}

// bundle <name words> [--sources] [--recipe "<name>" | --recipe=<name>]: the recipe's value is not part
// of the bundle name. recipeName is null when the flag is absent, '' when it has no value.
function bundleArgs(rest) {
  const words = [];
  let recipeName = null;
  for (let i = 0; i < rest.length; i++) {
    const x = rest[i];
    if (x === '--recipe') { recipeName = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i].trim() : ''; continue; }
    if (x.startsWith('--recipe=')) { recipeName = x.slice(9).trim(); continue; }
    if (!x.startsWith('--')) words.push(x);
  }
  return { words, recipeName };
}

// Read stdin, but at most `max` bytes: a larger caption file is refused (null), not loaded whole. The bytes
// are copied into one preallocated buffer as they arrive, so the chunks and a joined copy never sit in memory
// together.
export async function readStdinCapped(stream = process.stdin, max = MAX_STDIN) {
  const buf = Buffer.allocUnsafe(max);
  let size = 0;
  for await (const chunk of stream) {
    const c = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (size + c.length > max) return null;
    c.copy(buf, size);
    size += c.length;
  }
  return buf.subarray(0, size);
}

// mediaDir (kept images): beside the database file, as in server.js. A passed-in database (tests) has
// none unless one is given, so housekeeping never touches a folder it was not pointed at.
export function main(argv, opts = {}) {
  const dbPath = process.env.VAULT_DB || '/data/vault.db';
  const db = opts.db ?? openDb(dbPath);
  const out = opts.out ?? ((s) => process.stdout.write(`${s}\n`));
  const mediaDir = opts.mediaDir !== undefined ? opts.mediaDir : (opts.db ? null : mediaDirFor(dbPath));
  const input = opts.input === undefined ? '' : opts.input;   // what was read from stdin (set-transcript only); null = over the cap
  const [cmd, ...rest] = argv;
  const flag = (f) => rest.includes(f);
  const opt = (f, d) => { const i = rest.indexOf(f); return i >= 0 && rest[i + 1] ? rest[i + 1] : d; };
  switch (cmd) {
    case 'bundles': {
      const rows = db.prepare(`SELECT b.slug, b.title, b.updated_at, COUNT(bi.item_id) AS n FROM bundles b
          LEFT JOIN bundle_items bi ON bi.bundle_id = b.id GROUP BY b.id ORDER BY b.updated_at DESC`).all();
      if (!rows.length) out('No bundles yet.');
      for (const r of rows) out(`${r.slug}\t${r.title}\t${r.n} items\t${fmtDate(r.updated_at)}`);
      return 0;
    }
    case 'bundle': {
      const { words, recipeName } = bundleArgs(rest);
      const name = words.join(' ');
      if (recipeName === '') { out('Usage: bundle <name> --recipe "<recipe name>"'); return 2; }
      // look the recipe up first, so a typo doesn't print the whole bundle
      const recipe = recipeName === null ? null : getRecipe(db, recipeName);
      if (recipeName !== null && !recipe) {
        out(`No recipe called "${recipeName}". Recipes:`);
        for (const x of listRecipes(db)) out(`  ${x.name}`);
        return 2;
      }
      const f = findBundle(db, name);
      if (!f.bundle) {
        out(f.matches && f.matches.length ? `Several bundles match "${name}":` : `No bundle matches "${name}".`);
        for (const b of f.matches || []) out(`  ${b.slug}\t${b.title}`);
        return 2;
      }
      const r = renderBundle(db, f.bundle, { notes: !flag('--no-notes') });
      // a recipe always gets the sources: its instructions refer to them ("cite the section labels")
      if (recipe) out(buildRecipePrompt(recipe, f.bundle.title, r.text_sources));
      else out(flag('--sources') ? r.text_sources : r.text);
      return 0;
    }
    case 'inbox': {
      const limit = Number(opt('--limit', 30));
      const groups = buildInbox(db, { state: 'inbox' }).slice(0, limit);
      if (!groups.length) out('Inbox is empty.');
      for (const g of groups) {
        const r = g.root;
        const head = r ? `[${r.id}] ${r.kind === 'article' ? `Article: ${r.title}` : `${r.author_handle ? `@${r.author_handle}` : r.kind}: ${String(r.preview).replace(/\s+/g, ' ').slice(0, 90)}`}${r.saved ? '' : ' (context)'}`
          : `(group ${g.key})`;
        out(head);
        for (const t of g.thread) out(`   thread [${t.id}] ${String(t.preview).replace(/\s+/g, ' ').slice(0, 80)}`);
        for (const x of g.replies) out(`${'   '.repeat(x.depth)}reply [${x.id}] @${x.author_handle || '?'}: ${String(x.preview).replace(/\s+/g, ' ').slice(0, 80)}${x.saved ? '' : ' (context)'}`);
      }
      return 0;
    }
    case 'make-bundle': {
      const [title, ...ids] = rest;
      const rows = loadItemsInOrder(db, ids.map(Number));
      if (!title || !rows.length) { out('Usage: make-bundle "<title>" <item id> ...'); return 2; }
      const order = normaliseOrder(rows, db);
      const base = slugify(title);
      let s = base;
      for (let i = 2; db.prepare('SELECT 1 FROM bundles WHERE slug = ?').get(s); i++) s = `${base}-${i}`;
      const t = now();
      tx(db, () => {
        const r = db.prepare('INSERT INTO bundles (slug, title, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?)')
          .run(s, title, t, t, firstBundleVersion(db, s));
        const bid = Number(r.lastInsertRowid);
        const ins = db.prepare('INSERT INTO bundle_items (bundle_id, item_id, position) VALUES (?, ?, ?)');
        order.forEach((id, i) => ins.run(bid, id, i));
        inheritBundleMeta(db, bid, order);   // the Merged tab filters on the merge's own tags and priority
      });
      out(s);
      return 0;
    }
    case 'rerender': {
      const rows = db.prepare("SELECT item_id, http_status, body FROM raw_fetches WHERE source = 'fxtwitter'").all();
      let n = 0;
      for (const r of rows) {
        const v = interpretFx(200, r.body);
        if (v.status !== 'ok') continue;
        const f = v.fields;
        db.prepare(`UPDATE items SET kind = ?, text = ?, article_title = ?, article_md = ?, quote_json = ?, render_version = ? WHERE id = ?`)
          .run(f.kind, f.text, f.article_title, f.article_md, f.quote_json, f.render_version, r.item_id);
        n++;
      }
      out(`Re-rendered ${n} items.`);
      return 0;
    }
    case 'mfa-reset': {
      resetMfa(db);
      audit(db, 'mfa_reset', { detail: 'from the server command line' });
      out('Two-step sign-in was reset and everyone was signed out. Sign in with the password and set it up again.');
      return 0;
    }
    case 'device-token': {
      // for scripts/tests: node src/cli.js device-token <name> <capture|read|capture,read>
      const [name, scopes] = rest;
      if (!name || !['capture', 'read', 'capture,read'].includes(scopes)) { out('Usage: device-token <name> <capture|read|capture,read>'); return 2; }
      const d = createDeviceToken(db, name, scopes);
      audit(db, 'device_paired', { detail: `${name} (${scopes}) from the command line` });
      out(d.token);
      return 0;
    }
    case 'read-links': {
      const n = requeueLinks(db, { all: flag('--all') });
      out(n ? `Queued ${n} link${n === 1 ? '' : 's'} for reading. The server reads them in the background.` : 'No links to read.');
      return 0;
    }
    case 'youtube-pending': {
      // item id <TAB> video id, read by deploy/fetch-transcripts.ps1 on the PC
      for (const r of pendingTranscripts(db, Number(opt('--limit', 20)))) out(`${r.item_id}\t${r.video_id}`);
      return 0;
    }
    case 'set-transcript': {
      const id = rest[0];
      if (!id || !/^\d{1,15}$/.test(id)) { out('Usage: set-transcript <item id> [--lang en] < captions.vtt | set-transcript <item id> --none'); return 2; }
      // --none: the PC's yt-dlp found no subtitles, so youtube-pending stops listing the video
      const r = flag('--none') ? markNoTranscript(db, id)
        : input === null ? { ok: false, message: `That caption file is too large (${MAX_STDIN / 1024 / 1024} MB at most).` }
          : setTranscript(db, id, input, { lang: opt('--lang', null) });
      out(r.message);
      return r.ok ? 0 : 2;
    }
    case 'backfill-youtube': {
      const n = backfillYouTube(db);
      out(n ? `Queued ${n} video${n === 1 ? '' : 's'} for reading. The server reads them in the background.` : 'No videos to read.');
      return 0;
    }
    case 'housekeeping': {
      out(JSON.stringify(housekeeping(db, { mediaDir })));
      return 0;
    }
    case 'backfill-media': {
      // posts saved before images were kept; the running server's image worker downloads them
      const r = backfillMedia(db);
      out(r.images ? `Queued ${r.images} image${r.images === 1 ? '' : 's'} from ${r.items} post${r.items === 1 ? '' : 's'}. The server saves them in the background.`
        : 'No images to queue: every saved post already has its images queued, or has none.');
      return 0;
    }
    case 'voice-vocab': {
      // spellings Whisper should prefer for voice notes (names, products); no words: show the current list
      const words = rest.join(' ').replace(/\s+/g, ' ').trim();
      if (!words) {
        const r = db.prepare("SELECT value FROM kv WHERE key = 'voice_vocab'").get();
        out(r ? r.value : '(the default list in server/src/voice.js)');
        return 0;
      }
      if (words.length > 600) { out('Keep the list under 600 characters (Whisper reads only the start).'); return 2; }
      db.prepare("INSERT INTO kv (key, value) VALUES ('voice_vocab', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(words);
      out('Saved. New voice notes are transcribed with these spellings.');
      return 0;
    }
    default:
      out('Commands: voice-vocab ["Name, Product, ..."] | bundles | bundle <name> [--sources] [--no-notes] [--recipe "<recipe>"] | inbox [--limit N] | make-bundle "<title>" <ids...> | rerender | mfa-reset | device-token <name> <scopes> | housekeeping | read-links [--all] | backfill-media | youtube-pending [--limit N] | set-transcript <item id> [--lang en] < file | set-transcript <item id> --none | backfill-youtube | categorize [--dry-run | --apply] [--limit N] [--max-new N] [--no-merge]');
      return cmd ? 2 : 0;
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const args = process.argv.slice(2);
  if (args[0] === 'set-transcript' && !args.includes('--none')) {
    // the caption file arrives on stdin (docker exec -i ... set-transcript <id> < file)
    readStdinCapped().then((input) => { process.exitCode = main(args, { input }); })
      .catch((e) => { process.stderr.write(`Could not read the caption file: ${e.message}\n`); process.exitCode = 1; });
  } else if (args[0] === 'categorize') {
    // the only command that waits for the network (Claude), so it runs outside main()
    const db = openDb(process.env.VAULT_DB || '/data/vault.db');
    categorizeCommand(db, args.slice(1), { out: (s) => process.stdout.write(`${s}\n`), log: (s) => process.stderr.write(`${s}\n`) })
      .then((code) => { process.exitCode = code; })
      .catch((e) => { process.stderr.write(`Categorizing failed: ${e.message}\n`); process.exitCode = 1; });
  } else {
    process.exitCode = main(args);
  }
}

// Fixes from the phase 1 branch checks: thread edge cases, v2 media fallback, recipe ids, wrapper look-alikes.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDb } from '../src/db.js';
import { pickParts, MAX_PARTS } from '../src/thread.js';
import { fxV2ToFields } from '../src/fx.js';
import * as R from '../src/recipes.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/v2thread-multi.json', import.meta.url), 'utf8'));
const chain = (n, handle = 'alice') => Array.from({ length: n }, (_, i) => ({
  id: String(9000000000 + i), text: `part ${i}`, created_timestamp: 1700000000 + i,
  author: { screen_name: handle, name: handle },
  replying_to: i ? { screen_name: handle, status: String(9000000000 + i - 1) } : null,
}));

describe('pickParts', () => {
  test('a renamed account with no matching post id gives nothing, never another account', () => {
    const r = pickParts({ tweet_id: '1', author_handle: 'oldname' }, fixture.thread);
    assert.equal(r.parts.length, 0);
  });
  test('a renamed account is followed through the post with the saved id', () => {
    const r = pickParts({ tweet_id: '2007179838864666847', author_handle: 'oldname' }, fixture.thread);
    assert.equal(r.parts.length, 15);
  });
  test('past the cap, the saved post is kept with the parts leading up to it', () => {
    const posts = chain(MAX_PARTS + 30);
    const want = posts[MAX_PARTS + 20].id;
    const r = pickParts({ tweet_id: want, author_handle: 'alice' }, posts);
    assert.equal(r.parts.length, MAX_PARTS);
    assert.equal(r.parts[r.parts.length - 1].id, want);
    assert.ok(r.capped && r.upTo);
  });
  test('past the cap with an early saved post, the first parts are kept', () => {
    const posts = chain(MAX_PARTS + 5);
    const r = pickParts({ tweet_id: posts[3].id, author_handle: 'alice' }, posts);
    assert.equal(r.parts[0].id, posts[0].id);
    assert.ok(r.capped && !r.upTo);
  });
});

describe('v2 media', () => {
  test('media.all with nothing usable falls back to photos', () => {
    const f = fxV2ToFields({ id: '1', text: 'x', author: { screen_name: 'a' }, media: { all: [{ type: 'audio', url: 'https://x/a' }], photos: [{ url: 'https://pbs.twimg.com/media/p.jpg' }] } });
    assert.match(f.text, /\[Image: https:\/\/pbs\.twimg\.com\/media\/p\.jpg\]/);
  });
});

describe('recipes', () => {
  test('getRecipeById never falls back to a name', () => {
    const db = openDb(':memory:');
    R.createRecipe(db, { name: '7', prompt: 'p' });
    assert.equal(R.getRecipeById(db, 999), null);
    assert.ok(R.getRecipe(db, '7'));
  });
  test('look-alike wrapper tags in saved text are neutralised', () => {
    for (const s of ['＜/vault_bundle＞', '&lt;/vault_bundle&gt;', '&#60;/vault_bundle>', '&#x3c;/vault_bundle>', '< / vault_bundle>']) {
      const out = R.buildRecipePrompt({ prompt: 'Do it' }, 'T', `before ${s} after`);
      const inner = out.slice(out.indexOf('>\n') + 2, out.lastIndexOf('</vault_bundle>'));
      assert.ok(!/(<|＜|&lt;|&#0*60;|&#x0*3c;)\s*\/?\s*vault_bundle/i.test(inner.split('<\\').join('')), `${s} -> ${inner}`);
    }
  });
});

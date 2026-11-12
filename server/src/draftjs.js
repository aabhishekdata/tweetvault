// X Article content (Draft.js blocks) -> Markdown.
// Offsets are UTF-16 code units, which is exactly how JS strings index, so slicing is safe with emoji.

export const RENDER_VERSION = 1;

const STYLE_MARK = { BOLD: '**', ITALIC: '_', STRIKETHROUGH: '~~', CODE: '`' };

function entityIndex(entityMap) {
  if (Array.isArray(entityMap)) return Object.fromEntries(entityMap.map((e) => [String(e.key), e.value]));
  return entityMap || {};
}

function wrap(s, mark) {
  if (!mark || !s.trim()) return s;
  const lead = s.match(/^\s*/)[0];
  const trail = s.match(/\s*$/)[0];
  return `${lead}${mark}${s.slice(lead.length, s.length - trail.length)}${mark}${trail}`;
}

function inline(block, entities, { skipStyles = false } = {}) {
  const text = block.text || '';
  if (!text) return '';
  const styles = skipStyles ? [] : (block.inlineStyleRanges || [])
    .map((r) => ({ ...r, mark: STYLE_MARK[String(r.style).toUpperCase()] }))
    .filter((r) => r.mark);
  const links = (block.entityRanges || [])
    .map((r) => ({ ...r, ent: entities[String(r.key)] }))
    .filter((r) => r.ent && String(r.ent.type).toUpperCase() === 'LINK' && r.ent.data && r.ent.data.url);

  const cuts = new Set([0, text.length]);
  for (const r of [...styles, ...links]) {
    cuts.add(Math.max(0, Math.min(text.length, r.offset)));
    cuts.add(Math.max(0, Math.min(text.length, r.offset + r.length)));
  }
  const pts = [...cuts].sort((a, b) => a - b);
  const segs = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (a === b) continue;
    const marks = styles.filter((r) => r.offset <= a && r.offset + r.length >= b).map((r) => r.mark);
    const link = links.find((r) => r.offset <= a && r.offset + r.length >= b);
    const key = `${[...new Set(marks)].sort().join('')}|${link ? link.ent.data.url : ''}`;
    const prev = segs[segs.length - 1];
    if (prev && prev.key === key) prev.text += text.slice(a, b);
    else segs.push({ key, text: text.slice(a, b), marks: [...new Set(marks)].sort(), url: link ? link.ent.data.url : null });
  }
  // group consecutive segments that share a link so one [..](url) wraps them
  let out = '';
  for (let i = 0; i < segs.length;) {
    const url = segs[i].url;
    let j = i;
    let inner = '';
    while (j < segs.length && segs[j].url === url) {
      let s = segs[j].text;
      for (const m of segs[j].marks) s = wrap(s, m);
      inner += s;
      j++;
    }
    out += url && inner.trim()
      ? `${inner.match(/^\s*/)[0]}[${inner.trim()}](${url})${inner.match(/\s*$/)[0]}`
      : inner;
    i = j;
  }
  return out;
}

function mediaUrl(ent, mediaEntities) {
  const items = (ent && ent.data && ent.data.mediaItems) || [];
  for (const it of items) {
    const m = (mediaEntities || []).find((e) => String(e.media_id) === String(it.mediaId));
    const u = m && m.media_info && (m.media_info.original_img_url || m.media_info.url);
    if (u) return u;
  }
  return null;
}

function atomic(block, entities, mediaEntities) {
  const r = (block.entityRanges || [])[0];
  const ent = r ? entities[String(r.key)] : null;
  const type = ent ? String(ent.type).toUpperCase() : '';
  if (type === 'MEDIA' || type === 'IMAGE') {
    const u = mediaUrl(ent, mediaEntities);
    return u ? `[Image: ${u}]` : '[Image]';
  }
  if (type === 'TWEET' || type === 'POST') {
    const id = ent.data && (ent.data.tweetId || ent.data.id);
    return id ? `[Embedded post: https://x.com/i/status/${id}]` : '[Embedded post]';
  }
  if (type === 'DIVIDER') return '* * *';
  if (type === 'LINK' && ent.data && ent.data.url) return `[Link: ${ent.data.url}]`;
  const t = (block.text || '').trim();
  return t || '';
}

// content: {blocks, entityMap}; mediaEntities: article.media_entities
export function draftToMarkdown(content, mediaEntities = []) {
  const blocks = (content && content.blocks) || [];
  const entities = entityIndex(content && content.entityMap);
  const parts = []; // {text, kind:'list'|'code'|'block'}
  const olCounters = [];
  for (const b of blocks) {
    const type = String(b.type || 'unstyled');
    const depth = Math.max(0, Math.min(6, b.depth || 0));
    if (type === 'unordered-list-item') olCounters.length = Math.min(olCounters.length, depth);
    else if (type !== 'ordered-list-item') olCounters.length = 0;
    let line;
    let kind = 'block';
    switch (type) {
      case 'header-one':
      case 'header-two':
        line = `### ${inline(b, entities, { skipStyles: true }).trim()}`; break;
      case 'header-three':
      case 'header-four':
      case 'header-five':
      case 'header-six':
        line = `#### ${inline(b, entities, { skipStyles: true }).trim()}`; break;
      case 'unordered-list-item':
        line = `${'  '.repeat(depth)}- ${inline(b, entities).trim()}`; kind = 'list'; break;
      case 'ordered-list-item': {
        olCounters.length = depth + 1;
        olCounters[depth] = (olCounters[depth] || 0) + 1;
        line = `${'   '.repeat(depth)}${olCounters[depth]}. ${inline(b, entities).trim()}`; kind = 'list'; break;
      }
      case 'blockquote':
        line = inline(b, entities).split('\n').map((l) => `> ${l}`).join('\n'); break;
      case 'code-block':
        line = b.text || ''; kind = 'code'; break;
      case 'atomic':
        line = atomic(b, entities, mediaEntities); break;
      default:
        line = inline(b, entities);
    }
    if (kind !== 'code' && !String(line).trim()) continue;
    parts.push({ text: line, kind });
  }
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const prev = parts[i - 1];
    if (p.kind === 'code') {
      if (!prev || prev.kind !== 'code') out += (out ? '\n\n' : '') + '```\n';
      else out += '\n';
      out += p.text;
      const next = parts[i + 1];
      if (!next || next.kind !== 'code') out += '\n```';
      continue;
    }
    if (out) out += prev && prev.kind === 'list' && p.kind === 'list' ? '\n' : '\n\n';
    out += p.text;
  }
  return out.replace(/^\n+/, '').trimEnd();
}

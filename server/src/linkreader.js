// Reading a saved normal link (phase 3): YouTube videos go to youtube.js, everything else to web.js.
// The fetcher's worker calls readLink for a link item whose fetch_status is 'pending' (short links are
// expanded first, by resolveTco in fetcher.js). Each reader writes its own fields (link_type, link_title,
// link_site, link_author, link_published_at, link_md, link_meta, link_fetched_at) and ends the item at
// fetch_status 'ok' (content saved) or 'link_only' (nothing readable; the URL is always kept), or asks
// for a retry by throwing an Error with retry = true.
//
// deps: { now, log, fetchImpl, webFetch } - fetchImpl is injectable so tests never touch the network.
// webFetch is web.js's page fetcher (default: the SSRF-safe safeFetch in webfetch.js); a shared page is
// never fetched with the general fetchImpl.
import { isYouTubeUrl, readYouTube } from './youtube.js';
import { readWebPage } from './web.js';

export async function readLink(db, it, deps) {
  if (isYouTubeUrl(it.url)) return readYouTube(db, it, deps);
  return readWebPage(db, it, deps);
}

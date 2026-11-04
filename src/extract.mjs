// Extraction: fetch every candidate URL once (conditional GET when the previous run stored an ETag),
// parse the server-rendered HTML, crawl internal links up to the configured depth, and strip boilerplate.
import { SITE, POLICY, SKIP_PATH } from "./config.mjs";
import { parsePage, boilerplateFilter } from "./lib/html.mjs";
import { normalizePath } from "./discover.mjs";

const SUMMARY_FIELDS = ["title", "description", "robots", "canonical", "headings", "blocks", "text", "links", "isNotFound", "isGate", "contentHash"];

export async function fetchPages(client, paths, { state = {}, origin = SITE.origin, depth = POLICY.crawlDepth, log = () => {} } = {}) {
  const pages = new Map();   // path -> page record
  const queue = [...new Set(paths)].map((p) => ({ path: p, level: 0 }));
  const seen = new Set(queue.map((q) => q.path));
  const prev = state.pages || {};
  while (queue.length) {
    const { path, level } = queue.shift();
    const url = origin + path;
    const cached = prev[path];
    const res = await client.get(url, { etag: cached?.etag });
    let rec;
    if (res.notModified && cached?.summary) {
      rec = { path, status: 200, finalPath: cached.finalPath || path, etag: cached.etag, fromCache: true, level, ...cached.summary };
    } else if (res.status === 200 && res.body) {
      const parsed = parsePage(res.body, url);
      rec = { path, status: 200, finalPath: normalizePath(res.finalUrl, origin) || path, etag: res.etag, fromCache: false, level, ...pick(parsed, SUMMARY_FIELDS) };
    } else {
      rec = { path, status: res.status, finalPath: res.finalUrl ? normalizePath(res.finalUrl, origin) : null, etag: null, fromCache: false, level, error: res.error || null, text: "", blocks: [], links: [], headings: [], title: null, isNotFound: res.status === 404, contentHash: null };
    }
    pages.set(path, rec);
    log(`fetch ${res.status}${res.notModified ? " (304)" : ""} ${path}`);
    if (level < depth && rec.status === 200) {
      for (const href of rec.links || []) {
        const p = normalizePath(href, origin);
        if (!p || seen.has(p) || SKIP_PATH.test(p) || /\?/.test(href)) continue;
        seen.add(p); queue.push({ path: p, level: level + 1 });
      }
    }
  }
  // boilerplate across all 200 pages
  const ok = [...pages.values()].filter((p) => p.status === 200);
  const bp = boilerplateFilter(ok, { share: POLICY.boilerplateShare, minPages: POLICY.boilerplateMinPages });
  for (const p of ok) { p.contentBlocks = bp.apply(p.blocks || []); p.contentText = p.contentBlocks.join(" ").replace(/\s+/g, " ").trim(); }
  return { pages, boilerplate: [...bp.common] };
}

function pick(o, keys) { const r = {}; for (const k of keys) r[k] = o[k]; return r; }

export function pageStateFrom(pages) {
  const out = {};
  for (const [path, p] of pages) if (p.status === 200) out[path] = { etag: p.etag, finalPath: p.finalPath, fetchedAt: new Date().toISOString(), summary: pick(p, SUMMARY_FIELDS) };
  return out;
}

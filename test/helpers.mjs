// Test helpers: a synthetic site built from the recorded fixtures, with knobs for each scenario.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureApi } from "../src/lib/api.mjs";
import { NOT_FOUND_BODY, simpleHash } from "../src/lib/http.mjs";
import { SITE } from "../src/config.mjs";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const FIX = join(ROOT, "fixtures");
const HTML = { "/": "home.html", "/kids": "kids.html", "/our-beliefs/on-god": "on-god.html", "/vision": "vision.html", "/jobs": "jobs.html", "/connect": "connect.html", "/upcomingevents": "upcomingevents.html", "/items/leadership-legacy": "leadership-legacy.html" };
const cache = new Map();
const readHtml = (name) => { if (!cache.has(name)) cache.set(name, readFileSync(join(FIX, "html", name), "utf8")); return cache.get(name); };

export function syntheticPage({ title, text, robots, links = [], headings = [] }) {
  return `<!doctype html><html><head><title>${title} | Family Christian Centre</title>${robots ? `<meta name="robots" content="${robots}">` : ""}<meta name="description" content="${(text || "").slice(0, 120)}"><link rel="canonical" href="${SITE.origin}"></head><body>
<header id="SITE_HEADER"><nav>Home About Ministries Events Giving</nav></header>
<main id="PAGES_CONTAINER"><div id="SITE_PAGES">${headings.map((h) => `<h2>${h}</h2>`).join("")}<p>${text}</p>${links.map((l) => `<a href="${l}">${l}</a>`).join("")}<div>Sundays · 10:30am · In person & online. 160 Dickins Drive, Fort McMurray AB. Copyright Family Christian Centre.</div></div></main>
<footer id="SITE_FOOTER">Copyright 2026, Family Christian Centre. All Rights Reserved.</footer></body></html>`;
}

// Builds a client that serves recorded HTML where it exists, synthetic pages for every other known path, 404 otherwise.
export function siteClient({ pages = {}, missing = [], redirects = {}, thin = [], fail = [] } = {}) {
  const stats = { requests: 0, notModified: 0, errors: 0 };
  const known = new Set(Object.keys(pages));
  return {
    stats,
    async get(url, { etag } = {}) {
      stats.requests++;
      const u = new URL(url); let path = u.pathname.replace(/\/+$/, "") || "/"; if (path === "/home") path = "/";
      if (path.endsWith(".xml")) { const f = join(FIX, "sitemap", path.slice(1)); try { return { url, finalUrl: url, status: 200, etag: null, contentType: "application/xml", body: readFileSync(f, "utf8"), notModified: false }; } catch { return { url, finalUrl: url, status: 404, body: "", notModified: false }; } }
      if (fail.includes(path)) { stats.errors++; return { url, finalUrl: url, status: null, body: "", error: "network", notModified: false }; }
      if (redirects[path]) return { url, finalUrl: SITE.origin + redirects[path], status: 200, etag: null, contentType: "text/html", body: pages[redirects[path]]?.body || syntheticPage(pages[redirects[path]] || { title: "Moved", text: "moved page text that is long enough to count as content for indexing purposes." }), notModified: false };
      if (missing.includes(path) || !known.has(path)) return { url, finalUrl: url, status: 404, etag: null, contentType: "text/html", body: NOT_FOUND_BODY, notModified: false };
      const spec = pages[path];
      const body = spec.recorded ? readHtml(HTML[path]) : spec.body || syntheticPage(thin.includes(path) ? { ...spec, text: "tiny" } : spec);
      const tag = `W/"t-${simpleHash(body)}"`;
      if (etag && etag === tag) { stats.notModified++; return { url, finalUrl: url, status: 304, etag: tag, body: "", notModified: true }; }
      return { url, finalUrl: url, status: 200, etag: tag, contentType: "text/html", body, notModified: false };
    }
  };
}

// Pages for the whole recorded site: every Site Context static page, list page and item page gets a page.
export function fullSitePages(sc, cms, overrides = {}) {
  const pages = {};
  for (const p of sc.staticPages.items) { const path = p.path === "/home" ? "/" : p.path; pages[path] = HTML[path] ? { recorded: true } : { title: p.title.trim(), text: `${p.title.trim()} page. This is the ${p.title.trim()} ministry page of Family Christian Centre with enough words to count as real content for the search index.`, links: ["/kids", "/vision"] }; }
  for (const t of sc.dynamicPages.items) {
    // list and item templates share a path; the list page shows the titles of the item template's pages
    const itemTitles = sc.dynamicPages.items.filter((x) => x.path === t.path).flatMap((x) => (sc.dynamicItemPages[x.id]?.items || []).map((i) => i.title));
    if (!pages[t.path]) pages[t.path] = HTML[t.path] ? { recorded: true } : { title: t.title, text: itemTitles.length ? itemTitles.join(" · ") + " listing page of the collection." : "Nothing here yet.", headings: itemTitles };
    for (const ip of sc.dynamicItemPages[t.id]?.items || []) if (!pages[ip.path]) pages[ip.path] = HTML[ip.path] ? { recorded: true } : { title: ip.title, text: `${ip.title}. Detail page text for ${ip.title} with a description long enough to be indexed properly.`, headings: [ip.title] };
  }
  return { ...pages, ...overrides };
}

export function cloneApi(mutate) {
  const api = fixtureApi(FIX);
  const sc = structuredClone(api._raw.sc); const cms = structuredClone(api._raw.cms);
  if (mutate) mutate(sc, cms);
  return {
    kind: "fixture", _raw: { sc, cms },
    async listStaticPages() { return sc.staticPages; },
    async listDynamicPages() { return sc.dynamicPages; },
    async listDynamicItemPages(prefix, pageId) { return sc.dynamicItemPages[pageId] || { published: true, items: [] }; },
    async queryItems(id) { const c = cms.collections[id]; return c ? { total: c.total ?? c.items.length, items: c.items } : { total: 0, items: [] }; }
  };
}

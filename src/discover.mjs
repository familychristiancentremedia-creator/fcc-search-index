// Discovery: union of the public sitemap, the Wix Site Context page lists and the CMS collections.
// Each source reports whether it completed; an incomplete source makes the run incomplete (reconcile honours that).
import { SITE, CONTENT_COLLECTIONS, SKIP_PATH } from "./config.mjs";
import { decodeEntities } from "./lib/html.mjs";

export function normalizePath(input, origin = SITE.origin) {
  let u;
  try { u = new URL(input, origin); } catch { return null; }
  if (u.host.replace(/^www\./, "") !== SITE.host.replace(/^www\./, "")) return null;
  let p = u.pathname.replace(/\/+$/, "") || "/";
  if (p === "/home") p = "/";
  return p;
}

export function parseSitemapIndex(xml) { return [...xml.matchAll(/<sitemap>[\s\S]*?<loc>([\s\S]*?)<\/loc>[\s\S]*?<\/sitemap>/gi)].map((m) => decodeEntities(m[1].trim())); }
export function parseUrlset(xml) {
  return [...xml.matchAll(/<url>([\s\S]*?)<\/url>/gi)].map((m) => {
    const loc = /<loc>([\s\S]*?)<\/loc>/i.exec(m[1]); const lm = /<lastmod>([\s\S]*?)<\/lastmod>/i.exec(m[1]);
    return loc ? { loc: decodeEntities(loc[1].trim()), lastmod: lm ? lm[1].trim() : null } : null;
  }).filter(Boolean);
}

export async function discoverSitemap(client, { origin = SITE.origin, fetchSub } = {}) {
  const out = { complete: false, subs: [], urls: [], errors: [] };
  const idx = await client.get(origin + "/sitemap.xml");
  if (idx.status !== 200 || !idx.body) { out.errors.push(`sitemap index: status ${idx.status} ${idx.error || ""}`); return out; }
  const subs = parseSitemapIndex(idx.body);
  let ok = true;
  for (const sub of subs) {
    const r = await client.get(sub);
    const name = sub.split("/").pop();
    if (r.status !== 200 || !r.body) { out.errors.push(`sub-sitemap ${name}: status ${r.status}`); ok = false; continue; }
    const rows = parseUrlset(r.body);
    out.subs.push({ url: sub, name, count: rows.length });
    for (const row of rows) { const path = normalizePath(row.loc, origin); if (path && !SKIP_PATH.test(path)) out.urls.push({ path, lastmod: row.lastmod, sub: name }); }
  }
  out.complete = ok && subs.length > 0 && out.urls.length > 0;
  return out;
}

export async function discoverSiteContext(api) {
  if (!api) return null;
  const out = { complete: false, statics: [], dynamicPages: [], itemPages: {}, published: null, errors: [] };
  try {
    let complete = true;
    const s = await api.listStaticPages(); out.published = s.published; out.statics = (s.items || []).map((p) => ({ id: p.id, title: p.title?.trim(), path: normalizePath(p.path) }));
    if (s.complete === false) complete = false;
    const d = await api.listDynamicPages(); out.dynamicPages = (d.items || []).map((p) => ({ id: p.id, title: p.title, path: normalizePath(p.path), hasItemPages: !!p.hasItemPages }));
    if (d.complete === false) complete = false;
    for (const t of out.dynamicPages.filter((p) => p.hasItemPages)) {
      const r = await api.listDynamicItemPages(t.path, t.id);
      out.itemPages[t.id] = (r.items || []).map((p) => ({ id: p.id, title: p.title, path: normalizePath(p.path), recordId: recordIdFromItemPageId(p.id), published: r.published !== false }));
      if (r.complete === false) complete = false;
    }
    out.complete = complete;
  } catch (e) { out.errors.push(`site context: ${e.message || e}`); }
  return out;
}

// Item page ids look like "our-beliefs/{beliefTitle}_<CMS item _id>" (verified on the FCC site).
export function recordIdFromItemPageId(id) { const m = /_([0-9a-f-]{36})$/i.exec(id || ""); return m ? m[1] : null; }

export async function discoverCms(api) {
  if (!api) return null;
  const out = { complete: true, collections: {}, errors: [] };
  for (const [name, cfg] of Object.entries(CONTENT_COLLECTIONS)) {
    try {
      const r = await api.queryItems(name);
      if (r.total != null && r.items.length < r.total) { out.errors.push(`${name}: returned ${r.items.length} of ${r.total} items (pagination gap)`); out.complete = false; }
      out.collections[name] = { total: r.total, items: r.items.map((it) => ({
        _id: it._id, title: it[cfg.titleField], itemLink: it[cfg.itemLink] || null, listLink: it[cfg.listLink] || null,
        text: cfg.textFields.map((f) => fieldText(it[f])).filter(Boolean).join(" "),
        updatedAt: dateOf(it._updatedDate), createdAt: dateOf(it._createdDate), date: dateOf(it.date)
      })) };
    } catch (e) { out.errors.push(`${name}: ${e.message || e}`); out.complete = false; }
  }
  return out;
}

export function dateOf(v) { if (!v) return null; if (typeof v === "string") return v; if (typeof v === "object" && v.$date) return v.$date; return null; }
function fieldText(v) {
  if (v == null) return "";
  if (typeof v === "string") return v.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (typeof v === "object") { // Ricos rich content: collect text nodes
    const parts = []; (function walk(n) { if (!n || typeof n !== "object") return; if (typeof n.text === "string") parts.push(n.text); for (const k of Object.keys(n)) if (k !== "text") walk(n[k]); })(v); return parts.join(" ").replace(/\s+/g, " ").trim();
  }
  return String(v);
}

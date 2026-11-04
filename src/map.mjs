// Mapping: source records -> page mapping -> validated URL -> search document, with the policy rules.
// Never builds a URL from a title. Authority order: Site Context item pages > CMS link fields > sitemap > link crawl.
import { SITE, POLICY, CONTENT_COLLECTIONS, sectionFor } from "./config.mjs";
import { sha1, tokensOf } from "./lib/html.mjs";

const TITLE_SUFFIX = /\s*\|\s*Family Christian Centre\s*$/i;

// Phase A: candidates before fetching. Returns Map(path -> candidate).
export function buildCandidates({ sitemap, siteContext, cms }) {
  const c = new Map();
  const add = (path, meta) => { if (!path) return; const cur = c.get(path) || { path, evidence: [] }; Object.assign(cur, { ...meta, evidence: [...cur.evidence, ...(meta.evidence || [])] }); c.set(path, cur); };
  if (siteContext?.complete) {
    for (const p of siteContext.statics) add(p.path, { kind: "static", source: "site-context", pageId: p.id, scTitle: p.title, evidence: ["site-context:static"] });
    for (const t of siteContext.dynamicPages.filter((d) => !d.hasItemPages)) add(t.path, { kind: "list", source: "site-context", pageId: t.id, scTitle: t.title, evidence: ["site-context:dynamic-list"] });
    for (const t of siteContext.dynamicPages.filter((d) => d.hasItemPages)) {
      const col = collectionForTemplate(t.title);
      for (const ip of siteContext.itemPages[t.id] || []) add(ip.path, { kind: "item", source: col ? `cms:${col}` : "site-context", templateId: t.id, collection: col, recordId: ip.recordId, scTitle: ip.title, evidence: ["site-context:item-page"] });
    }
  }
  for (const u of sitemap?.urls || []) {
    const existing = c.get(u.path);
    if (existing) { existing.lastmod = u.lastmod; existing.evidence.push(`sitemap:${u.sub}`); continue; }
    const dyn = /^dynamic-/.test(u.sub);
    // Without the Site Context lists, classify by the recorded URL structure (config): list page or item of a known collection.
    const listCol = Object.entries(CONTENT_COLLECTIONS).find(([, cfg]) => cfg.listPath === u.path)?.[0] || null;
    const itemCol = dyn ? Object.entries(CONTENT_COLLECTIONS).find(([, cfg]) => u.path.startsWith(cfg.itemPrefix))?.[0] || null : null;
    add(u.path, { kind: listCol ? "list" : dyn ? "item" : "static", source: "sitemap", collection: listCol || itemCol || undefined, lastmod: u.lastmod, evidence: [`sitemap:${u.sub}`] });
  }
  // CMS link fields: cross-check item pages and note records that have no page
  if (cms?.collections) {
    for (const [col, data] of Object.entries(cms.collections)) {
      for (const it of data.items) {
        const path = it.itemLink ? normalizeLink(it.itemLink) : null;
        if (path && c.has(path)) { const cand = c.get(path); cand.collection = col; cand.recordId = cand.recordId || it._id; cand.record = it; cand.evidence.push("cms:link-field"); if (cand.recordId && cand.recordId !== it._id) cand.mappingConflict = `site-context record ${cand.recordId} vs cms ${it._id}`; }
        else if (path && !siteContext?.complete) { add(path, { kind: "item", source: `cms:${col}`, collection: col, recordId: it._id, record: it, evidence: ["cms:link-field"] }); }
        // else: record without a page in the published site (handled in finalize)
      }
    }
  }
  return c;
}

function collectionForTemplate(title) { for (const [col, cfg] of Object.entries(CONTENT_COLLECTIONS)) if (cfg.templateTitle === title) return col; return null; }
function normalizeLink(l) { try { const p = new URL(l, SITE.origin).pathname.replace(/\/+$/, "") || "/"; return p === "/home" ? "/" : p; } catch { return null; } }

// Phase B: after fetching. Produces documents and exclusions.
export function finalize({ candidates, pages, cms, siteContext, policy = POLICY }) {
  const docs = []; const excluded = []; const notes = [];
  const itemPageCount = {};
  for (const cand of candidates.values()) if (cand.kind === "item" && cand.collection) itemPageCount[cand.collection] = (itemPageCount[cand.collection] || 0) + 1;

  // orphan pages discovered only by the link crawl
  for (const [path, page] of pages) if (!candidates.has(path) && page.level > 0) candidates.set(path, { path, kind: "orphan", source: "link-crawl", evidence: ["link-crawl"] });

  for (const cand of candidates.values()) {
    const page = pages.get(cand.path);
    const reasons = [];
    if (!page) { excluded.push(ex(cand, "not-fetched")); continue; }
    if (page.status !== 200) {
      // a page the published-site listing says exists but the fetch cannot find is a mapping conflict, not a quiet exclusion
      const listed = cand.evidence.some((e) => e === "site-context:item-page" || e === "site-context:static" || e === "site-context:dynamic-list");
      excluded.push(ex(cand, listed && page.status === 404 ? "listed-but-404-conflict" : page.status === 404 ? "http-404" : `http-${page.status}`)); continue;
    }
    if (page.isNotFound) { excluded.push(ex(cand, "wix-404-page")); continue; }
    if (page.isGate) { excluded.push(ex(cand, "password-or-members-gate")); continue; }
    let path = cand.path;
    if (page.finalPath && page.finalPath !== cand.path) {
      if (candidates.has(page.finalPath)) { excluded.push(ex(cand, "redirect-to-known-page", { to: page.finalPath })); continue; }
      notes.push(`moved ${cand.path} -> ${page.finalPath}`); path = page.finalPath;
    }
    const robots = page.robots || null;
    if (robots && /noindex/.test(robots) && !policy.includeNoindexPages) { excluded.push(ex(cand, "noindex")); continue; }
    if (cand.kind === "list" && policy.excludeThinListPages) {
      const col = cand.collection || collectionForListPath(cand, siteContext);
      // empty = the collection has no records at all (CMS known) or no published item pages (CMS unknown)
      const recordCount = cms?.collections?.[col] ? cms.collections[col].items.length : null;
      const empty = recordCount != null ? recordCount === 0 : !(itemPageCount[col] > 0);
      if (col && empty) { excluded.push(ex(cand, "empty-list-page", { collection: col })); continue; }
    }
    const text = page.contentText ?? page.text ?? "";
    if (text.length < policy.minTextChars && !policy.thinAllowList.includes(path)) { excluded.push(ex(cand, "thin", { chars: text.length })); continue; }
    if (cand.kind === "orphan" && !policy.includeOrphanPages) { excluded.push(ex(cand, "orphan-excluded")); continue; }
    if (!policy.indexPdfs && /\.pdf$/i.test(path)) { excluded.push(ex(cand, "pdf")); continue; }

    const title = cleanTitle(page.title) || cand.scTitle || cand.record?.title || path;
    const docId = cand.recordId && cand.collection ? `cms:${cand.collection}:${cand.recordId}` : cand.pageId ? `page:${cand.pageId}` : `url:${sha1(path)}`;
    const headings = (page.headings || []).slice(0, 12);
    const cmsText = cand.record?.text || "";
    const fullText = [text, cmsText && !text.includes(cmsText.slice(0, 40)) ? cmsText : ""].filter(Boolean).join(" ");
    docs.push({
      docId, kind: cand.kind, source: cand.source, recordId: cand.recordId || null, templateId: cand.templateId || null, pageId: cand.pageId || null,
      path, url: SITE.origin + path, title, section: sectionFor(path),
      description: page.description || fullText.slice(0, 160), headings,
      text: fullText.slice(0, policy.excerptChars), tokens: tokensOf(title, headings.join(" "), fullText).slice(0, policy.maxTokens),
      robots, contentHash: page.contentHash, updatedAt: cand.record?.updatedAt || null, lastmod: cand.lastmod || null,
      evidence: cand.evidence, mappingConflict: cand.mappingConflict || null, listingEntries: []
    });
  }

  // records without pages: attach to a listing page if it renders them, else count
  let recordsWithoutPublicPage = 0, listingEntries = 0;
  if (cms?.collections) {
    const byPath = new Map(docs.map((d) => [d.path, d]));
    for (const [col, data] of Object.entries(cms.collections)) {
      const cfg = CONTENT_COLLECTIONS[col];
      for (const it of data.items) {
        const path = it.itemLink ? normalizeLink(it.itemLink) : null;
        if (path && byPath.has(path)) continue;
        const listPath = it.listLink ? normalizeLink(it.listLink) : null;
        const listing = (listPath && byPath.get(listPath)) || [...byPath.values()].find((d) => d.section === cfg?.section && d.kind === "list");
        const title = (it.title || "").trim();
        if (listing && title && (listing.text + " " + (pages.get(listing.path)?.contentText || "")).toLowerCase().includes(title.toLowerCase())) {
          listing.listingEntries.push({ recordId: it._id, title, collection: col, date: it.date || null, updatedAt: it.updatedAt || null }); listingEntries++;
          for (const t of tokensOf(title, it.text)) if (!listing.tokens.includes(t) && listing.tokens.length < policy.maxTokens) listing.tokens.push(t);
        } else { recordsWithoutPublicPage++; excluded.push({ recordId: it._id, collection: col, title, reason: "record-without-public-page" }); }
      }
    }
  }
  docs.sort((a, b) => a.path.localeCompare(b.path));
  return { docs, excluded, notes, stats: { recordsWithoutPublicPage, listingEntries, itemPageCount } };
}

function collectionForListPath(cand, siteContext) {
  for (const [col, cfg] of Object.entries(CONTENT_COLLECTIONS)) {
    const tmpl = siteContext?.dynamicPages?.find((d) => d.title === cfg.templateTitle);
    if (tmpl && tmpl.path === cand.path) return col;
    if (!tmpl && cand.path === cfg.listPath) return col;
  }
  return null;
}
function ex(cand, reason, extra = {}) { return { path: cand.path, kind: cand.kind, source: cand.source, recordId: cand.recordId || null, reason, ...extra }; }
export function cleanTitle(t) { return t ? t.replace(TITLE_SUFFIX, "").replace(/^Family Christian Centre\s*\|\s*/i, "").trim() : null; }

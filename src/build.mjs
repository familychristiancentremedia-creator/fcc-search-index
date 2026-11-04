// Index build and validation. The index is one JSON file the Concept 6 panel loads on first Search open;
// the manifest is the small mutable pointer the panel revalidates.
import { createHash } from "node:crypto";
import { SITE, POLICY, CONTENT_COLLECTIONS } from "./config.mjs";

export const INDEX_SCHEMA_VERSION = 1;

export function buildIndex(docs, { generatedAt = new Date().toISOString(), policy = POLICY } = {}) {
  const publicDocs = docs.map((d) => ({
    id: d.docId, url: d.path, title: d.title, section: d.section, kind: d.kind,
    description: (d.description || "").slice(0, 200), headings: d.headings || [],
    text: (d.text || "").slice(0, policy.excerptChars), tokens: (d.tokens || []).slice(0, policy.maxTokens),
    updatedAt: d.updatedAt || d.lastmod || null,
    ...(d.previousUrls?.length ? { previousUrls: d.previousUrls } : {}),
    ...(d.listingEntries?.length ? { listingEntries: d.listingEntries.map((e) => ({ title: e.title, date: e.date })) } : {})
  }));
  const body = JSON.stringify({ schema: INDEX_SCHEMA_VERSION, site: SITE.origin, generatedAt, count: publicDocs.length, docs: publicDocs });
  const hash = createHash("sha256").update(body).digest("hex");
  const version = `${generatedAt.replace(/[-:]/g, "").slice(0, 15)}-${hash.slice(0, 8)}`;
  const fileName = `index-${version}.json`;
  const manifest = { schema: INDEX_SCHEMA_VERSION, version, file: fileName, generatedAt, count: publicDocs.length, sizeBytes: Buffer.byteLength(body), sha256: hash };
  return { version, fileName, body, manifest };
}

export function validateIndex({ body, manifest }, { prevCount = null, allowDrift = false, policy = POLICY } = {}) {
  const errors = []; const warnings = [];
  let parsed;
  try { parsed = JSON.parse(body); } catch (e) { return { ok: false, errors: [`index is not valid JSON: ${e.message}`], warnings }; }
  if (parsed.schema !== INDEX_SCHEMA_VERSION) errors.push("schema version mismatch");
  if (!Array.isArray(parsed.docs) || parsed.docs.length === 0) errors.push("index has no documents");
  if (parsed.count !== parsed.docs?.length) errors.push("count does not match docs length");
  const allowedSources = new Set(["static", "list", "item", "orphan"]);
  const ids = new Set(); const urls = new Set();
  const emailRe = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  for (const d of parsed.docs || []) {
    if (!d.id || ids.has(d.id)) errors.push(`duplicate or missing id: ${d.id}`); ids.add(d.id);
    if (!d.url || !d.url.startsWith("/") || d.url.startsWith("//")) errors.push(`bad url: ${d.url}`);
    if (urls.has(d.url)) errors.push(`duplicate url: ${d.url}`); urls.add(d.url);
    if (!d.title) errors.push(`missing title: ${d.url}`);
    if (!d.text || d.text.length < policy.minTextChars) errors.push(`text too short: ${d.url}`);
    if (!allowedSources.has(d.kind)) errors.push(`unexpected kind ${d.kind}: ${d.url}`);
    if (d.id.startsWith("cms:")) { const col = d.id.split(":")[1]; if (!CONTENT_COLLECTIONS[col]) errors.push(`document from excluded collection ${col}: ${d.url}`); }
    // Addresses on a public page are public content; they are listed for review, not treated as a leak
    // (documents can only come from the allowed content collections and fetched public pages, checked above).
    for (const m of (d.text + " " + d.description).match(emailRe) || []) if (!policy.allowedEmails.includes(m.toLowerCase())) warnings.push(`e-mail address shown on ${d.url}: ${m}`);
  }
  if (manifest.sizeBytes > policy.sizeBudgetBytes) errors.push(`index is ${manifest.sizeBytes} bytes, over the ${policy.sizeBudgetBytes} budget`);
  if (prevCount != null && !allowDrift) {
    if (parsed.count < policy.driftFloor * prevCount) errors.push(`document count ${parsed.count} is below ${Math.round(policy.driftFloor * 100)}% of the previous ${prevCount}`);
    if (parsed.count > prevCount * 1.5 + 10) warnings.push(`document count grew from ${prevCount} to ${parsed.count}`);
  }
  return { ok: errors.length === 0, errors, warnings };
}

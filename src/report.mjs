// Run report: the reconciliation counts from the planning package (section 2.H) as JSON and Markdown.
export function buildReport({ runId, startedAt, finishedAt, mode, discovery, candidates, pages, mapping, rec, validation, manifest, published, client }) {
  const cms = discovery.cms;
  const collectionsDiscovered = cms ? Object.keys(cms.collections).length : 0;
  const recordsPerSource = cms ? Object.fromEntries(Object.entries(cms.collections).map(([k, v]) => [k, v.items.length])) : {};
  const recordsRetrieved = Object.values(recordsPerSource).reduce((a, b) => a + b, 0);
  const itemDocs = mapping.docs.filter((d) => d.kind === "item").length;
  const listDocs = mapping.docs.filter((d) => d.kind === "list").length;
  const excludedByReason = {};
  for (const e of mapping.excluded) excludedByReason[e.reason] = (excludedByReason[e.reason] || 0) + 1;
  const fetched = [...pages.values()];
  const report = {
    runId, startedAt, finishedAt, mode, complete: rec.complete, reasons: rec.reasons,
    sources: {
      sitemap: { complete: !!discovery.sitemap?.complete, urls: discovery.sitemap?.urls.length || 0, subSitemaps: discovery.sitemap?.subs || [], errors: discovery.sitemap?.errors || [] },
      siteContext: discovery.siteContext ? { complete: discovery.siteContext.complete, staticPages: discovery.siteContext.statics.length, dynamicTemplates: discovery.siteContext.dynamicPages.length, itemPages: Object.values(discovery.siteContext.itemPages).reduce((a, b) => a + b.length, 0), errors: discovery.siteContext.errors } : "unavailable (no API key)",
      cms: cms ? { complete: cms.complete, collections: collectionsDiscovered, records: recordsPerSource, errors: cms.errors } : "unavailable (no API key)",
      linkCrawl: { discovered: fetched.filter((p) => p.level > 0).length }
    },
    http: { requests: client.stats.requests, notModified: client.stats.notModified, errors: client.stats.errors, pagesFetched: fetched.length, pages200: fetched.filter((p) => p.status === 200).length, pages404: fetched.filter((p) => p.status === 404).length },
    counts: {
      cmsCollectionsDiscovered: collectionsDiscovered, recordsRetrieved, recordsEligibleForPublicIndexing: recordsRetrieved - (excludedByReason["record-without-public-page"] || 0),
      recordsMappedToPublicPages: itemDocs, recordsOnlyOnListingPages: mapping.stats.listingEntries, recordsWithoutPublicPage: mapping.stats.recordsWithoutPublicPage,
      publicUrlsValidated: fetched.filter((p) => p.status === 200 && !p.isNotFound).length, candidates: candidates.size,
      documents: rec.docs.length, dynamicPagesIndexed: itemDocs + listDocs, excluded: mapping.excluded.length, excludedByReason,
      unresolvedMappings: mapping.docs.filter((d) => d.mappingConflict).length + (excludedByReason["listed-but-404-conflict"] || 0),
      duplicatesConsolidated: excludedByReason["redirect-to-known-page"] || 0,
      changes: Object.fromEntries(Object.entries(rec.changes).map(([k, v]) => [k, v.length]))
    },
    validation, manifest, published, boilerplateBlocks: mapping.boilerplate?.length || 0
  };
  return { report, markdown: toMarkdown(report, mapping, rec) };
}

function toMarkdown(r, mapping, rec) {
  const c = r.counts; const lines = [];
  lines.push(`# Search index run ${r.runId}`, "", `${r.mode}. Started ${r.startedAt}, finished ${r.finishedAt}. **${r.complete ? "Complete" : "INCOMPLETE"}**${r.reasons.length ? ": " + r.reasons.join("; ") : ""}. Published: ${r.published ? "yes" : "no (phase 1 never publishes)"}.`, "");
  lines.push("## Summary", "",
    `- ${r.sources.sitemap.urls} public URLs in the sitemap (${r.sources.sitemap.subSitemaps.map((s) => `${s.name.split("_")[0]}: ${s.count}`).join(", ")})`,
    `- ${r.sources.linkCrawl.discovered} extra URLs found by link crawling`,
    `- ${r.http.pagesFetched} pages fetched (${r.http.pages200} OK, ${r.http.pages404} not found, ${r.http.notModified} unchanged via ETag)`,
    `- ${c.documents} documents in the index (${c.dynamicPagesIndexed} dynamic pages)`,
    `- ${c.changes.new} new, ${c.changes.updated} updated, ${c.changes.moved} moved, ${c.changes.removed} removed, ${c.changes.missing} missing (pending removal), ${c.changes.unconfirmed} unconfirmed`,
    `- ${c.excluded} excluded: ${Object.entries(c.excludedByReason).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`,
    `- ${c.unresolvedMappings} unresolved dynamic-page mappings`,
    `- Validation ${r.validation.ok ? "passed" : "FAILED"}${r.validation.errors.length ? ": " + r.validation.errors.slice(0, 5).join("; ") : ""}`, "");
  lines.push("## Dynamic-page coverage", "",
    `| Measure | Count |`, `|---|---|`,
    `| CMS collections discovered (content collections only) | ${c.cmsCollectionsDiscovered} |`,
    `| Records retrieved | ${c.recordsRetrieved} |`,
    `| Records eligible for public indexing | ${c.recordsEligibleForPublicIndexing} |`,
    `| Records mapped to actual public pages | ${c.recordsMappedToPublicPages} |`,
    `| Records accessible only through listing pages | ${c.recordsOnlyOnListingPages} |`,
    `| Records without a public page (excluded) | ${c.recordsWithoutPublicPage} |`,
    `| Public URLs validated (200, real page) | ${c.publicUrlsValidated} |`,
    `| Dynamic pages indexed | ${c.dynamicPagesIndexed} |`,
    `| Unresolved mappings | ${c.unresolvedMappings} |`,
    `| Duplicates consolidated | ${c.duplicatesConsolidated} |`, "");
  lines.push("## Sources", "", `- Sitemap: ${r.sources.sitemap.complete ? "complete" : "INCOMPLETE"}${r.sources.sitemap.errors.length ? " (" + r.sources.sitemap.errors.join("; ") + ")" : ""}`,
    `- Site Context API: ${typeof r.sources.siteContext === "string" ? r.sources.siteContext : `${r.sources.siteContext.complete ? "complete" : "INCOMPLETE"}: ${r.sources.siteContext.staticPages} static pages, ${r.sources.siteContext.dynamicTemplates} dynamic templates, ${r.sources.siteContext.itemPages} item pages`}`,
    `- CMS: ${typeof r.sources.cms === "string" ? r.sources.cms : `${r.sources.cms.complete ? "complete" : "INCOMPLETE"}: ${Object.entries(r.sources.cms.records).map(([k, v]) => `${k} ${v}`).join(", ")}`}`, "");
  if (mapping.excluded.length) { lines.push("## Exclusions", ""); for (const e of mapping.excluded) lines.push(`- ${e.path || e.recordId}: ${e.reason}${e.collection ? ` (${e.collection})` : ""}${e.chars != null ? ` (${e.chars} chars)` : ""}${e.to ? ` -> ${e.to}` : ""}`); lines.push(""); }
  if (r.validation.warnings?.length) { lines.push("## Validation warnings (for review)", ""); for (const w of r.validation.warnings) lines.push(`- ${w}`); lines.push(""); }
  if (rec.changes.new.length || rec.changes.removed.length || rec.changes.moved.length || rec.changes.updated.length) {
    const pathOf = (id) => { const d = rec.docs.find((x) => x.docId === id); return d ? ` (${d.path})` : ""; };
    lines.push("## Changes", "");
    for (const id of rec.changes.new) lines.push(`- new: ${id}${pathOf(id)}`);
    for (const id of rec.changes.updated) lines.push(`- updated: ${id}${pathOf(id)}`);
    for (const m of rec.changes.moved) lines.push(`- moved: ${m}`);
    for (const id of rec.changes.removed) lines.push(`- removed: ${id}`);
    for (const id of rec.changes.missing) lines.push(`- missing (pending): ${id}${pathOf(id)}`);
    lines.push("");
  }
  return lines.join("\n");
}

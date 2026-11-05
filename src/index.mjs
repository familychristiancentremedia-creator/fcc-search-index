#!/usr/bin/env node
// Pipeline orchestrator and CLI. Phase 1 never publishes: artifacts go to --out only.
//   node src/index.mjs --dry-run                 live site, sitemap + HTML (+ CMS if WIX_API_KEY/WIX_SITE_ID are set,
//                                                + Site Context if WIX_SITE_CONTEXT=1 as well)
//   node src/index.mjs --from-fixtures fixtures  offline, recorded sitemap, API responses and HTML
//   options: --out <dir> (default out) --state <file> (default <out>/state.json) --allow-drift --depth <n> --quiet
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SITE, POLICY } from "./config.mjs";
import { createClient, fixtureDirClient } from "./lib/http.mjs";
import { createApi, fixtureApi } from "./lib/api.mjs";
import { discoverSitemap, discoverSiteContext, discoverCms } from "./discover.mjs";
import { buildCandidates, finalize } from "./map.mjs";
import { fetchPages, pageStateFrom } from "./extract.mjs";
import { reconcile } from "./reconcile.mjs";
import { buildIndex, validateIndex } from "./build.mjs";
import { buildReport } from "./report.mjs";

export const FIXTURE_PAGE_FILES = {
  "/": "home.html", "/kids": "kids.html", "/our-beliefs/on-god": "on-god.html", "/vision": "vision.html", "/jobs": "jobs.html",
  "/connect": "connect.html", "/upcomingevents": "upcomingevents.html", "/items/leadership-legacy": "leadership-legacy.html"
};

export async function runPipeline({ client, api, state = {}, out, allowDrift = false, depth = POLICY.crawlDepth, mode = "dry-run", log = () => {}, sitemapClient, useSiteContext = true } = {}) {
  const startedAt = new Date().toISOString();
  const runId = startedAt.replace(/[-:]/g, "").slice(0, 15);
  // 1. discovery
  const sitemap = await discoverSitemap(sitemapClient || client);
  // Site Context is opt-in (useSiteContext). The API key must carry the "Read Site Context for Rich Content" scope;
  // a key without it would fail here on every run. The source is either on, and then required for a complete run,
  // or off, and then never consulted, so a flaky answer can never flip static-page identities (page:<id> vs url:<hash>).
  const siteContext = useSiteContext ? await discoverSiteContext(api) : null;
  const cms = await discoverCms(api);
  const discovery = { sitemap, siteContext, cms, siteContextOff: !useSiteContext };
  log(`discovery: sitemap ${sitemap.urls.length} urls (${sitemap.complete ? "complete" : "INCOMPLETE"}); site context ${siteContext ? (siteContext.complete ? "ok" : "FAILED") : "n/a"}; cms ${cms ? (cms.complete ? "ok" : "FAILED") : "n/a"}`);
  // 2. candidates (+ every previously indexed URL, so removals are decided on a real fetch)
  const candidates = buildCandidates(discovery);
  const prevDocs = state.index?.docs || [];
  // previously indexed pages that no source lists any more are still fetched and judged by the same rules
  for (const d of prevDocs) if (!candidates.has(d.path)) candidates.set(d.path, { path: d.path, kind: d.kind, source: "previous-index", pageId: d.pageId || undefined, recordId: d.recordId || undefined, collection: d.docId.startsWith("cms:") ? d.docId.split(":")[1] : undefined, evidence: ["previous-index"] });
  const paths = new Set(candidates.keys());
  // 3. extraction + link crawl
  const { pages, boilerplate } = await fetchPages(client, [...paths], { state, depth, log });
  // 4. mapping
  const mapping = finalize({ candidates, pages, cms, siteContext }); mapping.boilerplate = boilerplate;
  // 5. reconciliation
  // Completeness: every source answered, no fetch errors, and the listed pages mostly fetched (a crawl that loses
  // more than 10% of the pages the sources list is incomplete even before the drift gate against a previous index).
  const listed = [...candidates.values()].filter((c) => c.source !== "link-crawl" && c.source !== "previous-index");
  const listedOk = listed.filter((c) => pages.get(c.path)?.status === 200).length;
  const fetchOk = listed.length === 0 || listedOk >= POLICY.fetchFloor * listed.length;
  const complete = sitemap.complete && (siteContext ? siteContext.complete : true) && (cms ? cms.complete : true) && client.stats.errors === 0 && fetchOk;
  const rec = reconcile({ prevDocs, docs: mapping.docs, pages, complete, strikes: state.strikes || {}, allowDrift });
  if (!fetchOk) rec.reasons.unshift(`fetch gate: only ${listedOk} of ${listed.length} listed pages returned 200 (floor ${Math.round(POLICY.fetchFloor * 100)}%)`);
  // 6. build + validate
  const built = buildIndex(rec.docs);
  const validation = validateIndex(built, { prevCount: prevDocs.length || null, allowDrift });
  const finishedAt = new Date().toISOString();
  const { report, markdown } = buildReport({ runId, startedAt, finishedAt, mode, discovery, candidates, pages, mapping, rec, validation, manifest: built.manifest, published: false, client });
  // The publication gate (planning package, section 7): a run may replace the live index only when the
  // content run is complete (every source answered, no drift, no fetch errors) AND the index validates.
  // Generated files or a passing validation alone are never enough.
  const publishable = validation.ok && rec.complete;
  const newState = publishable ? { index: { version: built.version, docs: rec.docs }, pages: pageStateFrom(pages), strikes: rec.strikes, updatedAt: finishedAt } : null;
  if (out) {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, built.fileName), built.body);
    writeFileSync(join(out, "manifest.json"), JSON.stringify(built.manifest, null, 2));
    writeFileSync(join(out, "run.json"), JSON.stringify({ runId, publishable, complete: rec.complete, valid: validation.ok, reasons: [...rec.reasons, ...validation.errors], version: built.version, file: built.fileName, finishedAt }, null, 2));
    writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
    writeFileSync(join(out, "REPORT.md"), markdown);
    writeFileSync(join(out, "documents.json"), JSON.stringify(rec.docs, null, 1));
    if (newState) writeFileSync(join(out, "state.json"), JSON.stringify(newState));
    else writeFileSync(join(out, "state.rejected.json"), JSON.stringify({ reason: validation.errors.concat(rec.reasons), at: finishedAt }));
  }
  return { built, validation, report, markdown, rec, mapping, pages, discovery, candidates, newState, publishable };
}

function arg(name, def) { const i = process.argv.indexOf(name); return i > -1 ? (process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : true) : def; }

const isMain = !!process.argv[1] && (import.meta.url === pathToFileURL(process.argv[1]).href || /[\\/]src[\\/]index\.mjs$/.test(process.argv[1]));
if (isMain) {
  const fixtures = arg("--from-fixtures", null);
  const dry = process.argv.includes("--dry-run");
  if (!fixtures && !dry) { console.error("usage: node src/index.mjs --dry-run | --from-fixtures <dir> [--out dir] [--state file] [--allow-drift] [--depth n]"); process.exit(2); }
  const out = resolve(arg("--out", fixtures ? "out/fixtures" : "out/dry-run"));
  const statePath = arg("--state", join(out, "state.json"));
  const quiet = process.argv.includes("--quiet");
  const log = quiet ? () => {} : (m) => console.error(m);
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
  const useSiteContext = process.env.WIX_SITE_CONTEXT === "1"; // live runs: off unless the key has the scope
  let client, api;
  if (fixtures) {
    const dir = resolve(fixtures);
    const sm = fixtureDirClient(join(dir, "sitemap"), SITE.origin, { "/sitemap.xml": "sitemap.xml" });
    client = {
      stats: { requests: 0, notModified: 0, errors: 0 },
      async get(url, o) { const u = new URL(url); const name = u.pathname.endsWith(".xml") ? u.pathname.slice(1) : null; const r = name ? await fixtureDirClient(join(dir, "sitemap"), SITE.origin, { [u.pathname]: name }).get(url, o) : await fixtureDirClient(join(dir, "html"), SITE.origin, FIXTURE_PAGE_FILES).get(url, o); this.stats.requests++; if (r.notModified) this.stats.notModified++; return r; }
    };
    api = fixtureApi(dir);
  } else {
    client = createClient({ userAgent: SITE.userAgent, delayMs: SITE.delayMs, log });
    api = createApi({ apiKey: process.env.WIX_API_KEY, siteId: process.env.WIX_SITE_ID || SITE.siteId });
    if (!process.env.WIX_API_KEY) log("WIX_API_KEY not set: running from the public sitemap and HTML only (Site Context and CMS sources unavailable)");
    else if (!useSiteContext) log("WIX_SITE_CONTEXT not set to 1: Site Context source off (CMS on); static pages keep url-based identities");
  }
  const result = await runPipeline({ client, api, state, out, allowDrift: process.argv.includes("--allow-drift"), depth: Number(arg("--depth", POLICY.crawlDepth)), mode: fixtures ? "fixtures" : "dry-run (live, no publish)", log, useSiteContext: fixtures ? true : useSiteContext });
  console.log(result.markdown);
  console.log(`\nindex: ${join(out, result.built.fileName)} (${result.built.manifest.sizeBytes} bytes, ${result.built.manifest.count} documents); validation ${result.validation.ok ? "OK" : "FAILED"}; run ${result.rec.complete ? "complete" : "incomplete"}; publishable: ${result.publishable ? "yes" : "NO"}`);
  // exit 0 only for a publishable run, so a workflow or a person can gate on the exit code as well as on run.json
  process.exit(result.publishable ? 0 : 1);
}

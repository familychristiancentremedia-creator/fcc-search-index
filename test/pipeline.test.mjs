import { test } from "node:test";
import assert from "node:assert/strict";
import { runPipeline } from "../src/index.mjs";
import { siteClient, fullSitePages, cloneApi } from "./helpers.mjs";

const quiet = { log: () => {} };
const run = (opts) => runPipeline({ ...quiet, ...opts });
const byPath = (res, p) => res.rec.docs.find((d) => d.path === p);
const excluded = (res, p) => res.mapping.excluded.find((e) => e.path === p || e.recordId === p);

async function baseline(mutate, clientOpts = {}, runOpts = {}) {
  const api = cloneApi(mutate);
  const client = siteClient({ pages: fullSitePages(api._raw.sc, api._raw.cms, clientOpts.overrides), ...clientOpts });
  return run({ client, api, ...runOpts });
}

test("full site (API + sitemap): 72 sitemap URLs plus /vision, Jobs/Services lists excluded, calendar records excluded", async () => {
  const res = await baseline();
  assert.equal(res.discovery.sitemap.urls.length, 72);
  assert.ok(res.rec.complete); assert.ok(res.validation.ok, res.validation.errors.join("; "));
  assert.equal(res.rec.docs.length, 71, "54 static + /our-beliefs list + /vision + 15 item pages");
  assert.equal(res.rec.docs.filter((d) => d.kind === "item").length, 15);
  assert.ok(byPath(res, "/vision"), "noindexed public page is included under the balanced policy");
  assert.equal(byPath(res, "/vision").robots, "noindex");
  assert.equal(excluded(res, "/jobs").reason, "empty-list-page");
  assert.equal(excluded(res, "/services").reason, "empty-list-page");
  assert.equal(res.report.counts.recordsWithoutPublicPage, 0, "every OurBeliefs/Items record has a page; calendar records are not a content collection");
  assert.ok(!res.rec.docs.some((d) => /events-calendar|contact|Forms/.test(d.docId)));
  assert.ok(res.built.manifest.sizeBytes < 300 * 1024);
});

test("stable identities: items are keyed by collection + record id, statics by page id", async () => {
  const res = await baseline();
  assert.equal(byPath(res, "/our-beliefs/on-god").docId, "cms:OurBeliefs:3a7236e1-5f57-4ab6-8c9e-f0a5ba4dab2c");
  assert.equal(byPath(res, "/kids").docId, "page:c7sts");
  assert.equal(byPath(res, "/items/fcc-mission%2Fvision-summary").docId, "cms:Items:543c43b5-8c72-43ad-a0a3-f86b465e90c4", "encoded-slash slug is used verbatim");
});

test("sitemap-only mode (no API key): same URLs, url-based identities, /vision found by the link crawl", async () => {
  const api = cloneApi();
  const client = siteClient({ pages: fullSitePages(api._raw.sc, api._raw.cms) });
  const res = await run({ client, api: null });
  assert.ok(res.rec.complete);
  assert.equal(res.rec.docs.length, 71);
  assert.ok(byPath(res, "/vision").docId.startsWith("url:"));
  assert.equal(byPath(res, "/vision").source, "link-crawl");
  assert.equal(excluded(res, "/jobs").reason, "empty-list-page");
});

test("a new CMS item with a published page becomes a new document on the next run", async () => {
  const first = await baseline();
  const state = first.newState;
  const res = await baseline((sc, cms) => {
    sc.dynamicItemPages.j129y.items.push({ id: "our-beliefs/{beliefTitle}_99999999-9999-4999-8999-999999999999", title: "ON PRAYER", path: "/our-beliefs/on-prayer" });
    cms.collections.OurBeliefs.items.push({ _id: "99999999-9999-4999-8999-999999999999", beliefTitle: "ON PRAYER", "link-our-beliefs-beliefTitle": "/our-beliefs/on-prayer", "link-our-beliefs-all": "/our-beliefs/", beliefDescription: "We believe in prayer.", _updatedDate: { $date: "2026-11-05T00:00:00Z" } });
    cms.collections.OurBeliefs.total = 10;
  }, {}, { state });
  assert.ok(byPath(res, "/our-beliefs/on-prayer"));
  assert.deepEqual(res.rec.changes.new, ["cms:OurBeliefs:99999999-9999-4999-8999-999999999999"]);
  assert.equal(res.rec.changes.removed.length, 0);
});

test("a renamed slug keeps the document id, changes the URL and records the old one", async () => {
  const first = await baseline();
  const res = await baseline((sc, cms) => {
    const ip = sc.dynamicItemPages.j129y.items.find((i) => i.path === "/our-beliefs/on-god"); ip.path = "/our-beliefs/about-god";
    cms.collections.OurBeliefs.items.find((i) => i._id === "3a7236e1-5f57-4ab6-8c9e-f0a5ba4dab2c")["link-our-beliefs-beliefTitle"] = "/our-beliefs/about-god";
  }, { missing: ["/our-beliefs/on-god"] }, { state: first.newState });
  const d = res.rec.docs.find((x) => x.docId === "cms:OurBeliefs:3a7236e1-5f57-4ab6-8c9e-f0a5ba4dab2c");
  assert.equal(d.path, "/our-beliefs/about-god");
  assert.deepEqual(d.previousUrls, ["/our-beliefs/on-god"]);
  assert.ok(res.rec.changes.moved.includes("/our-beliefs/on-god -> /our-beliefs/about-god"));
  assert.equal(res.rec.docs.filter((x) => x.docId === d.docId).length, 1);
});

test("an item removed from the published site is struck, then removed on the second complete run", async () => {
  const first = await baseline();
  const gone = (sc, cms) => { sc.dynamicItemPages.j129y.items = sc.dynamicItemPages.j129y.items.filter((i) => i.path !== "/our-beliefs/on-god"); cms.collections.OurBeliefs.items = cms.collections.OurBeliefs.items.filter((i) => i._id !== "3a7236e1-5f57-4ab6-8c9e-f0a5ba4dab2c"); cms.collections.OurBeliefs.total = 8; };
  const second = await baseline(gone, { missing: ["/our-beliefs/on-god"] }, { state: first.newState });
  assert.deepEqual(second.rec.changes.missing, ["cms:OurBeliefs:3a7236e1-5f57-4ab6-8c9e-f0a5ba4dab2c"]);
  assert.ok(byPath(second, "/our-beliefs/on-god"), "still carried after one strike");
  const third = await baseline(gone, { missing: ["/our-beliefs/on-god"] }, { state: second.newState });
  assert.deepEqual(third.rec.changes.removed, ["cms:OurBeliefs:3a7236e1-5f57-4ab6-8c9e-f0a5ba4dab2c"]);
  assert.equal(byPath(third, "/our-beliefs/on-god"), undefined);
});

test("a CMS record with no published item page never gets a URL; it attaches to its listing page when that page renders it", async () => {
  const res = await baseline((sc, cms) => {
    cms.collections.Jobs.items.push({ _id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", title: "Youth Pastor", "link-jobs-title": "/jobs/youth-pastor", "link-jobs-all": "/jobs/", jobDescription: "Lead the youth ministry." });
    cms.collections.Jobs.total = 1;
    // the Jobs (Item) template still lists no item pages on the published site
  }, { overrides: { "/jobs": { title: "Jobs (List)", text: "Current openings: Youth Pastor. Apply through the office with a cover letter and references.", headings: ["Youth Pastor"] } } });
  assert.equal(byPath(res, "/jobs/youth-pastor"), undefined, "no invented URL");
  const jobs = byPath(res, "/jobs");
  assert.ok(jobs, "the Jobs list page is indexed now that it has content and a record");
  assert.deepEqual(jobs.listingEntries.map((e) => e.title), ["Youth Pastor"]);
  assert.ok(jobs.tokens.includes("youth"));
  assert.equal(res.report.counts.recordsOnlyOnListingPages, 1);
});

test("a record the site does not render anywhere is counted as records_without_public_page", async () => {
  const res = await baseline((sc, cms) => {
    cms.collections.OurBeliefs.items.push({ _id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", beliefTitle: "ON ANGELS", "link-our-beliefs-beliefTitle": "", "link-our-beliefs-all": "/our-beliefs/", beliefDescription: "Unpublished draft text." });
    cms.collections.OurBeliefs.total = 10;
  });
  assert.equal(res.report.counts.recordsWithoutPublicPage, 1);
  assert.ok(!res.rec.docs.some((d) => /ANGELS/.test(d.title)));
});

test("a listed item page that returns 404 is an unresolved mapping, not a silent exclusion", async () => {
  const res = await baseline(undefined, { missing: ["/our-beliefs/on-communion"] });
  assert.equal(excluded(res, "/our-beliefs/on-communion").reason, "listed-but-404-conflict");
  assert.equal(res.report.counts.unresolvedMappings, 1);
});

test("duplicate URL (redirect to a known page) is consolidated", async () => {
  const api = cloneApi();
  const pages = fullSitePages(api._raw.sc, api._raw.cms, { "/old-kids": { title: "Old", text: "x" } });
  const client = siteClient({ pages, redirects: { "/old-kids": "/kids" } });
  const res = await run({ client, api, state: { index: { docs: [{ docId: "url:old", kind: "static", path: "/old-kids", url: "https://www.familychristiancentre.org/old-kids", title: "Old", section: "Site", description: "", headings: [], text: "x".repeat(60), tokens: [], contentHash: "h" }] } }, allowDrift: true });
  assert.equal(res.rec.docs.filter((d) => d.path === "/kids").length, 1);
  assert.equal(excluded(res, "/old-kids")?.reason, "redirect-to-known-page");
  assert.equal(res.report.counts.duplicatesConsolidated, 1);
});

test("an incomplete source (CMS pagination gap) makes the run incomplete and removes nothing", async () => {
  const first = await baseline();
  const res = await baseline((sc, cms) => { cms.collections.OurBeliefs.total = 50; /* returned 9 of 50 */ }, { missing: ["/our-beliefs/on-god"] }, { state: first.newState });
  assert.equal(res.rec.complete, false);
  assert.equal(res.rec.changes.removed.length, 0);
  assert.ok(res.rec.changes.unconfirmed.includes("cms:OurBeliefs:3a7236e1-5f57-4ab6-8c9e-f0a5ba4dab2c"));
  assert.equal(res.newState, null, "state is not advanced by an incomplete run");
});

test("publication gate: a valid index from an incomplete run is not publishable; a complete valid run is", async () => {
  const first = await baseline();
  assert.equal(first.publishable, true);
  const res = await baseline((sc, cms) => { cms.collections.Items.total = 40; /* 6 of 40 returned */ }, {}, { state: first.newState });
  assert.equal(res.validation.ok, true, "the carried index still validates");
  assert.equal(res.rec.complete, false);
  assert.equal(res.publishable, false, "generated files and passing validation are not enough");
  assert.equal(res.newState, null);
});

test("fetch gate: a first run that loses more than 10% of the listed pages is not publishable even with no previous index", async () => {
  const api = cloneApi();
  const all = fullSitePages(api._raw.sc, api._raw.cms);
  const keep = Object.fromEntries(Object.entries(all).filter(([p]) => !/^\/(alpha|bonita|books|care-ministry|christmas|connect|creatives|discipleship|easter|eurasia|giving|kids)$/.test(p)));
  const client = siteClient({ pages: keep });
  const res = await run({ client, api });
  assert.equal(res.rec.complete, false);
  assert.ok(res.rec.reasons.some((r) => /fetch gate/.test(r)), res.rec.reasons.join("; "));
  assert.equal(res.publishable, false);
  assert.ok(res.mapping.excluded.filter((e) => e.reason === "listed-but-404-conflict").length >= 12);
});

test("a network error during the crawl makes the run incomplete", async () => {
  const first = await baseline();
  const res = await baseline(undefined, { fail: ["/giving"] }, { state: first.newState });
  assert.equal(res.rec.complete, false);
  assert.equal(res.rec.changes.removed.length, 0);
  assert.ok(byPath(res, "/giving"), "the previous document is carried forward");
});

test("drift gate: a run that finds far fewer pages keeps the previous index", async () => {
  const first = await baseline();
  const api = cloneApi();
  const few = Object.fromEntries(Object.entries(fullSitePages(api._raw.sc, api._raw.cms)).slice(0, 20));
  const client = siteClient({ pages: few });
  const res = await run({ client, api, state: first.newState });
  assert.equal(res.rec.complete, false);
  assert.equal(res.rec.docs.length, first.rec.docs.length, "the previous documents are carried forward");
  assert.ok(res.rec.reasons.some((r) => /drift gate|fetch gate/.test(r)), "either gate may trip first; both refuse the run: " + res.rec.reasons.join("; "));
  assert.equal(res.publishable, false);
  assert.equal(res.newState, null, "state does not advance, so the next run starts from the last good index");
});

test("unchanged pages are served from the ETag cache on the second run", async () => {
  const first = await baseline();
  const api = cloneApi();
  const client = siteClient({ pages: fullSitePages(api._raw.sc, api._raw.cms) });
  const res = await run({ client, api, state: first.newState });
  assert.ok(client.stats.notModified > 60, `expected most pages 304, got ${client.stats.notModified}`);
  assert.equal(res.rec.changes.updated.length, 0);
  assert.equal(res.rec.changes.unchanged.length, first.rec.docs.length);
});

test("content change on a static page is detected as updated", async () => {
  const first = await baseline();
  const res = await baseline(undefined, { overrides: { "/giving": { title: "Giving", text: "Ways to give have changed: e-transfer, text to give, and a brand new online portal for recurring gifts." } } }, { state: first.newState });
  assert.deepEqual(res.rec.changes.updated, ["page:jrahy"]);
});

test("policy switch: excluding noindexed pages drops /vision", async () => {
  const { POLICY } = await import("../src/config.mjs");
  const saved = POLICY.includeNoindexPages; POLICY.includeNoindexPages = false;
  try { const res = await baseline(); assert.equal(byPath(res, "/vision"), undefined); assert.equal(excluded(res, "/vision").reason, "noindex"); }
  finally { POLICY.includeNoindexPages = saved; }
});

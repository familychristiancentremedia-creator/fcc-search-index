import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePage, boilerplateFilter, tokensOf, decodeEntities } from "../src/lib/html.mjs";
import { parseSitemapIndex, parseUrlset, normalizePath, recordIdFromItemPageId } from "../src/discover.mjs";
import { buildIndex, validateIndex } from "../src/build.mjs";
import { reconcile } from "../src/reconcile.mjs";
import { cleanTitle } from "../src/map.mjs";
import { createApi } from "../src/lib/api.mjs";
import { FIX, syntheticPage } from "./helpers.mjs";

const html = (name) => readFileSync(join(FIX, "html", name), "utf8");

test("parsePage: recorded Wix page yields title, text, headings and links; 404 page is detected", () => {
  const p = parsePage(html("on-god.html"), "https://www.familychristiancentre.org/our-beliefs/on-god");
  assert.match(p.title, /ON GOD/i);
  assert.ok(p.text.length > 500, "server-rendered text present");
  assert.ok(p.links.some((l) => /^(\/|https?:\/\/(www\.)?familychristiancentre\.org)/.test(l)), "internal links found (Wix renders absolute same-host hrefs)");
  assert.equal(p.isNotFound, false);
  const nf = parsePage(html("notfound.html"), "https://www.familychristiancentre.org/x");
  assert.equal(nf.isNotFound, true);
  const v = parsePage(html("vision.html"), "https://www.familychristiancentre.org/vision");
  assert.equal(v.robots, "noindex");
});

test("parsePage: the encoded-slash slug page parses and keeps its exact path", () => {
  const p = parsePage(html("leadership-legacy.html"), "https://www.familychristiancentre.org/items/leadership-legacy");
  assert.match(p.title, /LEADERSHIP LEGACY/i);
  assert.equal(normalizePath("https://www.familychristiancentre.org/items/fcc-mission%2Fvision-summary"), "/items/fcc-mission%2Fvision-summary");
});

test("boilerplateFilter removes blocks shared by more than 60% of pages", () => {
  const pages = [];
  for (let i = 0; i < 10; i++) pages.push(parsePage(syntheticPage({ title: `P${i}`, text: `Unique sentence number ${i} about a ministry at the church.` }), "https://www.familychristiancentre.org/p" + i));
  const bp = boilerplateFilter(pages, { share: 0.6, minPages: 5 });
  assert.ok([...bp.common].some((b) => /Dickins Drive/.test(b)), "shared address line is boilerplate");
  const kept = bp.apply(pages[3].blocks);
  assert.ok(kept.some((b) => /Unique sentence number 3/.test(b)));
  assert.ok(!kept.some((b) => /Dickins Drive/.test(b)));
});

test("sitemap parsing and path normalisation", () => {
  const idx = parseSitemapIndex(readFileSync(join(FIX, "sitemap", "sitemap.xml"), "utf8"));
  assert.equal(idx.length, 3);
  const rows = parseUrlset(readFileSync(join(FIX, "sitemap", "pages-sitemap.xml"), "utf8"));
  assert.equal(rows.length, 57);
  assert.ok(rows.every((r) => r.lastmod));
  assert.equal(normalizePath("https://www.familychristiancentre.org/home"), "/");
  assert.equal(normalizePath("https://familychristiancentre.org/kids/"), "/kids");
  assert.equal(normalizePath("https://example.com/kids"), null, "other hosts are ignored");
  assert.equal(normalizePath("/giving"), "/giving");
});

test("item page ids carry the CMS record id", () => {
  assert.equal(recordIdFromItemPageId("our-beliefs/{beliefTitle}_3a7236e1-5f57-4ab6-8c9e-f0a5ba4dab2c"), "3a7236e1-5f57-4ab6-8c9e-f0a5ba4dab2c");
  assert.equal(recordIdFromItemPageId("items/{title}_00000000-0000-0000-0000-000000000003"), "00000000-0000-0000-0000-000000000003");
  assert.equal(recordIdFromItemPageId("nonsense"), null);
});

test("Site Context pagination caps report incomplete results", async () => {
  const api = createApi({
    apiKey: "test-key",
    siteId: "test-site",
    fetchImpl: async () => ({
      ok: true,
      async text() {
        return JSON.stringify({ published: true, items: [], pagingMetadata: { hasNext: true, cursors: { next: "next-page" } } });
      }
    })
  });
  const statics = await api.listStaticPages();
  const itemPages = await api.listDynamicItemPages("/items", "template");
  assert.equal(statics.complete, false);
  assert.equal(itemPages.complete, false);
});

test("tokens, entities, titles", () => {
  assert.deepEqual(tokensOf("FCC Kids", "Kids ministry — for children"), ["fcc", "kids", "ministry", "for", "children"]);
  assert.equal(decodeEntities("Men&#39;s &amp; Women&rsquo;s"), "Men's & Women’s");
  assert.equal(cleanTitle("FCC Kids | Family Christian Centre"), "FCC Kids");
  assert.equal(cleanTitle("Family Christian Centre | Come As You Are | Fort Mcmurray"), "Come As You Are | Fort Mcmurray");
});

const doc = (id, path, extra = {}) => ({ docId: id, kind: "static", path, url: "https://www.familychristiancentre.org" + path, title: "T " + path, section: "Site", description: "d", headings: [], text: "x".repeat(60), tokens: ["t"], contentHash: "h-" + path, ...extra });

test("validateIndex: accepts a sane index, rejects excluded collections, stray e-mails, duplicates and drift", () => {
  const good = buildIndex([doc("page:a", "/a"), doc("page:b", "/b")]);
  assert.equal(validateIndex(good).ok, true);
  const bad = buildIndex([doc("cms:contact02:1", "/a"), doc("page:b", "/b", { text: "write to someone@example.com for details and more words here" }), doc("page:c", "/b")]);
  const v = validateIndex(bad);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /excluded collection contact02/.test(e)));
  assert.ok(v.warnings.some((e) => /e-mail address shown on/.test(e)), "addresses on public pages are listed for review, not errors");
  assert.ok(v.errors.some((e) => /duplicate url/.test(e)));
  const drift = validateIndex(good, { prevCount: 10 });
  assert.ok(drift.errors.some((e) => /below 80%/.test(e)));
  assert.equal(validateIndex(good, { prevCount: 10, allowDrift: true }).ok, true);
  assert.equal(validateIndex(buildIndex([doc("page:a", "/a", { text: "info@familychristiancentre.org is the office address and this is long enough" })])).ok, true, "site e-mails are allowed");
});

test("reconcile: incomplete runs remove nothing; removal needs two strikes; moves keep identity", () => {
  const prev = [doc("page:a", "/a"), doc("page:b", "/b"), doc("page:c", "/c")];
  const pages = new Map([["/a", { status: 200, finalPath: "/a" }], ["/b", { status: 404, isNotFound: true }], ["/c-new", { status: 200, finalPath: "/c-new" }]]);
  const cur = [doc("page:a", "/a"), doc("page:c", "/c-new")];
  const inc = reconcile({ prevDocs: prev, docs: cur, pages, complete: false });
  assert.equal(inc.docs.length, 3, "incomplete run keeps everything");
  assert.deepEqual(inc.changes.unconfirmed, ["page:b"]);
  const r1 = reconcile({ prevDocs: prev, docs: cur, pages, complete: true, allowDrift: true });
  assert.deepEqual(r1.changes.missing, ["page:b"]); assert.equal(r1.strikes["page:b"], 1); assert.equal(r1.docs.length, 3);
  assert.deepEqual(r1.changes.moved, ["/c -> /c-new"]);
  assert.deepEqual(r1.docs.find((d) => d.docId === "page:c").previousUrls, ["/c"]);
  const r2 = reconcile({ prevDocs: prev, docs: cur, pages, complete: true, strikes: r1.strikes, allowDrift: true });
  assert.deepEqual(r2.changes.removed, ["page:b"]); assert.equal(r2.docs.length, 2);
});

test("reconcile: the drift gate marks a shrunken run incomplete", () => {
  const prev = Array.from({ length: 10 }, (_, i) => doc("page:" + i, "/p" + i));
  const pages = new Map(prev.map((d) => [d.path, { status: 200, finalPath: d.path }]));
  const r = reconcile({ prevDocs: prev, docs: prev.slice(0, 5), pages, complete: true });
  assert.equal(r.complete, false); assert.equal(r.docs.length, 10); assert.equal(r.changes.removed.length, 0);
});

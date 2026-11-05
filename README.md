# fcc-search-index

Automated full-site search index for **familychristiancentre.org**, feeding the Concept 6 header's in-browser search (route A: a built-in index, fetched only when a visitor opens Search; queries never leave the browser).

**Phase 1 (this repository today): read-only.** It discovers pages, maps CMS records to real public URLs, extracts text, reconciles against the previous run, builds and validates the index, and writes a report. It **never publishes**: nothing is uploaded, no site is republished, no Wix setting is touched. Scheduling, publishing to GitHub Pages and the Concept 6 integration are later phases (see the planning package: `FCC-search-indexing-architecture-2026-11-04.md` in the FCC SITE TINGs folder, `review-output/search-index/`).

## Run it

Node 22 or newer (developed on 24). No dependencies, no headless browser.

```bash
npm test                                   # 28 unit and pipeline tests on recorded fixtures (offline)
node src/index.mjs --from-fixtures fixtures  # offline smoke run on the recorded sitemap, API responses and 8 recorded pages
node src/index.mjs --dry-run               # live site: one request at a time, 400 ms apart, conditional GETs; writes out/dry-run/
```

Options: `--out <dir>` (artifacts), `--state <file>` (previous run; default `<out>/state.json`), `--allow-drift` (accept a big change in page count), `--depth <n>` (link-crawl depth, default 2), `--quiet`.

Artifacts in `out/<run>/`: `index-<version>.json` (the index), `manifest.json` (the pointer the panel will revalidate), `documents.json` (full internal records with evidence), `report.json` and `REPORT.md` (the reconciliation report), `run.json` (the publication gate: `publishable` is true only when the content run is complete **and** the index validates; a passing validation on an incomplete run is not publishable), `state.json` (ETags, content hashes, strikes; written only after a publishable run) or `state.rejected.json`. The process exits 0 only for a publishable run.

### What the API key adds

Without `WIX_API_KEY` the run uses the public sitemap, the server-rendered HTML and a two-level internal link crawl. That already covers every public page on the site today (72 sitemap URLs plus the noindexed `/vision` page), with URL-based identities. With an API key:

```bash
WIX_API_KEY=...   WIX_SITE_ID=8c234506-96ea-4329-a68e-98184058db48   node src/index.mjs --dry-run
```

CMS records are read and cross-checked: item pages get the identity `cms:<collection>:<itemId>` (stable across slug changes), a record without a published page can be attached to its listing page or reported, and a listed page that 404s is flagged as an unresolved mapping. This needs the Data Items read scope ("Read Data Items"; in the API-key screen the box is **Wix Data**, which Wix only offers as read-and-manage).

The Site Context API is a second, **opt-in** source (`WIX_SITE_CONTEXT=1`). It lists static pages, dynamic templates and the published item pages (the authoritative record-to-URL map), and static pages then get the identity `page:<id>` instead of `url:<hash>`. It needs the scope "Read Site Context for Rich Content" (`SCOPE.DC-RICOS.READ-SITE-CONTEXT`); on 5 November 2026 no box in the API-key screen was found to carry it (**Ricos Documents** does not), so live runs leave it off. The switch is deliberate: the source is either on and required for a complete run, or off and never consulted, so a key that sometimes can and sometimes can't answer never flips static-page identities between runs.

Never commit the key; GitHub Actions secrets hold it (`WIX_API_KEY`, `WIX_SITE_ID`), and the manual **Dry run** workflow reads them.

## How it works

`src/config.mjs` holds the site facts and the policy decided on 4 November 2026 (balanced: include noindexed-but-public pages, exclude empty list pages, include validated orphans, no PDFs; the only content collections are OurBeliefs, Items, Jobs, Services; everything else in the CMS is excluded before any rule runs).

1. `discover.mjs`: sitemap index and sub-sitemaps; Site Context lists; CMS items (reports an incomplete run on any pagination gap).
2. `map.mjs`: candidates from all sources, authority order Site Context item pages > CMS link fields > sitemap > link crawl; never builds a URL from a title. After fetching: 404 and Wix-404-page detection, redirect consolidation, policy rules, stable identities, listing-page attachment for records without pages.
3. `extract.mjs`: conditional GET with the previous ETag (Wix answers 304), parse of the server-rendered HTML (`#PAGES_CONTAINER` text, title, description, headings, links), link crawl, boilerplate removal (blocks on more than 60% of pages).
4. `reconcile.mjs`: incomplete runs remove nothing; a page is removed only after two consecutive complete runs in which it is dead; a run that shrinks below 80% of the previous count is incomplete. Before that, the fetch gate in `index.mjs` makes a run incomplete when fewer than 90% of the pages the sources list come back as real pages; a page that answers 200 with Wix's own "404 Error: Page Not Found" page (a soft 404) counts as lost, not fetched.
5. `build.mjs`: versioned index + manifest; validation (schema, identities, excluded collections, stray e-mail addresses, size budget, drift).
6. `report.mjs`: the reconciliation counts and changes, as JSON and Markdown.

## Fixtures

`fixtures/sitemap/` is the site's sitemap on 4 November 2026; `fixtures/api/` the Site Context and CMS responses (read-only recordings); `fixtures/html/` nine recorded pages including a 404. Tests build synthetic pages for the rest of the site from those recordings and mutate them per scenario (new item, renamed slug, removed item, record without a page, listed-but-404, soft 404, redirect duplicate, pagination gap, network error, drift gate, ETag cache, content change, policy switch).

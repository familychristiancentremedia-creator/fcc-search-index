// Site facts and policy for familychristiancentre.org. Decisions recorded 4 November 2026
// (see the planning package, section I). Change policy here, not in the pipeline.
export const SITE = {
  host: "www.familychristiancentre.org",
  origin: "https://www.familychristiancentre.org",
  siteId: process.env.WIX_SITE_ID || "8c234506-96ea-4329-a68e-98184058db48",
  userAgent: "fcc-search-index/0.1 (+https://github.com/familychristiancentremedia-creator; read-only indexer; stephenvturner@gmail.com)",
  delayMs: 400
};

// The only collections that may ever produce or feed documents. Everything else in the CMS
// (form submissions, members, locations, coupons, the abandoned events calendar) is excluded
// by this list before any other rule runs.
// listPath / itemPrefix: the published URL structure recorded on 4 November 2026, used only when the
// Site Context API is unavailable (no API key) to classify sitemap URLs. With the API, the live lists win.
export const CONTENT_COLLECTIONS = {
  OurBeliefs: { titleField: "beliefTitle", textFields: ["beliefDescription", "referenceScripture"], itemLink: "link-our-beliefs-beliefTitle", listLink: "link-our-beliefs-all", section: "Our Beliefs", templateTitle: "Our Beliefs (Item)", listPath: "/our-beliefs", itemPrefix: "/our-beliefs/" },
  Items: { titleField: "title", textFields: ["itemPageText"], itemLink: "link-items-title", listLink: "link-items-all", section: "Vision Map", templateTitle: "Vision Items", listPath: "/vision", itemPrefix: "/items/" },
  Jobs: { titleField: "title", textFields: ["jobDescription", "aboutUs", "jobType", "location"], itemLink: "link-jobs-title", listLink: "link-jobs-all", section: "Jobs", templateTitle: "Jobs (Item)", listPath: "/jobs", itemPrefix: "/jobs/" },
  Services: { titleField: "title", textFields: ["serviceDescription", "duration", "price"], itemLink: "link-services-title", listLink: "link-services-all", section: "Services", templateTitle: "Services (Item)", listPath: "/services", itemPrefix: "/services/" }
};

export const POLICY = {
  // "balanced": include noindexed-but-public pages, exclude empty list pages, include validated orphans, no PDFs.
  includeNoindexPages: true,
  includeOrphanPages: true,
  excludeThinListPages: true,
  minTextChars: 40,
  thinAllowList: [],                 // paths allowed to be thin (none today)
  indexPdfs: false,
  listingEntryRetentionDays: 7,      // records without pages, attached to a listing page, dropped this long after their date
  boilerplateShare: 0.6,             // a text block on more than this share of pages is boilerplate
  boilerplateMinPages: 5,
  removalStrikes: 2,                 // complete runs a missing page must fail before removal
  driftFloor: 0.8,                   // a run with fewer than this share of the previous doc count is incomplete
  fetchFloor: 0.9,                   // a run in which fewer than this share of the listed (sitemap/Site Context) pages return a real page (200, not a soft 404) is incomplete
  excerptChars: 1500,
  maxTokens: 400,
  sizeBudgetBytes: 300 * 1024,
  crawlDepth: 2,
  // Site e-mail addresses that may legitimately appear in page text; any other address found in a document fails validation.
  allowedEmails: ["info@familychristiancentre.org", "giving@familychristiancentre.org"]
};

// URL paths that are never candidates (Wix system paths, assets, lightbox query links, member areas).
export const SKIP_PATH = /\.(pdf|jpe?g|png|gif|svg|webp|mp4|mp3|zip|ics|xml|txt)$|^\/(_api|_partials|_functions|account|members|profile|blank-|wix-|_serverless)/i;

export function sectionFor(path) {
  if (path.startsWith("/our-beliefs")) return "Our Beliefs";
  if (path.startsWith("/items") || path === "/vision") return "Vision Map";
  if (path.startsWith("/jobs")) return "Jobs";
  if (path.startsWith("/services")) return "Services";
  return "Site";
}

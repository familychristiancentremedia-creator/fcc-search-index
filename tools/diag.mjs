import * as h from "../test/helpers.mjs";
import { runPipeline } from "../src/index.mjs";
const api = h.cloneApi(); const client = h.siteClient({ pages: h.fullSitePages(api._raw.sc, api._raw.cms) });
const res = await runPipeline({ client, api, log: () => {} });
console.log("docs", res.rec.docs.length, "candidates", res.candidates.size, "pages", res.pages.size);
console.log("excluded:", res.mapping.excluded.map(e => (e.path || e.recordId) + ":" + e.reason).join(" | "));
const kinds = {}; for (const c of res.candidates.values()) kinds[c.kind] = (kinds[c.kind] || 0) + 1; console.log(kinds);
console.log("list cands:", [...res.candidates.values()].filter(c => c.kind === "list").map(c => c.path + "/" + c.collection));

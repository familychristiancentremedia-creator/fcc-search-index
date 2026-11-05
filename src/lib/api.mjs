// Wix REST access for discovery (read-only): Site Context (static pages, dynamic templates, item pages)
// and Data Items (CMS records). Endpoints verified against the Wix API reference on 4 November 2026:
//   POST https://www.wixapis.com/ricos/v1/site-context/static-pages/list
//   POST https://www.wixapis.com/ricos/v1/site-context/dynamic-pages/list
//   POST https://www.wixapis.com/ricos/v1/site-context/dynamic-item-pages/list   { prefix, pageId, paging }
//   POST https://www.wixapis.com/wix-data/v2/items/query                        { dataCollectionId, query, returnTotalCount }
// Authentication: an account API key in `Authorization` plus `wix-site-id` (Wix docs, "Make REST API calls with an API key").
// A fixture mode reads recorded responses from fixtures/api for tests and offline runs.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function createApi({ apiKey, siteId, fetchImpl = fetch, log = () => {} }) {
  if (!apiKey || !siteId) return null;
  const headers = { Authorization: apiKey, "wix-site-id": siteId, "Content-Type": "application/json" };
  async function post(url, body) {
    const res = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) throw new Error(`${url} -> ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  }
  return {
    kind: "live",
    async listStaticPages() {
      const items = []; let cursor; let published; let complete = true;
      for (let i = 0; i < 20; i++) {
        const body = { paging: { limit: 100, ...(cursor ? { cursor } : {}) } };
        const r = await post("https://www.wixapis.com/ricos/v1/site-context/static-pages/list", body);
        published = r.published; items.push(...(r.items || []));
        const hasNext = !!r.pagingMetadata?.hasNext;
        cursor = r.pagingMetadata?.cursors?.next;
        if (!hasNext) break;
        if (!cursor) { complete = false; break; }
        if (i === 19) complete = false;
      }
      return { published, items, complete };
    },
    async listDynamicPages() { const r = await post("https://www.wixapis.com/ricos/v1/site-context/dynamic-pages/list", {}); return { published: r.published, items: r.items || [] }; },
    async listDynamicItemPages(prefix, pageId) {
      const items = []; let cursor; let published; let complete = true;
      for (let i = 0; i < 40; i++) {
        const body = { prefix, pageId, paging: { limit: 50, ...(cursor ? { cursor } : {}) } };
        const r = await post("https://www.wixapis.com/ricos/v1/site-context/dynamic-item-pages/list", body);
        published = r.published; items.push(...(r.items || []));
        const hasNext = !!r.pagingMetadata?.hasNext;
        cursor = r.pagingMetadata?.cursors?.next;
        if (!hasNext) break;
        if (!cursor) { complete = false; break; }
        if (i === 39) complete = false;
      }
      return { published, items, complete };
    },
    async queryItems(collectionId) {
      const items = []; let offset = 0; let total = null;
      for (let i = 0; i < 100; i++) {
        const r = await post("https://www.wixapis.com/wix-data/v2/items/query", { dataCollectionId: collectionId, query: { paging: { limit: 1000, offset }, sort: [{ fieldName: "_updatedDate", order: "DESC" }] }, returnTotalCount: true });
        const page = r.dataItems || []; items.push(...page.map((d) => ({ _id: d.id, ...(d.data || {}) })));
        total = r.pagingMetadata?.total ?? total; offset += page.length;
        if (!page.length || (total != null && offset >= total)) break;
      }
      return { total: total ?? items.length, items };
    }
  };
}

export function fixtureApi(dir) {
  const sc = JSON.parse(readFileSync(join(dir, "api", "site-context.json"), "utf8"));
  const cms = JSON.parse(readFileSync(join(dir, "api", "cms-items.json"), "utf8"));
  return {
    kind: "fixture",
    async listStaticPages() { return sc.staticPages; },
    async listDynamicPages() { return sc.dynamicPages; },
    async listDynamicItemPages(prefix, pageId) { return sc.dynamicItemPages[pageId] || { published: true, items: [] }; },
    async queryItems(collectionId) { const c = cms.collections[collectionId]; return c ? { total: c.total ?? c.items.length, items: c.items } : { total: 0, items: [] }; },
    _raw: { sc, cms }
  };
}

// Wix date values arrive as {"$date": "..."} or ISO strings.
export function wixDate(v) { if (!v) return null; if (typeof v === "string") return v; if (typeof v === "object" && v.$date) return v.$date; return null; }

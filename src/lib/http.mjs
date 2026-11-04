// Throttled, read-only HTTP client with conditional requests (If-None-Match).
// One request at a time, a fixed pause between requests, a descriptive User-Agent.
// A fixture client serves recorded pages from disk for tests and offline runs.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createClient({ userAgent, delayMs = 400, timeoutMs = 30000, log = () => {} } = {}) {
  let chain = Promise.resolve();
  let last = 0;
  const stats = { requests: 0, notModified: 0, errors: 0 };

  async function doGet(url, { etag } = {}) {
    const wait = Math.max(0, last + delayMs - Date.now());
    if (wait) await sleep(wait);
    last = Date.now();
    const headers = { "User-Agent": userAgent, Accept: "text/html,application/xml;q=0.9,*/*;q=0.8" };
    if (etag) headers["If-None-Match"] = etag;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      stats.requests++;
      const res = await fetch(url, { headers, redirect: "follow", signal: ctrl.signal });
      const out = { url, status: res.status, finalUrl: res.url || url, etag: res.headers.get("etag"), contentType: res.headers.get("content-type") || "", body: "", notModified: res.status === 304 };
      if (res.status === 304) { stats.notModified++; return out; }
      out.body = await res.text();
      return out;
    } catch (e) {
      stats.errors++;
      return { url, status: null, finalUrl: url, etag: null, contentType: "", body: "", error: String(e && e.message || e) };
    } finally { clearTimeout(timer); }
  }

  return {
    stats,
    get(url, opts) { const p = chain.then(() => doGet(url, opts)); chain = p.catch(() => {}); return p; }
  };
}

// Serves fixtures: `map` is { "<absolute url>": "<file path>" } and/or a function(url) -> file path | {status}.
export function fixtureClient(map, { missingStatus = 404 } = {}) {
  const stats = { requests: 0, notModified: 0, errors: 0 };
  return {
    stats,
    async get(url, { etag } = {}) {
      stats.requests++;
      let target = typeof map === "function" ? map(url) : map[url];
      if (target && typeof target === "object") return { url, finalUrl: target.finalUrl || url, status: target.status ?? 200, etag: target.etag || null, contentType: target.contentType || "text/html", body: target.body || "", notModified: false };
      if (!target || !existsSync(target)) return { url, finalUrl: url, status: missingStatus, etag: null, contentType: "text/html", body: missingStatus === 404 ? NOT_FOUND_BODY : "", notModified: false };
      const body = readFileSync(target, "utf8");
      const tag = `W/"fx-${simpleHash(body)}"`;
      if (etag && etag === tag) { stats.notModified++; return { url, finalUrl: url, status: 304, etag: tag, contentType: "text/html", body: "", notModified: true }; }
      return { url, finalUrl: url, status: 200, etag: tag, contentType: "text/html; charset=utf-8", body, notModified: false };
    }
  };
}

export function simpleHash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h.toString(16); }

export const NOT_FOUND_BODY = `<html><head><title>404 Error: Page Not Found</title></head><body><div id="PAGES_CONTAINER">Page not found</div></body></html>`;

export function fixtureDirClient(dir, origin, fileMap) {
  // fileMap: { "/path": "name.html" }
  return fixtureClient((url) => {
    const u = new URL(url);
    const key = u.pathname === "/home" ? "/" : u.pathname;
    const name = fileMap[key];
    return name ? join(dir, name) : null;
  });
}

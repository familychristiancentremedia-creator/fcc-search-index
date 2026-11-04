// Reconciliation against the previous published index. Safeguards (planning package, C.6):
//   - an incomplete run (a source failed, or the drift gate tripped) removes nothing;
//   - a previously indexed page is removed only after `removalStrikes` consecutive complete runs
//     in which its URL is dead (404, Wix 404 page, redirect off the site) or excluded by policy;
//   - a page merely missing from a source listing but still alive is kept and flagged "unlisted".
import { POLICY } from "./config.mjs";

export function reconcile({ prevDocs = [], docs, pages, complete, strikes = {}, policy = POLICY, allowDrift = false }) {
  const prevById = new Map(prevDocs.map((d) => [d.docId, d]));
  const curById = new Map(docs.map((d) => [d.docId, d]));
  const changes = { new: [], updated: [], moved: [], unchanged: [], removed: [], missing: [], unconfirmed: [], unlisted: [] };
  const reasons = [];
  let runComplete = !!complete;
  if (runComplete && prevDocs.length && docs.length < policy.driftFloor * prevDocs.length && !allowDrift) {
    runComplete = false; reasons.push(`drift gate: ${docs.length} documents vs ${prevDocs.length} previously (floor ${Math.round(policy.driftFloor * 100)}%)`);
  }
  const nextStrikes = {};
  const finalDocs = [];
  for (const d of docs) {
    const prev = prevById.get(d.docId);
    const out = { ...d, previousUrls: prev?.previousUrls ? [...prev.previousUrls] : [] };
    if (!prev) changes.new.push(d.docId);
    else {
      if (prev.path !== d.path) { changes.moved.push(`${prev.path} -> ${d.path}`); if (!out.previousUrls.includes(prev.path)) out.previousUrls.push(prev.path); }
      if (prev.contentHash !== d.contentHash) changes.updated.push(d.docId); else changes.unchanged.push(d.docId);
    }
    finalDocs.push(out);
  }
  for (const prev of prevDocs) {
    if (curById.has(prev.docId)) continue;
    const page = pages.get(prev.path);
    const dead = page && (page.status === 404 || page.isNotFound || (page.status === 200 && page.finalPath && !page.finalPath.startsWith("/")) || (page.status >= 400 && page.status < 500));
    if (!runComplete) { changes.unconfirmed.push(prev.docId); finalDocs.push({ ...prev, carried: "unconfirmed" }); continue; }
    const excludedByPolicy = page && page.status === 200 && !dead; // alive but not produced this run
    const n = (strikes[prev.docId] || 0) + 1;
    if (dead || excludedByPolicy) {
      if (n >= policy.removalStrikes) { changes.removed.push(prev.docId); }
      else { nextStrikes[prev.docId] = n; changes.missing.push(prev.docId); finalDocs.push({ ...prev, carried: dead ? "missing" : "excluded-pending" }); }
    } else { // not fetched at all this run (should not happen: prev URLs are always fetched), keep
      changes.unlisted.push(prev.docId); finalDocs.push({ ...prev, carried: "unlisted" });
    }
  }
  finalDocs.sort((a, b) => a.path.localeCompare(b.path));
  return { docs: finalDocs, changes, complete: runComplete, reasons, strikes: nextStrikes };
}

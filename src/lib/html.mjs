// Text extraction from Wix server-rendered HTML. Verified on 4 November 2026 that the SSR HTML of
// every tested page contains the same visible text a browser renders, so no headless browser is used.
import { createHash } from "node:crypto";

const BLOCK_TAGS = /^(p|div|section|article|header|footer|nav|main|ul|ol|li|h[1-6]|br|tr|td|th|table|blockquote|pre|figure|figcaption|hr|address|dd|dt|dl|form|fieldset|legend)$/i;

export function decodeEntities(s) {
  return s.replace(/&(#x([0-9a-f]+)|#(\d+)|amp|lt|gt|quot|apos|nbsp|rsquo|lsquo|rdquo|ldquo|hellip|ndash|mdash);/gi, (m, _, hex, dec, ..._rest) => {
    const name = m.slice(1, -1).toLowerCase();
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    if (dec) return String.fromCodePoint(parseInt(dec, 10));
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…", ndash: "–", mdash: "—" }[name] ?? m;
  });
}

function stripInvisible(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<template\b[^>]*>[\s\S]*?<\/template>/gi, " ")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
}

// Returns the inner HTML of the first element with the given id (depth-aware for the element's own tag).
function innerOfId(html, id) {
  const open = new RegExp(`<([a-z0-9]+)\\b[^>]*\\bid="${id}"[^>]*>`, "i").exec(html);
  if (!open) return null;
  const tag = open[1].toLowerCase();
  let depth = 1, i = open.index + open[0].length;
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi"); re.lastIndex = i;
  let m;
  while ((m = re.exec(html))) { depth += m[1] ? -1 : 1; if (depth === 0) return html.slice(i, m.index); }
  return html.slice(i);
}

function textWithBlocks(fragment) {
  const out = [];
  let i = 0;
  const re = /<\/?([a-z0-9]+)\b[^>]*>/gi;
  let m, lastIndex = 0;
  while ((m = re.exec(fragment))) {
    out.push(fragment.slice(lastIndex, m.index));
    if (BLOCK_TAGS.test(m[1])) out.push("\n");
    else out.push(" ");
    lastIndex = m.index + m[0].length;
  }
  out.push(fragment.slice(lastIndex));
  return decodeEntities(out.join(""));
}

export function blocksOf(text) {
  return text.split("\n").map((l) => l.replace(/[\s​ ]+/g, " ").trim()).filter((l) => l.length >= 12);
}

function attr(tagHtml, name) { const m = new RegExp(`\\b${name}=("([^"]*)"|'([^']*)')`, "i").exec(tagHtml); return m ? decodeEntities(m[2] ?? m[3] ?? "") : null; }
function metaContent(head, nameOrProp) {
  const re = /<meta\b[^>]*>/gi; let m;
  while ((m = re.exec(head))) { const t = m[0]; const n = attr(t, "name") || attr(t, "property"); if (n && n.toLowerCase() === nameOrProp) return attr(t, "content"); }
  return null;
}

export function parsePage(html, pageUrl) {
  const head = html.slice(0, 300000);
  const titleM = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head);
  const canonM = /<link\b[^>]*\brel="canonical"[^>]*>/i.exec(head);
  const clean = stripInvisible(html);
  const mainHtml = innerOfId(clean, "PAGES_CONTAINER") ?? innerOfId(clean, "SITE_PAGES") ?? (/<body[^>]*>([\s\S]*)<\/body>/i.exec(clean) || [, clean])[1];
  const headings = [];
  const hre = /<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi; let hm;
  while ((hm = hre.exec(mainHtml))) { const t = decodeEntities(hm[2].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim(); if (t) headings.push(t); }
  const rawText = textWithBlocks(mainHtml);
  const blocks = blocksOf(rawText);
  const text = rawText.replace(/[\s​ ]+/g, " ").trim();
  const links = new Set();
  const are = /<a\b[^>]*\bhref=("([^"]*)"|'([^']*)')/gi; let am;
  while ((am = are.exec(clean))) { const h = decodeEntities(am[2] ?? am[3] ?? ""); if (h && !h.startsWith("#") && !/^(mailto|tel|sms|javascript):/i.test(h)) links.add(h); }
  const title = titleM ? decodeEntities(titleM[1].replace(/\s+/g, " ")).trim() : null;
  const isNotFound = /^404\b/.test(title || "") || /404 Error: Page Not Found/i.test(title || "");
  const isGate = /wix-login|members-area-login|password-protected|<input[^>]+type="password"/i.test(clean.slice(0, 400000)) && text.length < 400;
  return {
    url: pageUrl, title, description: metaContent(head, "description"), robots: (metaContent(head, "robots") || "").toLowerCase() || null,
    canonical: canonM ? attr(canonM[0], "href") : null, headings, blocks, text, links: [...links], isNotFound, isGate,
    contentHash: sha1(text)
  };
}

export function sha1(s) { return createHash("sha1").update(s).digest("hex"); }

// Remove blocks that appear on more than `share` of pages (site chrome rendered into every page).
export function boilerplateFilter(pages, { share = 0.6, minPages = 5 } = {}) {
  const n = pages.length;
  if (n < minPages) return { common: new Set(), apply: (blocks) => blocks };
  const counts = new Map();
  for (const p of pages) for (const b of new Set(p.blocks)) counts.set(b, (counts.get(b) || 0) + 1);
  const common = new Set([...counts].filter(([, c]) => c / n > share).map(([b]) => b));
  return { common, apply: (blocks) => blocks.filter((b) => !common.has(b)) };
}

export function tokensOf(...parts) {
  const seen = new Set(); const out = [];
  for (const part of parts) for (const w of String(part || "").toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []) {
    const t = w.replace(/^['’-]+|['’-]+$/g, ""); if (t.length < 2 || seen.has(t)) continue; seen.add(t); out.push(t);
  }
  return out;
}

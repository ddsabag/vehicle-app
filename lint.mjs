#!/usr/bin/env node
// Compliance lint for a לוחית weekly content kit. No npm dependencies.
//   node lint.mjs <kit-folder> --repo <vehicle-app checkout> [--config lint-config.json] [--json] [--allow-stale-checkout]
//   node lint.mjs --selftest
// Scans every file in the kit (skips node_modules/, vendor/, .git/): markdown, text and subtitle files, YAML/CSV, JSON (every string),
// HTML/SVG/XML (visible text, alt/title, every attribute value, <style> incl. CSS content:, <script> strings, data: URIs, bidi
// overrides, block tags styled inline), JS/Python (string literals). Binary files are checked by name and hash (banned asset).
// Enforces lint-config.json, re-reads every fact in facts.json from its source in the checkout and checks every number in the copy
// against the facts (value, unit, model, topic, direction, approximation and history).
// Exit 0 = clean, 1 = violations (never deliver the kit), 2 = usage error.
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { variants, findTerm, lineOf, snippet, normalize, termLabel, fixFinals, foldDigits, INVISIBLE, PREFIX } from "./lib/hebrew.mjs";
import { verifyFact, checkFact, numbersIn, parseNum, repoHead, isAncestor, directionOf } from "./lib/facts.mjs";

const HERE = path.dirname(fs.realpathSync(url.fileURLToPath(import.meta.url)));
const rx = (src, flags = "giu") => new RegExp(fixFinals(src).replace(/\{P\}/g, PREFIX), flags);
const blankStr = s => s.replace(/[^\n]/g, " ");
const blankRange = (t, a, b) => t.slice(0, a) + blankStr(t.slice(a, b)) + t.slice(b);
const HEB_RE = /[\u05D0-\u05EA]/;

// ---------- text extraction ----------
const INLINE = new Set(["b", "i", "u", "em", "strong", "span", "mark", "small", "sup", "sub", "bdi", "bdo", "a", "s", "q", "abbr", "code", "font", "wbr",
  "tspan", "textpath", "label", "time", "data", "var", "kbd", "samp", "cite", "dfn", "ins", "del", "ruby", "rb", "rt", "rp", "rtc", "nobr", "big", "tt",
  "strike", "output", "acronym", "blink", "span"]);
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const INLINE_STYLE = /display\s*:\s*(?:inline|inline-block|inline-flex|inline-grid|inline-table|contents|ruby)\b/i;
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", shy: "\u00AD", lrm: "\u200E", rlm: "\u200F", zwj: "\u200D", zwnj: "\u200C",
  zerowidthspace: "\u200B", negativeverythinspace: "\u200B", negativethinspace: "\u200B", negativemediumspace: "\u200B", negativethickspace: "\u200B",
  invisibletimes: "\u2062", invisiblecomma: "\u2063", it: "\u2062", ic: "\u2063", af: "\u2061", applyfunction: "\u2061", nobreak: "\u2060", wj: "\u2060",
  ensp: " ", emsp: " ", emsp13: " ", emsp14: " ", thinsp: " ", thinspace: " ", hairsp: " ", veryverythinspace: " ", verythinspace: " ", numsp: " ", puncsp: " ", mediumspace: " ",
  newline: "\n", tab: "\t", colon: ":", period: ".", comma: ",", excl: "!", quest: "?", num: "#", percnt: "%", sol: "/", hyphen: "\u2010", dash: "\u2010", ndash: "\u2013", mdash: "\u2014",
  minus: "\u2212", lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201C", rdquo: "\u201D", sbquo: "\u201A", bdquo: "\u201E", laquo: "«", raquo: "»", hellip: "…", middot: "·", bull: "•",
  lpar: "(", rpar: ")", lsqb: "[", rsqb: "]", ast: "*", plus: "+", equals: "=", semi: ";", lowbar: "_", grave: "`", shekel: "₪" };
const ENT_RE = /&(?:#[xX]([0-9a-fA-F]+);?|#(\d+);?|([a-zA-Z][a-zA-Z0-9]*);)/g;
const entChar = (m, hex, dec, name) => {
  if (hex !== undefined || dec !== undefined) { const cp = hex !== undefined ? parseInt(hex, 16) : Number(dec); return cp > 0 && cp <= 0x10FFFF ? String.fromCodePoint(cp) : "\uFFFD"; }
  return ENT[name.toLowerCase()] ?? null;
};
export const decodeEntities = s => String(s).replace(ENT_RE, (m, h, d, n) => entChar(m, h, d, n) ?? m);

// Same-length replacement so offsets (and line numbers) stay valid: block tags -> spaces, inline tags (and block tags styled
// display:inline) -> zero-width (removed by the normaliser, so "ס<b>ו</b>חר" and "מצי<wbr>אה" read as one word), style/script/comments
// -> spaces. alt/title/aria-label text is kept in place. joinAll: every tag -> zero-width (a second reading for text split across blocks).
export function htmlToText(html, { joinAll = false } = {}) {
  const pad = (s, ch) => s.replace(/[^\n]/g, ch);
  let t = html.replace(/<!--[\s\S]*?-->/g, m => pad(m, " "))
    .replace(/<(style|script)\b[\s\S]*?<\/\1\s*>/gi, m => pad(m, " "));
  const stack = new Map();
  t = t.replace(/<\/?([a-zA-Z][\w:-]*)\b(?:"[^"]*"|'[^']*'|[^'">])*>/g, (m, name) => {
    name = name.toLowerCase();
    let inline = INLINE.has(name);
    if (m[1] !== "/") {
      const st = m.match(/\bstyle\s*=\s*("[^"]*"|'[^']*')/i);
      const inl = !!(st && INLINE_STYLE.test(decodeEntities(st[1])));
      if (!VOID.has(name) && !/\/>$/.test(m)) { if (!stack.has(name)) stack.set(name, []); stack.get(name).push(inl); }
      if (inl) inline = true;
    } else { const s = stack.get(name); if (s && s.length && s.pop()) inline = true; }
    if (joinAll) inline = true;
    const keep = [...m.matchAll(/\b(?:alt|title|aria-label)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)].map(x => decodeEntities(x[1] ?? x[2])).join(" ");
    if (keep) { const s = " " + keep + " "; return s.length <= m.length ? s + pad(m.slice(s.length), " ") : pad(m, " "); }
    // a block element (div, p, td, li, h1...) ends a sentence for the number context (U+2029): a compare row "רכבים פעילים 191,431" is not
    // read together with the next row "ריקולים 3.9"; <br> is only a space
    return inline ? pad(m, "\u200B") : name === "br" ? pad(m, " ") : "\u2029" + pad(m.slice(1), " ");
  });
  t = t.replace(ENT_RE, (m, h, d, n) => {
    const c = entChar(m, h, d, n);
    return c !== null && c.length <= m.length ? c + "\u200B".repeat(m.length - c.length) : m;
  });
  return t;
}
// CSS escapes ("\5DE\5E6 " -> "מצ"). The whitespace that ends a hex escape is kept as a space, so words glued by escapes still read apart.
const cssUnescape = s => String(s).replace(/\\([0-9a-fA-F]{1,6})([ \t\n]?)|\\(.)/g, (m, h, sp, c) => h ? (() => { const cp = parseInt(h, 16); return (cp > 0 && cp <= 0x10FFFF ? String.fromCodePoint(cp) : "\uFFFD") + (sp ? " " : ""); })() : c);
const jsUnescape = s => String(s).replace(/\\u\{([0-9a-fA-F]+)\}|\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})|\\N\{[^}]*\}/g, (m, a, b, c) => { const cp = parseInt(a ?? b ?? c ?? "FFFD", 16); return cp <= 0x10FFFF ? String.fromCodePoint(cp) : m; });
// JS / Python string literals: [{start, text}]
function stringLiterals(src) {
  const out = [];
  const re = /("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\[\s\S]|[^"\\\n])*"|'(?:\\[\s\S]|[^'\\\n])*'|`(?:\\[\s\S]|[^`\\])*`)/g;
  for (const m of src.matchAll(re)) { const q = m[0].startsWith('"""') || m[0].startsWith("'''") ? 3 : 1; out.push({ start: m.index, text: jsUnescape(m[0].slice(q, -q)) }); }
  return out;
}
function decodeDataUri(u) {
  const m = String(u).match(/^data:([^,;]*)((?:;[^,;]*)*),([\s\S]*)$/i);
  if (!m) return null;
  let body = m[3];
  try { body = /;base64/i.test(m[2]) ? Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8") : decodeURIComponentSafe(body); } catch { return null; }
  return { mime: (m[1] || "text/plain").toLowerCase(), body };
}
function decodeURIComponentSafe(s) { return s.replace(/(?:%[0-9a-fA-F]{2})+/g, m => { try { return decodeURIComponent(m); } catch { return m; } }); }

// Hidden or generated text in an HTML/SVG file: [{offset, text, kind, numbers}] (numbers = also checked against facts.json)
const NUMERIC_ATTRS = /^(?:data-(?!nonum$|start$|end$|duration$|media-start$|track-index$|layer$|z$|x$|y$|w$|h$|fps$|delay$|ease$|id$)[\w-]+|value|placeholder|content|label|summary|abbr|alt|title|aria-label|aria-description)$/i;
const GEOMETRY_ATTRS = /^(?:d|points|viewbox|transform|x|y|x1|x2|y1|y2|dx|dy|cx|cy|r|rx|ry|width|height|offset|stop-color|fill|stroke|stroke-[\w-]+|opacity|fill-opacity|font-size|font-family|font-weight|letter-spacing|preserveaspectratio|xmlns(?::\w+)?|version|class|id|lang|dir|rel|type|charset|crossorigin|integrity|media|sizes|srcset|loading|decoding|target|tabindex|role)$/i;
export function htmlHidden(raw, depth = 0) {
  const out = [];
  const attrNames = new Set();
  // <style> blocks: CSS escapes decoded; content: strings checked for numbers too
  for (const m of raw.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
    const css = cssUnescape(m[1]), off = m.index + m[0].indexOf(m[1]);
    out.push({ offset: off, text: css, kind: "css", numbers: false });
    for (const c of cssContent(m[1])) { out.push({ offset: off, text: c.text, kind: "css content", numbers: true }); c.attrs.forEach(a => attrNames.add(a)); }
  }
  // <script> blocks and on* handlers: JS escapes decoded; string literals with Hebrew checked for numbers
  for (const m of raw.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    const off = m.index + m[0].indexOf(m[1]);
    out.push({ offset: off, text: jsUnescape(m[1]), kind: "script", numbers: false });
    for (const s of stringLiterals(m[1])) if (HEB_RE.test(s.text)) out.push({ offset: off + s.start, text: s.text, kind: "script string", numbers: true });
  }
  // every attribute value of every tag (style values CSS-unescaped, on* values JS-unescaped)
  const noStyle = raw.replace(/<(style|script)\b[\s\S]*?<\/\1\s*>/gi, blankStr).replace(/<!--[\s\S]*?-->/g, blankStr);
  for (const tag of noStyle.matchAll(/<[a-zA-Z][\w:-]*\b((?:"[^"]*"|'[^']*'|[^'">])*)>/g)) {
    for (const a of tag[1].matchAll(/([^\s"'=<>\/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)) {
      const name = a[1].toLowerCase(), v = decodeEntities(a[2] ?? a[3] ?? a[4] ?? ""), off = tag.index + 1 + tag[0].slice(1).indexOf(a[0]);
      if (!/[\p{L}%]/u.test(v) || GEOMETRY_ATTRS.test(name)) continue;
      const text = name === "style" ? cssUnescape(v) : /^on/.test(name) ? jsUnescape(v) : v;
      out.push({ offset: off, text, kind: `attribute ${name}`, numbers: NUMERIC_ATTRS.test(name) && HEB_RE.test(text), attr: name });
      if (name === "style") for (const c of cssContent(v)) { out.push({ offset: off, text: c.text, kind: "css content", numbers: true }); c.attrs.forEach(x => attrNames.add(x)); }
    }
  }
  // CSS content: attr(x) shows the value of attribute x
  for (const h of out.filter(h => h.attr && attrNames.has(h.attr))) h.numbers = true, h.kind += " (shown by CSS attr())";
  // data: URIs anywhere (style, src, href, JSON in scripts): decoded; SVG/HTML payloads are read as markup
  if (depth < 2) for (const m of raw.matchAll(/data:[\w.+-]+\/[\w.+-]+(?:;[\w.+=-]+)*,/gi)) {
    const pre = raw.slice(Math.max(0, m.index - 6), m.index), from = m.index;
    const stop = /&quot;$/.test(pre) ? raw.indexOf("&quot;", from) : /&#0*39;$/.test(pre) ? raw.indexOf("&#39;", from) : /"$/.test(pre) ? raw.indexOf('"', from) : /'$/.test(pre) ? raw.indexOf("'", from) : /\($/.test(pre) ? raw.indexOf(")", from) : raw.slice(from).search(/[\s"'<>]/) + from;
    const uri = raw.slice(from, stop > from ? stop : raw.length);
    const d = decodeDataUri(decodeEntities(uri));
    if (!d) continue;
    if (/svg|html|xml/.test(d.mime)) {
      out.push({ offset: m.index, text: htmlToText(d.body), kind: "data: URI", numbers: true });
      for (const x of htmlHidden(d.body, depth + 1)) out.push({ ...x, offset: m.index, kind: "data: URI " + x.kind });
    } else if (/^text\//.test(d.mime)) out.push({ offset: m.index, text: d.body, kind: "data: URI", numbers: true });
  }
  return out;
}
function cssContent(css) {
  const out = [];
  for (const m of String(css).matchAll(/content\s*:\s*((?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|attr\(\s*[\w-]+\s*\)|[^;}"'])+)/gi)) {
    const attrs = [...m[1].matchAll(/attr\(\s*([\w-]+)\s*\)/gi)].map(x => x[1].toLowerCase());
    const text = [...m[1].matchAll(/"((?:\\[\s\S]|[^"\\])*)"|'((?:\\[\s\S]|[^'\\])*)'/g)].map(x => cssUnescape(x[1] ?? x[2])).join("");
    out.push({ text, attrs });
  }
  return out;
}
// Elements displayed with a bidi override (<bdo>, unicode-bidi: bidi-override / isolate-override, inline or via a CSS class): [start,end] of their content
function bidiOverrideRanges(raw) {
  const classes = new Set(), tags = new Set(["bdo"]);
  for (const m of raw.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi))
    for (const r of m[1].matchAll(/([^{}]+)\{([^}]*)\}/g)) if (/unicode-bidi\s*:\s*(?:bidi-override|isolate-override)/i.test(r[2]))
      for (const sel of r[1].split(",")) { const c = sel.trim().match(/\.([\w-]+)\s*$/); if (c) classes.add(c[1]); else if (/^[a-z][\w-]*$/i.test(sel.trim())) tags.add(sel.trim().toLowerCase()); }
  const out = [];
  for (const m of raw.matchAll(/<([a-zA-Z][\w-]*)\b((?:"[^"]*"|'[^']*'|[^'">])*)>/g)) {
    const name = m[1].toLowerCase(), attrs = decodeEntities(m[2]);
    const cls = (attrs.match(/\bclass\s*=\s*["']([^"']*)["']/i) || [, ""])[1].split(/\s+/);
    if (!(tags.has(name) || /unicode-bidi\s*:\s*(?:bidi-override|isolate-override)/i.test(attrs) || cls.some(c => classes.has(c)))) continue;
    const close = raw.slice(m.index + m[0].length).search(new RegExp(`</${name}\\s*>`, "i"));
    if (close >= 0) out.push([m.index + m[0].length, m.index + m[0].length + close]);
  }
  return out;
}
function reverseRanges(text, ranges) {
  let t = text;
  for (const [a, b] of ranges) t = t.slice(0, a) + [...t.slice(a, b)].reverse().join("") + t.slice(b);
  return t;
}

// JSON: the string values of each object form one group (title, badge and body of one post are one block); arrays of short strings
// (table rows) are joined with " · " so a number keeps its label. Technical keys are not checked against facts.json; every word and
// plate rule still runs on every string. Returns {copy, all, top: [[start,end]] per top-level entry of copy}.
function jsonToText(obj, skipKeys, keyValueOk) {
  const groups = [], all = [];
  const isCopy = (k, v) => !skipKeys.has(k) || (keyValueOk[k] && !new RegExp(keyValueOk[k], "u").test(v));
  const walk = (o, k) => {
    if (typeof o === "string") { all.push(o); return isCopy(k, o) ? [o] : []; }
    if (Array.isArray(o)) {
      const mine = []; for (const x of o) { const r = walk(x, k); if (typeof x === "string") mine.push(...r); }
      if (mine.length) groups.push(mine.every(s => s.length <= 40) ? mine.join(" · ") : mine.join("\n"));
      return [];
    }
    if (o && typeof o === "object") { const mine = []; for (const [kk, v] of Object.entries(o)) { const r = walk(v, kk); if (typeof v === "string") mine.push(...r); } if (mine.length) groups.push(mine.join("\n")); }
    return [];
  };
  const top = []; let copy = "";
  const entries = obj && typeof obj === "object" ? (Array.isArray(obj) ? obj.map((v, i) => [String(i), v]) : Object.entries(obj)) : [["", obj]];
  for (const [k, v] of entries) {
    const before = groups.length;
    if (typeof v === "string") { all.push(v); if (isCopy(k, v)) groups.push(v); } else walk(v, k);
    const mine = groups.slice(before);
    if (!mine.length) continue;
    if (copy) copy += "\n\n";
    const s = copy.length; copy += mine.join("\n\n"); top.push([s, copy.length]);
  }
  return { copy, all: all.join("\n\n"), top };
}

// Markdown structure: sections by heading (level 1-6), fenced code blocks (with language), paragraphs.
function mdStructure(text) {
  const lines = text.split("\n"), sections = [], codes = [];
  let off = 0, sec = { heading: "", level: 0, start: 0 }, code = null;
  for (const ln of lines) {
    const fence = ln.match(/^\s*(```+|~~~+)\s*([\w+-]*)\s*$/);
    if (fence) {
      if (!code) code = { lang: fence[2] || "", start: off, bodyStart: off + ln.length + 1, section: sec };
      else { code.end = off + ln.length; code.bodyEnd = off; codes.push(code); code = null; }
    } else if (!code && /^#{1,6}\s/.test(ln)) {
      sec.end = off; sections.push(sec); sec = { heading: ln.replace(/^#+\s*/, ""), level: ln.match(/^#+/)[0].length, start: off };
    }
    off += ln.length + 1;
  }
  sec.end = text.length; sections.push(sec);
  if (code) { code.end = code.bodyEnd = text.length; codes.push(code); }
  return { sections: sections.filter(s => s.end > s.start), codes };
}
// paragraph blocks: split on blank lines (offsets kept)
function paragraphs(text, from = 0, to = text.length) {
  const out = []; const re = /\n[ \t>]*\n/g; let s = from; re.lastIndex = from; let m;
  while ((m = re.exec(text)) && m.index < to) { if (m.index > s) out.push([s, m.index]); s = m.index + m[0].length; }
  if (to > s) out.push([s, to]);
  return out;
}
// sentence around offset i: bounded by . ! ? ; or a newline ("." between digits is a decimal point, not a boundary)
const isBoundary = (t, k) => { const c = t[k]; if (c === "\n" || c === "\u2029" || c === "!" || c === "?" || c === ";") return true; if (c === ".") return !(/\d/.test(t[k - 1] || "") && /\d/.test(t[k + 1] || "")) && !(/\p{L}/u.test(t[k - 1] || "") && /\p{L}/u.test(t[k + 1] || "") && t[k + 1] !== " "); return false; };
export function sentenceAt(t, a, b = a) {
  let s = a; while (s > 0 && !isBoundary(t, s - 1)) s--;
  let e = b; while (e < t.length && !isBoundary(t, e)) e++;
  return [s, e];
}

// ---------- rules ----------
export function loadConfig(p = path.join(HERE, "lint-config.json")) { return JSON.parse(fs.readFileSync(p, "utf8")); }

function mkV(rule, cfg, file, text, start, end, extra = {}) {
  const r = cfg.rules[rule] || {};
  return { rule, file, line: lineOf(text, start), he: extra.he || r.he, en: extra.en || r.en, snippet: snippet(text, start, end), match: text.slice(start, end), ...("detail" in extra ? { detail: extra.detail } : {}) };
}
const termsOf = list => (list || []).map(t => typeof t === "string" ? { term: t } : t);
const inRanges = (p, ranges) => (ranges || []).some(([a, b]) => p >= a && p < b);

// visible-character index: whitespace runs and invisible characters count as one / zero (so HTML padding does not stretch distances)
function visibleIndex(text) {
  const vis = new Array(text.length + 1); let v = 0, prevSpace = false;
  for (let i = 0; i < text.length; i++) { vis[i] = v; const c = text[i]; if (INVISIBLE.test(c)) continue; const sp = /\s/.test(c); if (!(sp && prevSpace)) v++; prevSpace = sp; }
  vis[text.length] = v; return vis;
}

// Word/phrase rules + plates + entitled + PRO + estimate + tiktok + banned asset, on one text blob.
//  blocks: [[start,end]] paragraphs (PRO label check); freeBlocks: windows for the PRO "free" check (default: each block plus the short
//  paragraphs next to it); measurement: ranges where impressions words are allowed; wordsOnly: only the word/phrase rules.
export function lintText(text, file, cfg, { blocks, freeBlocks, plateText, measurement, wordsOnly = false, noWords = false } = {}) {
  const out = [], vars = variants(text);
  for (const rule of noWords ? [] : ["forbidden-word", "winner-or-recommendation", "golden-rule", "tiktok-analytics", "banned-asset"]) {
    const R = cfg.rules[rule];
    const taken = []; // one report per place: overlapping hits of the same rule are merged
    for (const t of termsOf(R.terms)) for (const h of findTerm(text, t, {}, vars)) {
      if (t.metric_ok && inRanges(h.start, measurement)) continue;
      if (taken.some(([a, b]) => h.start < b && h.end > a)) continue;
      taken.push([h.start, h.end]);
      out.push(mkV(rule, cfg, file, text, h.start, h.end, { detail: `term "${termLabel(t)}" (${h.variant === "plain" ? "direct" : h.variant + " match"})` }));
    }
    for (const p of R.pairs || []) for (const h of pairHits(text, p, vars)) {
      if (taken.some(([a, b]) => h.start < b && h.end > a)) continue;
      taken.push([h.start, h.end]);
      out.push(mkV(rule, cfg, file, text, h.start, h.end, { detail: `${p.label}: "${h.a}" … "${h.b}"` }));
    }
  }
  // entitled + recall/settlement context (distance in visible characters)
  const Z = cfg.rules["entitled-claim"], vis = visibleIndex(text);
  const ctxHits = termsOf(Z.context_terms).flatMap(t => findTerm(text, t, {}, vars).map(h => h.start));
  const zTaken = [];
  for (const t of noWords ? [] : termsOf(Z.terms)) for (const h of findTerm(text, t, {}, vars)) {
    if (zTaken.some(([a, b]) => h.start < b && h.end > a)) continue;
    const c = ctxHits.find(p => Math.abs(vis[p] - vis[h.start]) <= Z.window_chars);
    if (c === undefined) continue;
    zTaken.push([h.start, h.end]);
    out.push(mkV("entitled-claim", cfg, file, text, h.start, h.end, { detail: `"${termLabel(t)}" near a recall/settlement word ("${snippet(text, c, c + 8, 0)}")` }));
  }
  if (wordsOnly) return out;
  out.push(...plates(plateText ?? text, file, cfg));
  // PRO features: label per block; "free" per window around the block
  const P = cfg.rules["pro-feature"], E = cfg.rules["estimate-label"];
  const B = blocks || [[0, text.length]];
  const markerHits = termsOf(P.markers).flatMap(m => findTerm(text, m, {}, vars));
  const basicHits = termsOf(P.basic_markers).flatMap(m => findTerm(text, m, {}, vars));
  const freeHits = termsOf(P.free_terms).flatMap(f => findTerm(text, f, {}, vars).map(h => ({ ...h, label: termLabel(f) })));
  for (const [a, b] of B) {
    const mk = markerHits.filter(h => h.start >= a && h.start < b);
    if (!mk.length) continue;
    if (!normalize(text.slice(a, b)).includes(normalize(P.label))) out.push(mkV("pro-feature", cfg, file, text, mk[0].start, mk[0].end, { detail: `block mentions "${text.slice(mk[0].start, mk[0].end)}" without the label "${P.label}"`, he: `פיצ'ר PRO בלי התווית "${P.label}"`, en: `PRO feature without the "${P.label}" label` }));
  }
  const windows = freeBlocks || B.map(([a, b], i) => {
    const isItem = ([x, y]) => /^\s*(?:>\s*)?(?:[א-ת]\.|\d+[.)]|#|\*\*|[-*•]\s)/u.test(text.slice(x, y));
    let s = a, e = b;
    if (i + 1 < B.length && B[i + 1][1] - B[i + 1][0] < 120 && !isItem(B[i + 1])) e = B[i + 1][1];
    if (i > 0 && B[i - 1][1] - B[i - 1][0] < 120 && !isItem([a, b])) s = B[i - 1][0];
    return [s, e];
  });
  const freeTaken = new Set();
  for (const [a, b] of windows) {
    const mk = markerHits.filter(h => h.start >= a && h.start < b);
    if (!mk.length) continue;
    for (const f of freeHits.filter(h => h.start >= a && h.start < b)) {
      if (freeTaken.has(f.start)) continue;
      const [cs, ce] = sentenceAt(text, f.start, f.end);
      const clauseHasPro = markerHits.some(h => h.start >= cs && h.start < ce) || normalize(text.slice(cs, ce)).includes(normalize(P.label));
      if (!clauseHasPro && basicHits.some(h => h.start >= cs && h.start < ce)) continue;
      freeTaken.add(f.start);
      out.push(mkV("pro-feature", cfg, file, text, f.start, f.end, { detail: `"${f.label}" next to a PRO feature ("${text.slice(mk[0].start, mk[0].end)}")`, he: "פיצ'ר PRO מוצג כחינמי", en: "PRO feature presented as free" }));
    }
  }
  // estimates: a trigger word and a number in the same sentence, without (הערכה)
  const eTaken = new Set();
  for (const t of termsOf(E.trigger_terms)) for (const h of findTerm(text, t, {}, vars)) {
    const [s, e] = sentenceAt(text, h.start, h.end);
    if (eTaken.has(s)) continue;
    const sent = text.slice(s, e);
    if (!numbersIn(sent.replace(/בנזין 95|95 אוקטן|לכל 1,000/g, blankStr)).length || sent.includes(E.label)) continue;
    eTaken.add(s);
    out.push(mkV("estimate-label", cfg, file, text, h.start, h.end, { detail: `"${text.slice(h.start, h.end)}" with a number in the same sentence and no ${E.label}` }));
  }
  return out;
}
// two terms in the same sentence, at most within_words words apart (e.g. a dealer word and a negative verb)
function pairHits(text, p, vars) {
  const out = [];
  const A = findTerm(text, { re: p.a }, {}, vars), Bh = findTerm(text, { re: p.b, unless_prev: p.b_unless_prev }, {}, vars);
  for (const a of A) for (const b of Bh) {
    const s = Math.min(a.start, b.start), e = Math.max(a.end, b.end);
    const between = text.slice(Math.min(a.end, b.end), Math.max(a.start, b.start));
    if (/[.!?;\n]/.test(between.replace(/(\d)\.(\d)/g, "$1$2"))) continue;
    if (between.trim().split(/\s+/).filter(Boolean).length > p.within_words) continue;
    out.push({ start: s, end: e, a: text.slice(a.start, a.end), b: text.slice(b.start, b.end) });
  }
  return out;
}

// ---------- plates ----------
// view of the text for plate matching: every digit script folded to 0-9, invisible characters dropped, dashes/spaces unified
function plateView(text) {
  let t = ""; const map = [];
  for (let i = 0; i < text.length;) {
    const ch = String.fromCodePoint(text.codePointAt(i)); const n = ch.length;
    if (INVISIBLE.test(ch)) { i += n; continue; }
    let c = ch;
    if (/\p{Nd}/u.test(c)) c = foldDigits(c).replace(/\u200B/g, "");
    else if (/[\u2010-\u2015\u2212\u05BE\uFE58\uFE63\uFF0D]/.test(c)) c = "-";
    else if (/[\u00A0\u2000-\u200A\u202F\u205F\u3000\t]/.test(c)) c = " ";
    else if (/[\u00B7\u2022\u2027\u30FB\uFF0F\u2044\u2215]/.test(c)) c = c === "\u2044" || c === "\u2215" || c === "\uFF0F" ? "/" : "·";
    t += c; for (let k = 0; k < c.length; k++) map.push(i); // one map entry per UTF-16 unit (emoji are 2 units)
    i += n;
  }
  map.push(text.length);
  return { t, map };
}
const PLATE_SEP = "(?:[ ]*[-/_·.,][ ]*|[ ]{1,3})";
export function plateSpans(text, cfg) {
  const R = cfg.rules["real-plate"], out = [];
  const allow = new Set(R.allow.map(p => p.replace(/\D/g, "")));
  const notP = (R.not_plates || []).map(r => new RegExp(r));
  const { t, map } = plateView(text);
  const runRe = new RegExp(`(?<!\\d)\\d+(?:${PLATE_SEP}\\d+)*(?!\\d)`, "g");
  for (const m of t.matchAll(runRe)) {
    const run = m[0];
    // digits inside a long hex token (git sha, hash) are not a plate; "IL2345678" still is
    let ta = m.index, tb = m.index + run.length; while (ta > 0 && /[A-Za-z0-9]/.test(t[ta - 1])) ta--; while (tb < t.length && /[A-Za-z0-9]/.test(t[tb])) tb++;
    if (/^\d+$/.test(run) && tb - ta >= 12 && /^[0-9a-f]+$/i.test(t.slice(ta, tb)) && /[a-f]/i.test(t.slice(ta, tb))) continue;
    const parts = [...run.matchAll(new RegExp(`\\d+|${PLATE_SEP}`, "g"))].map(x => ({ s: x[0], i: x.index }));
    const groups = parts.filter(p => /^\d/.test(p.s)), seps = parts.filter(p => !/^\d/.test(p.s));
    // candidate sub-runs: cut only at separators that hold whitespace ("23-456-78. 97%" -> "23-456-78"), never inside "23-456-78";
    // a run can hold several plates ("12-345-67, 1234567, 7654321")
    const cutOk = k => /\s/.test(seps[k].s);
    for (let i = 0; i < groups.length;) {
      let hit = null;
      if (i === 0 || cutOk(i - 1)) for (let j = groups.length - 1; j >= i && !hit; j--) {
        if (j < groups.length - 1 && !cutOk(j)) continue;
        const g = groups.slice(i, j + 1).map(x => x.s), digits = g.join("");
        if (digits.length < 7 || digits.length > 8) continue;
        if (!(g.every(x => x.length >= 2) || g.every(x => x.length === 1))) continue;
        const a = groups[i].i, b = groups[j].i + groups[j].s.length, str = run.slice(a, b);
        if (notP.some(r => r.test(str) || (!/[^\d]/.test(str) && r.test(digits)))) continue;
        hit = { a: m.index + a, b: m.index + b, digits, str, j };
      }
      if (hit) { out.push({ start: map[hit.a], end: map[hit.b - 1] + 1, digits: hit.digits, raw: hit.str, allowed: allow.has(hit.digits) }); i = hit.j + 1; } else i++;
    }
  }
  return out;
}
export function plates(text, file, cfg) {
  const R = cfg.rules["real-plate"];
  return plateSpans(text, cfg).filter(p => !p.allowed).map(p => mkV("real-plate", cfg, file, text, p.start, p.end, { detail: `"${p.raw}" (${p.digits}) is not on the demo allowlist (${R.allow.join(", ")})` }));
}

// ---------- extension prompt ----------
// schedule: the prompt schedules to the end (TikTok Studio's Schedule button), so a click on Schedule is allowed; Post/publish never is
function promptRegexes(R, { schedule = false } = {}) {
  const fill = "[^\\p{L}\\n.;!?]+", pub = schedule ? R.publish_terms_schedule_policy : R.publish_terms;
  return {
    click: rx(`(?<!\\p{L})[והבלש]{0,2}${R.click_terms}(?:${fill}\\p{L}+){0,3}?${fill}["'״“”]?${pub}(?!\\p{L})`, "giu"),
    imperative: rx(`(?<!\\p{L})(?:${R.imperative_terms})(?!\\p{L})`, "giu"),
    negBefore: rx(`${R.negation}(?:${fill}\\p{L}+){0,2}${fill.replace("+", "*")}$`, "iu"),
  };
}
// publish/confirm-click instructions in a text (any variant), unless negated in the same clause ("אל תלחץ על פרסם", "עצור לפני הלחיצה על פרסם")
export function publishClicks(text, cfg, { imperative = false, schedule = false } = {}) {
  const R = cfg.rules["extension-prompt"], re = promptRegexes(R, { schedule }), out = [], seen = new Set();
  for (const v of variants(text).slice(0, 3)) for (const r of imperative ? [re.click, re.imperative] : [re.click]) {
    r.lastIndex = 0;
    for (const m of v.text.matchAll(r)) {
      const before = v.text.slice(Math.max(0, m.index - 50), m.index);
      if (re.negBefore.test(before)) continue;
      const start = v.map[m.index], end = v.map[m.index + m[0].length - 1] + 1;
      if ([...seen].some(s => Math.abs(s - start) < 3)) continue;
      seen.add(start); out.push({ start, end });
    }
  }
  return out;
}
function promptLike(body, R) { const n = normalize(body); return R.prompt_signals.filter(s => rx(s, "iu").test(n)).length >= 2; }
export function checkPromptBody(text, a, b, file, cfg, label = "prompt") {
  const R = cfg.rules["extension-prompt"], out = [];
  const body = text.slice(a, b), vb = variants(body);
  const has = list => termsOf(list).some(t => findTerm(body, t, {}, vb).length);
  const at = (s, e, extra) => mkV("extension-prompt", cfg, file, text, a + s, a + e, extra);
  // two policies: drafts (the owner makes the last click) or schedule to the end (says so, clicks Schedule, never Post / publish now)
  const schedule = has(R.schedule_markers || []);
  if (!has(R.stop_markers)) out.push(at(0, 3, { detail: `${label} has no stop marker (עצור לפני האישור הסופי / STOP before)`, he: "הפרומפט לא אומר לעצור לפני האישור הסופי", en: "prompt does not say to STOP before the final confirm" }));
  if (schedule) {
    if (!has(R.no_post_markers || [])) out.push(at(0, 3, { detail: `${label} schedules to the end but never says not to press Post / publish now`, he: "פרומפט שמתזמן עד הסוף חייב לומר לא ללחוץ על Post / פרסום עכשיו", en: "a schedule-to-the-end prompt must forbid Post / publish now" }));
  } else {
    if (!has(R.draft_markers)) out.push(at(0, 3, { detail: `${label} does not say drafts (טיוטה / draft)`, he: "הפרומפט לא מגדיר שמירה כטיוטה", en: "prompt does not say to save/schedule as drafts" }));
    for (const t of termsOf(R.draft_contradictions)) for (const h of findTerm(body, t, {}, vb)) out.push(at(h.start, h.end, { detail: `${label} contradicts drafts ("${body.slice(h.start, h.end)}")`, he: "הפרומפט סותר שמירה כטיוטה", en: "prompt contradicts saving as drafts" }));
  }
  for (const h of publishClicks(body, cfg, { imperative: true, schedule })) out.push(at(h.start, h.end, { detail: `publish/confirm instruction "${body.slice(h.start, h.end)}"`, he: "הפרומפט מורה ללחוץ על פרסום/אישור סופי", en: "prompt tells the extension to click publish/final confirm" }));
  // poll/quiz: every sentence that mentions one must say phone app (or say not to), and never desktop/browser
  const pollRe = termsOf(R.poll_terms), phone = termsOf(R.phone_markers), desk = termsOf(R.desktop_markers), neg = rx(R.poll_negation, "iu");
  for (const h of pollRe.flatMap(t => findTerm(body, t, {}, vb))) {
    const [s, e] = sentenceAt(body, h.start, h.end), sent = body.slice(s, e), vs = variants(sent);
    const isNeg = neg.test(normalize(sent));
    const onDesk = desk.some(t => findTerm(sent, t, {}, vs).length);
    // the phone may be named by the list's lead-in line in the same paragraph ("בטלפון, באפליקציית אינסטגרם:" then "א. סטיקר סקר...")
    const paraStart = Math.max(0, body.lastIndexOf("\n\n", s));
    const leadIns = body.slice(paraStart, s).split("\n").filter(l => /:\s*["'״]?\s*$/.test(l));
    const onPhone = phone.some(t => findTerm(sent, t, {}, vs).length) || (!onDesk && leadIns.some(l => phone.some(t => findTerm(l, t).length) && !desk.some(t => findTerm(l, t).length)));
    if ((onDesk && !isNeg && !onPhone) || (!onPhone && !isNeg)) out.push(at(h.start, h.end, { detail: `poll/quiz in the ${label} without saying it is added only from the Instagram phone app ("${sent.trim().slice(0, 80)}")`, he: "סקר/חידון בפרומפט בלי הוראה שזה רק מהאפליקציה בטלפון", en: "poll/quiz must be added only from the IG phone app" }));
  }
  return out;
}
// Kit markdown: exactly one prompt (fences under a prompt heading, prompt-like fences anywhere, plus prompt files elsewhere in the kit)
export function lintPrompt(text, file, cfg, { extraPrompts = [] } = {}) {
  const R = cfg.rules["extension-prompt"], out = [];
  const { sections, codes } = mdStructure(text);
  const hre = rx(R.section_heading_regex, "iu"), codeRe = new RegExp(R.code_langs, "i");
  const isP = s => hre.test(fixFinals(s.heading));
  const ranges = sections.filter(isP).map(s => { const lvl = s.level || 2; const nxt = sections.find(x => x.start > s.start && (x.level || 2) <= lvl && !isP(x)); return [s.start, nxt ? nxt.start : text.length]; });
  const inPrompt = c => ranges.some(([a, b]) => c.start >= a && c.start < b);
  const prompts = codes.filter(c => !codeRe.test(c.lang) && (inPrompt(c) || promptLike(text.slice(c.bodyStart, c.bodyEnd), R)));
  const total = prompts.length + extraPrompts.length;
  if (total !== 1) {
    const at = prompts[1]?.start ?? ranges[0]?.[0] ?? 0;
    out.push(mkV("extension-prompt", cfg, file, text, at, at + 20, { detail: `found ${total} extension prompts (code blocks under a "פרומפט" heading or that read like a prompt${extraPrompts.length ? `, plus ${extraPrompts.join(", ")}` : ""}); the kit must have exactly ONE`, he: `נמצאו ${total} פרומפטים לתוסף; צריך בדיוק אחד`, en: `found ${total} extension prompts; exactly one is required` }));
  }
  for (const c of prompts) out.push(...checkPromptBody(text, c.bodyStart, c.bodyEnd, file, cfg));
  // a publish/confirm instruction anywhere else in the markdown
  let rest = text; for (const c of prompts) rest = blankRange(rest, c.bodyStart, c.bodyEnd);
  for (const h of publishClicks(rest, cfg)) out.push(mkV("extension-prompt", cfg, file, text, h.start, h.end, { detail: `publish/confirm instruction outside the prompt: "${text.slice(h.start, h.end)}"`, he: "הוראה ללחוץ על פרסום מחוץ לפרומפט", en: "publish/confirm-click instruction in the kit" }));
  return out;
}

// ---------- numbers vs facts ----------
function modelMasks(cfg, ctx) {
  const F = cfg.rules.facts;
  // a name that already ends in its number ("MG3") is never followed by a model number ("MG3 פי 3" is a claim)
  const brands = [...new Set([...(F.brands || []), ...(ctx.modelWords || [])])].filter(b => b.length >= 2 && !/\d$/.test(b)).sort((a, b) => b.length - a.length);
  const esc = s => fixFinals(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return {
    re: new RegExp(`(?<![\\p{L}\\p{N}])(?:${brands.map(esc).join("|")})(?![\\p{L}])(?:[ \\t-]+[A-Za-z][A-Za-z'.]*){0,2}?[ \\t-]*(\\d{1,3})(?![\\d])(?![.,]\\d)`, "giud"),
    unless: rx(F.model_number_unless_next, "iu"),
  };
}
function maskForNumbers(t, cfg, ctx) {
  const F = cfg.rules.facts;
  for (const p of [...F.allowed_phrases, ...(ctx.nonclaims || []).map(n => n.text)]) if (p) { const q = foldDigits(fixFinals(p)); t = t.split(q).join(blankStr(q)); }
  for (const { re } of F.ignore_patterns) t = t.replace(rx(re, "gmu"), blankStr);
  const mm = ctx._mm || (ctx._mm = modelMasks(cfg, ctx));
  mm.re.lastIndex = 0;
  for (const m of [...t.matchAll(mm.re)]) {
    const [a, b] = m.indices[1];
    if (mm.unless.test(t.slice(b))) continue;
    t = blankRange(t, a, b);
  }
  return t;
}
function unitAt(t, start, end, F) {
  const before = t.slice(Math.max(0, start - 3), start), after = t.slice(end, end + 8);
  for (const [u, r] of Object.entries(F.units)) if (rx(r.after, "iu").test(after) || rx(r.before, "iu").test(before)) return u;
  return null;
}
function factMeta(f, F) {
  const text = fixFinals(f.text || ""), v = parseNum(f.value);
  const n = numbersIn(text).find(x => Math.abs(x.value - v) < 1e-9);
  return { _num: v, _unit: n ? unitAt(text, n.index, n.index + n.raw.length, F) : null, _text: text.toLowerCase(), _dir: directionOf(f.text || "") };
}
// Is fact f a fair source for the copy number described by `c`? Returns the reason it is not, or null.
function incompatible(f, c, cfg, ctx) {
  const F = cfg.rules.facts;
  if (c.unit === "pct" && f._unit !== "pct") return "the copy number is a percentage, the fact is not";
  if (f._unit === "pct" && c.unit !== "pct") return "the fact is a percentage, the copy number is not";
  if (c.unit === "ils" && f._unit !== "ils") return "the copy number is in ש\"ח, the fact is not";
  for (const [name, src] of Object.entries(F.topics)) { const r = rx(src, "iu"); if (r.test(c.window) && !r.test(f._text)) return `the copy around it is about ${name} ("${c.window.trim().slice(0, 50)}"), the fact is not`; }
  if (c.entities.length && !c.entities.some(e => f._text.includes(e))) return `the copy names ${c.entities.join("/")}, the fact does not`;
  const cd = c.sign || directionOf(c.window);
  if (cd && cd !== "both" && f._dir && f._dir !== "both" && cd !== f._dir) return `the copy says ${cd === "up" ? "עלייה (up)" : "ירידה (down)"}, the fact says ${f._dir === "up" ? "עלייה (up)" : "ירידה (down)"}`;
  for (const b of F.bindings || []) {
    const locs = [f, ...((f.derive && f.derive.args) || [])];
    if (!locs.some(l => l.source_path === b.source_path && new RegExp(b.pointer, "u").test(String(l.json_pointer ?? l.source_field ?? "")))) continue;
    if (b.copy_forbid && rx(b.copy_forbid, "iu").test(c.context)) return `copy may not present ${b.source_path} ${b.pointer} as "${c.context.match(rx(b.copy_forbid, "iu"))[0]}" (${b.about})`;
    if (b.copy && !rx(b.copy, "iu").test(c.context)) return `copy using ${b.source_path} ${b.pointer} must say what it is (${b.about}: /${b.copy}/)`;
  }
  if (f.source_rev && !f.derive) {
    if (rx(F.present_markers, "iu").test(c.sentence)) return `the fact is historical (git revision ${String(f.source_rev).slice(0, 8)}), the copy presents it as current`;
    if (!rx(F.past_markers, "iu").test(c.sentence)) return `the fact is historical (git revision ${String(f.source_rev).slice(0, 8)}): the sentence must say when (a month, a date, בחודש שעבר, אשתקד...)`;
  }
  if (f._approx && !rx(F.approx_markers, "iu").test(c.before)) return `the fact is rounded (${f.value} vs ${f._exact} in the source): write "כ-${c.raw}"`;
  return null;
}
// table rows and list items: a number in a cell is read with the entity named in another cell of the same row
export const rowRanges = html => [...html.matchAll(/<(tr|li)\b[\s\S]*?<\/\1\s*>/gi)].map(m => [m.index, m.index + m[0].length]);
function checkNumbers(text, file, cfg, ctx, { skipRanges = [], blocks = null, rows = null } = {}) {
  const out = [], F = cfg.rules.facts;
  const tn = fixFinals(text);
  let t = foldDigits(tn); if (t.length !== text.length) t = tn;
  for (const p of plateSpans(text, cfg)) t = blankRange(t, p.start, p.end);
  for (const [a, b] of skipRanges) t = blankRange(t, a, b);
  t = maskForNumbers(t, cfg, ctx);
  // numbers written as words ("שבעה עשר אחוז", "שלושה מכל ארבעה")
  for (const w of termsOf(F.number_words)) for (const h of findTerm(text, w)) if (!inRanges(h.start, skipRanges))
    out.push(mkV("facts", cfg, file, text, h.start, h.end, { detail: `number written in words ("${text.slice(h.start, h.end)}"): write the number in digits, backed by a fact`, he: "מספר במילים בלי מקור", en: "number written in words (no source)" }));
  const searchRe = rx(F.search_words, "iu"), K = F.context_words ?? 4;
  for (const n of numbersIn(t)) {
    const start = n.index, end = n.index + n.raw.length;
    let [ss, se] = sentenceAt(tn, start, end);
    const words = (a, b) => tn.slice(a, b).split(/\s+/).filter(w => /\p{L}{2}|\p{N}/u.test(w));
    // a number alone in its block (a big stat on a slide) is read with the label right before/after it
    if (!words(ss, start).length && !words(end, se).length) {
      for (let k = 0; k < 6 && ss > 0 && !words(ss, start).length; k++) ss = sentenceAt(tn, ss - 1)[0];
      for (let k = 0; k < 6 && se < tn.length && !words(end, se).length; k++) se = sentenceAt(tn, se + 1)[1];
    }
    const wb = words(ss, start).slice(-K).join(" "), wa = words(end, se).slice(0, K).join(" ");
    const window = wb + " " + wa;
    const blk = blocks && blocks.find(([a, b]) => start >= a && start < b);
    const c = {
      raw: n.raw, unit: unitAt(t, start, end, F), window, sentence: tn.slice(ss, se), context: blk ? tn.slice(blk[0], blk[1]) : tn.slice(ss, se), before: tn.slice(Math.max(0, start - 12), start),
      sign: /[-\u2212\u2013]/.test(tn[start - 1] || "") && !/[\p{L}\p{N}]/u.test(tn[start - 2] || "") ? "down" : tn[start - 1] === "+" && !/[\p{L}\p{N}]/u.test(tn[start - 2] || "") ? "up" : null,
      entities: [...new Set(window.toLowerCase().split(/[^\p{L}\p{N}.'"]+/u).filter(w => ctx.entities.has(w)))],
    };
    const row = !c.entities.length && rows && rows.filter(([a, b]) => start >= a && start < b).sort((x, y) => (x[1] - x[0]) - (y[1] - y[0]))[0];
    if (row) c.entities = [...new Set(tn.slice(row[0], row[1]).toLowerCase().split(/[^\p{L}\p{N}.'"]+/u).filter(w => ctx.entities.has(w)))];
    const cands = ctx.facts.filter(f => Math.abs(f._num - n.value) < 1e-9);
    const priv = ctx.privFacts.find(f => Math.abs(f._num - n.value) < 1e-9);
    if (priv && (!cands.length || searchRe.test(c.sentence))) {
      out.push(mkV("facts", cfg, file, text, start, end, { detail: `${n.raw} matches a private fact (Search Console: "${priv.text}"); private numbers never go into copy`, he: "מספר פרטי (Search Console) בתוכן", en: "private number in public copy" }));
      continue;
    }
    if (!cands.length) { out.push(mkV("facts", cfg, file, text, start, end, { detail: `${n.raw} has no matching fact in facts.json`, he: `המספר ${n.raw} בלי מקור ב-facts.json`, en: `number ${n.raw} has no source fact` })); continue; }
    const why = [];
    if (cands.some(f => { const r = incompatible(f, c, cfg, ctx); if (r) why.push(`"${f.text}": ${r}`); return !r; })) continue;
    out.push(mkV("facts", cfg, file, text, start, end, { detail: `${n.raw} equals a fact's value but the copy does not fit it: ${why.slice(0, 2).join(" | ")}`, he: `המספר ${n.raw} לא תואם את העובדה (יחידה/דגם/נושא/כיוון)`, en: `number ${n.raw} does not fit its fact` }));
  }
  // estimates must carry the label near the number
  const lab = cfg.rules["estimate-label"].label;
  for (const f of ctx.facts.filter(f => f.estimate)) for (const n of numbersIn(t)) if (Math.abs(n.value - f._num) < 1e-9) {
    const near = text.slice(Math.max(0, n.index - 40), n.index + n.raw.length + 60);
    if (!near.includes(lab)) out.push(mkV("estimate-label", cfg, file, text, n.index, n.index + n.raw.length, { detail: `${n.raw} is an estimate (facts.json) without ${lab} next to it` }));
  }
  return out;
}

function validateFacts(factsDoc, repo, cfg, factsFile, { kitDir, now }) {
  const out = [], warn = [];
  const list = Array.isArray(factsDoc) ? factsDoc : factsDoc.facts || [];
  const F = cfg.rules.facts, req = F.required_fields;
  const good = [];
  list.forEach((f, i) => {
    const V = (he, en, detail, snip = f.text) => out.push({ rule: "facts", file: factsFile, line: i + 1, he, en, detail, snippet: String(snip ?? "").slice(0, 160) });
    const miss = req.filter(k => f[k] === undefined || f[k] === "");
    if (!f.json_pointer && !f.source_field && !f.regex && !f.derive) miss.push("json_pointer|source_field|regex|derive");
    if (miss.length) { V("עובדה חסרה שדות חובה", "fact is missing required fields", `fact ${i} (${f.text || f.id || "?"}): missing ${miss.join(", ")}`, JSON.stringify(f)); return; }
    if (!repo && !path.isAbsolute(f.source_path)) { V("אין ריפו לבדיקת המקור (--repo)", "no --repo checkout to verify the source", `fact ${i}: ${f.text}`, f.source_path); return; }
    const r = checkFact(f, { repo, kitDir, now, cfg: F });
    for (const e of r.errors) V("עובדה לא תקינה", "invalid fact", `fact ${i} "${f.text}": ${e}`);
    warn.push(...r.warnings.map(w => `fact ${i}: ${w}`));
    const v = r.verify;
    if (!v || !v.ok) { V("הערך בעובדה לא תואם למקור", "fact value does not match its source", `fact ${i} "${f.text}": value ${JSON.stringify(f.value)} vs source ${!v ? "ERROR not verified" : v.error && v.computed === undefined ? "ERROR " + v.error : JSON.stringify(v.computed) + (v.error ? ` (${v.error})` : "")} (${f.source_path}${f.json_pointer ? " " + f.json_pointer : ""}${f.source_rev ? " @" + String(f.source_rev).slice(0, 8) : ""})`); return; }
    if (r.errors.length) return;
    good.push({ ...f, ...factMeta(f, F), _approx: v.relErr > (F.approx_threshold ?? 0.005), _exact: Math.round(v.exact * 1e6) / 1e6 });
  });
  return { out, warn, list, good };
}

// ---------- kit ----------
function walk(dir, cfg, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!cfg.scan.skip_dirs.includes(e.name)) walk(path.join(dir, e.name), cfg, acc); }
    else if (e.isFile()) acc.push(path.join(dir, e.name));
    else if (e.isSymbolicLink()) { try { if (fs.statSync(path.join(dir, e.name)).isFile()) acc.push(path.join(dir, e.name)); } catch {} }
  }
  return acc;
}
// read a text file: UTF-8 (BOM ok), UTF-16 LE/BE (BOM or NUL pattern); null when it is not text
function readText(buf) {
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return buf.slice(2).toString("utf16le");
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) { const b = Buffer.from(buf.slice(2)); b.swap16 && b.length % 2 === 0 && b.swap16(); return b.toString("utf16le"); }
  const sample = buf.slice(0, 4000); let nulEven = 0, nulOdd = 0;
  for (let i = 0; i < sample.length; i++) if (sample[i] === 0) (i % 2 ? nulOdd++ : nulEven++);
  if (sample.length > 8 && nulOdd > sample.length / 6 && nulEven < sample.length / 50) return buf.toString("utf16le");
  if (sample.length > 8 && nulEven > sample.length / 6 && nulOdd < sample.length / 50) { const b = Buffer.from(buf.length % 2 ? buf.slice(0, -1) : buf); b.swap16(); return b.toString("utf16le"); }
  try { const s = new TextDecoder("utf-8", { fatal: true }).decode(buf); return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s; } catch { return null; }
}
function repoEntities(repo) {
  const words = new Set(), names = [];
  const add = s => { for (const w of String(s).split(/[\s|]+/)) if (w.length >= 2) words.add(w); names.push(String(s)); };
  if (!repo) return { words, names };
  try { for (const m of JSON.parse(fs.readFileSync(path.join(repo, "model/stats.json"), "utf8")).models || []) { add(m.label); add(m.disp); } } catch {}
  try { for (const k of Object.keys(JSON.parse(fs.readFileSync(path.join(repo, "market.json"), "utf8")).models || {})) add(k); } catch {}
  return { words, names };
}

export function lintKit(dir, { repo, cfg = loadConfig(), now = Date.now(), allowNonGit = false, allowStale = false } = {}) {
  const violations = [], warnings = [], info = [];
  const S = cfg.scan, F = cfg.rules.facts;
  const rel = p => path.relative(dir, p) || path.basename(p);
  const files = walk(dir, cfg);
  const V = (rule, file, he, en, detail, snip = "", line = 0) => violations.push({ rule, file, line, he, en, detail, snippet: snip });
  // banned asset: any path in the kit (also binaries), and the asset's hash
  const banned = termsOf(cfg.rules["banned-asset"].terms);
  for (const f of files) {
    const r = rel(f);
    if (banned.some(t => findTerm(r, t).length)) V("banned-asset", r, cfg.rules["banned-asset"].he, cfg.rules["banned-asset"].en, "file name names the banned asset", r);
    if ((S.banned_sha256 || []).length && fs.statSync(f).size < 500e6) {
      const h = crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
      if (S.banned_sha256.includes(h)) V("banned-asset", r, cfg.rules["banned-asset"].he, cfg.rules["banned-asset"].en, "this file is a copy of short-1-oketz (same sha256)", r);
    }
  }
  // facts
  const factsPath = path.join(dir, S.facts_file);
  let good = [], priv = [], nonclaims = [], factsCount = 0;
  if (!fs.existsSync(factsPath)) V("facts", S.facts_file, "חסר facts.json: אי אפשר לאמת אף מספר", "facts.json is missing: no number can be verified", "every kit needs facts.json (see RUNBOOK.md)");
  else {
    let doc; try { doc = JSON.parse(fs.readFileSync(factsPath, "utf8")); } catch (e) { V("facts", S.facts_file, "facts.json לא תקין", "facts.json is not valid JSON", e.message); }
    if (doc) {
      const r = validateFacts(doc, repo, cfg, S.facts_file, { kitDir: dir, now });
      violations.push(...r.out); warnings.push(...r.warn); factsCount = r.list.length;
      good = r.good.filter(f => !f.private); priv = r.good.filter(f => f.private);
      nonclaims = doc.nonclaims || [];
      const claimy = new RegExp(`%|ש"ח|ש״ח|₪|${Object.values(F.topics).map(s => fixFinals(s).replace(/\{P\}/g, "")).join("|")}|${fixFinals("מה(?:רכבים|נהגים|קונים|דגמים|ישראלים|לקוחות|סוחרים|משתמשים|בעלים)")}`, "iu");
      for (const n of nonclaims) {
        if (!n.text || !n.reason || String(n.reason).trim().length < 8) V("facts", S.facts_file, "nonclaim בלי text/reason אמיתי", "nonclaim needs text and a real reason", JSON.stringify(n));
        else if (claimy.test(fixFinals(n.text)) || directionOf(n.text)) V("facts", S.facts_file, "nonclaim נראה כמו טענה על נתונים", "nonclaim looks like a data claim: it needs a fact, not a nonclaim", `"${n.text}" (${n.reason})`, n.text);
        info.push(`nonclaim (not checked against facts): "${n.text}" — ${n.reason}`);
      }
      nonclaims = nonclaims.filter(n => n.text && n.reason && String(n.reason).trim().length >= 8 && !(claimy.test(fixFinals(n.text)) || directionOf(n.text)));
      // the checkout must be current and not older than the facts
      if (repo) {
        const h = repoHead(repo);
        if (!h.sha) { if (!allowNonGit) V("facts", "--repo", "--repo אינו ריפו git", "--repo is not a git checkout", "cannot tell how fresh the data is: clone ddsabag/vehicle-app (RUNBOOK step 1)", repo); }
        else {
          const age = (now - Date.parse(h.date)) / 864e5;
          if (age > (F.max_checkout_age_days ?? 3)) (allowStale ? (m => warnings.push(m)) : (m => V("facts", "--repo", "הריפו לא מעודכן", "stale checkout", m, h.sha.slice(0, 8))))(`checkout HEAD ${h.sha.slice(0, 8)} is from ${h.date} (${Math.round(age)} days old): git pull before linting${allowStale ? " (allowed by --allow-stale-checkout)" : ""}`);
          if (doc.repo_commit && doc.repo_commit !== h.sha) {
            const anc = isAncestor(repo, h.sha, doc.repo_commit);
            if (anc === true) V("facts", S.facts_file, "הריפו ישן מהעובדות", "checkout is older than facts.json", `facts.json was written at ${doc.repo_commit.slice(0, 8)}, the checkout (${h.sha.slice(0, 8)}) is older: pull and re-run`, doc.repo_commit);
            else warnings.push(`facts.json was written at ${String(doc.repo_commit).slice(0, 8)}, checkout is ${h.sha.slice(0, 8)} (values were re-verified against the checkout)`);
          }
        }
      }
    }
  }
  const ent = repoEntities(repo);
  const ctx = { facts: good, privFacts: priv, nonclaims, modelWords: [...ent.names.filter(n => /\d/.test(n) && /\p{L}/u.test(n)), ...ent.words], entities: new Set([...ent.words, ...(F.brands || [])].map(w => fixFinals(w).toLowerCase()).filter(w => w.length >= 2 && !(F.generic_model_words || []).map(g => fixFinals(g).toLowerCase()).includes(w))) };
  const kitMd = new RegExp(cfg.kit_md_regex, "u");
  const R = cfg.rules["extension-prompt"], promptFileRe = new RegExp(R.prompt_file_regex, "iu");
  const measRe = new RegExp(cfg.measurement_section_regex, "iu");
  const kitMds = [], extraPrompts = [];
  const lintFile = (text, r, opts, numOpts) => { violations.push(...lintText(text, r, cfg, opts)); if (numOpts) violations.push(...checkNumbers(text, r, cfg, ctx, numOpts)); };
  const lintHidden = (raw, r, items) => {
    for (const h of items) {
      const base = lineOf(raw, h.offset) - 1, tag = `${r} (${h.kind})`;
      const vs = [...lintText(h.text, tag, cfg, { wordsOnly: !!h.wordsOnly }), ...(h.wordsOnly ? plates(h.text, tag, cfg) : []), ...(h.numbers ? checkNumbers(h.text, tag, cfg, ctx, { rows: h.rows }) : [])];
      for (const v of vs) { v.line += base; violations.push(v); }
    }
  };
  for (const f of files) {
    const r = rel(f), name = path.basename(f), ext = path.extname(f).toLowerCase();
    if (S.binary_ext.includes(ext)) continue;
    const st = fs.statSync(f);
    // the official Google Play badge artwork (unchanged, checked by hash in playBadge) is not copy: its metadata is base64
    const PB = cfg.rules["play-badge"];
    if (PB && name === PB.badge_file && st.size < 1e6 && crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex") === PB.badge_sha256) continue;
    if (st.size > S.max_bytes) { V("scan", r, "קובץ גדול מדי לבדיקה", "file too large to check", `${st.size} bytes (max ${S.max_bytes}): split it or remove it from the kit`, r); continue; }
    const raw = readText(fs.readFileSync(f));
    const known = [...S.html_ext, ...S.md_ext, ...S.json_ext, ...S.code_ext, ...S.text_ext].includes(ext);
    if (raw === null) { if (known) V("scan", r, "הקובץ אינו טקסט UTF-8/UTF-16", "not readable text (UTF-8/UTF-16)", "the lint cannot check it: save it as UTF-8", r); else warnings.push(`${r}: binary file of unknown type, checked by name and hash only`); continue; }
    if (S.plates_only_files.includes(name)) { violations.push(...plates(raw, r, cfg)); continue; }
    if (!(name.normalize("NFC").match(kitMd)) && name !== S.facts_file && promptFileRe.test(name)) extraPrompts.push(r);
    else if (([...S.text_ext, ...S.md_ext].includes(ext) || !known) && !kitMd.test(name.normalize("NFC")) && promptLike(raw, R) && termsOf(R.prompt_signals.slice(0, 1).map(re => ({ re }))).some(t => findTerm(raw, t).length)) extraPrompts.push(r);
    if (S.html_ext.includes(ext)) {
      const text = htmlToText(raw);
      // decorative numerals and slide counters are marked data-nonum by the renderer: excluded from the number check only when they are
      // a 1-2 digit counter ("3", "2/5")
      const skip = [], nonumOk = new RegExp(S.nonum_allowed, "u");
      for (const m of raw.matchAll(/<([a-zA-Z][\w-]*)\b[^>]*\bdata-nonum\b[^>]*>([\s\S]*?)<\/\1\s*>/g))
        if (nonumOk.test(htmlToText(m[2]).replace(new RegExp(INVISIBLE.source, "gu"), ""))) skip.push([m.index, m.index + m[0].length]);
      const secs = [...raw.matchAll(/<section\b[\s\S]*?<\/section\s*>/gi)].map(m => [m.index, m.index + m[0].length]);
      const blocks = secs.length ? secs : paragraphs(text);
      lintFile(text, r, { blocks, freeBlocks: secs.length ? secs : undefined }, { skipRanges: skip, blocks: secs.length ? secs : undefined, rows: rowRanges(raw) });
      // the same text with every tag joined, and with bidi-override elements reversed (word rules only)
      const joined = htmlToText(raw, { joinAll: true });
      violations.push(...lintText(joined, r + " (tags joined)", cfg, { wordsOnly: true }).map(v => ({ ...v, file: r })));
      const bidi = bidiOverrideRanges(raw);
      if (bidi.length) violations.push(...lintText(reverseRanges(text, bidi), r, cfg, { wordsOnly: true }).map(v => ({ ...v, detail: v.detail + " (bidi override, as displayed)" })));
      lintHidden(raw, r, htmlHidden(raw));
    } else if (S.json_ext.includes(ext)) {
      let j; try { j = JSON.parse(raw); } catch { warnings.push(`${r}: not valid JSON, scanned as text`); }
      if (j !== undefined) {
        const t = jsonToText(j, new Set(S.json_skip_keys), S.json_skip_key_values || {});
        const blocks = paragraphs(t.copy);
        const vs = [...lintText(t.copy, r, cfg, { blocks, freeBlocks: t.top, plateText: t.all, noWords: true }), ...checkNumbers(t.copy, r, cfg, ctx, { blocks }), ...lintText(t.all, r, cfg, { wordsOnly: true })];
        for (const v of vs) { const i = v.match ? raw.indexOf(v.match) : -1; v.line = i >= 0 ? lineOf(raw, i) : 0; violations.push(v); }
      } else lintFile(raw, r, { blocks: paragraphs(raw) }, {});
    } else if (S.md_ext.includes(ext)) {
      const { sections, codes } = mdStructure(raw);
      const skip = codes.filter(c => new RegExp(F.command_fence_langs, "i").test(c.lang)).map(c => [c.start, c.end]);
      const measurement = sections.filter(s => measRe.test(s.heading.trim())).map(s => [s.start, s.end]);
      lintFile(raw, r, { blocks: paragraphs(raw), measurement }, { skipRanges: skip });
      if (kitMd.test(name.normalize("NFC"))) kitMds.push({ raw, r });
      else violations.push(...publishClicks(raw, cfg).map(h => mkV("extension-prompt", cfg, r, raw, h.start, h.end, { detail: `publish/confirm instruction outside the prompt: "${raw.slice(h.start, h.end)}"` })));
    } else if (S.code_ext.includes(ext)) {
      // code: only string literals are copy (identifiers like best_frame are not); the banned asset also in comments
      for (const t of banned) for (const h of findTerm(raw, t)) violations.push(mkV("banned-asset", cfg, r, raw, h.start, h.end, { detail: `term "${termLabel(t)}"` }));
      // a literal that holds markup (an HTML template in gen.py) is read like HTML: visible text, hidden text; CSS sizes are not copy
      const items = [];
      for (const s of stringLiterals(raw)) {
        if (/<[a-zA-Z][\w:-]*[\s>\/]/.test(s.text)) {
          items.push({ offset: s.start, text: htmlToText(s.text), kind: "string (markup)", numbers: true, rows: rowRanges(s.text) });
          items.push({ offset: s.start, text: htmlToText(s.text, { joinAll: true }), kind: "string (markup)", numbers: false, wordsOnly: true });
          for (const h of htmlHidden(s.text)) items.push({ ...h, offset: s.start, kind: "string " + h.kind });
        } else items.push({ offset: s.start, text: s.text, kind: "string", numbers: HEB_RE.test(s.text), wordsOnly: !HEB_RE.test(s.text) });
      }
      lintHidden(raw, r, items);
    } else {
      lintFile(raw, r, { blocks: paragraphs(raw) }, {});
      violations.push(...publishClicks(raw, cfg).map(h => mkV("extension-prompt", cfg, r, raw, h.start, h.end, { detail: `publish/confirm instruction outside the prompt: "${raw.slice(h.start, h.end)}"` })));
    }
  }
  violations.push(...playBadge(dir, files.map(rel), cfg));
  if (!kitMds.length) V("extension-prompt", ".", "חסר קובץ ערכת-תוכן-שבועית-N.md", "missing ערכת-תוכן-שבועית-N.md", "the kit must contain its weekly kit markdown with exactly one extension prompt");
  for (const k of kitMds) violations.push(...lintPrompt(k.raw, k.r, cfg, { extraPrompts: kitMds.length > 1 ? [...extraPrompts, ...kitMds.filter(x => x !== k).map(x => x.r)] : extraPrompts }));
  for (const p of extraPrompts) { const raw = readText(fs.readFileSync(path.join(dir, p))) || ""; violations.push(...checkPromptBody(raw, 0, raw.length, p, cfg, `prompt file ${p}`)); }
  return { violations: dedupe(violations), warnings, info, files: files.map(rel), facts: factsCount };
}
// Google Play badge (Dudu 2026-10-22): every post (a <section> of src/kit.html) and every reel composition (its end card) shows the
// unchanged official badge and "זמינה להורדה"; rendered files whose source is missing cannot be checked and fail
function playBadge(dir, rels, cfg) {
  const R = cfg.rules["play-badge"], out = [];
  if (!R) return out;
  const V = (file, detail, snip = "") => out.push({ rule: "play-badge", file, line: 0, he: R.he, en: R.en, detail, snippet: snip });
  const posix = rels.map(r => r.split(path.sep).join("/"));
  const postRe = new RegExp(R.post_html_regex, "u"), reelRe = new RegExp(R.reel_html_regex, "u");
  const want = normalize(R.text).replace(/\s+/g, " ");
  const hasText = html => normalize(htmlToText(html)).replace(/\s+/g, " ").includes(want);
  const refs = html => [...html.matchAll(/\bsrc\s*=\s*["']([^"']+)["']/gi)].map(m => m[1]).filter(u => path.posix.basename(u.split(/[?#]/)[0]) === R.badge_file);
  const checked = new Set();
  const checkFile = (r, ref) => {
    if (/^[a-z]+:|^\/\//i.test(ref)) { V(r, `the badge must be the local copy of ${R.badge_file}, not ${ref}`, ref); return; }
    const f = path.join(dir, path.posix.dirname(r), ref);
    const key = path.resolve(f); if (checked.has(key)) return; checked.add(key);
    if (!fs.existsSync(f)) { V(r, `${ref} is missing next to ${r}: copy content-factory/render/assets/${R.badge_file}`, ref); return; }
    const h = crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
    if (h !== R.badge_sha256) V(r, `${ref} is not the official badge artwork (sha256 differs): copy content-factory/render/assets/${R.badge_file} unchanged`, ref);
  };
  const posts = posix.filter(r => postRe.test(r)), reels = posix.filter(r => reelRe.test(r));
  for (const r of posts) {
    const raw = readText(fs.readFileSync(path.join(dir, r))) || "";
    const secs = [...raw.matchAll(/<section\b[^>]*>[\s\S]*?<\/section\s*>/gi)];
    if (!secs.length) V(r, "no <section> posts found: render the posts with render/build.mjs");
    for (const m of secs) {
      const id = (m[0].match(/\bid\s*=\s*["']([^"']+)["']/i) || [])[1] || `section at line ${lineOf(raw, m.index)}`;
      const rs = refs(m[0]);
      if (!rs.length) V(r, `${id}: no Google Play badge (img src="${R.badge_file}")`, id);
      else rs.forEach(x => checkFile(r, x));
      if (!hasText(m[0])) V(r, `${id}: the text "${R.text}" is missing next to the badge`, id);
    }
  }
  for (const r of reels) {
    const raw = readText(fs.readFileSync(path.join(dir, r))) || "";
    const rs = refs(raw);
    if (!rs.length) V(r, `reel end card has no Google Play badge (img src=".../${R.badge_file}")`, r);
    else rs.forEach(x => checkFile(r, x));
    if (!hasText(raw)) V(r, `reel end card is missing the text "${R.text}"`, r);
  }
  const pngRe = new RegExp(R.post_png_regex, "u"), mp4Re = new RegExp(R.reel_mp4_regex, "u");
  const pngs = posix.filter(r => !r.includes("/") && pngRe.test(r)), mp4s = posix.filter(r => !r.includes("/") && mp4Re.test(r));
  if (pngs.length && !posts.length) V(".", `${pngs.length} post image(s) but no src/kit.html: render with render/build.mjs so the badge can be checked`, pngs.join(", "));
  if (mp4s.length && !reels.length) V(".", `${mp4s.join(", ")} has no reel source (src/reel/index.html): the end card badge cannot be checked`, mp4s.join(", "));
  return out;
}
function dedupe(vs) {
  const seen = new Set(), out = [];
  // text hits found by several passes (plain, joined tags, hidden text) are one report; facts.json / file-level reports (no match) keep
  // every distinct detail (one fact can break several rules)
  for (const v of vs) { const k = [v.rule, v.file, v.line, normalize(v.match || v.snippet || "").replace(/\s+/g, ""), v.match ? "" : v.detail || ""].join("|"); if (seen.has(k)) continue; seen.add(k); out.push(v); }
  return out;
}

function report(res, dir, asJson) {
  if (asJson) { console.log(JSON.stringify(res, null, 1)); return; }
  const v = res.violations;
  console.log(`לוחית content lint · ${dir}`);
  console.log(`files scanned: ${res.files.length} · facts: ${res.facts} · violations: ${v.length} · warnings: ${res.warnings.length}`);
  const by = {};
  for (const x of v) (by[x.rule] ||= []).push(x);
  for (const [rule, list] of Object.entries(by)) {
    console.log(`\n✗ ${rule} (${list.length})`);
    for (const x of list.slice(0, 60)) console.log(`  ${x.file}:${x.line}  ${x.he} / ${x.en}\n      ${x.detail ? x.detail + " · " : ""}«${x.snippet}»`);
    if (list.length > 60) console.log(`  … and ${list.length - 60} more`);
  }
  for (const w of res.warnings) console.log(`! warning: ${w}`);
  for (const i of res.info || []) console.log(`i ${i}`);
  console.log(v.length ? "\nFAIL: לא למסור את הערכה עד שכל ההפרות מתוקנות / do not deliver this kit until every violation is fixed." : "\nPASS: הערכה עומדת בכללים / kit passes all rules.");
}

// ---------- selftest ----------
const SELFTEST_NOW = Date.parse("2026-10-22T08:00:00Z");
function writeKit(root, name, files) {
  const d = path.join(root, name); fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true });
  for (const [p, c] of Object.entries(files)) { const fp = path.join(d, p); fs.mkdirSync(path.dirname(fp), { recursive: true }); fs.writeFileSync(fp, typeof c === "string" ? c : c.base64 !== undefined ? Buffer.from(c.base64, "base64") : c.utf16 !== undefined ? Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(c.utf16, "utf16le")]) : c.repeat !== undefined ? c.repeat.text.repeat(c.repeat.times) : c.copy !== undefined ? fs.readFileSync(c.copy) : JSON.stringify(c, null, 1)); }
  return d;
}
// a tiny git repo from fixtures/repo with two commits: 2026-10-03 (petrol 8.27) and 2026-10-21 (petrol 7.77); plus an old clone at the first
function gitFixture(root) {
  const g = path.join(root, "git-repo"), old = path.join(root, "git-old"), shallow = path.join(root, "git-shallow");
  for (const d of [g, old, shallow]) fs.rmSync(d, { recursive: true, force: true });
  fs.cpSync(path.join(HERE, "fixtures/repo"), g, { recursive: true });
  const env = d => ({ ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d });
  const git = (args, d) => execFileSync("git", ["-C", g, ...args], { env: env(d), stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" }).trim();
  const fuel = JSON.parse(fs.readFileSync(path.join(g, "fuel.json"), "utf8"));
  fs.writeFileSync(path.join(g, "fuel.json"), JSON.stringify({ ...fuel, petrol95: 8.27, checked: "2026-10-03" }));
  git(["init", "-q"], "2026-10-03T06:00:00Z"); git(["add", "-A"], "2026-10-03T06:00:00Z"); git(["commit", "-q", "-m", "a"], "2026-10-03T06:00:00Z");
  const rev1 = git(["rev-parse", "HEAD"], "2026-10-03T06:00:00Z");
  fs.writeFileSync(path.join(g, "fuel.json"), JSON.stringify(fuel));
  git(["commit", "-q", "-am", "b"], "2026-10-21T06:00:00Z");
  const rev2 = git(["rev-parse", "HEAD"], "2026-10-21T06:00:00Z");
  execFileSync("git", ["clone", "-q", g, old], { stdio: "ignore" }); execFileSync("git", ["-C", old, "checkout", "-q", rev1], { stdio: "ignore" });
  execFileSync("git", ["clone", "-q", "--depth", "1", "file://" + g, shallow], { stdio: "ignore" });
  return { g, old, shallow, rev1, rev2 };
}
function selftest() {
  const cfg = loadConfig();
  const cases = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/selftest-cases.json"), "utf8"));
  let fail = 0, n = 0;
  const ck = (cond, msg) => { n++; if (!cond) { fail++; console.log("  ✗ " + msg); } };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "luchit-lint-selftest-"));
  console.log("1. text cases (fixtures/selftest-cases.json: text)");
  for (const c of cases.text) {
    const v = c.html ? lintHtmlString(c.text, cfg) : lintText(c.text, "case", cfg, {});
    const rules = new Set(v.map(x => x.rule));
    if (c.expect) ck(rules.has(c.expect), `expected ${c.expect}: ${JSON.stringify(c.text)} -> ${[...rules].join(",") || "clean"}`);
    else ck(!v.length, `expected clean: ${JSON.stringify(c.text)} -> ${v.map(x => x.rule + ":" + x.detail).join("; ")}`);
  }
  console.log("2. prompt cases");
  for (const c of cases.prompt) {
    const v = lintPrompt(c.md, "prompt.md", cfg);
    if (c.expect) ck(v.length > 0, `expected prompt violation: ${c.name}`); else ck(v.length === 0, `expected clean prompt: ${c.name} -> ${v.map(x => x.detail).join("; ")}`);
  }
  console.log("3. kit cases (numbers, facts, files, renderer; fixtures/selftest-cases.json: kits)");
  const G = gitFixture(tmp);
  const sub = s => typeof s === "string" ? s.replaceAll("@REV1@", G.rev1).replaceAll("@REV2@", G.rev2).replaceAll("@TMP@", tmp).replaceAll("@FACTORY@", HERE) : s;
  const deep = o => JSON.parse(sub(JSON.stringify(o)));
  for (const c of cases.kits) {
    const facts = deep(c.only_facts ? c.facts : [...cases.base_facts, ...(c.facts || [])]);
    const md = cases.kit_md.replace("@COPY@", (c.copy || []).join("\n> ")).replace("@MD_EXTRA@", c.md_extra || "").replace("@PROMPT@", c.prompt ?? cases.kit_prompt);
    const files = { "ערכת-תוכן-שבועית-9.md": md, "facts.json": JSON.stringify({ kit: 9, repo_commit: sub(c.repo_commit ?? null), facts, nonclaims: c.nonclaims || [] }), ...deep(c.files || {}) };
    if (c.no_md) delete files["ערכת-תוכן-שבועית-9.md"];
    const d = writeKit(tmp, "k-" + c.name.replace(/[^\w-]+/g, "_"), files);
    const repo = c.repo === "git" ? G.g : c.repo === "git-old" ? G.old : c.repo === "git-shallow" ? G.shallow : path.join(HERE, "fixtures/repo");
    const res = lintKit(d, { repo, cfg, now: SELFTEST_NOW, allowNonGit: !String(c.repo || "").startsWith("git") });
    const got = new Set(res.violations.map(x => x.rule));
    const show = () => res.violations.map(x => `      ${x.rule} ${x.file}:${x.line} ${x.detail || ""} «${x.snippet}»`).join("\n");
    if (c.expect === "pass") ck(res.violations.length === 0, `kit ${c.name} should pass:\n${show()}`);
    else for (const r of [].concat(c.expect)) ck(got.has(r), `kit ${c.name} should trigger ${r} (${c.why || ""}):\n${show() || "      (clean)"}`);
    for (const dtl of c.expect_detail || []) ck(res.violations.some(x => `${x.detail || ""} ${x.en || ""}`.includes(dtl)), `kit ${c.name} should report "${dtl}":\n${show()}`);
    for (const r of c.not_expect || []) ck(!got.has(r), `kit ${c.name} should not trigger ${r}:\n${show()}`);
    for (const dtl of c.not_detail || []) ck(!res.violations.some(x => (x.detail || "").includes(dtl)), `kit ${c.name} should not report "${dtl}":\n${show()}`);
    for (const fl of c.expect_file || []) ck(res.violations.some(x => String(x.file).startsWith(fl)), `kit ${c.name} should report a violation in ${fl}:\n${show() || "      (clean)"}`);
  }
  console.log("4. fixture kits (fixtures/good-kit must pass, fixtures/bad-kit must fail on every expected rule)");
  const repo = path.join(HERE, "fixtures/repo");
  const good = lintKit(path.join(HERE, "fixtures/good-kit"), { repo, cfg, now: SELFTEST_NOW, allowNonGit: true });
  ck(good.violations.length === 0, "good-kit should pass:\n" + good.violations.map(x => `    ${x.rule} ${x.file}:${x.line} ${x.detail || ""} «${x.snippet}»`).join("\n"));
  const bad = lintKit(path.join(HERE, "fixtures/bad-kit"), { repo, cfg, now: SELFTEST_NOW, allowNonGit: true });
  const got = new Set(bad.violations.map(x => x.rule));
  for (const r of cases.bad_kit_expect) ck(got.has(r), `bad-kit should trigger ${r}`);
  for (const d of cases.bad_kit_expect_details || []) ck(bad.violations.some(x => (x.detail || "").includes(d)), `bad-kit should report "${d}"`);
  console.log("5. the CLI runs through a symlinked path (as in the RUNBOOK: /mnt/project-files -> /mnt/attach/project-files)");
  const link = path.join(tmp, "factory-link");
  try { fs.symlinkSync(HERE, link, "dir"); } catch {}
  const run = args => { try { execFileSync(process.execPath, [path.join(link, "lint.mjs"), ...args], { stdio: "pipe", env: { ...process.env, LUCHIT_LINT_SELFTEST_CHILD: "1" } }); return 0; } catch (e) { return e.status; } };
  ck(run([path.join(HERE, "fixtures/bad-kit"), "--repo", repo]) === 1, "CLI via a symlink must fail bad-kit with exit 1");
  ck(run([]) === 2, "CLI via a symlink with no arguments must exit 2 (usage)");
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\nselftest: ${n - fail}/${n} passed`);
  process.exit(fail ? 1 : 0);
}
// an HTML string linted the way a kit file is (visible text, joined tags, bidi overrides, hidden text)
export function lintHtmlString(raw, cfg = loadConfig()) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "luchit-html-"));
  try {
    fs.writeFileSync(path.join(d, "x.html"), raw);
    const res = lintKit(d, { cfg, now: SELFTEST_NOW, allowNonGit: true });
    return res.violations.filter(v => v.rule !== "extension-prompt" && v.rule !== "facts");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
}

// ---------- cli ----------
const isMain = (() => { try { return !!process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(url.fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) {
  const a = process.argv.slice(2);
  if (a.includes("--selftest")) selftest();
  const opt = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const dir = a.find((x, i) => !x.startsWith("--") && !["--repo", "--config"].includes(a[i - 1]));
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) { console.error("usage: node lint.mjs <kit-folder> --repo <vehicle-app checkout> [--config lint-config.json] [--json] [--allow-stale-checkout]\n       node lint.mjs --selftest"); process.exit(2); }
  const repo = opt("--repo") || process.env.LUCHIT_REPO;
  const cfg = loadConfig(opt("--config"));
  const res = lintKit(dir, { repo, cfg, allowStale: a.includes("--allow-stale-checkout") });
  if (!repo) { res.warnings.push("no --repo given: facts could not be verified against the source"); res.violations.push({ rule: "facts", file: "--repo", line: 0, he: "חסר --repo", en: "no --repo checkout given", detail: "the facts cannot be verified without the vehicle-app checkout", snippet: "" }); }
  report(res, dir, a.includes("--json"));
  process.exit(res.violations.length ? 1 : 0);
}

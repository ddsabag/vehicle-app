// SEO lint for the static site: titles, descriptions, h1, canonical, alt, viewport, OG, JSON-LD, internal links, sitemap, robots.
// Usage: node .github/scripts/seo-check.mjs   (exit 1 on errors; warnings only print)
import fs from "node:fs";
import path from "node:path";
const SITE = "https://luchit.app/";
const errs = [], warns = [];
const E = (p, m) => errs.push(`${p}: ${m}`), W = (p, m) => warns.push(`${p}: ${m}`);
const walk = d => fs.readdirSync(d, {withFileTypes: true}).flatMap(e => e.isDirectory() ? (["node_modules", ".git", "android", "analytics", "worker", "lib"].includes(e.name) ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)]);
const pages = walk(".").filter(f => f.endsWith(".html")).map(f => f.replace(/^\.\//, ""));
const urlOf = f => f === "index.html" ? SITE : f.endsWith("/index.html") ? SITE + f.slice(0, -10) : SITE + f;
const norm = u => { try { const x = new URL(u, SITE); if (x.host !== "luchit.app") return null; let p = x.pathname.replace(/\/+/g, "/").replace(/\/index\.html$/, "/"); return SITE + p.slice(1); } catch { return null; } };
const exists = u => { const p = u.slice(SITE.length); return p === "" || fs.existsSync(p) || fs.existsSync(p + "index.html") || fs.existsSync(p.replace(/\/$/, "")); };
const titles = new Map(), descs = new Map();
const attr = (tag, n) => (tag.match(new RegExp(`\\b${n}="([^"]*)"`)) || [])[1];
const inbound = new Map();
const isStatic = f => f !== "index.html"; // index.html is the app shell: only headline checks
for (const f of pages) {
  const h = fs.readFileSync(f, "utf8"), u = urlOf(f), body = h.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "");
  const title = (h.match(/<title>([^<]*)<\/title>/) || [])[1];
  if (!title) E(f, "missing <title>"); else { if (title.length > 70) W(f, `title ${title.length} chars`); (titles.get(title) || titles.set(title, []).get(title)).push(f); }
  const d = (h.match(/<meta name="description" content="([^"]*)"/) || [])[1];
  if (!d) E(f, "missing meta description"); else { if (d.length < 50) W(f, "short description"); if (d.length > 200) W(f, `description ${d.length} chars`); (descs.get(d) || descs.set(d, []).get(d)).push(f); }
  const can = (h.match(/<link rel="canonical" href="([^"]*)"/) || [])[1];
  if (!can) E(f, "missing canonical"); else if (can !== u) E(f, `canonical ${can} != ${u}`);
  if (!/<meta name="viewport"/.test(h)) E(f, "missing viewport");
  if (!/<html lang="he"/.test(h)) E(f, "missing lang=he");
  for (const p of ["og:title", "og:description", "og:url", "og:image"]) if (!h.includes(`property="${p}"`)) E(f, `missing ${p}`);
  if (!h.includes('name="twitter:card"')) E(f, "missing twitter:card");
  const h1 = (body.match(/<h1[\s>]/g) || []).length;
  if (isStatic(f) && h1 !== 1) E(f, `${h1} <h1> tags`);
  if (isStatic(f)) { // heading order: no h3 before first h2, no skipped level
    let last = 1; for (const m of body.matchAll(/<h([1-6])[\s>]/g)) { const l = +m[1]; if (l > last + 1) W(f, `heading jump h${last}→h${l}`); last = l; }
  }
  for (const m of body.matchAll(/<img\b[^>]*>/g)) if (attr(m[0], "alt") === undefined) E(f, `img without alt: ${(attr(m[0], "src") || "").slice(0, 60)}`);
  // JSON-LD
  for (const m of h.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    let j; try { j = JSON.parse(m[1]); } catch (e) { E(f, "invalid JSON-LD: " + e.message); continue; }
    for (const n of Array.isArray(j) ? j : j["@graph"] || [j]) {
      if (!n["@type"]) E(f, "JSON-LD node without @type");
      if (n["@type"] === "FAQPage" && !(n.mainEntity || []).every(q => q.name && q.acceptedAnswer && q.acceptedAnswer.text)) E(f, "FAQPage malformed");
      if (n["@type"] === "Article" && !(n.headline && n.datePublished)) E(f, "Article missing headline/datePublished");
      if (n["@type"] === "BreadcrumbList" && !(n.itemListElement || []).every((x, i) => x.position === i + 1 && x.name)) E(f, "BreadcrumbList malformed");
    }
  }
  // internal links
  if (isStatic(f)) for (const m of body.matchAll(/<a\b[^>]*?href="([^"#]+)/g)) {
    const n = norm(m[1]); if (!n || n === u) continue;
    if (!exists(n)) E(f, `broken internal link ${m[1]}`);
    (inbound.get(n) || inbound.set(n, new Set()).get(n)).add(u);
  }
}
for (const [t, a] of titles) if (a.length > 1 && a.length < 50) W(a[0], `duplicate title in ${a.length} pages`); else if (a.length >= 50) E(a[0], `title shared by ${a.length} pages`);
for (const [t, a] of descs) if (a.length > 1) E(a[0], `description shared by ${a.length} pages`);
// sitemap
const sm = fs.readFileSync("sitemap.xml", "utf8"), locs = [...sm.matchAll(/<url><loc>([^<]+)<\/loc>(?:<lastmod>([^<]*)<\/lastmod>)?/g)];
const set = new Set(locs.map(x => x[1]));
for (const [l, lm] of locs.map(x => [x[1], x[2]])) { if (!exists(l)) E("sitemap.xml", `url without file ${l}`); if (lm && !/^\d{4}-\d\d-\d\d$/.test(lm)) E("sitemap.xml", `bad lastmod ${l}`); if (lm && lm > new Date().toISOString().slice(0, 10)) E("sitemap.xml", `lastmod in the future ${l}`); }
for (const f of pages) if (!set.has(urlOf(f)) && !/^(404|google)/.test(f)) E(f, "page not in sitemap.xml");
// orphans
for (const f of pages) { const u = urlOf(f); if (u !== SITE && !(inbound.get(u) || []).size) E(f, "orphan page (no inbound link)"); }
// robots
const rb = fs.readFileSync("robots.txt", "utf8");
if (!/Sitemap:\s*https:\/\/luchit\.app\/sitemap\.xml/.test(rb)) E("robots.txt", "no Sitemap line");
if (/Disallow:\s*\/\s*$/m.test(rb)) E("robots.txt", "blocks the whole site");
for (const f of ["manifest.json", "og.png", "icon-192.png", "icon-512.png", "apple-touch-icon.png"]) if (!fs.existsSync(f)) E(f, "referenced file missing");
console.log(`checked ${pages.length} pages, ${locs.length} sitemap urls`);
for (const w of warns.slice(0, 40)) console.log("WARN ", w);
if (warns.length > 40) console.log(`... ${warns.length - 40} more warnings`);
for (const e of errs.slice(0, 80)) console.log("ERROR", e);
if (errs.length > 80) console.log(`... ${errs.length - 80} more errors`);
console.log(`${errs.length} errors, ${warns.length} warnings`);
process.exit(errs.length ? 1 : 0);

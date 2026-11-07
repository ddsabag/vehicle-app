// Battery and equipment from the importers' own spec pages (Dudu 1.11.2026 23:07 UTC "אני רוצה את זה"): the ministry's model data has no
// battery size, electric range or comfort equipment, so a bot reads the Israeli importer's pages and spec PDFs for each model name and keeps,
// per ministry model code and year, only what a quote from a document it fetched shows.
//   targets(catDir, opt)   the model names to read from the catalog-data branch: electric and plug-in (opt.kinds), years >= opt.from,
//                          trims with at least opt.min active cars, most cars first; each {cd, maker, importer, name, n, trims: [{dg, trim, years, cc, fuel, n}]}
//   crawl(g, {browser})    v2: the runner's own browser opens the maker's Israeli site (SITES), the model's pages and their spec PDFs
//   prompt(g, docs)        the request for one model name, with the text we fetched (Claude has no web tools)
//   check(o, g, seen)      the reply against the rules: a trim must be one of the group's codes; every number and every fitted item needs a quote
//                          that is in a fetched document. Returns {rows, held}
//   run({env, api, ...})   reads groups until SPEC_BUDGET (USD, default 2) is spent; writes OUT/specs-extra.json and OUT/specs-review.md
// specs-extra.json: {v, u, fields, eq, codes: {"<tozeret_cd>-<degem_cd>|<year>": {kwh, kwhNet, rangeKm, dcKw, acKw, dcMin, screenIn, wheelIn, eq: [ids], no: [ids], src: [urls], cur}}}
// Public data (the importers' published specs); the log shows counts and URLs only, never money. Never red: an API problem ends the run with what it has.
//   node specs-extra.mjs --selftest   offline
import fs from "node:fs";
import path from "node:path";
import { client, ask, answer } from "./claude.mjs";
import { price } from "./ai-usage.mjs";

export const MODEL = "claude-sonnet-5-5";
// the equipment list: id -> the Hebrew row name the app shows (product, compare "מערכות בטיחות ואבזור" and the car card's "אבזור")
export const EQ = {
  wireless: "טעינה אלחוטית לטלפון", heatFront: "מושבים קדמיים מחוממים", heatRear: "מושבים אחוריים מחוממים", vent: "מושבים מאווררים",
  powerSeat: "מושב נהג חשמלי", seatMemory: "זיכרון למושב הנהג", heatWheel: "הגה מחומם", tailgate: "דלת תא מטען חשמלית",
  cam360: "מצלמת 360", sensors: "חיישני חניה", panorama: "גג פנורמי", sunroof: "חלון גג נפתח", hud: "תצוגה עילית",
  keyless: "כניסה והתנעה ללא מפתח", carplay: "CarPlay / Android Auto אלחוטי", matrix: "פנסי מטריקס / LED אדפטיביים",
  foldMirrors: "מראות מתקפלות חשמלית", rearVents: "פתחי מיזוג אחוריים", row3: "שורת מושבים שלישית", v2l: "הזנת מכשירים מהסוללה (V2L)",
};
// the numbers: field -> [Hebrew name, unit, lowest, highest]
export const NUM = { kwh: ["קיבולת סוללה", "קוט״ש", 5, 200], kwhNet: ["קיבולת שמישה", "קוט״ש", 5, 200], rangeKm: ["טווח חשמלי מוצהר (WLTP)", "ק״מ", 20, 1000],
  dcKw: ["הספק טעינה מהירה", "קילוואט", 10, 500], acKw: ["הספק טעינה ביתית", "קילוואט", 2, 23], dcMin: ["טעינה מהירה 10%-80%", "דקות", 8, 120],
  screenIn: ["מסך מולטימדיה", "אינץ׳", 5, 30], wheelIn: ["חישוקים", "אינץ׳", 14, 23] };
// press, listings and dealers' ads: never a source (the rule is the importer's own page, or the maker's Israeli site)
export const NOT_SOURCES = ["auto.co.il", "carzone.co.il", "icar.co.il", "ice.co.il", "ynet.co.il", "walla.co.il", "mako.co.il", "themarker.com", "calcalist.co.il",
  "globes.co.il", "yad2.co.il", "carsforsale.co.il", "wikipedia.org", "facebook.com", "youtube.com", "instagram.com", "drive.co.il", "maariv.co.il", "kikar.co.il",
  "haaretz.co.il", "israelhayom.co.il", "news1.co.il", "carshow.co.il", "autocar.co.uk", "evdatabase.org", "ev-database.org", "queenoftheroad.co.il", "midrag.co.il", "zap.co.il"];

const host = u => { try { return new URL(u).host.replace(/^www\./, "").toLowerCase(); } catch { return ""; } };
const norm = u => { try { const x = new URL(u); return (x.host.replace(/^www\./, "") + decodeURI(x.pathname).replace(/\/+$/, "")).toLowerCase(); } catch { return ""; } };
export const squash = t => String(t || "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
// a source counts when it is Israeli (.il) or a maker's Israeli section (/il/ or /he/ in the path), and not press or a listing
export const isSource = u => { const h = host(u); if (!h || NOT_SOURCES.some(d => h === d || h.endsWith("." + d))) return false;
  try { const p = new URL(u).pathname.toLowerCase(); return /\.il$/.test(h) || /(^|\/)(il|he|he-il|he_il|iw)(\/|$)/.test(p); } catch { return false; } };

export function targets(catDir, { kinds = ["ev", "phev"], from = 2024, min = 20 } = {}) {
  const meta = JSON.parse(fs.readFileSync(path.join(catDir, "meta.json"), "utf8")).makers, groups = new Map();
  for (const cd of Object.keys(meta)) {
    const p = path.join(catDir, "c", cd + ".json"); if (!fs.existsSync(p)) continue;
    const m = JSON.parse(fs.readFileSync(p, "utf8")), cols = m.cols;
    for (const f of new Set(Object.values(m.degems))) {
      const fp = path.join(catDir, "c", cd, f + ".json"); if (!fs.existsSync(fp)) continue;
      for (const row of JSON.parse(fs.readFileSync(fp, "utf8")).rows) {
        const d = Object.fromEntries(cols.map((c, i) => [c, row[i]]));
        if (d.sug_degem !== "P" || !(d.shnat_yitzur >= from) || !(d.mispar_rechavim_pailim >= min)) continue;
        const fuel = String(d.delek_nm || "").trim(), kind = fuel === "חשמל" ? "ev" : /חשמל/.test(fuel) ? "phev" : /היבריד|משולב/.test(String(d.technologiat_hanaa_nm || "")) ? "hybrid" : "ice";
        if (!kinds.includes(kind)) continue;
        const name = String(d.kinuy_mishari || "").trim().toUpperCase(), k = cd + "|" + name;
        const g = groups.get(k) || { cd: +cd, maker: m.n, importer: String(d.shem_yevuan || "").trim(), name, kind, n: 0, trims: [] };
        let t = g.trims.find(x => x.dg === d.degem_cd);
        if (!t) g.trims.push(t = { dg: d.degem_cd, trim: String(d.ramat_gimur || "").trim(), years: [], cc: d.nefah_manoa || 0, fuel, n: 0 });
        if (!t.years.includes(d.shnat_yitzur)) t.years.push(d.shnat_yitzur);
        t.n += d.mispar_rechavim_pailim; g.n += d.mispar_rechavim_pailim; groups.set(k, g);
      }
    }
  }
  return [...groups.values()].map(g => ({ ...g, trims: g.trims.map(t => ({ ...t, years: t.years.sort() })).sort((a, b) => b.n - a.n) })).sort((a, b) => b.n - a.n);
}

// v2 (Dudu 2.11.2026 04:01 UTC, card "כן, עד 2$ לניסיון"): the pilot's web tools could not open most importer sites, so the runner reads
// them itself in a real browser, starting from each maker's Israeli site below, and Claude only reads the text we fetched (no web tools).
// A seed site counts only when its home page names the importer or the brand (a parked or wrong domain is skipped).
export const SITES = {
  1014: ["https://www.byd.co.il/", "https://bydauto.co.il/"], 1604: ["https://jaecoo.co.il/"], 1605: ["https://omoda.co.il/"],
  1547: ["https://heyxpeng.co.il/"], 1450: ["https://cheryisrael.co.il/"], 443: ["https://mg-israel.co.il/"],
  1327: ["https://www.tesla.com/he_il/"], 1417: ["https://www.tesla.com/he_il/"], 1634: ["https://www.changan.co.il/"],
  1556: ["https://www.zeekrlife.com/he-il/"], 1465: ["https://dongfeng.co.il/"], 1436: ["https://leapmotor.co.il/"],
  // hybrids (7.11.2026; the brand check skips a seed that is not the brand's)
  481: ["https://www.hyundai.co.il/"], 253: ["https://www.hyundai.co.il/"], 413: ["https://www.toyota.co.il/"], 672: ["https://www.toyota.co.il/"],
  839: ["https://www.toyota.co.il/"], 488: ["https://www.toyota.co.il/"], 885: ["https://kia-israel.co.il/"], 416: ["https://kia-israel.co.il/"],
  299: ["https://www.suzuki.co.il/"], 683: ["https://www.suzuki.co.il/"], 404: ["https://www.lexus.co.il/"], 637: ["https://www.nissan.co.il/"],
  675: ["https://www.renault.co.il/"], 312: ["https://honda.co.il/"], 351: ["https://www.dacia.co.il/"],
};
// a model's own page when the maker's site has none or hides it (the importer group's new-car catalogue, or the maker's model page)
export const MODEL_URLS = {
  "1014|SEALION 5": ["https://www.shlomo.co.il/new/catalog/Sealion-5/8/", "https://www.shlomo.co.il/leasing/catalog/sealion-5-dm/SA2H0C", "https://www.shlomo.co.il/leasing/catalog/SEALION-5/SA2H0D"],
  "1604|JAECOO7 PHEV": ["https://jaecoo.co.il/models/jaecoo7/", "https://jaecoo.co.il/purchase/jaecoo7/", "https://jaecoo.co.il/prices-list/"],
  "1604|JAECOO 7 PHEV": ["https://jaecoo.co.il/models/jaecoo7/", "https://jaecoo.co.il/purchase/jaecoo7/", "https://jaecoo.co.il/prices-list/"],
  "1605|OMODA 7 PHEV": ["https://omoda.co.il/models/omoda7/", "https://omoda.co.il/purchase/omoda7/"],
  "404|LEXUS NX350H": ["https://www.lexus.co.il/new-cars/nx", "https://www.lexus.co.il/new-cars/nx/build"],
  "1327|MODEL Y": ["https://www.tesla.com/he_il/modely"], "1417|MODEL Y": ["https://www.tesla.com/he_il/modely"],
};
const BRAND = { 1014: "byd", 1604: "jaecoo", 1605: "omoda", 1547: "xpeng", 1450: "chery", 443: "mg", 1327: "tesla", 1417: "tesla", 1634: "deepal", 1556: "zeekr", 1465: "dongfeng", 1436: "leapmotor", 481: "hyundai", 253: "hyundai", 413: "toyota", 672: "toyota", 839: "toyota", 488: "toyota", 885: "kia", 416: "kia", 299: "suzuki", 683: "suzuki", 404: "lexus", 637: "nissan", 675: "renault", 312: "honda", 351: "dacia" };
export const PAGE_CAP = 8, PDF_CAP = 4, DOC_CHARS = 30000, ALL_CHARS = 80000;
const SPEC_WORDS = /spec|brochure|technical|catalog|pricelist|price-list|מפרט|מחירון|קטלוג|ברושור/i;
// the model name as it appears in a link: "SEALION 5" -> "sealion5", "JAECOO7 PHEV" -> "jaecoo7", "MODEL Y" -> "modely"
// (a name that is too short without them keeps them: "FX EV" -> "fxev", so the FX HEV pages are not the FX EV's)
export const token = name => { const k = squash(String(name).replace(/\b(PHEV|EV|DM-?I|EM-?I|BYD|PLUG-?IN|HEV|HYBRID|HSD|HV|LEXUS)\b/gi, "")); return k.length >= 3 || /\d/.test(k) ? k : squash(name); };
export const linkFits = (g, href, text) => { const k = token(g.name); if (k.length < 2) return false; let h = String(href || ""); try { h = decodeURI(h); } catch {}
  return squash(h).includes(k) || squash(text).includes(k); };

// the pages for one model: seeds -> links and the sitemap -> pages whose link names the model -> PDFs on those pages
export async function crawl(g, { browser, log = () => {}, pdfText }) {
  const seeds = SITES[g.cd] || [], docs = [], seenUrl = new Set(), ctx = await browser.newContext({ locale: "he-IL",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" });
  const brandWords = [BRAND[g.cd], squash(String(g.importer || "").split(/\s+/)[0]), squash(String(g.maker || "").split(/\s+/)[0])].filter(w => w && w.length > 1);
  const open = async url => { const page = await ctx.newPage();
    try { await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(async e => { if (!/Timeout/i.test(String(e.message))) throw e;
        log(`specs: ${new URL(url).host}: slow, waiting for the first bytes only`); await page.goto(url, { waitUntil: "commit", timeout: 60000 }); await page.waitForTimeout(15000); }); await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
      // text of every element, hidden tabs and accordions too, one line per block
      const grab = () => { const out = []; const skip = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "TEMPLATE"]);
        const walk = n => { for (const c of n.childNodes) { if (c.nodeType === 3) { const t = c.textContent.replace(/\s+/g, " ").trim(); if (t) out.push(t); }
          else if (c.nodeType === 1 && !skip.has(c.tagName)) { walk(c); if (/^(DIV|P|LI|TR|TD|TH|H\d|SECTION|ARTICLE|DT|DD|BR|TABLE)$/.test(c.tagName)) out.push("\n"); } } };
        walk(document.body || document.documentElement);
        return { text: out.join(" ").replace(/ *\n[\n ]*/g, "\n"), links: [...document.querySelectorAll("a[href]")].map(a => [a.href, (a.textContent || "").trim().slice(0, 80)])
          .concat([...document.querySelectorAll("iframe[src],embed[src],object[data]")].map(e => [e.src || e.data, "embed"])) }; };
      // a price list or spec table is often inside an iframe: its text counts as the page's
      const r = { text: "", links: [] };
      for (const f of page.frames()) { const x = await f.evaluate(grab).catch(() => null); if (x) { r.text += (r.text ? "\n" : "") + x.text; r.links.push(...x.links); } }
      return { url: page.url(), ...r };
    } catch (e) { log(`specs: ${new URL(url).host}: ${String(e.message || e).split("\n")[0].slice(0, 80)}`); return null; } finally { await page.close().catch(() => {}); } };
  const sitemap = async base => { const out = [];
    for (const p of ["sitemap.xml", "sitemap_index.xml", "wp-sitemap.xml", "page-sitemap.xml"]) {
      try { const r = await ctx.request.get(new URL(p, base).href, { timeout: 20000 }); if (!r.ok()) continue; const x = await r.text();
        for (const m of x.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) out.push(m[1]); } catch {} }
    return out; };
  try {
    for (const url of MODEL_URLS[g.cd + "|" + g.name] || []) {
      const p = await open(url); if (!p) continue;
      if (!brandWords.some(w => squash(p.text).includes(w))) { log(`specs: ${host(p.url)}: the model page names neither the brand nor the importer, skipped`); continue; }
      seenUrl.add(norm(url)); seenUrl.add(norm(p.url)); docs.push({ url: p.url, kind: "page", text: p.text });
      for (const [h, t] of p.links) if (/\.pdf(\?|$)/i.test(h) && (linkFits(g, h, t) || SPEC_WORDS.test(h + " " + t))) {
        const u = h.split("#")[0]; if (seenUrl.has(norm(u))) continue; seenUrl.add(norm(u));
        try { const r = await ctx.request.get(u, { timeout: 60000 }); if (r.ok()) { const text = await pdfText(await r.body()); if (text) docs.push({ url: u, kind: "pdf", text }); } } catch {}
      }
    }
    for (const seed of seeds) {
      const home = await open(seed); if (!home) continue;
      const host0 = host(home.url), sq = squash(home.text);
      if (!brandWords.some(w => sq.includes(w))) { log(`specs: ${host0}: the home page names neither the brand nor the importer, skipped (${home.text.length} chars: ${home.text.replace(/\s+/g, " ").slice(0, 100)})`); continue; }
      let cand = home.links.filter(([h]) => host(h) === host0 || host(h).endsWith("." + host0.split(".").slice(-3).join(".")));
      for (const loc of await sitemap(home.url)) if (/sitemap/i.test(loc) && /\.xml/i.test(loc)) {
        try { const r = await ctx.request.get(loc, { timeout: 20000 }); if (r.ok()) for (const m of (await r.text()).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) cand.push([m[1], ""]); } catch {}
      } else cand.push([loc, ""]);
      if (linkFits(g, home.url, "")) cand.unshift([home.url, ""]);
      const pages = [...new Map(cand.filter(([h, t]) => /^https?:/.test(h) && !/\.(jpe?g|png|webp|svg|mp4)(\?|$)/i.test(h) && linkFits(g, h, t)).map(([h]) => [h.split("#")[0], 1])).keys()];
      log(`specs: ${host0}: home ${home.text.length} chars, ${cand.length} links, ${pages.length} name the model`);
      // nothing named the model: show the site's short model-like addresses, to write MODEL_URLS from
      if (!pages.length) log(`specs: ${host0}: sample links: ${[...new Set(cand.map(([h]) => { try { const u = new URL(h); return host(h) === host0 && u.pathname.split("/").filter(Boolean).length <= 3 ? decodeURI(u.pathname) : ""; } catch { return ""; } }).filter(x => x.length > 1))].slice(0, 40).join(" ")}`);
      // the model's name in the address first, then spec words, then the shortest address
      const rank = h => (squash(h).includes(token(g.name)) ? 2 : 0) + (SPEC_WORDS.test(h) ? 1 : 0);
      pages.sort((a, b) => rank(b) - rank(a) || a.length - b.length);
      const pdfs = new Set(pages.filter(h => /\.pdf(\?|$)/i.test(h)));
      for (const url of pages.filter(h => !/\.pdf(\?|$)/i.test(h))) {
        if (docs.filter(d => d.kind === "page").length >= PAGE_CAP) break; if (seenUrl.has(norm(url))) continue; seenUrl.add(norm(url));
        const p = await open(url); if (!p) continue;
        docs.push({ url: p.url, kind: "page", text: p.text });
        for (const [h, t] of p.links) if (/\.pdf(\?|$)/i.test(h) && (linkFits(g, h, t) || SPEC_WORDS.test(h + " " + t))) pdfs.add(h.split("#")[0]);
      }
      for (const url of [...pdfs].slice(0, PDF_CAP)) {
        if (seenUrl.has(norm(url))) continue; seenUrl.add(norm(url));
        try { const r = await ctx.request.get(url, { timeout: 60000 }); if (!r.ok()) continue; const text = await pdfText(await r.body()); if (text) docs.push({ url, kind: "pdf", text }); }
        catch (e) { log(`specs: pdf: ${String(e.message || e).slice(0, 80)}`); }
      }
    }
  } finally { await ctx.close().catch(() => {}); }
  return trimDocs(docs);
}
// a site repeats its menus on every page: keep each line once, the model pages first, each document and the whole within the caps
export function trimDocs(docs) {
  const lines = new Set(), out = []; let all = 0;
  for (const d of docs) {
    const keep = []; let n = 0;
    for (const l of String(d.text).split("\n").map(x => x.replace(/\s+/g, " ").trim()).filter(Boolean)) {
      const k = squash(l); if (!k || lines.has(k)) continue; lines.add(k); if (n + l.length > DOC_CHARS || all + n + l.length > ALL_CHARS) break; keep.push(l); n += l.length + 1;
    }
    if (keep.length) { out.push({ ...d, text: keep.join("\n") }); all += n; }
    if (all >= ALL_CHARS) break;
  }
  return out;
}

export function prompt(g, docs = []) {
  return [
    `Below is text we copied from the Israeli importer's site (${g.importer || "the importer"}) for the ${g.maker} ${g.name} (${g.kind === "ev" ? "electric" : "plug-in hybrid"}).`,
    "Use only this text. Equipment differs by market and by trim; never add what you know from elsewhere.",
    "",
    "The Ministry of Transport lists these trims (code: trim name, model years, engine cc). Match each trim in the text to ONE code:",
    ...g.trims.map(t => `- ${t.dg}: ${t.trim || "(no trim name)"}, ${t.years.join("/")}, ${t.cc || 0} cc`),
    "",
    "For each code you can match with confidence, report what the text says:",
    `- numbers: ${Object.entries(NUM).map(([k, [he, u]]) => `${k} (${he}, ${u})`).join("; ")}`,
    `- equipment fitted as standard (true) or stated as not fitted (false); leave out what the text does not state: ${Object.entries(EQ).map(([k, he]) => `${k} (${he})`).join("; ")}`,
    "Every number and every true/false needs a quote: a short passage copied exactly from the text below, with the URL of its document.",
    "Write each quote once, in the top-level quotes list, with every code it is for in dg (a list); do not repeat it inside the trims.",
    "A quote must contain the number itself, or the equipment's name as the text writes it. Do not guess, do not convert units, do not use optional packages.",
    "year: the model year the document states for that trim, or null when it states none.",
    `The importer's pages describe the cars on sale now. When a document states no year, match the trim by its name to the code whose years include the latest year (${new Date().getUTCFullYear() - 1} or ${new Date().getUTCFullYear()}) and set year to null; leave out older codes.`,
    "When the text gives one column for several codes (for example \"69/68\"), report the same values for each of those codes.",
    "When the text does not let you tell which code a trim is, put the code in unsure with the reason. Keep each quote short (under 120 characters).",
    "",
    'Answer with JSON only: {"trims":[{"dg":<code>,"year":<year or null>,"num":{"kwh":<n>,...},"eq":{"wireless":true,...}}],"quotes":[{"f":"kwh","dg":[<code>,...],"url":"...","text":"..."}],"unsure":[{"dg":<code>,"why":"..."}]}',
    "",
    ...docs.map((d, i) => `=== DOCUMENT ${i + 1} (${d.kind}): ${d.url} ===\n${d.text}`),
  ].join("\n");
}

export function parse(text) {
  const m = String(text || "").match(/\{[\s\S]*\}/); if (!m) return null;
  try { const o = JSON.parse(m[0]); return o && Array.isArray(o.trims) ? o : null; } catch { return null; }
}

// the documents we fetched ourselves: url -> squashed text. own: the URL must be one of them (they came from the maker's Israeli site)
export const own = docs => ({ own: true, pages: new Map(docs.map(d => [norm(d.url), squash(d.text)])), cited: [] });
// the pilot's web-fetch results (v1 data in specs-extra.json was checked this way)
export function fetched(contents) {
  const pages = new Map(), cited = [];
  for (const content of contents) for (const b of content || []) {
    if (b && b.type === "web_fetch_tool_result" && b.content && b.content.type === "web_fetch_result") {
      const src = b.content.content && b.content.content.source;
      pages.set(norm(b.content.url), (pages.get(norm(b.content.url)) || "") + (src && src.type === "text" ? squash(src.data) : ""));
    }
    if (b && b.type === "text") for (const c of b.citations || []) if (c.cited_text) cited.push({ url: norm(c.url || ""), t: squash(c.cited_text) });
  }
  return { pages, cited };
}
const onPage = (q, seen) => { const t = squash(q.text), u = norm(q.url), page = seen.pages.get(u);
  if (t.length < 4 || page === undefined) return false;
  return page.includes(t) || seen.cited.some(c => (!c.url || c.url === u) && c.t.includes(t)); };
// a number is shown by a quote that holds it (12.9 also as 12,9)
const holds = (q, v) => { const s = String(q.text || ""); return [String(v), String(v).replace(".", ",")].some(x => new RegExp(`(^|[^0-9.,])${x.replace(/\./g, "\\.")}([^0-9]|$)`).test(s)); };

// year: the document's year when it is one of the code's years; with no year stated, the code's latest year when that is this year or last
// year (the importer's current page is the current model), marked cur
export function check(o, g, seen, { now = new Date() } = {}) {
  const rows = {}, held = [], codes = new Map(g.trims.map(t => [t.dg, t])), thisYear = now.getUTCFullYear();
  for (const u of (o.unsure || []).slice(0, 40)) if (u && codes.has(+u.dg)) held.push({ dg: +u.dg, why: String(u.why || "unsure").slice(0, 160) });
  for (const t of (o.trims || []).slice(0, 40)) {
    const dg = +(t && t.dg), tr = codes.get(dg); if (!tr) { held.push({ dg: t && t.dg, why: "not one of the model's codes" }); continue; }
    const latest = Math.max(...tr.years), stated = t.year !== null && t.year !== undefined && t.year !== "";
    const years = stated ? (tr.years.includes(+t.year) ? [+t.year] : []) : (latest >= thisYear - 1 ? [latest] : []);
    if (!years.length) { held.push({ dg, why: stated ? `the page is for ${t.year}, the codes are ${tr.years.join("/")}` : `no year on the page, and the code's latest year is ${latest}` }); continue; }
    const srcOk = q => seen.own ? seen.pages.has(norm(q.url)) : isSource(q.url);
    const shared = (Array.isArray(o.quotes) ? o.quotes : []).filter(q => q && Array.isArray(q.dg) && q.dg.map(Number).includes(dg));   // a quote written once for several codes
    const quotes = (Array.isArray(t.quotes) ? t.quotes : []).concat(shared).filter(q => q && typeof q.url === "string" && typeof q.text === "string" && srcOk(q) && onPage(q, seen));
    const by = f => quotes.filter(q => q.f === f), row = { eq: [], no: [], src: [] }, drop = [];
    for (const [f, [, , lo, hi]] of Object.entries(NUM)) {
      const v = t.num && t.num[f]; if (v === undefined || v === null) continue;
      const q = by(f).find(q => holds(q, v));
      if (typeof v === "number" && v >= lo && v <= hi && q) { row[f] = v; row.src.push(q.url); } else drop.push(f);
    }
    for (const [f, v] of Object.entries(t.eq || {})) {
      if (!(f in EQ) || typeof v !== "boolean") continue;
      const q = by(f)[0]; if (q) { (v ? row.eq : row.no).push(f); row.src.push(q.url); } else drop.push(f);
    }
    row.src = [...new Set(row.src)]; if (!stated) row.cur = true;
    if (drop.length) held.push({ dg, why: "no quote in the fetched text for " + drop.join(", ") });
    if (row.src.length) for (const y of years) rows[`${g.cd}-${dg}|${y}`] = Object.fromEntries(Object.entries(row).filter(([k, v]) => !Array.isArray(v) || v.length || k === "eq"));
  }
  return { rows, held };
}

// pdftotext from poppler (the workflow installs it); "" when it is missing or the file is not a PDF
export async function pdfText(buf) {
  const { execFileSync } = await import("node:child_process"), os = await import("node:os");
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pdf-")), "a.pdf"); fs.writeFileSync(f, buf);
  try { return execFileSync("pdftotext", ["-layout", "-enc", "UTF-8", f, "-"], { maxBuffer: 64 << 20 }).toString(); } catch { return ""; }
}

// SPEC_ONLY: "cd|NAME,cd|NAME" limits the run to those model names. SPEC_ASK=0 fetches and logs the documents only (no Claude, no cost)
export async function run({ env = process.env, api, groups, log = console.log, fetchDocs } = {}) {
  const out = env.OUT || "out", budget = +(env.SPEC_BUDGET || 2), limit = +(env.SPEC_MAX || 400), askOn = env.SPEC_ASK !== "0";
  fs.mkdirSync(out, { recursive: true });
  const prevFile = path.join(out, "specs-extra.json"); let prev = null; try { prev = JSON.parse(fs.readFileSync(prevFile, "utf8")); } catch {}
  const file = { v: 2, u: new Date().toISOString().slice(0, 10), fields: Object.fromEntries(Object.entries(NUM).map(([k, [he, u]]) => [k, { he, u }])), eq: EQ,
    codes: { ...((prev && prev.codes) || {}) }, done: { ...((prev && prev.v >= 2 && prev.done) || {}) } };
  groups ??= targets(env.CAT || "cat");
  const only = String(env.SPEC_ONLY || "").split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
  if (only.length) groups = groups.filter(g => only.includes(`${g.cd}|${g.name}`));
  if (askOn && api === undefined) { const c = await client(env, { timeout: 8 * 60000 }); api = c.api; if (!api) { log("specs: no Claude (" + c.why + ")"); return { read: 0 }; } }
  let browser = null;
  if (!fetchDocs) { const { chromium } = await import("playwright"); browser = await chromium.launch(); fetchDocs = g => crawl(g, { browser, log, pdfText }); }
  let spent = 0, read = 0, kept = 0; const review = [], t0 = Date.now(), minutes = +(env.SPEC_MINUTES || 140);
  try {
    for (const g of groups.filter(g => only.length || !file.done[g.cd + "|" + g.name]).slice(0, limit)) {   // named model names are read again
      if (spent >= budget) break;
      if (Date.now() - t0 > minutes * 60000) { log("specs: time limit reached, the next run goes on from here"); break; }   // the job has 170 minutes; what is read is kept
      const docs = await fetchDocs(g);
      log(`specs: ${g.cd}|${g.name}: ${docs.length} documents, ${docs.reduce((s, d) => s + d.text.length, 0)} chars` + docs.map(d => `\n  ${d.kind} ${d.text.length} ${d.url}`).join(""));
      if (!askOn) continue;
      if (!docs.length) { review.push({ g, docs, covered: new Set(), held: [{ dg: "-", why: "no page of the model found on the importer's site" }] }); continue; }
      const r = await ask(api, { model: MODEL, max_tokens: 16000, messages: [{ role: "user", content: prompt(g, docs) }] });
      if (r.error) { log(`specs: stopped (${r.error.why})`); if (r.error.key) break; continue; }
      spent += price(MODEL, r.msg.usage || {}); read++;
      const a = answer(r.msg), o = parse(a.text);
      if (!o) log(`specs: ${g.cd}|${g.name}: no valid answer (${a.why || r.msg.stop_reason || "not JSON"})`);
      const res = o ? check(o, g, own(docs)) : { rows: {}, held: g.trims.map(t => ({ dg: t.dg, why: "no valid answer" })) };
      Object.assign(file.codes, res.rows); kept += Object.keys(res.rows).length;
      file.done[g.cd + "|" + g.name] = file.u;
      review.push({ g, docs, covered: new Set(Object.keys(res.rows).map(k => +k.split("|")[0].split("-")[1])), held: res.held, rows: res.rows });
    }
  } finally { if (browser) await browser.close().catch(() => {}); }
  if (!askOn) return { read: 0, spent: 0 };
  fs.writeFileSync(prevFile, JSON.stringify(file) + "\n");
  const pct = (a, b) => b ? Math.round(100 * a / b) : 0;
  const trimsAll = review.reduce((s, r) => s + r.g.trims.length, 0), trimsOk = review.reduce((s, r) => s + r.covered.size, 0);
  const md = ["# מפרטי יבואנים: סוללה ואבזור", "", `נקראו ${read} דגמים, ${trimsOk} מתוך ${trimsAll} רמות גימור (${pct(trimsOk, trimsAll)}%) קיבלו נתונים עם ציטוט.`, "",
    "| יצרן | דגם | מסמכים | רמות גימור עם נתונים | ממתין לבדיקה |", "|---|---|---|---|---|",
    ...review.map(r => `| ${r.g.maker} | ${r.g.name} | ${r.docs.length} | ${r.covered.size}/${r.g.trims.length} | ${r.held.map(h => `${h.dg}: ${h.why}`).join("; ").replace(/\|/g, "/").slice(0, 300)} |`), "",
    "## מה נמצא", "", ...review.flatMap(r => Object.entries(r.rows || {}).map(([k, v]) => `- ${r.g.name} ${k}: ${Object.keys(NUM).filter(f => v[f] !== undefined).map(f => `${NUM[f][0]} ${v[f]}`).join(", ")}${v.eq && v.eq.length ? "; " + v.eq.map(e => EQ[e]).join(", ") : ""}${v.no && v.no.length ? "; בלי: " + v.no.map(e => EQ[e]).join(", ") : ""}${v.cur ? " (השנה לפי הדף העדכני)" : ""}`)), ""];
  fs.writeFileSync(path.join(out, "specs-review.md"), md.join("\n"));
  log(`specs: ${read} model names read, ${kept} code-years kept, ${trimsOk}/${trimsAll} trims covered`);   // counts only: the repo is public
  return { read, kept, trimsOk, trimsAll, spent };
}

if (process.argv[1] && process.argv[1].endsWith("specs-extra.mjs") && !process.argv.includes("--selftest")) {
  try { await run(); } catch (e) { console.log("specs: crash: " + String((e && e.message) || e).slice(0, 160)); }
}

if (process.argv[1] && process.argv[1].endsWith("specs-extra.mjs") && process.argv.includes("--selftest")) {
  let bad = 0; const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) bad++; };
  ok(isSource("https://www.byd.co.il/sealion-5") && isSource("https://www.kia.com/il/models/ev3") && !isSource("https://www.auto.co.il/cars/byd") && !isSource("https://www.byd.com/eu/car/seal-u")
    && !isSource("https://he.wikipedia.org/wiki/x") && !isSource("not a url"), "sources: Israeli or a maker's Israeli section, never press or foreign");
  const g = { cd: 1014, maker: "בי ווי די סין", name: "SEALION 5", kind: "phev", trims: [{ dg: 47, trim: "COMFORT", years: [2025, 2026], cc: 1498 }, { dg: 48, trim: "DESIGN", years: [2025, 2026], cc: 1498 }] };
  ok(/47: COMFORT/.test(prompt(g)) && /JSON only/.test(prompt(g)), "the prompt lists the codes and asks for JSON");
  const page = "SEALION 5 DM-i COMFORT: קיבולת סוללה 12.96 קוט\"ש, טווח חשמלי 71 ק\"מ. DESIGN: קיבולת סוללה 18.3 קוט\"ש, טווח חשמלי 100 ק\"מ, משטח טעינה אלחוטית לטלפון";
  const seen = fetched([[{ type: "web_fetch_tool_result", content: { type: "web_fetch_result", url: "https://www.byd.co.il/sealion-5", content: { source: { type: "text", data: page } } } }]]);
  const U = "https://www.byd.co.il/sealion-5/";
  const o = { trims: [
    { dg: 47, year: 2026, num: { kwh: 12.96, rangeKm: 71 }, eq: {}, quotes: [{ f: "kwh", url: U, text: "COMFORT: קיבולת סוללה 12.96 קוט\"ש" }, { f: "rangeKm", url: U, text: "טווח חשמלי 71 ק\"מ" }] },
    { dg: 48, year: 2026, num: { kwh: 18.3, rangeKm: 120 }, eq: { wireless: true, hud: true }, quotes: [{ f: "kwh", url: U, text: "קיבולת סוללה 18.3 קוט\"ש" }, { f: "rangeKm", url: U, text: "טווח חשמלי 100 ק\"מ" }, { f: "wireless", url: U, text: "משטח טעינה אלחוטית לטלפון" }, { f: "hud", url: "https://www.auto.co.il/x", text: "תצוגה עילית" }] },
    { dg: 99, year: 2026, num: { kwh: 10 }, quotes: [] }, { dg: 47, year: 2019, num: {}, quotes: [] }], unsure: [{ dg: 48, why: "two pages" }] };
  const r = check(o, g, seen);
  ok(r.rows["1014-47|2026"] && r.rows["1014-47|2026"].kwh === 12.96 && r.rows["1014-47|2026"].rangeKm === 71 && !r.rows["1014-47|2025"], "a quoted number is kept, for the page's year only");
  ok(r.rows["1014-48|2026"].kwh === 18.3 && r.rows["1014-48|2026"].rangeKm === undefined && r.rows["1014-48|2026"].eq.includes("wireless") && !r.rows["1014-48|2026"].eq.includes("hud"),
    "a number the quote does not hold, or a quote from the press, is dropped");
  ok(r.held.some(h => h.dg === 99) && r.held.some(h => h.dg === 47 && /2019/.test(h.why)) && r.held.some(h => h.dg === 48 && /rangeKm/.test(h.why) && /hud/.test(h.why)) && r.held.some(h => h.why === "two pages"),
    "held: a code not of this model, a page for another year, the dropped fields, the model's own unsure");
  const seen2 = fetched([[{ type: "web_fetch_tool_result", content: { type: "web_fetch_result", url: U, content: { source: { type: "base64", data: "" } } } }, { type: "text", text: "x", citations: [{ url: U, cited_text: "סוללה בקיבולת 12,96 קוט\"ש" }] }]]);
  ok(check({ trims: [{ dg: 47, year: 2025, num: { kwh: 12.96 }, quotes: [{ f: "kwh", url: U, text: "סוללה בקיבולת 12,96 קוט\"ש" }] }] }, g, seen2).rows["1014-47|2025"].kwh === 12.96, "a PDF: the API's cited passage is the page, 12,96 = 12.96");
  ok(parse('note {"trims":[],"unsure":[]} end').trims.length === 0 && parse("no json") === null, "parse");
  // targets from a tiny catalogue
  const tmp = fs.mkdtempSync(path.join((await import("node:os")).tmpdir(), "spx-")), cols = ["sug_degem", "degem_cd", "shnat_yitzur", "ramat_gimur", "nefah_manoa", "delek_nm", "technologiat_hanaa_nm", "kinuy_mishari", "shem_yevuan", "mispar_rechavim_pailim"];
  fs.mkdirSync(path.join(tmp, "c", "1014"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "meta.json"), JSON.stringify({ makers: { 1014: { n: "בי ווי די סין" } } }));
  fs.writeFileSync(path.join(tmp, "c", "1014.json"), JSON.stringify({ n: "בי ווי די סין", cols, degems: { 47: "a", 48: "a", 5: "a" } }));
  fs.writeFileSync(path.join(tmp, "c", "1014", "a.json"), JSON.stringify({ rows: [["P", 47, 2026, "COMFORT", 1498, "חשמל/בנזין", "", "SEALION 5", "x", 2852], ["P", 48, 2026, "DESIGN", 1498, "חשמל/בנזין", "", "SEALION 5", "x", 2436],
    ["P", 5, 2026, "COMFORT", 0, "חשמל", "", "ATTO 3", "x", 10], ["M", 48, 2026, "DESIGN", 1498, "חשמל/בנזין", "", "SEALION 5", "x", 99], ["P", 47, 2023, "COMFORT", 1498, "חשמל/בנזין", "", "SEALION 5", "x", 500]] }));
  const t = targets(tmp);
  ok(t.length === 1 && t[0].name === "SEALION 5" && t[0].kind === "phev" && t[0].trims.length === 2 && t[0].n === 5288 && t[0].trims[0].dg === 47, "targets: private, recent, enough cars, grouped by model name");
  // v2: our own documents, the year rule, the line dedupe, the link match
  ok(token("JAECOO7 PHEV") === "jaecoo7" && token("SEALION 5") === "sealion5" && token("MODEL Y") === "modely" && token("FX EV") === "fxev" && token("G6") === "g6" && token("YARIS CROSS HSD") === "yariscross" && token("RAV4 HYBRID") === "rav4" && token("LEXUS NX350H") === "nx350h" && linkFits(g, "https://x.co.il/models/sealion-5/", "")
    && !linkFits(g, "https://x.co.il/models/seal-u/", "דגמים") && linkFits(g, "https://x.co.il/p/12", "BYD Sealion 5 DM-i"), "the model's name in a link");
  const docs = trimDocs([{ url: U, kind: "page", text: "תפריט\n" + page }, { url: "https://www.byd.co.il/x.pdf", kind: "pdf", text: "תפריט\nDESIGN 2025: מסך מולטימדיה 15.6 אינץ'" }]);
  ok(docs.length === 2 && !/תפריט/.test(docs[1].text) && /15.6/.test(prompt(g, docs)), "a line repeated across documents is kept once; the documents go in the prompt");
  const s2 = own(docs), NOW = new Date("2026-11-02T00:00:00Z");
  const r2 = check({ trims: [{ dg: 48, year: null, num: { screenIn: 15.6 }, quotes: [{ f: "screenIn", url: "https://www.byd.co.il/x.pdf", text: "מסך מולטימדיה 15.6" }] },
    { dg: 47, year: 2025, num: { kwh: 12.96 }, quotes: [{ f: "kwh", url: "https://other.co.il/a", text: "קיבולת סוללה 12.96" }] }] }, g, s2, { now: NOW });
  ok(r2.rows["1014-48|2026"] && r2.rows["1014-48|2026"].screenIn === 15.6 && r2.rows["1014-48|2026"].cur && !r2.rows["1014-47|2025"], "no year on the page: the code's latest year, marked; a URL we did not fetch never counts");
  const r3 = check({ trims: [{ dg: 47, year: null, num: { kwh: 12.96 } }, { dg: 48, year: null, num: { kwh: 12.96 } }], quotes: [{ f: "kwh", dg: [47, 48], url: U, text: "קיבולת סוללה 12.96" }] }, g, s2, { now: NOW });
  ok(r3.rows["1014-47|2026"].kwh === 12.96 && r3.rows["1014-48|2026"].kwh === 12.96, "a quote written once for several codes counts for each");
  ok(check({ trims: [{ dg: 47, year: null, num: { kwh: 12.96 }, quotes: [{ f: "kwh", url: U, text: "קיבולת סוללה 12.96" }] }] }, { ...g, trims: [{ ...g.trims[0], years: [2023] }] }, s2, { now: NOW }).held[0].why.includes("2023"),
    "no year on the page and an old code: held");
  // a run through a fake API and fake documents: the budget stops it, the file and the review are written
  const fakeMsg = { stop_reason: "end_turn", usage: { input_tokens: 2e6, output_tokens: 0 }, content: [{ type: "text", text: JSON.stringify({ trims: [o.trims[0]] }) }] };
  const api = { messages: { create: async () => fakeMsg } }, out = path.join(tmp, "out"), fetchDocs = async () => [{ url: U, kind: "page", text: page }];
  const res = await run({ env: { OUT: out, SPEC_BUDGET: "3" }, api, fetchDocs, groups: [g, { ...g, name: "OTHER" }], log: () => {} });
  const f = JSON.parse(fs.readFileSync(path.join(out, "specs-extra.json"), "utf8"));
  ok(res.read === 1 && f.codes["1014-47|2026"].kwh === 12.96 && f.done["1014|SEALION 5"] && !f.done["1014|OTHER"] && /1\/2/.test(fs.readFileSync(path.join(out, "specs-review.md"), "utf8")), "run: stops at the budget, keeps the file and the review");
  const res2 = await run({ env: { OUT: out, SPEC_BUDGET: "3" }, api, fetchDocs, groups: [g], log: () => {} });
  ok(res2.read === 0, "run: a model name already read is not read again");
  const res3 = await run({ env: { OUT: out, SPEC_ONLY: "1014|OTHER", SPEC_ASK: "0" }, api: null, fetchDocs, groups: [g, { ...g, name: "OTHER" }], log: () => {} });
  ok(res3.read === 0 && !JSON.parse(fs.readFileSync(path.join(out, "specs-extra.json"), "utf8")).done["1014|OTHER"], "SPEC_ASK=0 fetches only and writes nothing");
  console.log(bad ? `${bad} failed` : "selftest ok"); process.exit(bad ? 1 : 0);
}

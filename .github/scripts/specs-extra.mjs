// Battery and equipment from the importers' own spec pages (Dudu 1.11.2026 23:07 UTC "אני רוצה את זה"; pilot budget $15 chosen on the card
// 23:10 UTC): the ministry's model data has no battery size, electric range or comfort equipment, so a bot reads the Israeli importer's
// spec sheet or price list for each model name and keeps, per ministry model code and year, only what a quote from a page it fetched shows.
//   targets(catDir, opt)   the model names to read from the catalog-data branch: electric and plug-in (opt.kinds), years >= opt.from,
//                          trims with at least opt.min active cars, most cars first; each {cd, maker, importer, name, n, trims: [{dg, trim, years, cc, fuel, n}]}
//   prompt(g)              the request for one model name
//   check(o, g, seen)      the reply against the rules: a trim must be one of the group's codes; every number and every fitted item needs a quote
//                          from a page fetched in this conversation that holds it; press and listing sites never count. Returns {rows, held}
//   run({env, api, ...})   reads groups until SPEC_BUDGET (USD, default 15) is spent; writes OUT/specs-extra.json and OUT/specs-review.md
// specs-extra.json: {v, u, fields, eq, codes: {"<tozeret_cd>-<degem_cd>|<year>": {kwh, kwhNet, rangeKm, dcKw, acKw, dcMin, eq: [ids], src: [urls]}}}
// Public data (the importers' published specs); the log shows counts only, never money. Never red: an API problem ends the run with what it has.
//   node specs-extra.mjs --selftest   offline
import fs from "node:fs";
import path from "node:path";
import { client, ask, answer } from "./claude.mjs";
import { price } from "./ai-usage.mjs";

export const MODEL = "claude-sonnet-5-5", SEARCH_CAP = 6, FETCH_CAP = 8;
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
  try { const p = new URL(u).pathname.toLowerCase(); return /\.il$/.test(h) || /(^|\/)(il|he|he-il|iw)(\/|$)/.test(p); } catch { return false; } };

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

export function prompt(g) {
  return [
    `Find the official Israeli specifications of the ${g.maker} ${g.name} (${g.kind === "ev" ? "electric" : "plug-in hybrid"}), imported by ${g.importer || "its Israeli importer"}.`,
    "Search for the importer's model page, spec sheet (מפרט טכני) or price list (מחירון) and fetch it. Use only the importer's own site or the maker's Israeli site.",
    "Never use press, reviews, listings or dealers' ads, and never a foreign market's spec: equipment differs by market.",
    "",
    "The Ministry of Transport lists these trims (code: trim name, model years, engine cc). Match each trim on the page to ONE code:",
    ...g.trims.map(t => `- ${t.dg}: ${t.trim || "(no trim name)"}, ${t.years.join("/")}, ${t.cc || 0} cc`),
    "",
    "For each code you can match with confidence, report what the page says:",
    `- numbers: ${Object.entries(NUM).map(([k, [he, u]]) => `${k} (${he}, ${u})`).join("; ")}`,
    `- equipment fitted as standard (true) or stated as not fitted (false); leave out what the page does not state: ${Object.entries(EQ).map(([k, he]) => `${k} (${he})`).join("; ")}`,
    "Every number and every true/false needs a quote: a short passage copied exactly from a page you fetched in this conversation, with its URL.",
    "A quote must contain the number itself, or the equipment's name as the page writes it. Do not guess, do not convert units, do not use optional packages.",
    "When the page does not let you tell which code a trim is, or the page is for another model year than every listed year, put the code in unsure with the reason.",
    "",
    'Answer with JSON only: {"trims":[{"dg":<code>,"year":<model year the page is for>,"num":{"kwh":<n>,...},"eq":{"wireless":true,...},"quotes":[{"f":"kwh","url":"...","text":"..."}]}],"unsure":[{"dg":<code>,"why":"..."}]}',
  ].join("\n");
}

export function parse(text) {
  const m = String(text || "").match(/\{[\s\S]*\}/); if (!m) return null;
  try { const o = JSON.parse(m[0]); return o && Array.isArray(o.trims) ? o : null; } catch { return null; }
}

// what the conversation fetched: url -> squashed page text, and every passage the API cited (a PDF arrives as cited passages)
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

export function check(o, g, seen) {
  const rows = {}, held = [], codes = new Map(g.trims.map(t => [t.dg, t]));
  for (const u of (o.unsure || []).slice(0, 40)) if (u && codes.has(+u.dg)) held.push({ dg: +u.dg, why: String(u.why || "unsure").slice(0, 160) });
  for (const t of (o.trims || []).slice(0, 40)) {
    const dg = +(t && t.dg), tr = codes.get(dg); if (!tr) { held.push({ dg: t && t.dg, why: "not one of the model's codes" }); continue; }
    const year = +t.year, years = tr.years.includes(year) ? [year] : [];
    if (!years.length) { held.push({ dg, why: `the page is for ${t.year || "an unknown year"}, the codes are ${tr.years.join("/")}` }); continue; }
    const quotes = (Array.isArray(t.quotes) ? t.quotes : []).filter(q => q && typeof q.url === "string" && typeof q.text === "string" && isSource(q.url) && onPage(q, seen));
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
    row.src = [...new Set(row.src)];
    if (drop.length) held.push({ dg, why: "no quote on a fetched importer page for " + drop.join(", ") });
    if (row.src.length) for (const y of years) rows[`${g.cd}-${dg}|${y}`] = Object.fromEntries(Object.entries(row).filter(([k, v]) => !Array.isArray(v) || v.length || k === "eq"));
  }
  return { rows, held };
}

const turnCost = (m, msg) => price(m, msg.usage || {}) + ((msg.usage && msg.usage.server_tool_use && msg.usage.server_tool_use.web_search_requests) || 0) * 0.01;

export async function run({ env = process.env, api, groups, log = console.log } = {}) {
  const out = env.OUT || "out", budget = +(env.SPEC_BUDGET || 15), limit = +(env.SPEC_MAX || 400);
  fs.mkdirSync(out, { recursive: true });
  const prevFile = path.join(out, "specs-extra.json"); let prev = null; try { prev = JSON.parse(fs.readFileSync(prevFile, "utf8")); } catch {}
  const file = { v: 1, u: new Date().toISOString().slice(0, 10), fields: Object.fromEntries(Object.entries(NUM).map(([k, [he, u]]) => [k, { he, u }])), eq: EQ, codes: { ...((prev && prev.codes) || {}) }, done: { ...((prev && prev.done) || {}) } };
  groups ??= targets(env.CAT || "cat");
  if (api === undefined) { const c = await client(env, { timeout: 8 * 60000 }); api = c.api; if (!api) { log("specs: no Claude (" + c.why + ")"); return { read: 0 }; } }
  let spent = 0, read = 0, kept = 0; const review = [];
  const todo = groups.filter(g => !file.done[g.cd + "|" + g.name]).slice(0, limit);
  for (const g of todo) {
    if (spent >= budget) break;
    const tools = [{ type: "web_search_20250305", name: "web_search", max_uses: SEARCH_CAP },
      { type: "web_fetch_20250910", name: "web_fetch", max_uses: FETCH_CAP, citations: { enabled: true }, max_content_tokens: 16000, blocked_domains: NOT_SOURCES }];
    const params = { model: MODEL, max_tokens: 8000, tools, messages: [{ role: "user", content: prompt(g) }] }, contents = [];
    let msg = null, err = null;
    for (let turn = 0; turn < 4; turn++) {
      const r = await ask(api, params); if (r.error) { err = r.error; break; }
      msg = r.msg; contents.push(msg.content); spent += turnCost(MODEL, msg);
      if (msg.stop_reason !== "pause_turn") break;
      params.messages = [...params.messages, { role: "assistant", content: msg.content }];
    }
    if (err) { log(`specs: stopped (${err.why})`); if (err.key) break; continue; }
    read++;
    const o = msg && msg.stop_reason !== "pause_turn" ? parse(answer(msg).text) : null;
    const res = o ? check(o, g, fetched(contents)) : { rows: {}, held: g.trims.map(t => ({ dg: t.dg, why: "no valid answer" })) };
    Object.assign(file.codes, res.rows); kept += Object.keys(res.rows).length;
    file.done[g.cd + "|" + g.name] = file.u;
    const covered = new Set(Object.keys(res.rows).map(k => +k.split("|")[0].split("-")[1]));
    review.push({ g, covered, held: res.held });
  }
  fs.writeFileSync(prevFile, JSON.stringify(file) + "\n");
  const pct = (a, b) => b ? Math.round(100 * a / b) : 0;
  const trimsAll = review.reduce((s, r) => s + r.g.trims.length, 0), trimsOk = review.reduce((s, r) => s + r.covered.size, 0);
  const md = ["# מפרטי יבואנים: סוללה ואבזור", "", `נקראו ${read} דגמים, ${trimsOk} מתוך ${trimsAll} רמות גימור (${pct(trimsOk, trimsAll)}%) קיבלו נתונים עם ציטוט.`, "",
    "| יצרן | דגם | רמות גימור עם נתונים | ממתין לבדיקה |", "|---|---|---|---|",
    ...review.map(r => `| ${r.g.maker} | ${r.g.name} | ${r.covered.size}/${r.g.trims.length} | ${r.held.map(h => `${h.dg}: ${h.why}`).join("; ").replace(/\|/g, "/").slice(0, 300)} |`), ""];
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
  // a run through a fake API: the budget stops it, the file and the review are written
  const fakeMsg = { stop_reason: "end_turn", usage: { input_tokens: 2e6, output_tokens: 0 }, content: [{ type: "web_fetch_tool_result", content: { type: "web_fetch_result", url: U, content: { source: { type: "text", data: page } } } },
    { type: "text", text: JSON.stringify({ trims: [o.trims[0]] }) }] };
  const api = { messages: { create: async () => fakeMsg } }, out = path.join(tmp, "out");
  const res = await run({ env: { OUT: out, SPEC_BUDGET: "3" }, api, groups: [g, { ...g, name: "OTHER" }], log: () => {} });
  const f = JSON.parse(fs.readFileSync(path.join(out, "specs-extra.json"), "utf8"));
  ok(res.read === 1 && f.codes["1014-47|2026"].kwh === 12.96 && f.done["1014|SEALION 5"] && !f.done["1014|OTHER"] && /1\/2/.test(fs.readFileSync(path.join(out, "specs-review.md"), "utf8")), "run: stops at the budget, keeps the file and the review");
  const res2 = await run({ env: { OUT: out, SPEC_BUDGET: "3" }, api, groups: [g], log: () => {} });
  ok(res2.read === 0, "run: a model name already read is not read again");
  console.log(bad ? `${bad} failed` : "selftest ok"); process.exit(bad ? 1 : 0);
}

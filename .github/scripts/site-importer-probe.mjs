// Why can an importer's own recall page show an open service call for a car the app (the ministry's data) shows as clean?
// For each plate: the register row; the car's rows in the ministry's per-car list of unfixed recalls (36bf1404) and how fresh that list is;
// the maker's rows in the ministry's recall list (2c33523f, read from the catalogue file the app uses); and the importer's own recall page,
// opened in a browser with every request it makes after the plate is submitted.
// QUERIES "sample=N" also checks N other cars of the same model, and N cars the ministry lists with an open recall of the same maker, on the
// importer's page, to measure how often the two sources disagree.
// Runs on GitHub via inspect.yml (script names starting with "site-" get a browser). PLATES may be "b64:<base64 of a comma-separated list>";
// every plate (in any grouping) and every VIN is masked in the report, which is public.
import fs from "node:fs";

const API = "https://data.gov.il/api/3/action/", CAT = "https://raw.githubusercontent.com/ddsabag/vehicle-app/catalog-data/";
const ACTIVE = "053cea08-09bc-40ec-8f7a-156f0677aff3", OPEN = "36bf1404-0be4-49d2-82dc-2f1ead4a8b93", LIST = "2c33523f-87aa-44ec-a736-edbb0a82975e";
const html = fs.readFileSync("index.html", "utf8");
// the importer pages, taken from index.html so the probe opens the page the app links to
const IMPORTER_RECALL = new Function("return " + html.slice(html.indexOf("const IMPORTER_RECALL = [") + "const IMPORTER_RECALL = ".length, html.indexOf("];", html.indexOf("const IMPORTER_RECALL = [")) + 1))();

const SECRET = new Set();
const addPlate = p => {
  const d = String(p).replace(/\D/g, ""); if (!d) return;
  const g = d.length === 8 ? [d.slice(0, 3), d.slice(3, 5), d.slice(5)] : d.length === 7 ? [d.slice(0, 2), d.slice(2, 5), d.slice(5)] : [d];
  for (const s of [d, ...["-", " ", ".", "–"].map(j => g.join(j))]) SECRET.add(s);
};
const scrub = s => {
  let t = String(s);
  for (const x of [...SECRET].sort((a, b) => b.length - a.length)) t = t.split(x).join("[plate]");
  return t.replace(/\b[A-HJ-NPR-Z0-9]{17}\b/g, "[vin]");
};
const say = (...a) => console.log(scrub(a.join(" ")));
const mask = p => { const d = String(p).replace(/\D/g, ""); return d.length > 4 ? d.slice(0, 2) + "x".repeat(d.length - 4) + d.slice(-2) : "xx"; };
const show = (o, keys) => keys.filter(k => o[k] !== undefined && o[k] !== null && String(o[k]).trim() !== "").map(k => `${k}=${String(o[k]).trim().slice(0, 140)}`).join(" | ");
const wait = ms => new Promise(r => setTimeout(r, ms));

const get = async (act, params) => {
  for (let a = 0; ; a++) {
    try {
      const r = await fetch(API + act + "?" + new URLSearchParams(params), {headers: {Accept: "application/json"}, signal: AbortSignal.timeout(60000)});
      if (!r.ok) throw new Error(act + " HTTP " + r.status);
      return (await r.json()).result;
    } catch (e) { if (a >= 2) throw e; await wait(3000 * (a + 1)); }
  }
};
const search = (id, filters, limit = 50, extra = {}) => get("datastore_search", {resource_id: id, filters: JSON.stringify(filters), limit: String(limit), ...extra});

const raw = process.env.PLATES || "";
const plates = (raw.startsWith("b64:") ? Buffer.from(raw.slice(4), "base64").toString("utf8") : raw).split(",").map(s => s.replace(/\D/g, "")).filter(Boolean);
plates.forEach(addPlate);
const opts = Object.fromEntries((process.env.QUERIES || "").split(",").map(s => s.trim().split("=")).filter(a => a.length === 2));
const SAMPLE = Math.min(40, Number(opts.sample) || 0);
const NO_GOV = process.env.NO_GOV === "1";   // local test of the browser part only

const makerOnly = v => String(v.tozeret_nm || "").replace(/\s+(יפן|גרמניה|קוריאה|סין|ספרד|צרפת|איטליה|ארה"ב|ארהב|אנגליה|בריטניה|צ'כיה|צכיה|סלובקיה|טורקיה|הודו|תאילנד|מקסיקו|בלגיה|הונגריה|פולין|אוסטריה|שוודיה|רומניה|פורטוגל|דרום אפריקה|ברזיל|ארגנטינה|קנדה|מרוקו|אינדונזיה|מלזיה|טייוואן|סלובניה|הולנד|פינלנד|אוסטרליה|רוסיה|בלארוס|אוזבקיסטן|וייטנאם|הפיליפינים|קולומביה|אירן|מצרים|ירדן)$/, "").trim();
const importerFor = v => {
  if (process.env.IMPORTER_URL) return {name: "test", url: process.env.IMPORTER_URL};
  const mk = makerOnly(v), m = [mk, v.kinuy_mishari, v.degem_nm].filter(Boolean).join(" ");
  return IMPORTER_RECALL.find(x => x.re.test(mk)) || IMPORTER_RECALL.find(x => x.re.test(m)) || null;
};

// ---------- the importer's page in a browser ----------
let browser = null, ctx = null;
async function openBrowser(){
  const {chromium} = await import("playwright");
  browser = await chromium.launch(process.env.CHROME_PATH ? {executablePath: process.env.CHROME_PATH} : {});
  ctx = await browser.newContext({viewport: {width: 1100, height: 900}, locale: "he-IL", timezoneId: "Asia/Jerusalem",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36"});
}
const OPEN_RE = /קיימת קריאת שירות פתוחה|קיימות קריאות שירות|קריאות שירות פתוחות|קריאת שירות פתוחה|נמצאה קריאת|נמצאו קריאות|רכבך נכלל|הרכב נכלל|יש לבצע|ממתין לביצוע|לא בוצע/;
const NONE_RE = /לא קיימ|אין קריא|אין לרכב|לא נמצא|לא נמצאו|אינו נכלל|לא נכלל|אין ריקול|לא קיימות|אין צורך|כל הקריאות בוצעו|בוצעו כל/;
async function checkImporter(url, plate, verbose){
  const page = await ctx.newPage(), calls = [];
  let armed = false;
  page.on("response", async res => {
    const req = res.request(), t = req.resourceType();
    if (!["xhr", "fetch", "document"].includes(t)) return;
    const ct = (res.headers()["content-type"] || "").split(";")[0];
    let body = "";
    try { if (/json|text|html|xml|javascript/.test(ct)) body = await res.text(); } catch {}
    calls.push({phase: armed ? "submit" : "load", t, m: req.method(), u: req.url(), pd: req.postData() || "", s: res.status(), ct, body});
  });
  const out = {cls: "unknown", msg: "", text: "", calls, url: ""};
  try {
    await page.goto(url, {waitUntil: "domcontentloaded", timeout: 60000});
    await page.waitForLoadState("networkidle", {timeout: 25000}).catch(() => {});
    // some importer pages build the form after a "loading" screen: wait for a visible text field in any frame, up to 30 s
    for (let t = 0; t < 30; t++) {
      let n = 0; for (const f of page.frames()) n += await f.locator("input:visible").count().catch(() => 0);
      if (n) break;
      if (t === 10) await page.mouse.wheel(0, 600).catch(() => {});
      await page.waitForTimeout(1000);
    }
    // a cookie or consent bar can sit over the form
    for (const t of ["מאשר", "אישור", "הבנתי", "קבל", "Accept"]) { const b = page.locator(`button:visible:has-text("${t}"), a:visible:has-text("${t}")`).first(); if (await b.count().catch(() => 0)) { await b.click({timeout: 3000}).catch(() => {}); break; } }
    // the plate field: in the page or in one of its frames
    let frame = null, field = null;
    for (const f of page.frames()) {
      const ins = f.locator("input:visible");
      const n = await ins.count().catch(() => 0);
      for (let i = 0; i < n; i++) {
        const el = ins.nth(i), a = await el.evaluate(e => ({type: e.type, name: e.name, id: e.id, ph: e.placeholder, aria: e.getAttribute("aria-label") || "", lbl: (e.labels && e.labels[0] ? e.labels[0].innerText : "")})).catch(() => null);
        if (!a || !/^(text|tel|number|search|)$/.test(a.type)) continue;
        if (verbose) say(`  field: type=${a.type} name=${a.name} id=${a.id} placeholder="${a.ph}" aria="${a.aria}" label="${String(a.lbl).trim().slice(0, 40)}" (frame ${f === page.mainFrame() ? "main" : f.url().slice(0, 80)})`);
        const fit = /רישוי|רכב|לוחית|plate|car|licen|מספר|number|רישום/i.test([a.name, a.id, a.ph, a.aria, a.lbl].join(" "));
        if (!field || (fit && !field.fit)) { field = {el, fit}; frame = f; }
      }
    }
    if (!field) {
      out.url = page.url(); out.msg = "no input field on the page";
      out.text = (await page.evaluate(() => document.body.innerText).catch(() => "")).slice(0, 1500);
      if (verbose) {
        say(`  frames: ${page.frames().map(f => f.url().slice(0, 100)).join(" | ")}`);
        const dom = await page.evaluate(() => {
          const all = [...document.querySelectorAll("input, select, textarea, form, iframe, [contenteditable]")].map(e => `${e.tagName.toLowerCase()} type=${e.type || ""} name=${e.getAttribute("name") || ""} id=${e.id || ""} class=${String(e.className || "").slice(0, 60)} hidden=${!(e.offsetWidth || e.offsetHeight)} src=${(e.getAttribute("src") || "").slice(0, 100)}`);
          const shadow = [...document.querySelectorAll("*")].filter(e => e.shadowRoot).map(e => e.tagName.toLowerCase());
          const main = document.querySelector("main") || document.body;
          return {all, shadow, html: main.innerHTML.replace(/\s+/g, " ").replace(/<(svg|style|script)[^]*?<\/\1>/g, "").slice(0, 5000)};
        }).catch(e => ({all: [], shadow: [], html: "evaluate failed: " + e.message}));
        say(`  form elements in the page (${dom.all.length}):`); for (const x of dom.all.slice(0, 40)) say("    " + x);
        say(`  elements with a shadow root: ${dom.shadow.join(", ") || "none"}`);
        say(`  page HTML (main, scripts and styles removed, first 5,000 chars):\n${dom.html}`);
      }
      return out;
    }
    armed = true;
    await field.el.click({timeout: 5000}).catch(() => {});
    await field.el.fill(plate);
    const btn = frame.locator(`button:visible, input[type=submit]:visible, input[type=button]:visible, a:visible`).filter({hasText: /בדיק|בדוק|חפש|חיפוש|שלח|המשך|הצג|search|check|submit/i}).first();
    const sub = frame.locator(`input[type=submit]:visible`).first();
    if (await btn.count().catch(() => 0)) await btn.click({timeout: 5000}).catch(() => field.el.press("Enter"));
    else if (await sub.count().catch(() => 0)) await sub.click({timeout: 5000}).catch(() => field.el.press("Enter"));
    else await field.el.press("Enter");
    await page.waitForLoadState("networkidle", {timeout: 20000}).catch(() => {});
    await page.waitForTimeout(3000);
    out.url = page.url();
    const texts = [];
    for (const f of page.frames()) texts.push(await f.evaluate(() => document.body ? document.body.innerText : "").catch(() => ""));
    out.text = texts.join("\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
    const lines = out.text.split("\n").map(s => s.trim()).filter(Boolean);
    const hit = lines.find(l => OPEN_RE.test(l)) || lines.find(l => NONE_RE.test(l));
    out.msg = hit || "";
    out.cls = hit ? (OPEN_RE.test(hit) && !/^(לא|אין)/.test(hit) ? "open" : "none") : "unknown";
  } catch (e) { out.msg = "error: " + e.message.split("\n")[0]; }
  finally { await page.close().catch(() => {}); }
  return out;
}
function printCalls(calls){
  for (const c of calls) {
    say(`  [${c.phase}] ${c.t} ${c.m} ${c.s} ${c.ct} ${c.u}`);
    if (c.pd) say(`    sent: ${c.pd.slice(0, 600)}`);
    if (c.body && c.t !== "document") say(`    answer: ${c.body.replace(/\s+/g, " ").slice(0, 1800)}`);
  }
}

// ---------- the ministry's side ----------
let openFields = [];
async function ministryFreshness(){
  say("===== how fresh the ministry's recall data is =====");
  for (const id of [OPEN, LIST]) {
    try { const r = await get("resource_show", {id}); say(`${id.slice(0, 8)} "${r.name}": last_modified ${r.last_modified} | metadata_modified ${r.metadata_modified} | created ${r.created}`); }
    catch (e) { say(`${id.slice(0, 8)} resource_show: ${e.message}`); }
  }
  try {
    const o = await get("datastore_search", {resource_id: OPEN, limit: "3", sort: "RECALL_ID desc"});
    openFields = o.fields.map(f => f.id);
    say(`per-car list of unfixed recalls: ${o.total} rows; fields ${openFields.join(",")}; newest RECALL_IDs ${o.records.map(r => r.RECALL_ID).join(", ")}`);
  } catch (e) { say("per-car list: " + e.message); }
  try {
    const l = await get("datastore_search", {resource_id: LIST, limit: "12", sort: "RECALL_ID desc"});
    say(`recall list: ${l.total} rows; newest:`);
    for (const r of l.records) say("  " + show(r, ["RECALL_ID", "TOZAR_TEUR", "DEGEM", "SHNAT_RECALL", "BUILD_BEGIN_A", "BUILD_END_A", "YEVUAN_TEUR"]));
  } catch (e) { say("recall list: " + e.message); }
}
const ownOpen = async p => {
  const seen = new Map();
  for (const val of [Number(p), String(p)]) {
    try { for (const r of (await search(OPEN, {MISPAR_RECHEV: val}, 50)).records) seen.set(String(r.RECALL_ID) + "|" + (r._id || ""), r); } catch (e) { return {err: e.message, rows: []}; }
  }
  return {rows: [...seen.values()]};
};

// which recall campaigns have cars in the per-car list: the list of unfixed cars can trail the list of campaigns
async function coverage(){
  say("\n===== per-car list coverage =====");
  for (const sort of ["TAARICH_PTICHA desc", "RECALL_ID desc"]) {
    try { const o = await get("datastore_search", {resource_id: OPEN, limit: "6", sort, fields: "RECALL_ID,TAARICH_PTICHA,SUG_RECALL,SUG_TAKALA"}); say(`per-car list by ${sort}: ` + o.records.map(r => `${r.RECALL_ID} (${r.TAARICH_PTICHA})`).join(", ")); }
    catch (e) { say(`per-car list by ${sort}: ${e.message}`); }
  }
  try {
    const sql = `SELECT "RECALL_ID", COUNT(*) AS n, MIN("TAARICH_PTICHA") AS first, MAX("TAARICH_PTICHA") AS last FROM "${OPEN}" GROUP BY "RECALL_ID" ORDER BY "RECALL_ID" DESC LIMIT 60`;
    const r = await get("datastore_search_sql", {sql});
    say("per-car rows per recall (SQL, newest 60): " + r.records.map(x => `${x.RECALL_ID}:${x.n}(${String(x.first).slice(0, 10)})`).join(" "));
  } catch (e) { say("datastore_search_sql: " + e.message); }
  let list = [];
  try { list = (await get("datastore_search", {resource_id: LIST, limit: "400", sort: "RECALL_ID desc"})).records; } catch (e) { say("recall list: " + e.message); return; }
  const rows = [];
  for (let i = 0; i < list.length; i += 6) {
    await Promise.all(list.slice(i, i + 6).map(async r => {
      try { const o = await get("datastore_search", {resource_id: OPEN, filters: JSON.stringify({RECALL_ID: Number(r.RECALL_ID)}), limit: "1", fields: "RECALL_ID,TAARICH_PTICHA"}); rows.push({r, n: o.total, d: o.records[0] && o.records[0].TAARICH_PTICHA}); }
      catch (e) { rows.push({r, n: null, err: e.message}); }
    }));
  }
  rows.sort((a, b) => Number(b.r.RECALL_ID) - Number(a.r.RECALL_ID));
  const zero = rows.filter(x => x.n === 0), some = rows.filter(x => x.n > 0);
  say(`the newest ${rows.length} campaigns of the recall list (RECALL_ID ${rows[rows.length - 1].r.RECALL_ID}..${rows[0].r.RECALL_ID}): ${some.length} have cars in the per-car list, ${zero.length} have none, ${rows.filter(x => x.n === null).length} unknown`);
  const newestWith = some[0]; say(`newest campaign with cars in the per-car list: ${newestWith ? newestWith.r.RECALL_ID + " opened " + newestWith.d + " (" + newestWith.n + " cars)" : "none"}`);
  say("per campaign (id | maker | models | recall year | build range | importer | cars in the per-car list | its opening date):");
  for (const x of rows) say(`  ${x.r.RECALL_ID} | ${x.r.TOZAR_TEUR} | ${String(x.r.DEGEM || "").slice(0, 50)} | ${x.r.SHNAT_RECALL} | ${x.r.BUILD_BEGIN_A || ""}..${x.r.BUILD_END_A || ""} | ${String(x.r.YEVUAN_TEUR || "").slice(0, 30)} | ${x.n === null ? "? " + x.err : x.n} | ${x.d || ""}`);
}

// ---------- run ----------
await openBrowser();
if (!NO_GOV) await ministryFreshness();
if (!NO_GOV && opts.coverage === "1") await coverage();
for (const p of plates) {
  say(`\n===== plate ${mask(p)} =====`);
  let v = {tozeret_nm: "", kinuy_mishari: "", degem_nm: ""};
  if (!NO_GOV) {
    const a = await search(ACTIVE, {mispar_rechev: Number(p)}, 1).catch(e => ({records: [], err: e.message}));
    if (!a.records.length) { say("not in the active register" + (a.err ? " (" + a.err + ")" : "")); continue; }
    v = a.records[0];
    if (v.misgeret) SECRET.add(String(v.misgeret).trim());
    say("register: " + show(v, ["tozeret_cd", "tozeret_nm", "degem_cd", "degem_nm", "kinuy_mishari", "sug_degem", "shnat_yitzur", "moed_aliya_lakvish", "ramat_gimur", "baalut", "tozeret_eretz_nm"]) + (v.misgeret ? ` | VIN ${String(v.misgeret).trim().length} chars, starts ${String(v.misgeret).trim().slice(0, 3)}` : ""));
    const own = await ownOpen(p);
    say(`the ministry's per-car list: ${own.rows.length} unfixed recall(s) for this car${own.err ? " (" + own.err + ")" : ""}`);
    for (const r of own.rows) say("  " + show(r, Object.keys(r).filter(k => k !== "_id" && !/MISPAR_RECHEV/i.test(k))));
    // the maker's recalls the app reads (catalogue file per register maker code)
    const rec = await fetch(`${CAT}r/${Number(v.tozeret_cd)}.json`).then(r => r.ok ? r.json() : null).catch(() => null);
    if (!rec) say(`catalogue recall file r/${Number(v.tozeret_cd)}.json: missing`);
    else {
      const rows = rec.rows.slice().sort((a, b) => (Number(b.RECALL_ID) || 0) - (Number(a.RECALL_ID) || 0));
      say(`catalogue recall file r/${Number(v.tozeret_cd)}.json (built ${rec.u}): ${rows.length} rows; the newest 15:`);
      for (const r of rows.slice(0, 15)) say("  " + show(r, ["RECALL_ID", "TOZAR_TEUR", "DEGEM", "SHNAT_RECALL", "BUILD_BEGIN_A", "BUILD_END_A", "SUG_RECALL", "TEUR_TAKALA", "YEVUAN_TEUR"]));
      const nm = [v.degem_nm, v.kinuy_mishari].filter(Boolean).map(s => String(s).toUpperCase().replace(/[^A-Z0-9]/g, "")).filter(s => s.length >= 2);
      const mine = rows.filter(r => { const d = String(r.DEGEM || "").toUpperCase().replace(/[^A-Z0-9,]/g, ""); return nm.some(n => d.split(",").some(x => x === n || x.includes(n))); });
      say(`rows naming this model (${nm.join("/")}): ${mine.length}`);
      for (const r of mine.slice(0, 20)) say("  " + show(r, ["RECALL_ID", "DEGEM", "SHNAT_RECALL", "BUILD_BEGIN_A", "BUILD_END_A", "TEUR_TAKALA"]));
    }
    // the ministry's recall list searched by the model's names, in case the catalogue file misses rows
    for (const q of [...new Set([v.kinuy_mishari, v.degem_nm].filter(Boolean).map(s => String(s).trim()))]) {
      try {
        const l = await get("datastore_search", {resource_id: LIST, q, limit: "30"});
        say(`recall list, free-text "${q}": ${l.total} row(s)`);
        for (const r of l.records.slice(0, 12)) say("  " + show(r, ["RECALL_ID", "TOZAR_TEUR", "DEGEM", "SHNAT_RECALL", "BUILD_BEGIN_A", "BUILD_END_A", "YEVUAN_TEUR"]));
      } catch (e) { say(`recall list "${q}": ${e.message}`); }
    }
  }
  const imp = importerFor(v);
  if (!imp) { say("no importer page for this maker in the app"); continue; }
  say(`\nimporter page (as in the app): ${imp.name} ${imp.url}`);
  const r = await checkImporter(imp.url, p, true);
  say(`importer answer: ${r.cls} | "${r.msg}" | final URL ${r.url}`);
  say("page requests (xhr/fetch/document; load = before the plate was sent):"); printCalls(r.calls.filter(c => c.phase === "submit" || c.t !== "document" || c.u === imp.url));
  say("page text after the plate was sent (first 2,500 chars):\n" + r.text.slice(0, 2500));

  if (SAMPLE && !NO_GOV) {
    const tally = {};
    const one = async (kind, detail, q, ministryOpen) => {
      addPlate(q);
      const x = await checkImporter(imp.url, q, false);
      const k = `${kind}: ministry ${ministryOpen ? "open" : "none"} / importer ${x.cls}`; tally[k] = (tally[k] || 0) + 1;
      say(`  ${mask(q)} | ${kind} ${detail} | ministry: ${ministryOpen ? "open" : "none"} | importer: ${x.cls} | "${x.msg.slice(0, 90)}"`);
      await wait(4000);
    };
    say(`\n===== sample: ${SAMPLE} other cars of the same model (maker ${v.tozeret_cd}, model ${v.degem_cd}) =====`);
    const same = (await search(ACTIVE, {tozeret_cd: Number(v.tozeret_cd), degem_cd: Number(v.degem_cd)}, 1000).catch(() => ({records: []}))).records.filter(r => String(r.mispar_rechev) !== p);
    say(`the register has ${same.length} car(s) of this maker and model code`);
    const step = Math.max(1, Math.floor(same.length / SAMPLE));
    for (const r of same.filter((_, i) => i % step === 0).slice(0, SAMPLE)) {
      const q = String(r.mispar_rechev); addPlate(q);
      const own = await ownOpen(q);
      await one("same model", String(r.shnat_yitzur), q, own.rows.length > 0);
    }
    say(`\n===== sample: ${SAMPLE} cars of this maker that the ministry lists with an unfixed recall =====`);
    const rec = await fetch(`${CAT}r/${Number(v.tozeret_cd)}.json`).then(r => r.ok ? r.json() : null).catch(() => null);
    const ids = (rec ? rec.rows : []).map(r => Number(r.RECALL_ID)).filter(Boolean).sort((a, b) => b - a);
    const picked = [];
    for (const id of [...new Set(ids)]) {
      if (picked.length >= SAMPLE) break;
      const o = await search(OPEN, {RECALL_ID: id}, 5).catch(() => ({records: []}));
      for (const r of o.records.slice(0, 2)) if (picked.length < SAMPLE) picked.push({q: String(r.MISPAR_RECHEV), id});
    }
    for (const x of picked) { addPlate(x.q); await one("ministry open", "recall " + x.id, x.q, true); }
    say("\ntally: " + JSON.stringify(tally));
  }
}
await browser.close();

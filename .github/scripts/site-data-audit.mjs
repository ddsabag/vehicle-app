// Data-correctness audit of what a user sees for a plate (runs on GitHub: data.gov.il is not reachable from the dev container).
// QUERIES: "mode=discover" prints dataset fields and value lists; otherwise "seed=7;n=100;rare=15[;only=c004,c010]" samples plates
// inside the runner, opens each one in the checkout's index.html like a user, and compares what is rendered with the raw ministry rows.
// Plates, VINs and owner details are never printed: cars are case ids (c001...), plates are masked (first 2 + last 2 digits).
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const OPTS = Object.fromEntries(String(process.env.QUERIES || "").split(/[;,]\s*(?=[a-z]+=)/).map(s => s.split("=")).filter(a => a[0]).map(([k, ...v]) => [k.trim(), v.join("=").trim()]));
const MODE = OPTS.mode || "audit";
const html = fs.readFileSync("index.html", "utf8");
const block = html.slice(html.indexOf("const PLATE_SETS"), html.indexOf("const MODEL_SETS"));
const SETS = [...block.matchAll(/\{key:"([^"]+)",\s*id:"([0-9a-f-]{36})"[^}]*?\}/g)].map(m => ({key: m[1], id: m[2], field: (m[0].match(/field:"([^"]+)"/) || [])[1] || "mispar_rechev", pad: /pad:true/.test(m[0]), role: (m[0].match(/role:"(\w+)"/) || [])[1]}));
const MODEL = Object.fromEntries([...html.slice(html.indexOf("const MODEL_SETS")).slice(0, 600).matchAll(/(\w+):\s*"([0-9a-f-]{36})"/g)].map(m => [m[1], m[2]]));
const SET = k => SETS.find(s => s.key === k);
const API = "https://data.gov.il/api/3/action/";
const sleep = ms => new Promise(r => setTimeout(r, ms));
// AUDIT_LOCAL_MOCK (a module path) is only for testing the harness in a container that cannot reach data.gov.il; it is never set on the runner
const LOCAL_MOCK = process.env.AUDIT_LOCAL_MOCK ? await import(process.env.AUDIT_LOCAL_MOCK) : null;
if (LOCAL_MOCK) { const real = globalThis.fetch; globalThis.fetch = async (u, o) => /data\.gov\.il/.test(String(u)) ? new Response(JSON.stringify(LOCAL_MOCK.answer(String(u))), {status: 200, headers: {"content-type": "application/json"}}) : real(u, o); }
let reqN = 0, lastReq = 0, throttled = 0;
const GAP = Number(OPTS.gap || 450);   // ms between two of my requests
// data.gov.il answers 403 (and the browser sees failed requests) when one address sends more than about 80 requests a minute:
// every request to it, mine and the app's, goes into one sliding one-minute window that is kept under LIMIT
let LIMIT = Number(OPTS.limit || 58); const HITS = [];
const inWin = () => { const t = Date.now() - 60000; while (HITS.length && HITS[0] < t) HITS.shift(); return HITS.length; };
async function slot(n = 1) { for (;;) { if (inWin() + n <= LIMIT || !HITS.length) return; await sleep(Math.max(250, HITS[0] + 60000 - Date.now() + 50)); } }
let coolUntil = 0; const cool = ms => { coolUntil = Math.max(coolUntil, Date.now() + ms); };
async function call(act, params, {tries = 4, quiet = false} = {}) {
  let last;
  for (let a = 0; a < tries; a++) {
    if (coolUntil > Date.now()) await sleep(coolUntil - Date.now());
    await slot(1);
    const wait = lastReq + GAP - Date.now(); if (wait > 0) await sleep(wait);
    lastReq = Date.now(); reqN++; HITS.push(lastReq);
    try {
      const r = await fetch(API + act + "?" + new URLSearchParams(params), {headers: {Accept: "application/json", "User-Agent": "luchit-data-audit/1.0"}, signal: AbortSignal.timeout(60000)});
      if (r.status === 403 || r.status === 429 || r.status >= 500) { last = new Error("HTTP " + r.status); throttled++; if (r.status !== 500) { LIMIT = Math.max(30, Math.round(LIMIT * 0.9)); cool(60000); } else await sleep(5000 * (a + 1)); continue; }
      if (!r.ok) { const e = new Error("HTTP " + r.status); e.status = r.status; throw e; }
      const j = await r.json();
      if (!j.success) throw new Error("CKAN " + JSON.stringify(j.error || {}).slice(0, 120));
      return j.result;
    } catch (e) { last = e; if (e.status && e.status < 500 && e.status !== 429) throw e; await sleep(2000 * (a + 1)); }
  }
  if (!quiet) console.log(`  ! ${act} failed: ${last && last.message}`);
  throw last;
}
const search = (id, p) => call("datastore_search", {resource_id: id, ...Object.fromEntries(Object.entries(p).map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v) : String(v)]))});
const mask = p => { p = String(p); return p.length > 4 ? p.slice(0, 2) + "x".repeat(p.length - 4) + p.slice(-2) : "xx"; };
const PRIV = /^(mispar_rechev|MISPAR_RECHEV|MISPAR RECHEV|misgeret|mispar_shilda|shilda|mispar_manoa|_id|rank)$/i;
const show = o => Object.entries(o || {}).filter(([k, v]) => !PRIV.test(k) && v !== null && String(v).trim() !== "").map(([k, v]) => `${k}=${String(v).trim().slice(0, 60)}`).join(" | ");

/* ================= discovery ================= */
if (MODE === "discover") {
  console.log("datasets in index.html:", SETS.map(s => s.key).join(","), "| model:", Object.keys(MODEL).join(","));
  for (const s of [...SETS, ...Object.entries(MODEL).map(([key, id]) => ({key: "model." + key, id}))]) {
    try {
      const r = await search(s.id, {limit: 1, offset: 1000});
      console.log(`\n## ${s.key} total=${r.total}\nfields: ${r.fields.map(f => f.id + ":" + f.type).join(", ")}\nsample: ${show(r.records[0])}`);
    } catch (e) {
      console.log(`\n## ${s.key} (${s.id}) ERROR ${e.message}`);
      try { const rs = await call("resource_show", {id: s.id}, {tries: 1}); console.log(`  resource_show: name=${rs.name} datastore_active=${rs.datastore_active} package=${rs.package_id} modified=${rs.last_modified || rs.metadata_modified}`); } catch (e2) { console.log("  resource_show: " + e2.message); }
    }
  }
  const distinct = async (key, id, f) => {
    try {
      const r = await search(id, {fields: f, distinct: "true", limit: 400});
      const vals = r.records.map(x => x[f]);
      console.log(`\n## distinct ${key}.${f}: ${vals.length}`);
      if (vals.length <= 60) for (const v of vals) { let t = "?"; try { t = (await search(id, {filters: {[f]: v}, limit: 0})).total; } catch {} console.log(`  ${JSON.stringify(v)}\t${t}`); }
      else console.log("  " + vals.map(v => JSON.stringify(v)).join(" "));
    } catch (e) { console.log(`distinct ${key}.${f}: ${e.message}`); }
  };
  await distinct("active", SET("active").id, "baalut");
  await distinct("active", SET("active").id, "sug_delek_nm");
  await distinct("owners", SET("owners").id, "baalut");
  await distinct("tech", SET("tech").id, "mkoriut_nm");
  await distinct("active", SET("active").id, "tozeret_nm");
  await distinct("recalls", MODEL.recalls, "TOZAR_TEUR");
  await distinct("wltp", MODEL.wltp, "technologiat_hanaa_nm");
  for (const q of ["ביטול סופי", "תג נכה", "ירדו מהכביש", "רכב לא פעיל"]) {
    try { const r = await call("package_search", {q, rows: "15"}); console.log(`\n# package_search "${q}": ${r.count}`); for (const p of r.results) console.log(`- ${p.title} | ${p.resources.filter(x => x.datastore_active).map(x => x.id + ":" + x.name).slice(0, 4).join("; ")}`); }
    catch (e) { console.log(`package_search ${q}: ${e.message}`); }
  }
  console.log(`\nrequests: ${reqN}`);
  process.exit(0);
}

/* ================= audit ================= */
process.env.TZ = "Asia/Jerusalem";
const T0 = Date.now(), BUDGET = Number(OPTS.minutes || 52) * 60000;
const SEED = String(OPTS.seed || "7"), NACT = Number(OPTS.n || 100), NRARE = Number(OPTS.rare || 15);
const ONLY = OPTS.only ? new Set(OPTS.only.split(/[ |+,]/).filter(Boolean)) : null;
const E = v => v === null || v === undefined || String(v).trim() === "" || String(v).trim() === "0000-00-00";
const N = v => Number(String(v).replace(/,/g, "").trim());
const isN = v => !E(v) && !isNaN(N(v));
const dig = s => String(s || "").replace(/[^\d]/g, "");
const nrm = s => String(s || "").toUpperCase().replace(/[^A-Z0-9א-ת]/g, "");
const sp = s => String(s || "").replace(/\s+/g, " ").trim();
function fnv(s) { let h = 0x811c9dc5; for (const c of String(s)) { h ^= c.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; }
const pickOf = (label, n) => n > 0 ? fnv(SEED + "|" + label) % n : 0;
// my own date formatter: YYYY-MM-DD -> DD/MM/YYYY, YYYY-M -> MM/YYYY, YYYYMM -> MM/YYYY
function fd(v) { const s = String(v).trim(); let m;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) return `${m[3]}/${m[2]}/${m[1]}`;
  if ((m = s.match(/^(\d{4})-(\d{1,2})$/))) return `${m[2].padStart(2, "0")}/${m[1]}`;
  if ((m = s.match(/^(\d{4})(\d{2})$/))) return `${m[2]}/${m[1]}`;
  if ((m = s.match(/^(\d{4})(\d{2})(\d{2})$/))) return `${m[3]}/${m[2]}/${m[1]}`;
  return s; }
const ymd = v => { const m = String(v || "").match(/^(\d{4})-?(\d{2})-?(\d{2})/); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
const ym = v => { const m = String(v || "").match(/^(\d{4})-?(\d{1,2})/); return m ? new Date(+m[1], +m[2] - 1, 1) : null; };
const today = (() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); })();
const ORD = ["", "ראשונה", "שנייה", "שלישית", "רביעית", "חמישית", "שישית", "שביעית", "שמינית", "תשיעית", "עשירית"];
const FEE = (() => { const t = html.slice(html.indexOf("const FEE_TABLE"), html.indexOf("};", html.indexOf("const FEE_TABLE"))); const o = {}; for (const m of t.matchAll(/(\d):\[([\d,]+)\]/g)) o[m[1]] = m[2].split(",").map(Number); return o; })();

/* ---------- my own raw reads ---------- */
const TEXT_PLATE = new Set(["cancel2010", "cancel2000"]);   // plate column is text there (zero-padded); numeric everywhere else
async function rowsByPlate(set, plate) {
  const forms = TEXT_PLATE.has(set.key) ? [String(plate), plate.padStart(7, "0"), plate.padStart(8, "0")] : [Number(plate)];
  let err = null, ok = false;
  for (const v of [...new Set(forms)]) {
    try { const r = await search(set.id, {filters: {[set.field]: v}, limit: 50}); ok = true; if (r.records.length) return {rows: r.records}; }
    catch (e) { err = e; if (e.status === 404) break; }
  }
  return {rows: [], err: ok ? null : (err && err.message) || "error"};
}
async function modelRowsMine(id, R) {
  for (const f of [{tozeret_cd: N(R.tozeret_cd), degem_cd: N(R.degem_cd)}, {tozeret_cd: String(R.tozeret_cd).trim(), degem_cd: String(R.degem_cd).trim()}]) {
    try { const r = await search(id, {filters: f, limit: 500}); if (r.records.length) return r.records; } catch {}
  }
  return [];
}
let RECALL_LIST = null;
async function recallList() {
  if (RECALL_LIST) return RECALL_LIST;
  const all = []; let total = Infinity;
  for (let off = 0; off < total; off += 1000) { const r = await search(MODEL.recalls, {limit: 1000, offset: off}); total = r.total; all.push(...r.records); if (!r.records.length) break; }
  return RECALL_LIST = all;
}
// brand of the register's maker name -> the recall list's TOZAR_TEUR (English); my own table
const BRANDS = [[/טויוטה/, /TOYOTA/], [/לקסוס/, /LEXUS/], [/יונדא/, /HYUNDAI/], [/קיה/, /\bKIA\b/], [/מאזדה|מזדה/, /MAZDA/], [/סקודה/, /SKODA/], [/פולקסווגן|פולקסוואגן/, /VOLKSWAGEN|\bVW\b/],
  [/סיאט/, /SEAT/], [/קופרה/, /CUPRA|SEAT/], [/אאודי|אודי/, /AUDI/], [/ניסאן|ניסן/, /NISSAN/], [/מיצובישי/, /MITSUBISHI/], [/סוזוקי/, /SUZUKI/], [/הונדה/, /HONDA/], [/סובארו/, /SUBARU/],
  [/פיג.?ו|פז.?ו/, /PEUGEOT/], [/סיטרואן/, /CITROEN/], [/רנו/, /RENAULT/], [/דאצ.?יה/, /DACIA/], [/אופל/, /OPEL/], [/שברולט/, /CHEVROLET/], [/פורד/, /FORD/], [/פיאט/, /FIAT/], [/ג.?יפ/, /JEEP/],
  [/ב\.? ?מ\.? ?וו|במוו|BMW/, /BMW/], [/מרצדס/, /MERCEDES|DAIMLER/], [/מיני/, /MINI/], [/וולוו|וולבו/, /VOLVO/], [/טסלה/, /TESLA/], [/BYD|בי ?וו?י ?די/, /BYD/], [/ג.?ילי/, /GEELY/], [/צ.?רי/, /CHERY/],
  [/(?<![א-ת])מ\.? ?ג(?![א-ת])|אם.?ג.?י|\bMG\b/, /\bMG\b|SAIC/], [/אלפא/, /ALFA/], [/לנד רובר|ריינג|רובר/, /LAND ?ROVER|RANGE|\bROVER/], [/י?ג.?ואר/, /JAGUAR/], [/פורשה/, /PORSCHE/], [/איסוזו/, /ISUZU/],
  [/סאנג|קיי ?ג.?י|KGM/, /SSANG|KGM/], [/דודג|דודג'/, /DODGE/], [/קרייזלר/, /CHRYSLER/], [/ראם/, /\bRAM\b/], [/לינק/, /LYNK/], [/פולסטאר/, /POLESTAR/], [/סמארט/, /SMART/], [/ג.?נסיס/, /GENESIS/],
  [/קאדילק/, /CADILLAC/], [/ג.?י אם סי|GMC/, /GMC/], [/איווקו/, /IVECO/], [/זיקר/, /ZEEKR/], [/אקספנג/, /XPENG/], [/ליפמוטור/, /LEAPMOTOR/], [/ג.?אקו/, /JAECOO/], [/אומודה/, /OMODA/],
  [/די ?אס|^DS/, /\bDS\b/], [/מקסוס/, /MAXUS/], [/ימאהה/, /YAMAHA/], [/קוואסאקי/, /KAWASAKI/], [/הארלי/, /HARLEY/], [/דוקאטי/, /DUCATI/], [/ק.?ט.?מ|KTM/, /KTM/], [/פיאג.?ו/, /PIAGGIO/], [/ספה/, /VESPA|PIAGGIO/], [/סאן ?יאנג|SYM/, /SYM|SANYANG/], [/קימקו|קואנג ?יאנג/, /KYMCO|KWANG/], [/דיפאל/, /DEEPAL|CHANGAN/]];
const BRANDS_AT = BRANDS.map(([he, en]) => [new RegExp("^(?:" + he.source + ")"), en]);
const brandRe = (mk, lat) => { mk = String(mk || "").trim(); lat = String(lat || "").trim().toUpperCase();
  for (const [he, en] of BRANDS_AT) if (he.test(mk)) return en;     // the Hebrew maker name, from its first word
  for (const [, en] of BRANDS) if (lat && en.test(lat)) return en;  // else the Latin maker name, when the row has one
  return null; };

/* ---------- sampling (inside the runner, deterministic by seed) ---------- */
async function count(id, filters, q) { const p = {limit: 0}; if (filters && Object.keys(filters).length) p.filters = filters; if (q) p.q = q; return (await search(id, p)).total; }
async function rowAt(id, filters, q, off, field) { const p = {limit: 1, offset: off, fields: field}; if (filters && Object.keys(filters).length) p.filters = filters; if (q) p.q = q; const r = await search(id, p); return r.records[0] && r.records[0][field]; }
const OWNS = (OPTS.owns || "פרטי|ליסינג|השכרה|חברה").split("|");
const FUELS = [{k: "petrol", f: {sug_delek_nm: "בנזין"}}, {k: "diesel", f: {sug_delek_nm: "דיזל"}}, {k: "ev", f: {sug_delek_nm: "חשמל"}}, {k: "hybrid", f: {sug_delek_nm: "בנזין"}, q: "HYBRID"}, {k: "phev", f: {sug_delek_nm: "חשמל/בנזין"}}];
const HYB = ["HYBRID", "HEV", "HSD"];
const MAKES = (OPTS.makes || "טויוטה יפן|יונדאי קוריאה|קיה ד. קוריאה|מזדה יפן|סקודה צ'כיה|מיצובישי יפן|סוזוקי יפן|פולקסווגן גרמנ|רנו צרפת|פיג'ו צרפת|ניסאן אנגליה|הונדה יפן|סובארו יפן|אאודי גרמניה|מרצדס בנץ גרמנ|ב מ וו גרמניה|סיטרואן צרפת|אופל גרמניה|שברולט ד.קוריא|פורד גרמניה|סיאט ספרד|ג'יפ ארהב\"|טויוטה טורקיה|יונדאי טורקיה|צ'רי סין|וולבו בלגיה").split("|").filter(Boolean);
async function sample() {
  const cases = [], seen = new Set();
  const add = (plate, from, why) => { plate = String(plate || "").replace(/\D/g, ""); if (!plate || seen.has(plate)) return false; seen.add(plate); cases.push({id: "c" + String(cases.length + 1).padStart(3, "0"), plate, from, why}); return true; };
  const act = SET("active").id;
  for (let i = 0; i < NACT; i++) {
    const y = 2005 + (i % 22), o = OWNS[Math.floor(i / 22) % OWNS.length], fu0 = FUELS[(i + Math.floor(i / 22)) % FUELS.length], fu = fu0.q ? {...fu0, q: HYB[i % HYB.length]} : fu0;
    const mk = OPTS.makes && MAKES.length && i % 3 === 0 ? MAKES[pickOf("mk" + i, MAKES.length)] : null;
    const tries = [...(mk ? [[mk, fu, o]] : []), [null, fu, o], [null, null, o], [null, fu, null], [null, null, null]];
    let done = false;
    for (const [m, f, ow] of tries) {
      if (done) break;
      const filt = {shnat_yitzur: y, ...(f ? f.f : {}), ...(ow ? {baalut: ow} : {}), ...(m ? {tozeret_nm: m} : {})};
      let tot = 0; try { tot = await count(act, filt, f && f.q); } catch { continue; }
      if (!tot) continue;
      for (let k = 0; k < 2 && !done; k++) {
        try { const p = await rowAt(act, filt, f && f.q, pickOf(`a${i}.${k}`, tot), "mispar_rechev"); done = add(p, "active", `y=${y} own=${ow || "*"} fuel=${f ? f.k : "*"}${m ? " make=" + m : ""} of ${tot}`); } catch {}
      }
    }
  }
  const rare = [["inactive", 2], ["inactive2", 1], ["cancel", 2], ["cancel2010", 1], ["cancel2000", 1], ["import", 3], ["moto", 2], ["heavy", 2], ["public", 1]];
  let left = NRARE;
  for (const [k, want] of rare) {
    const s = SET(k); if (!s || left <= 0) continue;
    let tot = 0; try { tot = await count(s.id, null); } catch (e) { console.log(`sample ${k}: ${e.message}`); continue; }
    for (let j = 0; j < want && left > 0; j++) { try { const p = await rowAt(s.id, null, null, pickOf(`r${k}${j}`, tot), s.field); if (add(p, k, `${k} of ${tot}`)) left--; } catch (e) { console.log(`sample ${k}: ${e.message}`); } }
  }
  return cases;
}

/* ---------- raw facts for one plate ---------- */
const MAIN_ORDER = SETS.filter(s => s.role === "main").map(s => s.key);
async function raw(c) {
  const out = {sets: {}, errs: {}};
  const extra = fnv(c.id) % 4 === 0;   // one active car in four is also looked up in the import and off-the-road registers and the disability-tag list
  const mains = c.from === "active" ? ["active", ...(extra ? ["import", "cancel"] : [])] : [...new Set(["active", "import", "inactive", "cancel", c.from])];
  for (const k of [...mains, ...(c.from === "active" ? [] : ["cont"]), "tech", "owners", "recall", ...(c.from !== "active" || extra ? ["tag"] : [])]) { const r = await rowsByPlate(SET(k), c.plate); out.sets[k] = r.rows; if (r.err) out.errs[k] = r.err; }
  const primary = MAIN_ORDER.find(k => out.sets[k] && out.sets[k].length) || null;
  const R = {};
  const fill = r => { for (const [k, v] of Object.entries(r || {})) if (E(R[k]) && !E(v)) R[k] = v; };
  MAIN_ORDER.filter(k => out.sets[k] && out.sets[k].length).forEach(k => fill(out.sets[k][0]));
  fill((out.sets.cont || [])[0]); fill((out.sets.tech || [])[0]);
  out.primary = primary; out.R = R;
  if (!E(R.tozeret_cd) && !E(R.degem_cd)) {
    out.wltp = await modelRowsMine(MODEL.wltp, R); out.price = await modelRowsMine(MODEL.price, R);
    if (!E(R.kinuy_mishari) && isN(R.shnat_yitzur) && (fnv(c.id + "k") % 3 === 0 || c.from !== "active")) { try { out.cohort = await count(SET("active").id, {kinuy_mishari: R.kinuy_mishari, shnat_yitzur: N(R.shnat_yitzur)}); } catch {} }
  } else { out.wltp = []; out.price = []; }
  return out;
}

/* ---------- the page, read like a user ---------- */
const BLOCK = /cloudflareinsights|google-analytics|googletagmanager|doubleclick|googlesyndication|facebook\.(com|net)|clarity\.ms|hotjar|luchit\.app\/api\/e/;
let browser, ctx, BASE;
async function startBrowser() {
  const root = process.cwd();
  const TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".txt": "text/plain"};
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname); if (p.endsWith("/")) p += "index.html";
    const f = path.join(root, p);
    if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, {"content-type": TYPES[path.extname(f)] || "application/octet-stream"}); fs.createReadStream(f).pipe(res);
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r)); server.unref();
  BASE = `http://127.0.0.1:${server.address().port}/`;
  const {chromium} = await import("playwright");
  browser = await chromium.launch();
  ctx = await browser.newContext({viewport: {width: 1100, height: 900}, locale: "he-IL", timezoneId: "Asia/Jerusalem", serviceWorkers: "block"});
  await ctx.addInitScript(() => { try { localStorage.setItem("analyticsOff", "1"); localStorage.setItem("reviewAsked", "1"); } catch {} });
  await ctx.route("**/*", route => BLOCK.test(route.request().url()) ? route.abort() : route.continue());
  if (LOCAL_MOCK) await ctx.route(/data\.gov\.il/, route => route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify(LOCAL_MOCK.answer(route.request().url()))}));   // local harness test only
}
function collect() {
  const T = el => (el ? el.textContent : "").replace(/\s+/g, " ").trim();
  const panel = document.querySelector("#tabpanel");
  const cards = panel ? [...panel.querySelectorAll("section.card")].map(c => ({
    title: T(c.querySelector(".head h2")), count: T(c.querySelector(".head .count")),
    facts: [...c.querySelectorAll("dl.facts > div")].map(d => [T(d.querySelector("dt")), T(d.querySelector("dd"))]),
    text: T(c.querySelector(".fold-body")),
    recalls: [...c.querySelectorAll(".recall")].map(r => ({b: T(r.querySelector("b")), note: T(r.querySelector(".note"))})),
    rlist: [...c.querySelectorAll(".rlist > li")].map(li => ({dim: li.classList.contains("dim"), time: T(li.querySelector("time")), pill: T(li.querySelector(".pill")), b: T(li.querySelector(":scope > b")), note: T(li.querySelector(":scope > .note"))})),
    timeline: [...c.querySelectorAll(".timeline > li")].map(li => ({time: T(li.querySelector("time")), text: T(li.querySelectorAll(":scope > span")[1])})),
    grid: [...c.querySelectorAll(".tow-grid > *")].map(d => ({k: T(d.querySelector(".k")), v: T(d.querySelector(".v"))})),
    hook: T(c.querySelector(".hook-box")), ban: T(c.querySelector(".tow-ban")), firstOwn: T(c.querySelector(".first-own b")),
    items: [...c.querySelectorAll(".insights > li")].map(li => T(li.querySelector("b"))),
    stl: [...c.querySelectorAll(".stl-h b")].map(T),
    notes: [...c.querySelectorAll("p.note")].map(T),
  })) : [];
  const stats = panel ? [...panel.querySelectorAll(".stats .stat")].map(s => ({k: T(s.querySelector(".k")), v: T(s.querySelector(".v"))})) : [];
  return {cards, stats, text: T(panel)};
}
async function readPage(plate) {
  if (coolUntil > Date.now()) await sleep(coolUntil - Date.now());
  await slot(Number(OPTS.appslot || 16));
  const page = await ctx.newPage(); const perr = [], net = {n: 0, bad: [], failed: 0, t0: Date.now(), ms: 0};
  page.on("pageerror", e => perr.push(String(e).slice(0, 140).replace(/\d{6,8}/g, "<n>")));
  page.on("request", r => { if (/data\.gov\.il/.test(r.url())) { net.n++; HITS.push(Date.now()); } });
  // 403/429/5xx = the ministry refused or failed; a request the browser reports as failed is usually an error answer without CORS headers (a numeric filter on a text column), which the app expects
  page.on("response", r => { if (/data\.gov\.il/.test(r.url()) && (r.status() === 403 || r.status() === 429 || r.status() >= 500)) net.bad.push(r.status()); });
  page.on("requestfailed", r => { if (/data\.gov\.il/.test(r.url())) net.failed++; });
  try {
    await page.goto(BASE + "?plate=" + plate, {waitUntil: "domcontentloaded", timeout: 30000});
    await page.waitForFunction(() => document.querySelector("#out .id-card") || document.querySelector("#out .msg.edge"), null, {timeout: 50000});
    net.ms = Date.now() - net.t0;
    const edge = await page.evaluate(() => { const m = document.querySelector("#out .msg.edge"); return m ? m.textContent.replace(/\s+/g, " ").trim() : ""; });
    if (edge) return {edge: edge.replace(/\d[\d-]{5,}/g, "<plate>"), perr, net};
    await page.waitForTimeout(1200);
    const head = await page.evaluate(() => {
      const T = el => (el ? el.textContent : "").replace(/\s+/g, " ").trim(), o = document.querySelector("#out");
      return {title: T(o.querySelector(".id-title")), sub: T(o.querySelector(".id-sub")), pills: [...o.querySelectorAll(".id-card .pill")].map(T), drive: T(o.querySelector(".id-card .pill.drive")),
        banners: [...o.querySelectorAll(".alert-banner")].map(T), msgs: [...o.querySelectorAll(".side .msg, .side p.msg")].map(T),
        errs: typeof current !== "undefined" && current && current.errs ? current.errs.map(s => s.key) : [], ownMirror: !!(typeof current !== "undefined" && current && current.ownMirror),
        srcFoot: T(o.querySelector("#srcFoot"))};
    });
    const tabs = {};
    for (const k of ["overview", "recalls", "buy", "maint", "specs"]) {
      await page.click(`.tabs [data-tab="${k}"]`);
      await page.waitForFunction(k => { const b = document.querySelector(`#tab-${k}`); return b && b.getAttribute("aria-selected") === "true"; }, k, {timeout: 5000}).catch(() => null);
      await page.waitForTimeout(k === "buy" ? 900 : 250);
      tabs[k] = await page.evaluate(collect);
    }
    return {head, tabs, perr, net};
  } catch (e) { return {edge: "harness: " + e.message.slice(0, 120), perr, net}; }
  finally { await page.close().catch(() => {}); }
}

/* ---------- expectations from the raw rows (my own rules, written from the app's stated wording) ---------- */
const DEALER = /סוחר|יבואן/;
const kindOf = t => { t = String(t || ""); return /השכר/.test(t) ? "rental" : /ליסינג|החכר|חכיר/.test(t) ? "lease" : /לנהיגה|לימוד|מונית|ממשל|סיור|תיור|הסעה/.test(t) ? "special" : /חברה|חברת|תאגיד/.test(t) ? "company" : /פרטי/.test(t) ? "private" : "other"; };
function pool(rows, R, opt = {}) {
  let rs = rows || [];
  const sd = String(R.sug_degem || "").trim().toUpperCase();
  if (sd && rs.some(r => !E(r.sug_degem))) rs = rs.filter(r => String(r.sug_degem || "").trim().toUpperCase() === sd);
  if (opt.filter) rs = rs.filter(opt.filter);
  const y = N(R.shnat_yitzur);
  let p = rs.filter(r => N(r.shnat_yitzur) === y);
  if (!p.length && rs.length) { const d = Math.min(...rs.map(r => isN(r.shnat_yitzur) ? Math.abs(N(r.shnat_yitzur) - y) : 99)); p = rs.filter(r => (isN(r.shnat_yitzur) ? Math.abs(N(r.shnat_yitzur) - y) : 99) === d); }
  const tr = nrm(R.ramat_gimur), t = tr ? p.filter(r => nrm(r.ramat_gimur) === tr) : [];
  return t.length ? t : p;
}
const vals = (rows, f, keep = v => !E(v)) => [...new Set(rows.map(r => r[f]).filter(keep).map(v => String(v).trim()))];
const posV = v => isN(v) && N(v) > 0;

const STAT = {}; const MIS = []; const NOTES = []; const MAKEPAIRS = new Map(); const STLS = []; const AMBIG = [];
function check(c, field, ok, shown, expected, evidence, quiet) {
  STAT[field] ||= {n: 0, bad: 0, cases: [], quiet: !!quiet}; STAT[field].n++;
  if (ok) return;
  STAT[field].bad++;
  if (quiet) return;   // a personal fact (the disability tag): only the totals are printed
  STAT[field].cases.push(c.id);
  const line = `MISMATCH ${c.id} ${mask(c.plate)} | ${field} | shown="${String(shown).slice(0, 140)}" | expected="${String(expected).slice(0, 140)}"${evidence ? " | evidence: " + String(evidence).slice(0, 260) : ""}`;
  MIS.push(line); console.log(line);
}
const cardOf = (P, tab, re) => (P.tabs[tab] || {cards: []}).cards.find(c => re.test(c.title));
const factOf = (P, tab, re, label) => { const c = cardOf(P, tab, re); const f = c && c.facts.find(([k]) => k === label); return f ? f[1] : ""; };

function compare(c, X, P) {
  const R = X.R, v = R, y = N(R.shnat_yitzur), cancelled = /^cancel/.test(X.primary || ""), inactive = /^inactive/.test(X.primary || "");
  const W = pool(X.wltp, R), PR = pool(X.price, R, {filter: r => posV(r.mehir)});
  const spec = l => factOf(P, "specs", /^הרכב$/, l) || factOf(P, "specs", /^מנוע והנעה$/, l) || factOf(P, "specs", /^משקלים וצמיגים$/, l) || factOf(P, "specs", /^בטיחות$/, l) || factOf(P, "specs", /^סביבה$/, l);
  const inSet = (shown, set, f = x => sp(x)) => set.map(f).includes(f(shown));
  // identity
  check(c, "identity.year", sp(spec("שנת ייצור")) === sp(R.shnat_yitzur || ""), spec("שנת ייצור"), R.shnat_yitzur || "", "");
  const mk = spec("יצרן"); MAKEPAIRS.set(`${sp(R.tozeret_nm)} -> ${mk}`, (MAKEPAIRS.get(`${sp(R.tozeret_nm)} -> ${mk}`) || 0) + 1);
  check(c, "identity.make", !E(mk) || E(R.tozeret_nm), mk, R.tozeret_nm, "");
  const modelExp = !E(R.kinuy_mishari) ? [R.kinuy_mishari] : vals(W, "kinuy_mishari").concat(E(R.degem_nm) ? [] : [R.degem_nm]);
  check(c, "identity.model", modelExp.length ? inSet(spec("דגם"), modelExp) : E(spec("דגם")), spec("דגם"), modelExp.join(" / "), `kinuy=${R.kinuy_mishari || ""} degem_nm=${R.degem_nm || ""}`);
  const trimExp = !E(R.ramat_gimur) ? [R.ramat_gimur] : vals(W, "ramat_gimur");
  check(c, "identity.trim", trimExp.length ? inSet(spec("רמת גימור"), trimExp) : E(spec("רמת גימור")), spec("רמת גימור"), trimExp.join(" / "), "");
  check(c, "identity.colour", sp(spec("צבע")) === sp(R.tzeva_rechev || ""), spec("צבע"), R.tzeva_rechev || "", "");
  const fuelExp = !E(R.sug_delek_nm) ? [R.sug_delek_nm] : vals(W, "delek_nm");
  check(c, "identity.fuel", fuelExp.length ? inSet(spec("דלק"), fuelExp) : E(spec("דלק")), spec("דלק"), fuelExp.join(" / "), "");
  const ccExp = posV(R.nefach_manoa) ? [String(N(R.nefach_manoa))] : vals(W, "nefah_manoa", posV).map(x => String(N(x)));
  check(c, "identity.engine_cc", ccExp.length ? ccExp.includes(dig(spec("נפח מנוע"))) : E(spec("נפח מנוע")), spec("נפח מנוע"), ccExp.join(" / "), "");
  { const reg = String(R.sug_delek_nm || ""), tech = vals(W, "technologiat_hanaa_nm").join(" ").toUpperCase(), fuel = reg || vals(W, "delek_nm").join(" ");
    const exp = new Set();
    if (/^חשמל$/.test(reg.trim()) || (!reg && /חשמל/.test(fuel) && !/בנזין|דיזל/.test(fuel))) exp.add("חשמלי");
    else if (/חשמל\//.test(reg) || /PLUG|פלאג|נטען/.test(tech)) exp.add("פלאג-אין");
    else if (/היברידי/.test(tech)) exp.add("היברידי");
    else if (/דיזל|סולר/.test(fuel)) exp.add("דיזל");
    else if (/גפ"?מ|גז/.test(fuel)) exp.add("גפ״מ");
    else if (fuel) exp.add("בנזין");
    if (/היברידי/.test(tech) && /PLUG|פלאג/.test(tech)) { exp.add("היברידי"); exp.add("פלאג-אין"); }
    if (/חשמלי/.test(tech) && !/PLUG|פלאג|היברידי/.test(tech)) exp.add("חשמלי");
    check(c, "identity.drive_pill", exp.size ? exp.has(P.head.drive) : !P.head.drive, P.head.drive, [...exp].join(" / "), `sug_delek_nm=${reg} tech=${vals(W, "technologiat_hanaa_nm").join("|")}`); }
  { const vin = (P.tabs.specs.cards.find(x => x.title === "מספרי זיהוי") || {}).text || "", want = R.misgeret || R.mispar_shilda || "";
    check(c, "identity.vin", E(want) ? true : vin.includes(String(want).trim()), "(vin hidden)", "(vin hidden)", E(want) ? "" : "register VIN not found in the card"); }
  // status
  const pills = P.head.pills.join(" | ");
  check(c, "status.inactive_pill", inactive === P.head.pills.includes("לא פעיל"), pills, inactive ? "לא פעיל" : "(no inactive pill)", `primary=${X.primary}`);
  check(c, "status.cancel_pill", cancelled === P.head.pills.includes("ירד מהכביש") && cancelled === P.head.banners.some(b => /הרכב ירד מהכביש/.test(b)), pills + " || " + P.head.banners.join(" | ").slice(0, 80), cancelled ? "pill+banner ירד מהכביש" : "(none)", `primary=${X.primary}`);
  const imp = (X.sets.import || []).length > 0;
  check(c, "status.import_pill", imp === P.head.pills.some(p => /יבוא/.test(p)), pills, imp ? `pill "${String(X.sets.import[0].sug_yevu || "יבוא אישי")}"` : "(no import pill)", `in import dataset: ${imp}; primary=${X.primary}`);
  { const t = P.tabs.buy.text; const says = /הרכב פעיל ולא בוטל/.test(t);
    check(c, "status.buy_checklist", !(says && (inactive || cancelled)), says ? "הרכב פעיל ולא בוטל" : "(other)", inactive ? "not 'פעיל' for a car registered as לא פעיל" : "", `primary=${X.primary}`); }
  if (X.primary === "heavy") check(c, "status.heavy_note", /רכב כבד/.test(P.tabs.overview.text), "", "רכב כבד: מידע חלקי", "");
  if (cancelled) { const sh = factOf(P, "overview", /^רישוי וטסט$/, "ירד מהכביש"), ex = E(R.bitul_dt) ? "" : fd(R.bitul_dt);
    check(c, "status.cancel_date", sp(sh) === sp(ex), sh, ex, ""); }
  // test
  { const t = ymd(R.tokef_dt), sh = factOf(P, "overview", /^רישוי וטסט$/, "טסט בתוקף עד");
    check(c, "test.valid_until", E(R.tokef_dt) ? E(sh) : sh === fd(R.tokef_dt), sh, E(R.tokef_dt) ? "" : fd(R.tokef_dt), "");
    const pill = P.head.pills.find(p => /^טסט/.test(p)) || "";
    const expPill = !t || cancelled ? "" : t < today ? "טסט לא בתוקף" : `טסט עד ${String(t.getMonth() + 1).padStart(2, "0")}/${t.getFullYear()}`;
    check(c, "test.pill", pill === expPill, pill, expPill, `tokef_dt=${R.tokef_dt || ""}`);
    const sl = factOf(P, "overview", /^רישוי וטסט$/, "טסט אחרון");
    check(c, "test.last", E(R.mivchan_acharon_dt) ? E(sl) : sl === fd(R.mivchan_acharon_dt), sl, E(R.mivchan_acharon_dt) ? "" : fd(R.mivchan_acharon_dt), ""); }
  // km
  { const st = P.tabs.overview.stats, km = st.find(s => s.k === "ק״מ בטסט האחרון"), per = st.find(s => s.k === "ממוצע לשנה");
    const kmR = posV(R.kilometer_test_aharon) ? N(R.kilometer_test_aharon) : null;
    check(c, "km.last_test", kmR ? km && N(dig(km.v)) === kmR : !km, km ? km.v : "", kmR || "", "");
    if (kmR) { const start = ym(R.moed_aliya_lakvish) || (isN(R.shnat_yitzur) ? new Date(N(R.shnat_yitzur), 6, 1) : null), td = ymd(R.mivchan_acharon_dt) || new Date();
      if (start) { const yrs = Math.max(((td.getFullYear() - start.getFullYear()) * 12 + (td.getMonth() - start.getMonth()) + (td.getDate() - start.getDate()) / 30) / 12, 0.5), e = Math.round(kmR / yrs / 100) * 100;
        check(c, "km.per_year", e === 0 ? !per : per && Math.abs(N(dig(per.v)) - e) <= Math.max(200, e * 0.03), per ? per.v : "", e === 0 ? "(not shown: rounds to 0)" : e, `km=${kmR} road=${R.moed_aliya_lakvish || ""} test=${R.mivchan_acharon_dt || ""}`); } } }
  // road dates
  { const sh = factOf(P, "overview", /^רישוי וטסט$/, "עלה לכביש"); check(c, "road.first_date", E(R.moed_aliya_lakvish) ? E(sh) : sh === fd(R.moed_aliya_lakvish), sh, E(R.moed_aliya_lakvish) ? "" : fd(R.moed_aliya_lakvish), "");
    const rr = factOf(P, "overview", /^רישוי וטסט$/, "רישום ראשון"); check(c, "road.first_registration", E(R.rishum_rishon_dt) ? E(rr) : rr === fd(R.rishum_rishon_dt), rr, E(R.rishum_rishon_dt) ? "" : fd(R.rishum_rishon_dt), ""); }
  // ownership
  { const own = (X.sets.owners || []).filter(r => !E(r.baalut)).sort((a, b) => String(a.baalut_dt).localeCompare(String(b.baalut_dt)));
    const card = cardOf(P, "overview", /^היסטוריית בעלויות$/), mirror = P.head.ownMirror;
    const road = ym(R.moed_aliya_lakvish) || (isN(R.shnat_yitzur) ? new Date(N(R.shnat_yitzur), 0, 1) : null), floor = !road || road < new Date(2017, 0, 1);
    const hands = own.filter(r => !DEALER.test(r.baalut)), n = hands.length, fo = String(R.mkoriut_nm || "").replace(/"/g, "").trim();
    let exp = "";
    if (!n) exp = own.length ? "אצל סוחר" : "";
    else if (n === 1) exp = !floor && (!fo || kindOf(fo) === kindOf(hands[0].baalut)) ? "יד ראשונה" : "יד אחת במאגר";
    else exp = `${floor ? "לפחות " : ""}יד ${ORD[n] || n}`;
    const ev = `log=${own.map(r => `${r.baalut}@${r.baalut_dt}`).join(">")} road=${R.moed_aliya_lakvish || ""} mkoriut=${fo}`;
    if (mirror) NOTES.push(`${c.id}: ownership from the app's mirror (API returned no rows to the app); my API rows=${own.length}`);
    else {
      const shown = card ? card.count : "";
      check(c, "owners.hands", shown === exp, shown, exp, ev);
      const pill = P.head.pills.find(p => /יד |אצל סוחר/.test(p)) || "";
      check(c, "owners.hands_pill", pill === exp, pill, exp, "");
      const expTl = own.slice().reverse().map((r, i) => `${fd(r.baalut_dt)} ${sp(r.baalut)}${i === 0 ? "נוכחי" : ""}`).join(" / ");
      const shTl = card ? card.timeline.map(t => `${t.time} ${t.text}`).join(" / ") : "";
      check(c, "owners.timeline", sp(shTl) === sp(expTl), shTl, expTl, "");
      if (!own.length && !E(R.baalut)) { const cur = factOf(P, "overview", /^בעלות$/, "בעלות נוכחית"); check(c, "owners.current_no_log", sp(cur) === sp(R.baalut), cur, R.baalut, ""); }
    }
    { const sh = ((cardOf(P, "overview", /^(היסטוריית בעלויות|בעלות)$/) || {}).firstOwn || "").replace(/^בעלות ראשונה: /, ""), ex = /^ביס לנהיגה/.test(fo) ? "בית ספר לנהיגה" : fo;
      check(c, "owners.first_owner", sp(sh) === sp(ex), sh, ex, ""); }
    if (own.length && !E(R.baalut) && kindOf(own[own.length - 1].baalut) !== kindOf(R.baalut) && !DEALER.test(own[own.length - 1].baalut))
      NOTES.push(`${c.id} ${mask(c.plate)}: source: last ownership-log type "${own[own.length - 1].baalut}" (${own[own.length - 1].baalut_dt}) differs from the register's current baalut "${R.baalut}"`);
    // insights the ownership log drives
    const past = own.slice(0, -1).map(r => String(r.baalut));
    if (!mirror && own.length) {
      const ins = (cardOf(P, "overview", /^מידע חשוב/) || {items: []}).items;
      check(c, "owners.insight_rental", past.some(t => /השכר/.test(t)) === ins.includes("היה רכב השכרה"), ins.join(" | ").slice(0, 120), past.some(t => /השכר/.test(t)) ? "היה רכב השכרה" : "(none)", "");
      const pl = past.some(t => /החכר|ליסינג/.test(t));
      check(c, "owners.insight_lease", pl === ins.includes("היה רכב ליסינג"), ins.join(" | ").slice(0, 120), pl ? "היה רכב ליסינג" : "(none)", pl ? "a past log record is " + past.filter(t => /החכר|ליסינג/.test(t)).join(",") : "");
      const DLR = /סוחר|יבואן|מסחר/, cur = String(own[own.length - 1].baalut), pastDealer = past.some(t => DLR.test(t));
      const coCur = own.length > 1 && /חברה|חברת|תאגיד|החכר|השכר|ליסינג/.test(cur) && !DLR.test(cur), coNow = coCur && !pastDealer;
      if (coCur && pastDealer && !ins.includes("הרכב רשום כעת על חברה")) NOTES.push(`${c.id}: current log type ${cur} after a dealer: the page says only "היה אצל סוחר" (the company-now line is in the same else-if chain)`);
      check(c, "owners.insight_company_now", coNow === ins.includes("הרכב רשום כעת על חברה"), ins.join(" | ").slice(0, 120), coNow ? "הרכב רשום כעת על חברה" : "(none)", coNow ? `current log type ${cur}` : "");
      const lastDealer = DLR.test(cur);
      check(c, "owners.insight_dealer_now", lastDealer === ins.includes("הרכב רשום כעת על סוחר"), ins.join(" | ").slice(0, 120), lastDealer ? "הרכב רשום כעת על סוחר" : "(none)", "");
    }
  }
  { const has = (X.sets.tag || []).length > 0, said = /לרכב יש תג חניה לנכה/.test(P.tabs.overview.text);
    if (X.sets.tag !== undefined && !X.errs.tag) check(c, "tag.insight", has === said, "", "", "", true); }
  // open recalls on this car
  { const ids = (X.sets.recall || []).map(r => String(r.RECALL_ID).trim()).sort();
    const card = cardOf(P, "recalls", /^ריקולים פתוחים לרכב הזה$/), shown = card ? card.recalls.map(r => (r.note.match(/מספר (\d+)/) || [])[1] || "?").sort() : [];
    const ban = P.head.banners.find(b => /ריקול/.test(b) && /פתוח/.test(b)) || "";
    check(c, "recalls.open", ids.join(",") === shown.join(","), shown.join(",") || "(none)", ids.join(",") || "(none)", X.errs.recall ? "my query failed: " + X.errs.recall : "");
    const bn = ban ? (/יש ריקול פתוח/.test(ban) ? 1 : N((ban.match(/(\d+) ריקולים/) || [])[1])) : 0;
    check(c, "recalls.open_banner", bn === ids.length, ban.slice(0, 60) || "(no banner)", ids.length, "");
    for (const r of X.sets.recall || []) { const s = card && card.recalls.find(x => x.note.includes("מספר " + String(r.RECALL_ID).trim()));
      if (s && !E(r.TAARICH_PTICHA)) check(c, "recalls.open_date", s.note.includes("נפתח ב-" + fd(r.TAARICH_PTICHA)), s.note, "נפתח ב-" + fd(r.TAARICH_PTICHA), ""); } }
  // model recalls
  { const br = brandRe(R.tozeret_nm, R.tozar);
    const card = cardOf(P, "recalls", /^ריקולים שנפתחו לדגם$/), shown = card ? card.rlist : [];
    if (E(R.degem_cd)) NOTES.push(`${c.id}: no model code (${X.primary}): model recalls not looked up by the app`);
    else if (!RECALL_LIST) NOTES.push(`${c.id}: recall list not loaded`);
    else {
      const open = new Set((X.sets.recall || []).map(r => String(r.RECALL_ID).trim()));
      const tk = x => String(x || "").toUpperCase().replace(/([A-Z])(\d)/g, "$1 $2").replace(/(\d)([A-Z])/g, "$1 $2").split(/[^A-Z0-9א-ת]+/).filter(Boolean);
      const LAT = new Set(["TOYOTA", "MAZDA", "HYUNDAI", "KIA", "SKODA", "SEAT", "AUDI", "BMW", "MERCEDES", "NISSAN", "HONDA", "SUZUKI", "SUBARU", "PEUGEOT", "CITROEN", "RENAULT", "OPEL", "FORD", "FIAT", "JEEP", "VOLVO", "LEXUS", "MITSUBISHI", "CHEVROLET", "VOLKSWAGEN", "VW", "TESLA", "BYD", "MG", "DACIA", "CUPRA", "MINI", "PORSCHE", "GEELY", "CHERY", "DS", "ALFA", "ROMEO"]);
      const kin = tk(R.kinuy_mishari), names = [kin, kin.length > 1 && LAT.has(kin[0]) ? kin.slice(1) : [], tk(R.degem_nm)].filter(n => n.length);
      const J = a => a.join(""), sub = (a, b) => a.length && b.length >= a.length && b.some((_, i) => a.every((t, j) => b[i + j] === t));
      const partsOf = r => String(r.DEGEM || "").split(/[,\/+;]/).map(x => x.trim()).filter(Boolean);
      const cls = r => { const ps = partsOf(r).map(tk);
        if (ps.some(p => names.some(n => J(p) === J(n))) || names.some(n => J(tk(r.DEGEM)) === J(n))) return "strict";
        if (ps.some(p => names.some(n => sub(n, p)))) return "wider";      // the row names a longer model that contains this one ("COROLLA CROSS" for a COROLLA)
        if (ps.some(p => names.some(n => sub(p, n)))) return "narrower";   // the row names a shorter model ("E-TRON" for an A3 SB E-TRON, "COROLLA" for a COROLLA HSD SDN)
        return "no"; };
      const descOf = r => sp(E(r.TEUR_TAKALA) ? (E(r.SUG_TAKALA) ? "ריקול" : r.SUG_TAKALA) : r.TEUR_TAKALA);
      const dgOf = r => sp(String(r.DEGEM || "").split(/\s*,\s*/).join(", "));
      const segs = s => s.note.split(" · ").map(sp);
      const pool2 = shown.map(s => ({s, used: false}));
      const rows = RECALL_LIST.filter(r => !open.has(String(r.RECALL_ID).trim())).map(r => ({r, k: cls(r), brand: !!(br && br.test(String(r.TOZAR_TEUR || "")))}));
      const miss = [];
      // rows of this brand first, so a shared description is credited to the right maker
      for (const x of rows.filter(x => x.k !== "no").sort((p, q) => (q.brand - p.brand) || (p.k === "strict" ? -1 : 1))) {
        const hit = pool2.find(p => !p.used && sp(p.s.b) === descOf(x.r) && segs(p.s).includes(dgOf(x.r)));
        if (hit) { hit.used = true; hit.x = x; } else if (x.k === "strict" && x.brand) miss.push(x.r);
      }
      const extra = pool2.filter(p => !p.used);
      for (const p of pool2.filter(p => p.used)) {
        if (p.x.k !== "strict") AMBIG.push(`${c.id} ${sp(R.kinuy_mishari)} (${R.degem_nm}) ${y}: shows ${p.x.k} row #${p.x.r.RECALL_ID} DEGEM="${p.x.r.DEGEM}" (${p.x.r.TOZAR_TEUR}) "${descOf(p.x.r).slice(0, 50)}" fits=${p.s.dim ? "other years" : p.s.pill || "-"}`);
        if (!p.x.brand) AMBIG.push(`${c.id} ${sp(R.kinuy_mishari)}: shows a row of another maker #${p.x.r.RECALL_ID} TOZAR_TEUR=${p.x.r.TOZAR_TEUR} DEGEM="${p.x.r.DEGEM}"`);
      }
      if (br) check(c, "recalls.model_missing", !miss.length, `${shown.length} rows shown`, miss.map(r => `#${r.RECALL_ID} DEGEM="${r.DEGEM}" ${r.SHNAT_RECALL} "${descOf(r).slice(0, 40)}"`).join("; "), `car kinuy=${R.kinuy_mishari} degem_nm=${R.degem_nm} year=${y} brand=${br}`);
      else NOTES.push(`${c.id}: missing-row check skipped (no brand mapping for "${R.tozeret_nm}")`);
      check(c, "recalls.model_extra", !extra.length, extra.map(p => `"${p.s.b.slice(0, 40)}" [${p.s.note.slice(0, 90)}]`).join("; "), "(only rows that name this model)", `car kinuy=${R.kinuy_mishari} degem_nm=${R.degem_nm}`);
      check(c, "recalls.model_count", (card ? N(card.count) : 0) === shown.length, card ? card.count : "", shown.length, "");
      for (const p of pool2.filter(p => p.used)) { const r = p.x.r, a = String(r.BUILD_BEGIN_A || "").match(/(19|20)\d{2}/), b2 = String(r.BUILD_END_A || "").match(/(19|20)\d{2}/);
        const fits = a && b2 && !isNaN(y) ? y >= +a[0] && y <= +b2[0] : null, pill = p.s.pill;
        const ok = fits === null ? !pill : fits ? /בשנת הייצור|כולל את שנת הייצור/.test(pill) && !p.s.dim : pill === "שנים אחרות" && p.s.dim;
        check(c, "recalls.model_fits", ok, pill || "(no pill)", fits === null ? "(no pill)" : fits ? "בשנת הייצור" : "שנים אחרות", `#${r.RECALL_ID} build ${r.BUILD_BEGIN_A}..${r.BUILD_END_A} year=${y}`); }
    } }
  // settlements: collected for review; the banner, the card and the checklist must agree
  { const card = cardOf(P, "recalls", /הסדר פשרה/), list = card ? card.stl : [];
    const ban = P.head.banners.find(b => /הסדר/.test(b)) || "", bn = ban ? (/ייתכן שמגיעה הטבה/.test(ban) ? 1 : N((ban.match(/(\d+) הטבות/) || [])[1])) : 0;
    check(c, "settlements.consistent", bn === list.length, ban.slice(0, 50) || "(no banner)", list.length, "");
    if (list.length) STLS.push(`${c.id} ${sp(R.tozeret_nm)} | ${sp(R.kinuy_mishari)} ${R.degem_nm || ""} | ${y} | ${R.tzeva_rechev || ""} | ${R.sug_delek_nm || ""} | cc=${R.nefach_manoa || ""} => ${list.join(" ; ")}`); }
  // towing
  { const card = cardOf(P, "overview", /^כמה מותר לגרור$/) || {grid: [], notes: [], text: ""};
    const rs = (X.wltp || []).filter(r => { const sd = String(R.sug_degem || "").trim().toUpperCase(); return !sd || E(r.sug_degem) || String(r.sug_degem).trim().toUpperCase() === sd; });
    const has = r => posV(r.kosher_grira_im_blamim) || posV(r.kosher_grira_bli_blamim), zero = r => isN(r.kosher_grira_im_blamim) && isN(r.kosher_grira_bli_blamim) && N(r.kosher_grira_im_blamim) === 0 && N(r.kosher_grira_bli_blamim) === 0;
    const same = rs.filter(r => N(r.shnat_yitzur) === y), tr = nrm(R.ramat_gimur);
    let exp, expYear = null;
    const pairs = list => { const t = list.filter(r => tr && nrm(r.ramat_gimur) === tr); return [...new Set((t.some(has) ? t : list).filter(has).map(r => `${posV(r.kosher_grira_im_blamim) ? N(r.kosher_grira_im_blamim) : "—"}/${posV(r.kosher_grira_bli_blamim) ? N(r.kosher_grira_bli_blamim) : "—"}`))]; };
    if (same.some(has)) exp = pairs(same);
    else if (same.length && same.every(zero)) exp = ["ban"];
    else { const other = rs.filter(has); if (other.length) { const d = Math.min(...other.map(r => Math.abs(N(r.shnat_yitzur) - y))); const near = other.filter(r => Math.abs(N(r.shnat_yitzur) - y) === d); exp = pairs(near); expYear = [...new Set(near.map(r => N(r.shnat_yitzur)))]; }
      else if (posV(R.kosher_grira_im_blamim) || posV(R.kosher_grira_bli_blamim)) exp = [`${posV(R.kosher_grira_im_blamim) ? N(R.kosher_grira_im_blamim) : "—"}/${posV(R.kosher_grira_bli_blamim) ? N(R.kosher_grira_bli_blamim) : "—"}`];
      else exp = ["none"]; }
    const g = k => (card.grid.find(x => x.k === k) || {}).v || "";
    const shown = card.ban ? "ban" : card.grid.length ? `${dig(g("עם בלמים")) ? N(dig(g("עם בלמים"))) : "—"}/${dig(g("בלי בלמים")) ? N(dig(g("בלי בלמים"))) : "—"}` : /אין במאגר/.test(card.text) ? "none" : "(card missing)";
    const yr = (card.notes.join(" ").match(/משנת (\d{4})/) || [])[1];
    check(c, "tow.limits", exp.includes(shown), shown + (yr ? ` (note: model year ${yr})` : ""), exp.join(" or ") + (expYear ? ` (from year ${expYear.join("/")})` : ""),
      `car ${R.sug_degem || ""} ${sp(R.kinuy_mishari)} ${y} ${R.ramat_gimur || ""}; model rows for this maker+model code: ${(X.wltp || []).map(r => `${r.sug_degem || "?"}/${sp(r.kinuy_mishari)}/${r.shnat_yitzur}/${sp(r.ramat_gimur)}:${r.kosher_grira_im_blamim ?? ""}/${r.kosher_grira_bli_blamim ?? ""}`).join(", ").slice(0, 260)}`);
    // the hook box (registration's own towing-hook field)
    const hk = Object.entries(R).find(([k, x]) => /grira|gerira|vav/i.test(k) && !/kosher_grira/i.test(k) && !E(x));
    if (hk && shown !== "ban") { const none = /^(0|לא|אין|ללא)$|ללא|אין|לא מותקן/.test(String(hk[1]).trim()); check(c, "tow.hook", none ? /לא מותקן וו גרירה/.test(card.hook) : /^מותקן וו גרירה/.test(card.hook), card.hook, none ? "לא מותקן וו גרירה" : "מותקן וו גרירה " + hk[1], `${hk[0]}=${hk[1]}`); } }
  // specs and weights
  { const kgOk = (lab, ownV, mf) => { const sh = spec(lab); const ex = posV(ownV) ? [String(N(ownV))] : mf ? vals(W, mf, posV).map(x => String(N(x))) : [];
      check(c, "specs." + lab, ex.length ? ex.includes(dig(sh)) : E(sh), sh, ex.join(" / ") || "(not shown: the registry writes 0 or nothing)", E(ownV) ? "" : `register value=${ownV}`); };
    kgOk("משקל כולל מותר", R.mishkal_kolel, "mishkal_kolel"); kgOk("משקל עצמי", R.mishkal_azmi, null); kgOk("כושר העמסה", R.mishkal_mitan_harama, null);
    check(c, "specs.tyre_front", sp(spec("צמיג קדמי")) === sp(R.zmig_kidmi || R.mida_zmig_kidmi || ""), spec("צמיג קדמי"), R.zmig_kidmi || "", "");
    check(c, "specs.tyre_rear", sp(spec("צמיג אחורי")) === sp(R.zmig_ahori || R.mida_zmig_ahori || ""), spec("צמיג אחורי"), R.zmig_ahori || "", "");
    const hpExp = vals(W, "koah_sus", posV).map(x => String(N(x))), hp = spec("כוח");
    check(c, "specs.power", hpExp.length ? hpExp.includes(dig(hp)) : posV(R.hespek) ? dig(hp) === String(N(R.hespek)) : E(hp), hp, hpExp.join(" / ") || (posV(R.hespek) ? R.hespek : "(not shown)"), E(R.hespek) ? "" : `hespek=${R.hespek}`);
    { const se = vals(W, "mispar_moshavim", posV).concat(vals(W, "mispar_moshavim", posV).length ? [] : posV(R.mispar_mekomot) ? [String(R.mispar_mekomot)] : []), ss = spec("מושבים");
      check(c, "specs.seats", se.length ? inSet(ss, se) : E(ss), ss, se.join(" / ") || "(not shown)", E(R.mispar_mekomot) ? "" : `mispar_mekomot=${R.mispar_mekomot}`); }
    { const sr = spec("סרנים"); check(c, "specs.axles", posV(R.sranim) ? dig(sr) === String(N(R.sranim)) : E(sr), sr, posV(R.sranim) ? R.sranim : "(not shown)", E(R.sranim) ? "" : `sranim=${R.sranim}`); }
    const sl = posV(R.ramat_eivzur_betihuty) ? [String(R.ramat_eivzur_betihuty).trim()] : vals(W, "ramat_eivzur_betihuty", posV);
    check(c, "specs.safety_level", sl.length ? sl.includes((spec("רמת אבזור בטיחותי").match(/^(\S+) מתוך/) || [])[1] || "") : E(spec("רמת אבזור בטיחותי")), spec("רמת אבזור בטיחותי"), sl.join(" / ") || "(not shown: 0 = not rated)", E(R.ramat_eivzur_betihuty) ? "" : `register=${R.ramat_eivzur_betihuty}`);
    { const ins = (cardOf(P, "overview", /^מידע חשוב/) || {items: []}).items, low = ins.includes("רמת בטיחות נמוכה"), lv = N(R.ramat_eivzur_betihuty);
      if (!E(R.ramat_eivzur_betihuty)) check(c, "insight.safety_low", low === (lv >= 1 && lv <= 2), low ? "רמת בטיחות נמוכה" : "(none)", lv >= 1 && lv <= 2 ? "רמת בטיחות נמוכה" : "(none: level " + lv + (lv === 0 ? " = not rated" : "") + ")", ""); }
    const zh = posV(R.kvutzat_zihum) ? [String(R.kvutzat_zihum).trim()] : vals(W, "kvutzat_zihum", posV), zt = ((cardOf(P, "specs", /^סביבה$/) || {}).text || "").match(/קבוצת זיהום (\S+) מתוך 15/);
    check(c, "specs.pollution_group", zh.length ? zh.includes(zt ? zt[1] : "") : !zt, zt ? zt[1] : "", zh.join(" / ") || "(not shown: 0 = no group)", E(R.kvutzat_zihum) ? "" : `register=${R.kvutzat_zihum}`);
    const gb = vals(W, "automatic_ind").map(x => x === "1" ? "אוטומטית" : "ידנית"), gs = spec("תיבת הילוכים");
    check(c, "specs.gearbox", gb.length ? gb.includes(gs) : E(gs), gs, gb.join(" / "), "");
    for (const [lab, f] of [["דלתות", "mispar_dlatot"], ["מרכב", "merkav"], ["כריות אוויר", "mispar_kariot_avir"]]) { const ex = vals(W, f), sh = spec(lab);
      check(c, "specs." + f, ex.length ? inSet(sh, ex) : E(sh), sh, ex.join(" / "), ""); }
    const co = vals(W, "CO2_WLTP", posV).concat(vals(W, "kamut_CO2", posV)).map(x => String(N(x))), cs = spec("פליטת CO₂");
    check(c, "specs.co2", co.length ? co.includes(dig(cs)) || co.includes(String(N((cs.match(/[\d.]+/) || [""])[0]))) : true, cs, co.join(" / "), "");
    const imps = vals(PR.length ? PR : pool(X.price, R), "shem_yevuan"), si = spec("יבואן");
    check(c, "specs.importer", imp ? E(si) : imps.length ? inSet(si, imps) : E(si), si, imp ? "(personal import: none)" : imps.join(" / "), ""); }
  // registered changes (tech dataset flags) and other register facts
  { const mods = cardOf(P, "overview", /^שינויים ברכב$/), f = l => { const x = mods && mods.facts.find(([k]) => k === l); return x ? x[1] : ""; };
    for (const [l, k] of [["שינוי מבנה", "shinui_mivne_ind"], ["התקנת גפ״מ (גז)", "gapam_ind"], ["שינוי צבע", "shnui_zeva_ind"], ["שינוי מידת צמיגים", "shinui_zmig_ind"]]) {
      const ex = E(R[k]) ? "" : String(R[k]).trim() === "1" ? "כן" : "לא"; check(c, "mods." + k, sp(f(l)) === ex, f(l), ex, ""); }
    check(c, "specs.engine_model", sp(spec("דגם מנוע")) === sp(R.degem_manoa || ""), spec("דגם מנוע"), R.degem_manoa || "", "");
    check(c, "specs.vehicle_type", sp(spec("סוג רכב")) === sp(R.sug_rechev_nm || ""), spec("סוג רכב"), R.sug_rechev_nm || "", "");
    const hn = !E(R.hanaa_nm) ? [R.hanaa_nm] : vals(W, "hanaa_nm"); check(c, "specs.drive", hn.length ? inSet(spec("הנעה"), hn) : E(spec("הנעה")), spec("הנעה"), hn.join(" / "), "");
    if (imp) { const sy = factOf(P, "overview", /^רישוי וטסט$/, "סוג יבוא"); check(c, "status.import_type", sp(sy) === sp(X.sets.import[0].sug_yevu || ""), sy, X.sets.import[0].sug_yevu || "", ""); } }
  // licence fee
  { const card = cardOf(P, "maint", /^אגרת רישוי שנתית$/), g = card ? card.grid : [], fee = N(dig((g.find(x => x.k === "הערכה") || {}).v)), grp = N(((g.find(x => x.k === "קבוצת מחיר") || {}).v || "").match(/^\d/));
    const groups = vals(W, "kvuzat_agra_cd").map(N).filter(x => FEE[x]), priv = String(R.sug_degem || "P").toUpperCase() === "P";
    const col = y >= 2024 ? 0 : y >= 2021 ? 1 : y >= 2017 ? 2 : 3;
    const exp = priv && groups.length && !isNaN(y) ? groups.map(gr => `${gr}:${FEE[gr][col] + 135}`) : [];
    const shown = fee ? `${grp}:${fee}` : "";
    check(c, "fee.licence", exp.length ? exp.includes(shown) : !fee, shown || "(no fee)", exp.join(" or ") || "(no fee)", `kvuzat_agra_cd in pool=${vals(W, "kvuzat_agra_cd").join(",")} sug_degem=${R.sug_degem || ""} year=${y}`); }
  // list price and the value estimate
  { const card = cardOf(P, "buy", /^שווי משוער$/), g = card ? card.grid : [], sh = N(dig((g.find(x => x.k === "מחיר מחירון כחדש") || {}).v));
    const ex = vals(PR, "mehir", posV).map(N);
    check(c, "price.list", ex.length ? ex.includes(sh) : !sh, sh || "(none)", ex.join(" / ") || "(none)", `price rows for model=${(X.price || []).length}, years=${[...new Set((X.price || []).map(r => r.shnat_yitzur))].sort().join(",")}`);
    if (sh) { const vt = (g.find(x => x.k === "שווי משוער היום") || {}).v || "";
      check(c, "value.labelled_estimate", /הערכה בלבד/.test(card.text) && /\d+–\d+/.test(vt), vt + " / " + (card.notes[0] || "").slice(0, 40), "range + 'הערכה בלבד'", ""); } }
  // cars of this model and year on the road (modelstats, monthly) vs a live count of the active register
  { const ms = cardOf(P, "buy", /^איך הדגם הזה מחזיק$/), m = ms ? (ms.text.match(/\(([\d,]+) רכבים פעילים משנתון (\d{4})/) || null) : null;
    if (m && X.cohort != null) { const sh = N(m[1]); check(c, "counts.model_year_active", sh >= X.cohort * 0.85, sh, `>= ~${X.cohort} (active rows with kinuy_mishari="${R.kinuy_mishari}" and year ${y})`, "");
      if (sh > X.cohort * 2.5 + 50) NOTES.push(`${c.id}: "איך הדגם הזה מחזיק" counts ${sh} cars for ${sp(R.kinuy_mishari)} ${y}, of which ${X.cohort} carry this exact model name (variants folded together)`); } }
  // "partial data" message
  { const said = P.head.msgs.some(t => /חלק ממאגרי משרד התחבורה לא ענו/.test(t)), myErr = Object.keys(X.errs).filter(k => k !== "recall");
    check(c, "message.partial_data", said === (myErr.length > 0), said ? "partial-data message shown" : "(none)", myErr.length ? "message (my reads failed: " + myErr.map(k => k + " " + X.errs[k]).join(", ") + ")" : "(none: every dataset answered my reads)", `app errs=${P.head.errs.join(",")}`); }
}

/* ---------- run ---------- */
console.log(`site-data-audit seed=${SEED} n=${NACT} rare=${NRARE} index.html ${Math.round(html.length / 1024)} KB, datasets ${SETS.length}`);
let cases = await sample();
console.log(`sampled ${cases.length} cases in ${Math.round((Date.now() - T0) / 1000)}s, ${reqN} requests`);
for (const c of cases) console.log(`SAMPLE ${c.id} ${mask(c.plate)} ${c.from} ${c.why}`);
try { await recallList(); console.log(`recall list: ${RECALL_LIST.length} rows`); } catch (e) { console.log("recall list failed: " + e.message); }
await startBrowser();
let audited = 0, skipped = [], infra = [];
const act = cases.filter(c => c.from === "active"), rar = cases.filter(c => c.from !== "active"), order = [];
for (let i = 0, j = 0; i < act.length || j < rar.length; i++) { if (i < act.length) order.push(act[i]); if ((i % 7 === 6 || i >= act.length) && j < rar.length) order.push(rar[j++]); }
for (const c of order) {
  if (ONLY && !ONLY.has(c.id)) continue;
  if (Date.now() - T0 > BUDGET) { skipped.push(c.id); continue; }
  let P = await readPage(c.plate);
  if (P.net.bad.length) { LIMIT = Math.max(30, Math.round(LIMIT * 0.9)); console.log(`  ${c.id}: the ministry refused ${P.net.bad.length} of the app's ${P.net.n} requests (${[...new Set(P.net.bad)].join(",")}); cooling down 75s, limit now ${LIMIT}/min, opening it again`); cool(75000); P = await readPage(c.plate); }
  let X; try { X = await raw(c); } catch (e) { console.log(`CASE ${c.id} ${mask(c.plate)} raw read failed: ${e.message}`); continue; }
  if (P.net.bad.length) { infra.push(c.id); cool(60000); console.log(`CASE ${c.id} ${mask(c.plate)} skipped: the ministry refused ${P.net.bad.length} of the app's requests again`); continue; }
  const R = X.R;
  if (P.edge) { const ln = `CASE ${c.id} ${mask(c.plate)} ${X.primary || "-"} page: ${P.edge.slice(0, 90)} | after ${Math.round(P.net.ms / 1000)}s, app requests=${P.net.n} failed-in-browser=${P.net.failed} | in my reads: ${Object.entries(X.sets).filter(([, r]) => r.length).map(([k]) => k).join(",") || "nothing"} errs: ${Object.keys(X.errs).join(",") || "-"}`; console.log(ln);
    check(c, "page.result", !X.primary, P.edge.slice(0, 60), X.primary ? `the car (found in ${X.primary})` : "not found", `after ${Math.round(P.net.ms / 1000)}s, ${P.net.n} app requests, ${P.net.failed} failed in the browser`); audited++; continue; }
  const before = MIS.length;
  try { compare(c, X, P); } catch (e) { console.log(`CASE ${c.id} compare error: ${e.stack.split("\n").slice(0, 3).join(" / ")}`); }
  audited++;
  console.log(`CASE ${c.id} ${mask(c.plate)} ${X.primary} ${Math.round(P.net.ms / 1000)}s/${P.net.n}req${P.net.failed ? "/" + P.net.failed + "failed" : ""} | ${sp(R.tozeret_nm)} ${sp(R.kinuy_mishari)} ${R.shnat_yitzur || ""} | fuel=${R.sug_delek_nm || ""} own=${R.baalut || ""} | owners=${(X.sets.owners || []).length} recalls=${(X.sets.recall || []).length} wltp=${(X.wltp || []).length} price=${(X.price || []).length} | errs=${Object.keys(X.errs).join(",") || "-"} app-errs=${P.head.errs.join(",") || "-"} | mismatches=${MIS.length - before}${P.perr.length ? " | page errors: " + P.perr.join(" ; ") : ""} | t=${Math.round((Date.now() - T0) / 1000)}s`);
}
/* ---------- maker-name rules, over every maker name in the registers ----------
   The app decides a few things from the maker name alone (the shown make, the importer's recall page, the brand's resale tier,
   which settlements can apply). Each is computed by the app's own functions twice: on the register's name ("רנו טורקיה")
   and on the make the page shows ("רנו"). A difference means the factory country changed the answer. */
let MAKERS_OUT = [];
async function makersPass() {
  const names = new Map();
  for (const k of ["active", "inactive", "cancel"]) { const s = SET(k); if (!s) continue;
    try { const r = await search(s.id, {fields: "tozeret_nm", distinct: "true", limit: 1000}); for (const x of r.records) { const n = String(x.tozeret_nm || "").trim(); if (n && !names.has(n)) names.set(n, k); } }
    catch (e) { MAKERS_OUT.push(`makers ${k}: ${e.message}`); } }
  if (coolUntil > Date.now()) await sleep(coolUntil - Date.now());
  await slot(16);
  const page = await ctx.newPage();
  page.on("request", r => { if (/data\.gov\.il/.test(r.url())) HITS.push(Date.now()); });
  await page.goto(BASE, {waitUntil: "domcontentloaded", timeout: 30000});
  await page.waitForFunction(() => typeof SETTLEMENTS !== "undefined" && typeof makeName === "function", null, {timeout: 30000});
  const res = await page.evaluate(list => {
    const pickF = (...a) => a.find(x => x != null && String(x).trim() !== "") || "";
    const Dof = n => { const v = {tozeret_nm: n}; return {v, make: makeName(v), price: null, modelRecalls: [], pick: pickF}; };
    return list.map(n => { const D = Dof(n), S = Dof(D.make);
      const imp = x => { try { return importerRecall(x).name; } catch (e) { return "error " + e.message; } };
      const tier = x => { try { return brandTier(x, false).k; } catch (e) { return "error"; } };
      const stl = x => SETTLEMENTS.filter(s => s.mk.test(normS([x.v.tozeret_nm, x.make].join(" ")))).map(s => s.id);
      return {n, shown: D.make, impFull: imp(D), impShown: imp(S), tierFull: tier(D), tierShown: tier(S), stlFull: stl(D), stlShown: stl(S)}; });
  }, [...names.keys()]);
  const allIds = await page.evaluate(() => SETTLEMENTS.filter(s => !(new Date(s.until + "T23:59:59") < new Date())).map(s => [s.id, s.mk.source]));
  await page.close();
  const bad = [];
  for (const r of res) {
    const why = [];
    if (r.impFull !== r.impShown) why.push(`importer recall page "${r.impFull}" (for "${r.shown}" alone: "${r.impShown}")`);
    if (r.tierFull !== r.tierShown) why.push(`resale tier ${r.tierFull} (for "${r.shown}" alone: ${r.tierShown})`);
    const extra = r.stlFull.filter(x => !r.stlShown.includes(x)); if (extra.length) why.push(`settlements of another maker can apply: ${extra.join(",")}`);
    if (why.length) bad.push([r, why]);
  }
  for (const [r, why] of bad) { let n = "?"; try { n = await count(SET(names.get(r.n)).id, {tozeret_nm: r.n}); } catch {}
    MAKERS_OUT.push(`MAKER-RULE "${r.n}" (${names.get(r.n)}, ${n} cars) shown as "${r.shown}": ${why.join("; ")}`); }
  for (const [id, src] of allIds) { const hit = res.filter(r => r.stlFull.includes(id)).map(r => r.n);
    if (!hit.length) MAKERS_OUT.push(`SETTLE-MK ${id} /${src}/ matches no maker name in the registers, so it never shows`); }
  const multi = [...new Set(res.filter(r => /\s/.test(r.shown)).map(r => `"${r.n}" -> "${r.shown}"`))];
  MAKERS_OUT.push(`MAKER-NAMES ${res.length} names read; shown names that keep more than one word (${multi.length}): ${multi.join(", ")}`);
}
if (OPTS.makers !== "0") { try { await makersPass(); } catch (e) { MAKERS_OUT.push("makers pass failed: " + e.message); } }
await browser.close();
console.log(`\n===== SUMMARY: ${audited} cars audited, ${MIS.length} mismatches, ${reqN} requests by the harness (${throttled} refused and retried), ${Math.round((Date.now() - T0) / 60000)} min${skipped.length ? `, skipped for time: ${skipped.join(",")}` : ""}${infra.length ? `, skipped because the ministry refused the app: ${infra.join(",")}` : ""}`);
for (const [f, s] of Object.entries(STAT).sort()) console.log(`FIELD ${f.padEnd(28)} checked=${s.n} mismatched=${s.bad}${s.bad && !s.quiet ? " [" + s.cases.slice(0, 20).join(",") + "]" : ""}${s.quiet ? " (totals only)" : ""}`);
console.log("\n===== maker name -> shown make (count)"); for (const [k, n] of [...MAKEPAIRS].sort()) console.log(`MAKE ${k} (${n})`);
console.log("\n===== settlements shown"); for (const s of STLS) console.log("STL " + s);
console.log("\n===== model recall rows shown that only partly name the model"); for (const s of AMBIG) console.log("AMBIG " + s);
console.log("\n===== maker-name rules (every maker name in the registers)"); for (const s of MAKERS_OUT) console.log(s);
console.log("\n===== notes"); for (const s of NOTES) console.log("NOTE " + s);

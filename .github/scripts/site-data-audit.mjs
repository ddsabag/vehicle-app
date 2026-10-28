// Data-correctness audit of what a user sees for a plate (runs on GitHub: data.gov.il is not reachable from the dev container).
// QUERIES: "mode=discover" prints dataset fields and value lists; otherwise "seed=7;n=100;rare=15[;only=c004,c010][;regs=moto|heavy]" samples plates
// inside the runner, opens each one in the checkout's index.html like a user, and compares what is rendered with the raw ministry rows.
// Plates, VINs and owner details are never printed: cars are case ids (c001...), plates are masked (first 2 + last 2 digits).
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const OPTS = Object.fromEntries(String(process.env.QUERIES || "").split(/[;,]\s*(?=[a-z]+=)/).map(s => s.split("=")).filter(a => a[0]).map(([k, ...v]) => [k.trim(), v.join("=").trim()]));
const MODE = OPTS.mode || "audit";
const html = fs.readFileSync("index.html", "utf8");
const block = html.slice(html.indexOf("const PLATE_SETS"), html.indexOf("const MODEL_SETS"));
const SETS = [...block.matchAll(/\{key:"([^"]+)",\s*id:"([0-9a-f-]{36})"[^}]*?\}/g)].map(m => ({key: m[1], id: m[2], field: (m[0].match(/field:"([^"]+)"/) || [])[1] || "mispar_rechev", pad: /pad:true/.test(m[0]), role: (m[0].match(/role:"(\w+)"/) || [])[1], nodates: /nodates:true/.test(m[0])}));
const MODEL = Object.fromEntries([...html.slice(html.indexOf("const MODEL_SETS")).slice(0, 600).matchAll(/(\w+):\s*"([0-9a-f-]{36})"/g)].map(m => [m[1], m[2]]));
const SET = k => SETS.find(s => s.key === k);
const API = "https://data.gov.il/api/3/action/";
const sleep = ms => new Promise(r => setTimeout(r, ms));
// AUDIT_LOCAL_MOCK (a module path) is only for testing the harness in a container that cannot reach data.gov.il; it is never set on the runner
const LOCAL_MOCK = process.env.AUDIT_LOCAL_MOCK ? await import(process.env.AUDIT_LOCAL_MOCK) : null;
if (LOCAL_MOCK) { const real = globalThis.fetch; globalThis.fetch = async (u, o) => /data\.gov\.il/.test(String(u)) ? new Response(JSON.stringify(LOCAL_MOCK.answer(String(u))), {status: 200, headers: {"content-type": "application/json"}})
  : LOCAL_MOCK.rawFile && /raw\.githubusercontent\.com/.test(String(u)) ? (f => f ? new Response(f.body, {status: 200, headers: {"content-type": f.type}}) : new Response("", {status: 404}))(LOCAL_MOCK.rawFile(String(u))) : real(u, o); }
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
const optNum = (k, d) => OPTS[k] === undefined || OPTS[k] === "" ? d : Number(OPTS[k]);   // n=0 means none, not the default
const SEED = String(OPTS.seed || "7"), NACT = optNum("n", 100), NRARE = optNum("rare", 15);
const ONLY = OPTS.only ? new Set(OPTS.only.split(/[ |+,]/).filter(Boolean)) : null;
const E = v => v === null || v === undefined || String(v).trim() === "" || String(v).trim().startsWith("0000-00-00");
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
    try { const r = await search(id, {filters: f, limit: 300, sort: "shnat_yitzur desc"}); if (r.records.length) return r.records; } catch {}   // as the app asks (newest years first)
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
  if (LOCAL_MOCK && LOCAL_MOCK.plates) return LOCAL_MOCK.plates.map((x, i) => ({id: "c" + String(i + 1).padStart(3, "0"), plate: String(x.plate), from: x.from || "active", why: x.why || "local"}));
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
  // one car from each of the other registers first, starting at a register that turns with the seed, then more by weight: a small rare=
  // (the daily check's 10) still reaches every register, the motorcycle, heavy and public ones included
  const RARE_W = [["inactive", 2], ["inactive2", 1], ["cancel", 2], ["cancel2010", 1], ["cancel2000", 1], ["import", 3], ["moto", 2], ["heavy", 2], ["public", 1]]
    .filter(([k]) => !OPTS.regs || OPTS.regs.split(/[ |+,]/).includes(k));   // regs=moto|heavy|public samples only those
  const turn = pickOf("rare-turn", RARE_W.length), ring = [...RARE_W.slice(turn), ...RARE_W.slice(0, turn)], plan = ring.map(([k]) => k);
  while (ring.length && plan.length < NRARE) for (const [k, w] of ring) for (let j = 0; j < w; j++) plan.push(k);
  const tots = {}, nth = {};
  for (const k of plan.slice(0, Math.max(0, NRARE))) {
    const s = SET(k); if (!s) continue;
    if (!(k in tots)) { tots[k] = 0; try { tots[k] = await count(s.id, null); } catch (e) { console.log(`sample ${k}: ${e.message}`); } }
    if (!tots[k]) continue;
    const j = nth[k] = (nth[k] ?? -1) + 1;
    try { const p = await rowAt(s.id, null, null, pickOf(`r${k}${j}`, tots[k]), s.field); add(p, k, `${k} of ${tots[k]}`); } catch (e) { console.log(`sample ${k}: ${e.message}`); }
  }
  return cases;
}

/* ---------- raw facts for one plate ---------- */
// which register is the car, written from the app's stated rules (index.html, "which register is the car", 20.10.2026):
//  - active, personal import and public are always read; the rare registers only when active has no row and answered
//  - the car is the first main register's row (PLATE_SETS order); a cancel row with a later import row of the same maker tested after the
//    cancellation is a car registered again: the import row goes first
//  - another main register's row adds only fields that name and describe the vehicle, and only for the same vehicle (maker and model codes,
//    or the chassis number); a motorcycle or heavy row (no dates) borrows the licence and test dates of the same vehicle's import row, and the
//    licence date of its public row while that is not permanently cancelled; a cancel row takes its reason from the public row of the same
//    cancellation
//  - the public register's cancellation code: a permanent one (2, 3, 5, 6, 8) is off the road, a deposit (C, S) or a removal by the police or
//    the safety patrol (A, B, Z, R) is a temporary hold beside the car; beside an active row only a temporary hold counts
const MAIN_ORDER = SETS.filter(s => s.role === "main").map(s => s.key);
const RARE = MAIN_ORDER.filter(k => !["active", "import", "public"].includes(k));
const NODATES = new Set(SETS.filter(s => s.nodates).map(s => s.key));
const NO_TEST_KEYS = new Set([...NODATES, "inactive2"]);   // registers that publish no test or licence dates (a row of one that has them is reported)
const toD = v => { const m = String(v ?? "").match(/^(\d{4})-?(\d{2})-?(\d{2})/); if (!m || +m[1] < 1950) return null; const d = new Date(+m[1], +m[2] - 1, +m[3]); return d.getMonth() === +m[2] - 1 && d.getDate() === +m[3] ? d : null; };
const sameN = (a, b, k) => !!a && !!b && isN(a[k]) && isN(b[k]) && N(a[k]) === N(b[k]);
const vinOf = r => String(r && (r.misgeret || r.mispar_shilda || r.shilda) || "").trim().toUpperCase();
const sameCarR = (a, b) => sameN(a, b, "tozeret_cd") && sameN(a, b, "degem_cd") || !!vinOf(a) && vinOf(a) === vinOf(b);
const sameDay = (x, y) => { const a = toD(x), b = toD(y); return !!a && !!b && +a === +b; };
const ID_F = new Set(["tozeret_cd", "tozeret_nm", "tozeret_eretz_nm", "tozar", "degem_cd", "degem_nm", "kinuy_mishari", "sug_degem", "ramat_gimur",
  "shnat_yitzur", "tzeva_cd", "tzeva_rechev", "sug_delek_nm", "misgeret", "mispar_shilda", "shilda", "sug_rechev_cd", "sug_rechev_nm", "degem_manoa",
  "tozar_manoa", "mispar_manoa", "nefach_manoa", "hespek", "hanaa_nm", "mispar_mekomot", "mishkal_kolel", "mishkal_azmi", "mishkal_mitan_harama",
  "sranim", "zmig_kidmi", "zmig_ahori", "mida_zmig_kidmi", "mida_zmig_ahori"]);
const LEND = {import: new Set(["tokef_dt", "mivchan_acharon_dt", "moed_aliya_lakvish"]), public: new Set(["tokef_dt"])};
// the lending row also names the type and colour the moto and heavy registers lack (index.html LENT_ID, 28.10)
const LENT_I = new Set(["sug_rechev_cd", "sug_rechev_nm", "tzeva_cd", "tzeva_rechev"]);
function pubSt(r) {
  const cd = String(r.bitul_cd ?? "").trim().toUpperCase(), nm = String(r.bitul_nm || "").trim();
  if (cd === "0" || /לא מבוטל/.test(nm) || !cd && !nm) return null;
  const dep = /^[CS]$/.test(cd) || /הפקד/.test(nm), patrol = cd === "B" || /ניידת/.test(nm), cop = /^[AZR]$/.test(cd) || /משטרה/.test(nm);
  if (!dep && !patrol && !cop && (/^[23568]$/.test(cd) || /בטול|ביטול|אובדן|פרוק|העברה/.test(nm))) return {gone: true};
  return {status: dep ? "הרישיון מופקד" : patrol ? "הורד מהכביש בידי ניידת בטיחות" : cop ? "הורד מהכביש בידי המשטרה" : nm || "לא פעיל", nm, dt: r.bitul_dt, temp: dep || patrol || cop};
}
// the catalogue the app reads model recalls from (catalog-data branch): how far the per-car list reaches (meta.recHz, meta.recIn) and, per maker,
// the models and years that list holds for each recall (r/<cd>.json "l") and the rows it adds (x: sister brands, recalls only the list names)
const CAT = "https://raw.githubusercontent.com/ddsabag/vehicle-app/catalog-data/";
let CAT_META; const CAT_R = new Map();
async function catJson(p) { try { const r = await fetch(CAT + p, {signal: AbortSignal.timeout(30000)}); return r.ok ? await r.json() : null; } catch { return null; } }
const catCdOf = cd => String(N(cd) || String(cd || "").trim());
async function catMetaMine() { if (CAT_META === undefined) CAT_META = await catJson("meta.json"); return CAT_META; }
async function catRecMine(cd) { cd = catCdOf(cd); if (!CAT_R.has(cd)) CAT_R.set(cd, await catJson(`r/${cd}.json`)); return CAT_R.get(cd); }

async function raw(c) {
  const out = {sets: {}, errs: {}};
  const read = async k => { const r = await rowsByPlate(SET(k), c.plate); out.sets[k] = r.rows; if (r.err) out.errs[k] = r.err; };
  for (const k of ["active", "import", "public"]) await read(k);
  const rare = !out.sets.active.length && !out.errs.active;
  if (rare) for (const k of RARE) await read(k);
  const extra = fnv(c.id) % 4 === 0;   // one active car in four is also looked up in the disability-tag list
  for (const k of ["cont", "tech", "owners", "recall", "dpf", ...(rare || extra ? ["tag"] : [])]) await read(k);
  let mains = MAIN_ORDER.filter(k => (out.sets[k] || []).length);
  { const c0 = mains[0] && /^cancel/.test(mains[0]) && out.sets[mains[0]][0], im = (out.sets.import || [])[0], t = im && toD(im.mivchan_acharon_dt), b = c0 && toD(c0.bitul_dt);
    if (c0 && im && sameN(c0, im, "tozeret_cd") && t && b && t > b) mains = ["import", ...mains.filter(k => k !== "import")]; }
  const p0 = mains[0] || null, top = p0 && out.sets[p0][0], R = {}, lent = new Set(); let datesFrom = null;
  const fill = (r, keys) => Object.entries(r || {}).filter(([k, x]) => (!keys || keys.has(k)) && E(R[k]) && !E(x)).map(([k, x]) => (R[k] = x, k));
  if (top) fill(top);
  for (const k of mains.slice(1)) {
    const r = out.sets[k][0];
    if (sameCarR(top, r)) fill(r, ID_F);
    if (NODATES.has(p0) && LEND[k] && !(k === "public" && (pubSt(r) || {}).gone) && sameN(top, r, "tozeret_cd") && sameN(top, r, "shnat_yitzur")) {
      lent.add(k); if (fill(r, LEND[k]).some(f => f !== "moed_aliya_lakvish")) datesFrom = datesFrom || k; fill(r, LENT_I); }
    if (/^cancel/.test(p0) && k === "public" && (pubSt(r) || {}).gone && sameDay(top.bitul_dt, r.bitul_dt)) fill(r, new Set(["bitul_nm"]));
  }
  if ((out.sets.import || [])[0] && E(R.sug_yevu)) R.sug_yevu = out.sets.import[0].sug_yevu;
  fill((out.sets.cont || [])[0]); fill((out.sets.tech || [])[0]);
  const pub = (out.sets.public || [])[0];
  const ps = !p0 || !pub ? null : p0 === "public" || lent.has("public") ? pubSt(pub) : p0 === "active" && sameCarR(top, pub) ? (st => st && !st.gone ? st : null)(pubSt(pub)) : null;
  Object.assign(out, {primary: p0, mains, R, lent, datesFrom, ps, hold: ps && !ps.gone ? ps : null, gone: !!(ps && ps.gone)});
  out.cancelled = !!p0 && (/^cancel/.test(p0) || out.gone);
  out.noTest = !!p0 && NO_TEST_KEYS.has(p0) && !datesFrom;
  if (!E(R.tozeret_cd) && !E(R.degem_cd)) {
    out.wltp = await modelRowsMine(MODEL.wltp, R); out.price = await modelRowsMine(MODEL.price, R);
    if (!E(R.kinuy_mishari) && isN(R.shnat_yitzur) && (fnv(c.id + "k") % 3 === 0 || c.from !== "active")) { try { out.cohort = await count(SET("active").id, {kinuy_mishari: R.kinuy_mishari, shnat_yitzur: N(R.shnat_yitzur)}); } catch {} }
    out.catMeta = await catMetaMine(); out.catRec = await catRecMine(R.tozeret_cd);
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
  browser = await chromium.launch(process.env.AUDIT_CHROME ? {executablePath: process.env.AUDIT_CHROME} : {});
  ctx = await browser.newContext({viewport: {width: 1100, height: 900}, locale: "he-IL", timezoneId: "Asia/Jerusalem", serviceWorkers: "block"});
  await ctx.addInitScript(() => { try { localStorage.setItem("analyticsOff", "1"); localStorage.setItem("reviewAsked", "1"); } catch {} });
  await ctx.route("**/*", route => BLOCK.test(route.request().url()) ? route.abort() : route.continue());
  if (LOCAL_MOCK) await ctx.route(/data\.gov\.il/, route => route.fulfill({status: 200, contentType: "application/json", headers: {"access-control-allow-origin": "*"}, body: JSON.stringify(LOCAL_MOCK.answer(route.request().url()))}));   // local harness test only
  if (LOCAL_MOCK && LOCAL_MOCK.rawFile) await ctx.route(/raw\.githubusercontent\.com/, route => { const f = LOCAL_MOCK.rawFile(route.request().url()); return f ? route.fulfill({status: 200, contentType: f.type, headers: {"access-control-allow-origin": "*"}, body: f.body}) : route.fulfill({status: 404, body: ""}); });
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
    timeline: [...c.querySelectorAll(".timeline > li")].map(li => ({time: T(li.querySelector("time")), text: T(li.querySelectorAll(":scope > span")[1]), dur: T(li.querySelector(".dur"))})), ownNow: T(c.querySelector(".own-now b")),
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
        srcFoot: T(o.querySelector("#srcFoot")),
        // the "checked" line above the tabs (a car without an open recall or a settlement): its state, title, text and the recalls it lists
        line: (l => l ? {state: l.dataset.line || "", title: T(l.querySelector("summary b")), text: T(l),
          rlist: [...l.querySelectorAll(".rlist > li")].map(li => ({dim: li.classList.contains("dim"), time: T(li.querySelector("time")), pill: T(li.querySelector(".pill")), b: T(li.querySelector(":scope > b")), note: T(li.querySelector(":scope > .note"))}))} : null)(o.querySelector("details.ckl")),
        tabs: [...o.querySelectorAll(".tabs [data-tab]")].map(b => b.dataset.tab)};
    });
    const tabs = {};
    for (const k of head.tabs) {
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
// ownership order (20.10): the log gives months only and a month's transfers come in no set order, so within a month a dealer goes
// first and a private owner last, and in the latest month the register's current owner type goes last (the same kind first, else any
// fleet kind: the register and the log mix up company, leasing and rental). The current owner is the register's type when it names
// one, else the log's last record.
const ownK = t => DEALER.test(String(t || "")) ? "dealer" : kindOf(t);
const FLEET = ["company", "lease", "rental"];
const sameOwnK = (a, b) => a === b || FLEET.includes(a) && FLEET.includes(b);
function ordOwn(rows, cur) {
  if (!rows.length) return rows;
  const m = r => N(r.baalut_dt), last = Math.max(...rows.map(m)), ck = ownK(cur);
  let now = -1;
  if (ck !== "other") for (const same of [(a, b) => a === b, sameOwnK]) { rows.forEach((r, i) => { if (m(r) === last && same(ck, ownK(r.baalut))) now = i; }); if (now >= 0) break; }
  const rk = (r, i) => i === now ? 3 : ownK(r.baalut) === "dealer" ? 0 : ownK(r.baalut) === "private" ? 2 : 1;
  return rows.map((r, i) => [r, i]).sort((a, b) => m(a[0]) - m(b[0]) || rk(...a) - rk(...b) || a[1] - b[1]).map(x => x[0]);
}
// months held, written the way the page writes them
function spanText(mo) {
  if (mo < 1) return "פחות מחודש";
  const y = Math.floor(mo / 12), r = mo % 12, ms = ["", "חודש", "חודשיים"][r] || `${r} חודשים`, ys = ["", "שנה", "שנתיים"][y] || `${y} שנים`;
  return !y ? ms : !r ? ys : r <= 2 ? `${ys} ו${ms}` : `${ys} ו-${ms}`;
}
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
const pickE = (...a) => a.find(x => !E(x));
const firstPosE = (...a) => a.find(posV);
const numS = x => { const d = String(x ?? "").replace(/[^\d.]/g, ""); return d ? String(Number(d)) : ""; };   // "1,798 סמ״ק" -> "1798"
// the licence as the app states its rule (index.html licState): days from local midnight; a licence that ended in the last 3 days is "lag", one whose
// last test is from 30 days before its end or later and at most 30 days old is "renew"; otherwise an ended licence is "bad"
function licMine(tokef, test, td) {
  const ex = toD(tokef); if (!ex) return null;
  const days = Math.round((ex - td) / 864e5), t = toD(test);
  const near = days < 0 && !!t && t >= new Date(ex.getFullYear(), ex.getMonth(), ex.getDate() - 30);
  const k = days >= 0 ? "ok" : near && t >= new Date(td.getFullYear(), td.getMonth(), td.getDate() - 30) ? "renew" : days >= -3 ? "lag" : "bad";
  return {k, days, ex};
}
// the km at the last test (index.html kmAtTest): only from a test 60 days or more away from the first registration and the on-road month (a new
// car's delivery reading), the yearly pace from half a year on; a used personal import counts its years from mid production year
const monthsB = (a, b) => (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth()) + (b.getDate() - a.getDate()) / 30;
function kmMine(R) {
  const km = posV(R.kilometer_test_aharon) ? N(R.kilometer_test_aharon) : null, t = toD(R.mivchan_acharon_dt);
  const used = /משומש/.test(String(R.mkoriut_nm || "") + String(R.sug_yevu || "")), road = ym(R.moed_aliya_lakvish), born = isN(R.shnat_yitzur) ? new Date(N(R.shnat_yitzur), 6, 1) : null;
  const near = d => !!d && Math.abs(t - d) < 60 * 864e5;
  if (!km) return {km: null, per: null};
  if (!t) return {km: km >= 1000 ? km : null, per: null};
  if (!used && (near(toD(R.rishum_rishon_dt)) || near(road))) return {km: null, per: null};
  const start = used ? born : road || born, years = start && t > start ? monthsB(start, t) / 12 : 0;
  return {km, per: years >= 0.5 ? Math.round(km / years / 100) * 100 : null, years};
}
// the model rows the app reads (index.html ofType, rankRows, ownRow, towOf, listPrice), so a borrowed row or a tie between rows is expected, not a mismatch
const sdR = r => String(r.sug_degem || "").trim().toUpperCase();
const nkR = x => String(x || "").trim().toUpperCase();
const sameModelR = (r, v) => !E(v.kinuy_mishari) && nkR(r.kinuy_mishari) === nkR(v.kinuy_mishari) || !E(v.degem_nm) && nkR(r.degem_nm) === nkR(v.degem_nm);
function ofTypeR(rows, v) {
  const sd = sdR(v);
  if (sd && rows.some(r => sdR(r) === sd)) return rows.filter(r => sdR(r) === sd);
  if (!rows.some(sdR) || E(v.kinuy_mishari) && E(v.degem_nm)) return rows;
  const named = new Set(rows.filter(r => sameModelR(r, v)).map(sdR));
  return !sd && !named.size ? rows : rows.filter(r => !sdR(r) || named.has(sdR(r)));
}
function scoreR(r, v) {
  const n = s => String(s || "").trim().toLowerCase(), dy = Math.abs(N(r.shnat_yitzur) - N(v.shnat_yitzur));
  return (isNaN(dy) ? -50 : -dy * 10) + (n(r.sug_degem) && n(r.sug_degem) === n(v.sug_degem) ? 3 : 0) + (n(r.ramat_gimur) && n(r.ramat_gimur) === n(v.ramat_gimur) ? 5 : 0)
    + (n(r.kinuy_mishari) && n(r.kinuy_mishari) === n(v.kinuy_mishari) ? 2 : 0);
}
// ranked as the app ranks them; rows with the same score keep the ministry's order, which is not fixed, so "rev" ranks them the other way round
const rankR = (rows, v, rev) => rows.map((r, i) => [r, i, scoreR(r, v)]).sort((a, b) => b[2] - a[2] || (rev ? b[1] - a[1] : a[1] - b[1])).map(x => x[0]);
const topRows = (rows, v) => { if (!rows.length) return []; const s = rows.map(r => scoreR(r, v)), m = Math.max(...s); return rows.filter((_, i) => s[i] === m); };
const trimK = x => String(x ?? "").trim().toUpperCase().replace(/\s+/g, " ");
const trimOkR = (r, v) => E(v.ramat_gimur) || trimK(r.ramat_gimur) === trimK(v.ramat_gimur);
const ownRowR = (r, v) => !!r && !E(r.shnat_yitzur) && N(r.shnat_yitzur) === N(v.shnat_yitzur) && trimOkR(r, v) && (!sdR(v) || !sdR(r) || sdR(r) === sdR(v));
const hasTowR = r => !!r && (posV(r.kosher_grira_im_blamim) || posV(r.kosher_grira_bli_blamim));
const towZeroR = r => isN(r.kosher_grira_im_blamim) && isN(r.kosher_grira_bli_blamim) && N(r.kosher_grira_im_blamim) === 0 && N(r.kosher_grira_bli_blamim) === 0;
function towOfR(ranked, v) {
  const y = N(v.shnat_yitzur), yr = ranked.filter(r => N(r.shnat_yitzur) === y), own = yr.find(r => ownRowR(r, v));
  if (own && (hasTowR(own) || towZeroR(own))) return {towRow: hasTowR(own) ? own : null, zeroTow: towZeroR(own) && y >= 2008};
  const t = yr.find(hasTowR); if (t) return {towRow: t, zeroTow: false};
  if (yr.some(towZeroR)) return {towRow: null, zeroTow: yr.every(towZeroR) && y >= 2008};
  return {towRow: ranked.find(r => hasTowR(r) && sameModelR(r, v)) || null, zeroTow: false};
}
// the list price: the car's year and trim, then its year, then its trim, then any row; within one of those the best ranked (ties: any of them)
function priceMine(rows, v) {
  const p = rows.filter(r => posV(r.mehir)), y = N(v.shnat_yitzur), trims = rows.some(r => !E(r.ramat_gimur));
  const sameT = r => !trims || trimOkR(r, v), sameY = r => N(r.shnat_yitzur) === y;
  for (const f of [r => sameY(r) && sameT(r), sameY, sameT, () => true]) { const c = p.filter(f); if (c.length) return topRows(c, v).map(r => ({r, own: sameY(r) && (!sdR(v) || !sdR(r) || sdR(r) === sdR(v))})); }
  return [];
}
// the importer shown in the specs: the price row's, else the best ranked row that names one
function importerMine(rows, v) {
  const cand = priceMine(rows, v), withImp = topRows(rows.filter(r => !E(r.shem_yevuan)), v).map(r => String(r.shem_yevuan).trim());
  if (!cand.length) return withImp.length ? withImp : [""];
  return [...new Set(cand.flatMap(x => !E(x.r.shem_yevuan) ? [String(x.r.shem_yevuan).trim()] : withImp.length ? withImp : [""]))];
}
// the registration's towing-hook field, whatever its name
const hookOf = R => { const h = Object.entries(R).find(([k, x]) => /grira|gerira|vav/i.test(k) && !/kosher_grira/i.test(k) && !E(x)); return h ? {k: h[0], text: String(h[1]).trim(), none: /^(0|לא|אין|ללא)$|ללא|אין|לא מותקן/.test(String(h[1]).trim())} : null; };
// the model recall list (index.html recallReach, matchModelRecalls, learnedRecalls): build years, the per-car list's reach and its model links
const ABSENT_YEARS = Number((html.match(/const REC_ABSENT_YEARS\s*=\s*(\d+)/) || [])[1] || 3);
const recYear = x => { const m = String(x || "").match(/(19|20)\d{2}/); return m ? +m[0] : null; };
const recKey = r => [String(r.TEUR_TAKALA || "").replace(/\s+/g, " ").trim() || "#" + r.RECALL_ID, r.BUILD_BEGIN_A || "", r.BUILD_END_A || ""].join("|");
const linkKeyR = v => String(v.kinuy_mishari || v.degem_nm || "").trim().toUpperCase().replace(/\s+/g, " ") + "|" + (Number(v.shnat_yitzur) || "");

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
  const R = X.R, v = R, y = N(R.shnat_yitzur), cancelled = X.cancelled, inactive = /^inactive/.test(X.primary || ""), hold = X.hold, imp = (X.sets.import || []).length > 0;
  const now = new Date(), td = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const W = pool(X.wltp, R), PR = pool(X.price, R, {filter: r => posV(r.mehir)});
  const MT = ofTypeR(X.wltp || [], R), W0 = topRows(MT, R), Ws = W0.length ? W0 : [{}];   // the rows the app can read as the car's model row
  const spec = l => factOf(P, "specs", /^הרכב$/, l) || factOf(P, "specs", /^מנוע והנעה$/, l) || factOf(P, "specs", /^משקלים וצמיגים$/, l) || factOf(P, "specs", /^בטיחות$/, l) || factOf(P, "specs", /^סביבה$/, l);
  const inSet = (shown, set, f = x => sp(x)) => set.map(f).includes(f(shown));
  // one expected value per row the app can read as its model row: shown must be one of them ("" = not shown)
  const oneOf = (field, shown, exps, norm = sp, ev = "") => { const e = [...new Set(exps.map(x => x === undefined || x === null || E(x) ? "" : norm(x)))];
    check(c, field, e.includes(norm(shown || "")), shown, e.map(x => x || "(not shown)").join(" / "), ev); };
  const ins = (cardOf(P, "overview", /^מידע חשוב/) || {items: []}).items;
  // identity
  check(c, "identity.year", sp(spec("שנת ייצור")) === sp(R.shnat_yitzur || ""), spec("שנת ייצור"), R.shnat_yitzur || "", "");
  const mk = spec("יצרן"); MAKEPAIRS.set(`${sp(R.tozeret_nm)} -> ${mk}`, (MAKEPAIRS.get(`${sp(R.tozeret_nm)} -> ${mk}`) || 0) + 1);
  check(c, "identity.make", !E(mk) || E(R.tozeret_nm), mk, R.tozeret_nm, "");
  // the car's name at the top carries the maker whenever the register names one (26.10: a card titled "EX5" alone)
  check(c, "identity.title_make", E(R.tozeret_nm) || !E(mk) && sp(P.head.title).toUpperCase().includes(sp(mk).toUpperCase()), P.head.title, `${mk || "(maker missing)"} in the title`, `tozeret_nm=${R.tozeret_nm || ""}`);
  oneOf("identity.model", spec("דגם"), Ws.map(w => pickE(R.kinuy_mishari, w.kinuy_mishari, R.degem_nm)), sp, `kinuy=${R.kinuy_mishari || ""} degem_nm=${R.degem_nm || ""}`);
  check(c, "identity.trim", sp(spec("רמת גימור")) === sp(R.ramat_gimur || ""), spec("רמת גימור"), R.ramat_gimur || "(not shown: the register has none)", "");   // the register's own trim only
  check(c, "identity.colour", sp(spec("צבע")) === sp(R.tzeva_rechev || ""), spec("צבע"), R.tzeva_rechev || "", "");
  oneOf("identity.fuel", spec("דלק"), Ws.map(w => pickE(R.sug_delek_nm, w.delek_nm)));
  oneOf("identity.engine_cc", spec("נפח מנוע"), Ws.map(w => firstPosE(R.nefach_manoa, w.nefah_manoa)), numS);
  { const reg = String(R.sug_delek_nm || ""), Wd = [...W, ...W0], tech = vals(Wd, "technologiat_hanaa_nm").join(" ").toUpperCase(), fuel = reg || vals(Wd, "delek_nm").join(" ");
    const exp = new Set();
    if (/^חשמל$/.test(reg.trim()) || (!reg && /חשמל/.test(fuel) && !/בנזין|דיזל/.test(fuel))) exp.add("חשמלי");
    else if (/חשמל\//.test(reg) || /PLUG|פלאג|נטען/.test(tech)) exp.add("פלאג-אין");
    else if (/היברידי/.test(tech)) exp.add("היברידי");
    else if (/דיזל|סולר/.test(fuel)) exp.add("דיזל");
    else if (/גפ"?מ|גז/.test(fuel)) exp.add("גפ״מ");
    else if (fuel) exp.add("בנזין");
    if (/היברידי/.test(tech) && /PLUG|פלאג/.test(tech)) { exp.add("היברידי"); exp.add("פלאג-אין"); }
    if (/חשמלי/.test(tech) && !/PLUG|פלאג|היברידי/.test(tech)) exp.add("חשמלי");
    check(c, "identity.drive_pill", exp.size ? exp.has(P.head.drive) : !P.head.drive, P.head.drive, [...exp].join(" / "), `sug_delek_nm=${reg} tech=${vals(Wd, "technologiat_hanaa_nm").join("|")}`); }
  { const card = P.tabs.specs.cards.find(x => x.title === "מספרי זיהוי"), vin = card ? card.text : "", want = String([R.misgeret, R.mispar_shilda, R.shilda].find(x => !E(x)) || "");
    // the card's text comes with its white space collapsed (T), so the register's value is compared the same way; the evidence describes it without printing it
    const w1 = want.replace(/\s+/g, " ").trim(), shape = s => `${s.trim().length} chars${/\s/.test(s.trim()) ? ", inner spaces" : ""}${/[a-z]/.test(s) ? ", lower case" : ""}${/[^A-Za-z0-9\s]/.test(s) ? ", other signs" : ""}`;
    if (w1 && w1 !== want.trim()) NOTES.push(`${c.id}: the register writes the VIN with runs of white space (${shape(want)}), compared with them collapsed as a page shows them`);
    check(c, "identity.vin", !w1 || vin.includes(w1), "(vin hidden)", "(vin hidden)", w1 ? `register VIN (${shape(want)}) not found in the card${!card ? " (no ID card)" : /מספר שלדה/.test(vin) ? "" : " (the card shows no VIN)"}` : ""); }
  // status: which register is the car, and the public register's hold
  const pills = P.head.pills.join(" | "), regs = `primary=${X.primary} registers=${X.mains.join(",")}${X.lent.size ? " lent=" + [...X.lent].join(",") : ""}`;
  check(c, "status.inactive_pill", inactive === P.head.pills.includes("לא פעיל"), pills, inactive ? "לא פעיל" : "(no inactive pill)", regs);
  check(c, "status.cancel_pill", cancelled === P.head.pills.includes("ירד מהכביש") && cancelled === P.head.banners.some(b => /הרכב ירד מהכביש/.test(b)), pills + " || " + P.head.banners.join(" | ").slice(0, 80), cancelled ? "pill+banner ירד מהכביש" : "(none)", regs + (X.gone ? " public=permanent" : ""));
  { const pub = (X.sets.public || [])[0], st = pub ? `public bitul_cd=${pub.bitul_cd ?? ""} bitul_nm=${pub.bitul_nm || ""}` : "no public row";
    check(c, "status.hold_pill", hold ? P.head.pills.includes(hold.status) : !P.head.pills.some(p => /^הרישיון מופקד$|^הורד מהכביש/.test(p)), pills, hold ? hold.status : "(no hold pill)", `${regs}; ${st}`);
    check(c, "status.hold_insight", hold ? ins.includes(hold.status) : !ins.some(t => /^הרישיון מופקד$|^הורד מהכביש/.test(t)), ins.join(" | ").slice(0, 120), hold ? hold.status : "(none)", st); }
  { const want = imp ? String(X.sets.import[0].sug_yevu || "יבוא אישי").replace(/-/g, " · ") : "", got = P.head.pills.filter(p => /יבוא/.test(p));
    check(c, "status.import_pill", imp ? got.includes(want) : !got.length, got.join(" | ") || "(none)", want || "(no import pill)", `in import dataset: ${imp}; ${regs}`); }
  { const ck = cardOf(P, "buy", /^מה נבדק/), first = ck ? ck.items[0] || "" : "";
    const want = cancelled ? "הרכב ירד מהכביש" : inactive ? "הרכב רשום כלא פעיל" : hold ? hold.status : "הרכב פעיל ולא בוטל";
    check(c, "status.buy_checklist", first === want, first || "(no checks card)", want, regs); }
  if (X.primary === "heavy") check(c, "status.heavy_note", ins.includes("רכב כבד: מידע חלקי"), ins.join(" | ").slice(0, 120), "רכב כבד: מידע חלקי", "");
  if (cancelled) { const sh = factOf(P, "overview", /^רישוי וטסט$/, "ירד מהכביש"), ex = E(R.bitul_dt) ? "" : fd(R.bitul_dt);
    check(c, "status.cancel_date", sp(sh) === sp(ex), sh, ex, "");
    const why = factOf(P, "overview", /^רישוי וטסט$/, "סיבה"); check(c, "status.cancel_reason", sp(why) === sp(R.bitul_nm || ""), why, R.bitul_nm || "(none)", regs); }
  // test: the dates as the register writes them (none from a register that publishes none), the licence state from them
  { const top = X.primary && X.sets[X.primary][0];
    if (X.noTest && top && (toD(top.tokef_dt) || toD(top.mivchan_acharon_dt))) check(c, "test.no_dates_register", false, "(dates hidden)", `the ${X.primary} register has dates for this car`, `tokef_dt=${top.tokef_dt || ""} mivchan=${top.mivchan_acharon_dt || ""}`);
    // the licence date's label reads "הטסט פג" once the date has passed (index.html licKey, 28.10)
    const LK = licMine(R.tokef_dt, R.mivchan_acharon_dt, td), lkey = LK && LK.days < 0 ? "הטסט פג" : "טסט בתוקף עד";
    const lc = cardOf(P, "overview", /^רישוי וטסט$/) || {notes: []}, sh = factOf(P, "overview", /^רישוי וטסט$/, lkey), sl = factOf(P, "overview", /^רישוי וטסט$/, "טסט אחרון");
    const expV = X.noTest || !toD(R.tokef_dt) ? "" : fd(R.tokef_dt), expL = X.noTest || !toD(R.mivchan_acharon_dt) ? "" : fd(R.mivchan_acharon_dt);
    check(c, "test.valid_until", sh === expV, sh, expV || "(not shown)", `tokef_dt=${R.tokef_dt || ""}${X.datesFrom ? " (from " + X.datesFrom + ")" : ""}`);
    check(c, "test.last", sl === expL, sl, expL || "(not shown)", `mivchan_acharon_dt=${R.mivchan_acharon_dt || ""}`);
    const noDates = lc.notes.some(t => /לא מפרסם במאגרים הפתוחים תאריכי טסט/.test(t));
    check(c, "test.no_dates_note", noDates === X.noTest, noDates ? "note shown" : "(none)", X.noTest ? "note: the register publishes no test dates" : "(none)", regs);
    const L = cancelled || X.noTest ? null : licMine(R.tokef_dt, R.mivchan_acharon_dt, td);
    const noTokef = lc.notes.some(t => /לא מראה תאריך תוקף לטסט/.test(t));
    check(c, "test.no_tokef_note", noTokef === (!cancelled && !X.noTest && !L), noTokef ? "note shown" : "(none)", !cancelled && !X.noTest && !L ? "note: no licence date" : "(none)", `tokef_dt=${R.tokef_dt || ""}`);
    const pill = P.head.pills.find(p => /^טסט|^לא ברור אם הטסט חודש$/.test(p)) || "";
    const expPill = !L ? "" : L.k === "ok" ? `טסט עד ${String(L.ex.getMonth() + 1).padStart(2, "0")}/${L.ex.getFullYear()}` : L.k === "bad" ? "טסט לא בתוקף" : "לא ברור אם הטסט חודש";
    check(c, "test.pill", pill === expPill, pill || "(none)", expPill || "(none)", `tokef_dt=${R.tokef_dt || ""} mivchan=${R.mivchan_acharon_dt || ""} state=${L ? L.k + " " + L.days + "d" : "-"}`);
    const tIns = ins.filter(t => /^הטסט לא בתוקף$|^לא ברור אם הטסט חודש$|^הטסט מתקרב$/.test(t)).join(" | ");
    const expIns = !L ? "" : L.k === "bad" ? "הטסט לא בתוקף" : L.k !== "ok" ? "לא ברור אם הטסט חודש" : L.days <= 60 ? "הטסט מתקרב" : "";
    check(c, "test.insight", tIns === expIns, tIns || "(none)", expIns || "(none)", `state=${L ? L.k + " " + L.days + "d" : "-"}`); }
  // km
  { const st = P.tabs.overview.stats, km = st.find(s => s.k === "ק״מ בטסט האחרון"), per = st.find(s => s.k === "ממוצע לשנה"), K = kmMine(R);
    const ev = `km=${R.kilometer_test_aharon || ""} test=${R.mivchan_acharon_dt || ""} road=${R.moed_aliya_lakvish || ""} first-reg=${R.rishum_rishon_dt || ""}${K.years ? " years=" + K.years.toFixed(2) : ""}`;
    check(c, "km.last_test", K.km ? !!km && N(dig(km.v)) === K.km : !km, km ? km.v : "(no tile)", K.km || "(no tile)", ev);
    check(c, "km.per_year", K.per ? !!per && N(dig(per.v)) === K.per : !per, per ? per.v : "(no tile)", K.per || "(no tile)", ev); }
  // road dates
  { const sh = factOf(P, "overview", /^רישוי וטסט$/, "עלה לכביש"); check(c, "road.first_date", E(R.moed_aliya_lakvish) ? E(sh) : sh === fd(R.moed_aliya_lakvish), sh, E(R.moed_aliya_lakvish) ? "" : fd(R.moed_aliya_lakvish), "");
    const rr = factOf(P, "overview", /^רישוי וטסט$/, "רישום ראשון"); check(c, "road.first_registration", E(R.rishum_rishon_dt) ? E(rr) : rr === fd(R.rishum_rishon_dt), rr, E(R.rishum_rishon_dt) ? "" : fd(R.rishum_rishon_dt), ""); }
  // ownership
  { const own = ordOwn((X.sets.owners || []).filter(r => !E(r.baalut)), R.baalut);
    // the current owner: the register's type when it names one; "נוכחי" goes on the log's last record only when it is that owner
    const regK = ownK(R.baalut), last = own[own.length - 1], inLog = !!last && (regK === "other" || sameOwnK(regK, ownK(last.baalut)));
    const curK = regK !== "other" ? regK : last ? ownK(last.baalut) : "";
    const card = cardOf(P, "overview", /^היסטוריית בעלויות$/), mirror = P.head.ownMirror;
    const road = ym(R.moed_aliya_lakvish) || (isN(R.shnat_yitzur) ? new Date(N(R.shnat_yitzur), 0, 1) : null), floor = !road || road < new Date(2017, 0, 1);
    const hands = own.filter(r => !DEALER.test(r.baalut)), n = hands.length, fo = String(R.mkoriut_nm || "").replace(/"/g, "").trim();
    // a used personal import's hands are its hands in Israel (index.html ownersLabel, 28.10)
    const inIL = /משומש/.test(String(R.mkoriut_nm || "") + String(R.sug_yevu || "")) ? " בישראל" : "";
    let exp = "";
    if (!n) exp = own.length && curK === "dealer" ? "אצל סוחר" : "";
    else if (n === 1) exp = !floor && (!fo || kindOf(fo) === kindOf(hands[0].baalut)) ? "יד ראשונה" + inIL : "יד אחת במאגר";
    else exp = `${floor ? "לפחות " : ""}יד ${ORD[n] || n}${inIL}`;
    const ev = `log=${own.map(r => `${r.baalut}@${r.baalut_dt}`).join(">")} road=${R.moed_aliya_lakvish || ""} mkoriut=${fo}`;
    if (mirror) NOTES.push(`${c.id}: ownership from the app's mirror (API returned no rows to the app); my API rows=${own.length}`);
    else {
      const shown = card ? card.count : "";
      check(c, "owners.hands", shown === exp, shown, exp, ev);
      const pill = P.head.pills.find(p => /יד |אצל סוחר/.test(p)) || "";
      check(c, "owners.hands_pill", pill === exp, pill, exp, "");
      const expTl = own.slice().reverse().map((r, i) => `${fd(r.baalut_dt)} ${sp(r.baalut)}${i === 0 && inLog ? (cancelled ? "אחרון" : "נוכחי") : ""}`).join(" / ");
      const shTl = card ? card.timeline.map(t => `${t.time} ${t.text}`).join(" / ") : "";
      check(c, "owners.timeline", sp(shTl) === sp(expTl), shTl, expTl, "");
      // months held: to the next transfer's month, the current owner to this month (or to the month the car left the road)
      const mon = d => d.getFullYear() * 12 + d.getMonth(), endD = cancelled ? ym(R.bitul_dt) : new Date();
      const expDur = own.map((r, i) => { const a = ym(r.baalut_dt), b = i < own.length - 1 ? ym(own[i + 1].baalut_dt) : inLog ? endD : null;
        return a && b ? spanText(Math.max(0, mon(b) - mon(a))) + (i < own.length - 1 ? "" : cancelled ? ", עד שהרכב ירד מהכביש" : ", עד היום") : ""; }).reverse().join(" / ");
      const shDur = card ? card.timeline.map(t => t.dur).join(" / ") : "";
      if (own.length) check(c, "owners.durations", sp(shDur) === sp(expDur), shDur, expDur, own.map(r => r.baalut_dt).join(">"));
      // a car off the road names its last owner, not a current one (index.html ownNowKey, 28.10)
      const nowKey = cancelled ? "בעלות אחרונה" : "בעלות נוכחית";
      if (own.length) check(c, "owners.now_line", (card ? card.ownNow : "") === (inLog ? "" : `${nowKey}: ${sp(R.baalut)}`), card ? card.ownNow : "", inLog ? "(none)" : `${nowKey}: ${sp(R.baalut)}`, `register "${R.baalut || ""}" log last "${last ? last.baalut : ""}"`);
      if (!own.length && !E(R.baalut)) { const cur = factOf(P, "overview", /^בעלות$/, nowKey); check(c, "owners.current_no_log", sp(cur) === sp(R.baalut), cur, R.baalut, ""); }
    }
    { const sh = ((cardOf(P, "overview", /^(היסטוריית בעלויות|בעלות)$/) || {}).firstOwn || "").replace(/^בעלות ראשונה: /, ""), ex = /^ביס לנהיגה/.test(fo) ? "בית ספר לנהיגה" : fo;
      check(c, "owners.first_owner", sp(sh) === sp(ex), sh, ex, ""); }
    if (own.length && !inLog)
      NOTES.push(`${c.id} ${mask(c.plate)}: source: the register's current owner "${R.baalut}" is not in the log's last month (last record "${last.baalut}" ${last.baalut_dt})`);
    // insights the ownership log drives
    const past = (inLog ? own.slice(0, -1) : own).map(r => String(r.baalut));
    if (!mirror && !own.length && X.sets.owners && !X.errs.owners) {
      const ins = (cardOf(P, "overview", /^מידע חשוב/) || {items: []}).items, dealerNow = curK === "dealer";
      check(c, "owners.insight_dealer_now", dealerNow === ins.includes("הרכב רשום כעת על סוחר"), ins.join(" | ").slice(0, 120), dealerNow ? "הרכב רשום כעת על סוחר" : "(none)", `no log rows, register "${R.baalut || ""}"`);
    }
    if (!mirror && own.length) {
      const ins = (cardOf(P, "overview", /^מידע חשוב/) || {items: []}).items;
      check(c, "owners.insight_rental", past.some(t => /השכר/.test(t)) === ins.includes("היה רכב השכרה"), ins.join(" | ").slice(0, 120), past.some(t => /השכר/.test(t)) ? "היה רכב השכרה" : "(none)", "");
      // an owner held for 3 months or less (to the next transfer's month) is a registration before delivery and makes no lease or dealer line
      const monA = d => d.getFullYear() * 12 + d.getMonth(), endA = cancelled ? ym(R.bitul_dt) : new Date();
      const span = i => { const a = ym(own[i].baalut_dt), b = i < own.length - 1 ? ym(own[i + 1].baalut_dt) : inLog ? endA : null; return a && b ? Math.max(0, monA(b) - monA(a)) : null; };
      const held = i => span(i) == null || span(i) > 3, road = ym(R.moed_aliya_lakvish), a0 = ym(own[0].baalut_dt);
      const newAtFirst = !!road && !!a0 && Math.abs(monA(a0) - monA(road)) <= 1;
      const pl = past.some((t, i) => /החכר|ליסינג/.test(t) && held(i));
      const sl = !pl && past.some((t, i) => /החכר|ליסינג/.test(t) && !held(i)), slT = /החכר|ליסינג/.test(past[0] || "") && !held(0) ? "כנראה נמכר כיד 2, 0 ק״מ" : "נרשם לזמן קצר על חברת ליסינג";
      check(c, "owners.insight_short_lease", sl === ins.includes(slT), ins.join(" | ").slice(0, 120), sl ? slT : "(none)", "");
      check(c, "owners.insight_lease", pl === ins.includes("היה רכב ליסינג"), ins.join(" | ").slice(0, 120), pl ? "היה רכב ליסינג" : "(none)", pl ? "a past log record is " + past.filter(t => /החכר|ליסינג/.test(t)).join(",") : "");
      const coNow = own.length > 1 && FLEET.includes(curK), dealerNow = curK === "dealer", wasDealer = !dealerNow && past.some((t, i) => DEALER.test(t) && !(i === 0 && !held(0) && newAtFirst));
      check(c, "owners.insight_company_now", coNow === ins.includes("הרכב רשום כעת על חברה"), ins.join(" | ").slice(0, 120), coNow ? "הרכב רשום כעת על חברה" : "(none)", `current owner ${curK} (register "${R.baalut || ""}")`);
      check(c, "owners.insight_dealer_now", dealerNow === ins.includes("הרכב רשום כעת על סוחר"), ins.join(" | ").slice(0, 120), dealerNow ? "הרכב רשום כעת על סוחר" : "(none)", `current owner ${curK} (register "${R.baalut || ""}")`);
      check(c, "owners.insight_was_dealer", wasDealer === ins.includes("היה אצל סוחר"), ins.join(" | ").slice(0, 120), wasDealer ? "היה אצל סוחר" : "(none)", "");
      const newDealer = !dealerNow && !wasDealer && DEALER.test(past[0] || "") && !held(0) && newAtFirst;
      // a short first leasing record shows the same title (owners.insight_short_lease checks that one): when it is shown, one such title is the lease's
      const zk = "כנראה נמכר כיד 2, 0 ק״מ", leaseZk = sl && slT === zk && ins.includes(zk), nZk = ins.filter(t => t === zk).length - (leaseZk ? 1 : 0);
      check(c, "owners.insight_new_dealer", nZk === (newDealer ? 1 : 0), ins.join(" | ").slice(0, 120), newDealer ? zk : "(none)", leaseZk ? "one such title is the short first lease's" : "");
    }
  }
  { const has = (X.sets.tag || []).length > 0, said = /לרכב יש תג חניה לנכה/.test(P.tabs.overview.text);
    if (X.sets.tag !== undefined && !X.errs.tag) check(c, "tag.insight", has === said, "", "", "", true); }
  // open recalls on this car (the per-car list; a recall listed twice for one plate is one recall)
  const openIds = [...new Set((X.sets.recall || []).map(r => String(r.RECALL_ID ?? "").trim()))];
  { const ids = openIds.slice().sort();
    const card = cardOf(P, "recalls", /^ריקולים פתוחים לרכב הזה$/), shown = card ? card.recalls.map(r => (r.note.match(/מספר (\d+)/) || [])[1] || "?").sort() : [];
    const ban = P.head.banners.find(b => /ריקול/.test(b) && /פתוח/.test(b)) || "";
    check(c, "recalls.open", ids.join(",") === shown.join(","), shown.join(",") || "(none)", ids.join(",") || "(none)", X.errs.recall ? "my query failed: " + X.errs.recall : (X.sets.recall || []).length > ids.length ? `${(X.sets.recall || []).length} rows for ${ids.length} recalls` : "");
    const bn = ban ? (/יש ריקול פתוח/.test(ban) ? 1 : N((ban.match(/(\d+) ריקולים/) || [])[1])) : 0;
    check(c, "recalls.open_banner", bn === ids.length, ban.slice(0, 60) || "(no banner)", ids.length, "");
    for (const r of X.sets.recall || []) { const s = card && card.recalls.find(x => x.note.includes("מספר " + String(r.RECALL_ID).trim()));
      if (s && !E(r.TAARICH_PTICHA)) check(c, "recalls.open_date", s.note.includes("נפתח ב-" + fd(r.TAARICH_PTICHA)), s.note, "נפתח ב-" + fd(r.TAARICH_PTICHA), ""); } }
  // model recalls: the recall list's rows that name this model, as the app lists them (one entry per defect and build range, the per-car list's reach)
  { const br = brandRe(R.tozeret_nm, R.tozar);
    // a car page lists only the model recalls to check with the importer: in the recalls tab when the car has one, else in the amber
    // "checked" line above the tabs; the model's recall history is on model pages only
    const hist = cardOf(P, "recalls", /^ריקולים שנפתחו לדגם$/), pend = cardOf(P, "recalls", /^כדאי לבדוק מול היבואן$/), line = P.head.line;
    const shown = [...(hist ? hist.rlist.map(s => ({...s, card: "hist"})) : []), ...(pend ? pend.rlist.map(s => ({...s, card: "pend"})) : []), ...(line ? line.rlist.map(s => ({...s, card: "pend"})) : [])];
    const knownOpen = !P.head.msgs.some(t => /מידע על ריקולים לא זמין/.test(t));   // the per-car list answered the app for this plate
    const meta = X.catMeta, hz = meta && meta.recHz && meta.recHz.id ? meta.recHz : null, held = meta && Array.isArray(meta.recIn) ? new Set(meta.recIn.map(Number)) : null;
    const links = X.catRec && X.catRec.l || null, lk = linkKeyR(R);
    const reach = r => { if (!hz) return "?"; const id = N(r.RECALL_ID);
      if (id > hz.id || (hz.from && id >= hz.from && !(hz.ids || []).includes(id))) return "fresh";
      if (!held || held.has(id)) return "listed";
      return N(r.SHNAT_RECALL) >= now.getFullYear() - ABSENT_YEARS ? "absent" : "nolist"; };
    const fitsOf = r => { const from = recYear(r.BUILD_BEGIN_A), to = recYear(r.BUILD_END_A), near = !isNaN(y) && !!from && !!to && (y === to + 1 || y === from - 1);
      if (links && links[r.RECALL_ID] && links[r.RECALL_ID][lk]) return {fits: true, near: false, byList: true};
      return {fits: !isNaN(y) && from && to ? (y >= from && y <= to ? true : near ? null : false) : null, near}; };
    // what the app shows for one model recall: its card and its pill
    const expOf = r => { const f = fitsOf(r), k = reach(r), pending = knownOpen && f.fits !== false && (k === "fresh" || k === "absent");
      if (pending) return {card: "pend", pill: f.fits === true ? "בשנת הייצור" : f.near ? "שנה סמוכה" : "", dim: false, f, k};
      if (f.fits === false) return {card: "hist", pill: "שנים אחרות", dim: true, f, k};
      if (!knownOpen) return {card: "hist", pill: f.fits === true ? "כולל את שנת הייצור" : f.near ? "ייתכן שכולל את שנת הייצור" : "", dim: false, f, k};
      return {card: "hist", pill: (f.fits === true ? "בשנת הייצור, " : f.near ? "שנה סמוכה, " : "") + (k === "nolist" ? "אין רשימת רכבים" : "לא פתוח ברכב הזה"), dim: false, f, k}; };
    if (E(R.degem_cd)) NOTES.push(`${c.id}: no model code (${X.primary}): model recalls not looked up by the app`);
    else if (!RECALL_LIST) NOTES.push(`${c.id}: recall list not loaded`);
    else if (((P.tabs.recalls || {}).text || "").includes("רשימת הריקולים לדגם לא נטענה") || (line && line.text.includes("רשימת הריקולים לדגם לא נטענה"))) NOTES.push(`${c.id}: the app could not load the model's recall list (catalogue)`);
    else {
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
      // the shown entry: its text, the models it names and, when shown, its build range
      const rangeOf = r => sp(`ייצור ${E(r.BUILD_BEGIN_A) ? "" : fd(r.BUILD_BEGIN_A)} – ${E(r.BUILD_END_A) ? "" : fd(r.BUILD_END_A)}`);
      const fits1 = (s, r) => { const rs = segs(s).find(x => /^ייצור /.test(x)); return sp(s.b) === descOf(r) && (E(r.DEGEM) || segs(s).includes(dgOf(r))) && (!rs || rs === rangeOf(r)); };
      // a recall open on this plate is listed in its own card, with every batch of the same defect
      const openKeys = new Set(RECALL_LIST.filter(r => openIds.includes(String(r.RECALL_ID).trim())).map(recKey));
      const pool2 = shown.map(s => ({s, used: false}));
      const rows = RECALL_LIST.filter(r => !openIds.includes(String(r.RECALL_ID).trim()) && !openKeys.has(recKey(r))).map(r => ({r, k: cls(r), brand: !!(br && br.test(String(r.TOZAR_TEUR || "")))}));
      const cands = rows.filter(x => x.k !== "no" || (links && links[x.r.RECALL_ID] && links[x.r.RECALL_ID][lk]));
      // rows of this brand first, so a shared description is credited to the right maker
      for (const x of cands.sort((p, q) => (q.brand - p.brand) || (p.k === "strict" ? -1 : 1))) {
        const hit = pool2.find(p => !p.used && fits1(p.s, x.r));
        if (hit) { hit.used = true; hit.x = x; }
      }
      // one entry stands for every batch of a defect: a strict row of this brand is missing only when nothing of its defect and build range is shown
      const shownKeys = new Set(pool2.filter(p => p.used).map(p => recKey(p.x.r)));
      const catIds = X.catRec ? new Set([...(X.catRec.rows || []), ...(X.catRec.x || [])].map(r => String(r.RECALL_ID))) : null;
      // only a recall to check with the importer is listed; a car off the road lists them in its recalls tab, which it has only with an open recall
      const pendShown = !cancelled || P.head.tabs.includes("recalls");
      const miss = cands.filter(x => x.k === "strict" && x.brand && pendShown && expOf(x.r).card === "pend" && !pool2.some(p => p.x === x) && !shownKeys.has(recKey(x.r)));
      const lag = catIds ? miss.filter(x => !catIds.has(String(x.r.RECALL_ID))) : [];
      for (const x of lag) NOTES.push(`${c.id}: recall #${x.r.RECALL_ID} (${x.r.SHNAT_RECALL}) names this model but is not in the catalogue yet (it is rebuilt daily)`);
      const miss2 = miss.filter(x => !lag.includes(x));
      if (br) check(c, "recalls.model_missing", !miss2.length, `${shown.length} rows shown`, miss2.map(x => `#${x.r.RECALL_ID} DEGEM="${x.r.DEGEM}" ${x.r.SHNAT_RECALL} "${descOf(x.r).slice(0, 40)}"`).join("; "), `car kinuy=${R.kinuy_mishari} degem_nm=${R.degem_nm} year=${y} brand=${br}`);
      else NOTES.push(`${c.id}: missing-row check skipped (no brand mapping for "${R.tozeret_nm}")`);
      // a shown row that names no part of this model: the catalogue's own rows (a sister brand, or a recall only the per-car list names) explain it
      const catRows = X.catRec ? [...(X.catRec.rows || []), ...(X.catRec.x || [])] : [];
      const extra = [];
      for (const p of pool2.filter(p => !p.used)) {
        const r = catRows.find(r => fits1(p.s, r));
        if (r && links && links[r.RECALL_ID] && links[r.RECALL_ID][lk]) { p.used = true; p.x = {r, k: "list", brand: true}; AMBIG.push(`${c.id} ${sp(R.kinuy_mishari)} ${y}: shows #${r.RECALL_ID} "${descOf(r).slice(0, 40)}" because the per-car list holds cars of this model and year`); }
        else if (r) { p.used = true; p.x = {r, k: "catalogue", brand: true}; AMBIG.push(`${c.id} ${sp(R.kinuy_mishari)} ${y}: shows catalogue row #${r.RECALL_ID} DEGEM="${r.DEGEM}" (${r.TOZAR_TEUR || ""}) that my name match does not take`); }
        else extra.push(p);
      }
      for (const p of pool2.filter(p => p.used && p.x.k !== "list" && p.x.k !== "catalogue")) {
        if (p.x.k !== "strict") AMBIG.push(`${c.id} ${sp(R.kinuy_mishari)} (${R.degem_nm}) ${y}: shows ${p.x.k} row #${p.x.r.RECALL_ID} DEGEM="${p.x.r.DEGEM}" (${p.x.r.TOZAR_TEUR}) "${descOf(p.x.r).slice(0, 50)}" pill=${p.s.pill || "-"}`);
        if (!p.x.brand) AMBIG.push(`${c.id} ${sp(R.kinuy_mishari)}: shows a row of another maker #${p.x.r.RECALL_ID} TOZAR_TEUR=${p.x.r.TOZAR_TEUR} DEGEM="${p.x.r.DEGEM}"`);
      }
      check(c, "recalls.model_extra", !extra.length, extra.map(p => `"${p.s.b.slice(0, 40)}" [${p.s.note.slice(0, 90)}]`).join("; "), "(only rows that name this model)", `car kinuy=${R.kinuy_mishari} degem_nm=${R.degem_nm}`);
      check(c, "recalls.model_count", (hist ? N(hist.count) : 0) === (hist ? hist.rlist.length : 0), hist ? hist.count : "", hist ? hist.rlist.length : 0, "");
      { const ban = P.head.banners.find(b => /^ייתכן שהרכב נכלל ב/.test(b)) || (line && line.state === "warn" ? line.title : ""), n = cancelled ? 0 : shown.filter(s => s.card === "pend").length;   // a car off the road: the tab only
        check(c, "recalls.pending_banner", !!ban === n > 0, ban.slice(0, 50) || "(no banner)", n ? `banner for ${n} recalls the per-car list cannot answer yet` : "(none)", ""); }
      if (!hz) NOTES.push(`${c.id}: catalogue meta without the per-car list's reach: pills not checked`);
      else for (const p of pool2.filter(p => p.used)) {
        // the group's entry is the one that says the most about this car, so any row of the shown defect and build range may be the one behind it
        const grp = [...new Map([p.x.r, ...cands.map(x => x.r), ...catRows].filter(r => recKey(r) === recKey(p.x.r)).map(r => [String(r.RECALL_ID), r])).values()];
        const exps = grp.map(expOf), ok = exps.some(e => e.card === p.s.card && e.pill === p.s.pill && e.dim === p.s.dim);
        const e0 = exps[0];
        check(c, "recalls.model_fits", ok, `${p.s.card === "pend" ? "[check with importer] " : ""}${p.s.pill || "(no pill)"}${p.s.dim ? " (dim)" : ""}`, [...new Set(exps.map(e => `${e.card === "pend" ? "[check with importer] " : ""}${e.pill || "(no pill)"}${e.dim ? " (dim)" : ""}`))].join(" or "),
          `#${p.x.r.RECALL_ID} build ${p.x.r.BUILD_BEGIN_A || "?"}..${p.x.r.BUILD_END_A || "?"} year=${y} fits=${e0.f.fits}${e0.f.near ? " near" : ""}${e0.f.byList ? " by-list" : ""} reach=${e0.k} knownOpen=${knownOpen}`);
      }
    } }
  // settlements: never for a personal import or a car off the road; the banner, the card and the checklist must agree
  { const card = cardOf(P, "recalls", /הסדר פשרה/), list = card ? card.stl : [];
    const ban = P.head.banners.find(b => /הסדר/.test(b)) || "", bn = ban ? (/ייתכן שמגיעה הטבה/.test(ban) ? 1 : N((ban.match(/(\d+) הטבות/) || [])[1])) : 0;
    check(c, "settlements.consistent", bn === list.length, ban.slice(0, 50) || "(no banner)", list.length, "");
    // the recalls tab only with an open recall or a settlement; otherwise the "checked" line, unless the ministry's recall list did not answer the app
    const hasTab = P.head.tabs.includes("recalls"), known = !P.head.msgs.some(t => /מידע על ריקולים לא זמין/.test(t)), wantTab = (known && openIds.length > 0) || bn > 0;
    check(c, "recalls.tab_shown", hasTab === wantTab, hasTab ? "tab" : "(no tab)", wantTab ? "tab (open recall or settlement)" : "(no tab)", `open=${openIds.length} settlement banners=${bn}`);
    const ln = P.head.line, wantLine = !cancelled && known && !hasTab;
    check(c, "recalls.check_line", !!ln === wantLine, ln ? ln.title.slice(0, 50) : "(no line)", wantLine ? "the checked line" : "(no line)", "");
    // "checked" is a claim that every check ran on a live answer: never with a part that did not load
    if (ln) check(c, "recalls.line_honest", !(/^נבדק/.test(ln.title) && /לא נטענה/.test(ln.text)), ln.title.slice(0, 50), "(not \"נבדק\" while a list did not load)", ln.state || "");
    if (imp || cancelled) check(c, "settlements.scope", !list.length && !bn, `${list.length} shown`, imp ? "(none: a personal import)" : "(none: off the road)", regs);
    if (imp && !cancelled) { const said = ((P.tabs.recalls || {}).text || "").includes("הרכב יובא ביבוא אישי, ולכן לא נבדק מול הסדרי הפשרה") || !!(P.head.line && P.head.line.text.includes("לא נבדק מול הסדרי פשרה"));
      check(c, "settlements.import_line", said, said ? "line shown" : "(none)", "הרכב יובא ביבוא אישי, ולכן לא נבדק מול הסדרי הפשרה", ""); }
    if (list.length) STLS.push(`${c.id} ${sp(R.tozeret_nm)} | ${sp(R.kinuy_mishari)} ${R.degem_nm || ""} | ${y} | ${R.tzeva_rechev || ""} | ${R.sug_delek_nm || ""} | cc=${R.nefach_manoa || ""} => ${list.join(" ; ")}`); }
  // towing: the car's own model row decides, then a row of its year, then the same model name in another year; 0/0 from 2008 is "no towing
  // approved" unless the registration has a hook fitted; the registration's own limits when no model row has any
  { const card = cardOf(P, "overview", /^כמה מותר לגרור$/) || {grid: [], notes: [], text: "", hook: "", ban: ""}, hk = hookOf(R), hooked = !!hk && !hk.none;
    const outcome = ranked => { const {towRow, zeroTow} = towOfR(ranked, R), tSrc = towRow || (hasTowR(R) ? R : null), ban = !tSrc && zeroTow && !hooked;
      const kg = k => tSrc && posV(tSrc[k]) ? N(tSrc[k]) : "—", year = tSrc && tSrc !== R && !E(tSrc.shnat_yitzur) && N(tSrc.shnat_yitzur) !== y ? String(tSrc.shnat_yitzur).trim() : "";
      return {shown: ban ? "ban" : tSrc ? `${kg("kosher_grira_im_blamim")}/${kg("kosher_grira_bli_blamim")}` : zeroTow ? "0/0 with a hook fitted" : "none", year}; };
    const outs = [outcome(rankR(MT, R)), outcome(rankR(MT, R, true))];
    const g = k => (card.grid.find(x => x.k === k) || {}).v || "";
    const shown = card.ban ? "ban" : card.grid.length ? `${dig(g("עם בלמים")) ? N(dig(g("עם בלמים"))) : "—"}/${dig(g("בלי בלמים")) ? N(dig(g("בלי בלמים"))) : "—"}`
      : /מותקן וו גרירה, והמאגר לא מראה/.test(card.text) ? "0/0 with a hook fitted" : /אין במאגר של משרד התחבורה נתוני גרירה/.test(card.text) ? "none" : "(card missing)";
    const yr = (card.notes.join(" ").match(/לפי נתוני הדגם משנת (\d{4})/) || [])[1] || "";
    check(c, "tow.limits", outs.some(o => o.shown === shown), shown, [...new Set(outs.map(o => o.shown))].join(" or "),
      `car ${R.sug_degem || ""} ${sp(R.kinuy_mishari)} ${y} ${R.ramat_gimur || ""}${hk ? ` hook "${hk.text}"` : ""}; model rows: ${MT.map(r => `${r.sug_degem || "?"}/${sp(r.kinuy_mishari)}/${r.shnat_yitzur}/${sp(r.ramat_gimur)}:${r.kosher_grira_im_blamim ?? ""}/${r.kosher_grira_bli_blamim ?? ""}`).join(", ").slice(0, 260)}`);
    check(c, "tow.year_note", outs.some(o => o.year === yr), yr || "(no year note)", [...new Set(outs.map(o => o.year || "(no year note)"))].join(" or "), "");
    // the hook box (registration's own towing-hook field), not beside the 0/0 ban
    if (hk && shown !== "ban") check(c, "tow.hook", hk.none ? /^לא מותקן וו גרירה/.test(card.hook) : /^מותקן וו גרירה/.test(card.hook), card.hook, hk.none ? "לא מותקן וו גרירה" : "מותקן וו גרירה " + hk.text, `${hk.k}=${hk.text}`); }
  // specs and weights: the register's own value first where the app reads it first, else the model row's; 0 is no value
  { const kg = (lab, key, ownV, mf) => oneOf("specs." + key, spec(lab), Ws.map(w => mf ? firstPosE(ownV, w[mf]) : firstPosE(ownV)), numS, E(ownV) ? "" : `register value=${ownV}`);   // field names stay one word (site-data-truth.mjs reads them)
    kg("משקל כולל מותר", "weight_total", R.mishkal_kolel, "mishkal_kolel"); kg("משקל עצמי", "weight_own", R.mishkal_azmi, null); kg("כושר העמסה", "load", R.mishkal_mitan_harama, null);
    check(c, "specs.tyre_front", sp(spec("צמיג קדמי")) === sp(pickE(R.zmig_kidmi, R.mida_zmig_kidmi) || ""), spec("צמיג קדמי"), pickE(R.zmig_kidmi, R.mida_zmig_kidmi) || "", "");
    check(c, "specs.tyre_rear", sp(spec("צמיג אחורי")) === sp(pickE(R.zmig_ahori, R.mida_zmig_ahori) || ""), spec("צמיג אחורי"), pickE(R.zmig_ahori, R.mida_zmig_ahori) || "", "");
    oneOf("specs.power", spec("כוח"), Ws.map(w => posV(w.koah_sus) ? w.koah_sus : posV(R.hespek) ? R.hespek : ""), numS, E(R.hespek) ? "" : `hespek=${R.hespek}`);
    oneOf("specs.seats", spec("מושבים"), Ws.map(w => firstPosE(w.mispar_moshavim, R.mispar_mekomot)), numS, E(R.mispar_mekomot) ? "" : `mispar_mekomot=${R.mispar_mekomot}`);
    { const sr = spec("סרנים"); check(c, "specs.axles", posV(R.sranim) ? dig(sr) === String(N(R.sranim)) : E(sr), sr, posV(R.sranim) ? R.sranim : "(not shown)", E(R.sranim) ? "" : `sranim=${R.sranim}`); }
    // the borrowed-row note: the model row on screen is not the car's own year, trim and type
    { const note = ((cardOf(P, "specs", /^הרכב$/) || {}).notes || []).some(t => /^נתוני הדגם במפרט לפי/.test(t)), expNotes = [...new Set(Ws.map(w => !!Object.keys(w).length && !ownRowR(w, R)))];
      check(c, "specs.borrowed_note", expNotes.includes(note), note ? "note shown" : "(none)", expNotes.map(b => b ? "note: model data of another year, trim or type" : "(none)").join(" or "),
        `car ${R.sug_degem || ""}/${R.shnat_yitzur || ""}/${sp(R.ramat_gimur)}; first model row ${W0.map(w => `${w.sug_degem || ""}/${w.shnat_yitzur || ""}/${sp(w.ramat_gimur)}`).join(" | ")}`); }
    // an active or inactive car shows the register's level, and 0 when it is empty on a car built from 2014 (index.html safetyLevel); in the other
    // registers the WLTP row of the car's own year and trim decides the same way, and without one the first positive level of the row or the model
    const lv0 = x => posV(x) ? String(N(x)) : N(R.shnat_yitzur) >= 2014 ? "0" : null, up = x => String(x ?? "").trim().toUpperCase(), sd0 = up(R.sug_degem);
    const Wt = (X.wltp || []).filter(r => (!sd0 || !(X.wltp || []).some(q => !E(q.sug_degem)) || up(r.sug_degem) === sd0) && N(r.shnat_yitzur) === N(R.shnat_yitzur) && up(r.ramat_gimur) === up(R.ramat_gimur));
    const sl = X.primary === "active" || X.primary === "inactive" ? [lv0(R.ramat_eivzur_betihuty)].filter(Boolean)
      : Wt.length ? [...new Set(Wt.map(r => lv0(r.ramat_eivzur_betihuty)))].filter(Boolean)
      : posV(R.ramat_eivzur_betihuty) ? [String(N(R.ramat_eivzur_betihuty))] : vals(W, "ramat_eivzur_betihuty", posV).map(x => String(N(x)));
    check(c, "specs.safety_level", sl.length ? sl.includes((spec("רמת אבזור בטיחותי").match(/^(\S+) מתוך/) || [])[1] || "") : E(spec("רמת אבזור בטיחותי")), spec("רמת אבזור בטיחותי"), sl.join(" / ") || "(not shown)", E(R.ramat_eivzur_betihuty) ? "" : `register=${R.ramat_eivzur_betihuty}`);
    { const low = ins.includes("רמת בטיחות נמוכה");
      check(c, "insight.safety_low", !low, low ? "רמת בטיחות נמוכה" : "(none)", "(none: the level is in the safety card, never a warning)", ""); }
    const zt = ((cardOf(P, "specs", /^סביבה$/) || {}).text || "").match(/קבוצת זיהום (\S+) מתוך 15/);
    oneOf("specs.pollution_group", zt ? zt[1] : "", Ws.map(w => firstPosE(R.kvutzat_zihum, w.kvutzat_zihum)), numS, E(R.kvutzat_zihum) ? "" : `register=${R.kvutzat_zihum}`);
    oneOf("specs.gearbox", spec("תיבת הילוכים"), Ws.map(w => E(w.automatic_ind) ? "" : String(w.automatic_ind).trim() === "1" ? "אוטומטית" : "ידנית"));
    oneOf("specs.mispar_dlatot", spec("דלתות"), Ws.map(w => Number(w.mispar_dlatot) > 0 ? w.mispar_dlatot : ""));   // 0 doors = no value, not shown
    oneOf("specs.merkav", spec("מרכב"), Ws.map(w => w.merkav));
    oneOf("specs.mispar_kariot_avir", spec("כריות אוויר"), Ws.map(w => firstPosE(w.mispar_kariot_avir)), numS);
    { const ev = t => t.includes("חשמל") && !t.includes("בנזין") && !t.includes("דיזל");
      oneOf("specs.co2", (spec("פליטת CO₂").match(/[\d.,]+/) || [""])[0], Ws.map(w => firstPosE(w.CO2_WLTP, w.kamut_CO2) ?? (ev(String(pickE(R.sug_delek_nm, w.delek_nm) || "")) && isN(w.CO2_WLTP) ? "0" : "")), numS); }
    { const d = spec("מסנן חלקיקים"), r = (X.sets.dpf || [])[0], ex = r ? "הותקן" + (E(r.taarich_hatkana) ? "" : " ב-" + fd(r.taarich_hatkana)) : "";
      if (X.sets.dpf && !X.errs.dpf) check(c, "specs.dpf", sp(d) === ex, d, ex || "(not shown)", ""); }
    oneOf("specs.importer", spec("יבואן"), imp ? [""] : importerMine(ofTypeR(X.price || [], R), R), sp, imp ? "personal import: none" : `price rows=${(X.price || []).length}`); }
  // registered changes (tech dataset flags) and other register facts
  { const mods = cardOf(P, "overview", /^שינויים ברכב$/), f = l => { const x = mods && mods.facts.find(([k]) => k === l); return x ? x[1] : ""; };
    for (const [l, k] of [["שינוי מבנה", "shinui_mivne_ind"], ["התקנת גפ״מ (גז)", "gapam_ind"], ["שינוי צבע", "shnui_zeva_ind"], ["שינוי מידת צמיגים", "shinui_zmig_ind"]]) {
      const ex = E(R[k]) ? "" : String(R[k]).trim() === "1" ? "כן" : "לא"; check(c, "mods." + k, sp(f(l)) === ex, f(l), ex, ""); }
    check(c, "specs.engine_model", sp(spec("דגם מנוע")) === sp(R.degem_manoa || ""), spec("דגם מנוע"), R.degem_manoa || "", "");
    check(c, "specs.vehicle_type", sp(spec("סוג רכב")) === sp(R.sug_rechev_nm || ""), spec("סוג רכב"), R.sug_rechev_nm || "", "");
    oneOf("specs.drive", spec("הנעה"), Ws.map(w => pickE(R.hanaa_nm, w.hanaa_nm)));
    if (imp) { const sy = factOf(P, "overview", /^רישוי וטסט$/, "סוג יבוא"); check(c, "status.import_type", sp(sy) === sp(R.sug_yevu || ""), sy, R.sug_yevu || "", ""); } }
  // licence fee: the model row's fee group, private cars only
  { const fee = N(dig(factOf(P, "overview", /^רישוי וטסט$/, "אגרת רישוי שנתית (הערכה)")));   // a row of "רישוי וטסט"; the price group is no longer shown
    const groups = [...new Set(W0.map(w => N(w.kvuzat_agra_cd)))].filter(x => FEE[x]), priv = String(R.sug_degem || "P").toUpperCase() === "P";
    const col = y >= 2024 ? 0 : y >= 2021 ? 1 : y >= 2017 ? 2 : 3;
    const exp = priv && groups.length && !isNaN(y) && !cancelled ? [...new Set(groups.map(gr => String(FEE[gr][col] + 135)))] : [];
    const shown = fee ? String(fee) : "";
    check(c, "fee.licence", exp.length ? exp.includes(shown) : !fee, shown || "(no fee)", exp.join(" or ") || "(no fee)", `kvuzat_agra_cd of the model row=${W0.map(w => w.kvuzat_agra_cd ?? "").join(",")} sug_degem=${R.sug_degem || ""} year=${y}`); }
  // list price and the value estimate: none for a personal import or a car off the road
  { const card = cardOf(P, "buy", /^שווי משוער$/) || {grid: [], notes: [], text: ""}, g = card.grid, sh = N(dig((g.find(x => x.k === "מחיר מחירון כחדש") || {}).v));
    const cand = imp || cancelled || isNaN(N(R.shnat_yitzur)) ? [] : priceMine(ofTypeR(X.price || [], R), R), ex = [...new Set(cand.map(x => N(x.r.mehir)))];
    check(c, "price.list", ex.length ? ex.includes(sh) : !sh, sh || "(none)", ex.join(" / ") || (imp ? "(none: a personal import)" : cancelled ? "(none: off the road)" : "(none)"), `price rows for model=${(X.price || []).length}, years=${[...new Set((X.price || []).map(r => r.shnat_yitzur))].sort().join(",")}`);
    if (sh) { const note = card.notes.some(t => /^מחיר המחירון לפי/.test(t)), expN = [...new Set(cand.filter(x => N(x.r.mehir) === sh).map(x => !x.own))];
      check(c, "price.borrowed_note", expN.includes(note), note ? "note shown" : "(none)", expN.map(b => b ? "note: the price of another year or type" : "(none)").join(" or "), cand.map(x => `${x.r.sug_degem || ""}/${x.r.shnat_yitzur}/${sp(x.r.ramat_gimur)}`).join(" | "));
      const vt = (g.find(x => /^שווי (משוער )?היום/.test(x.k)) || {}).v || "";
      check(c, "value.labelled_estimate", /הערכה בלבד/.test(card.text) && /\d+–\d+/.test(vt), vt + " / " + (card.notes.slice(-1)[0] || "").slice(0, 40), "range + 'הערכה בלבד'", ""); }
    else { const want = cancelled ? "הרכב ירד מהכביש, ולכן אין לו הערכת שווי." : imp ? "מחירון היבואן הרשמי לא חל על רכב ביבוא אישי, ולכן אין כאן מחיר מחירון והערכת שווי." : "אין במאגר מחיר מחירון לדגם הזה, ולכן אין הערכת שווי.";
      check(c, "value.fallback", sp(card.text) === want, sp(card.text).slice(0, 80), want, ""); } }
  // cars of this model and year on the road (modelstats, monthly) vs a live count of the active register
  { const ms = cardOf(P, "buy", /^איך הדגם הזה מחזיק$/), m = ms ? (ms.text.match(/\(([\d,]+) רכבים פעילים משנתון (\d{4})/) || null) : null;
    if (m && X.cohort != null) { const sh = N(m[1]); check(c, "counts.model_year_active", sh >= X.cohort * 0.85, sh, `>= ~${X.cohort} (active rows with kinuy_mishari="${R.kinuy_mishari}" and year ${y})`, "");
      if (sh > X.cohort * 2.5 + 50) NOTES.push(`${c.id}: "איך הדגם הזה מחזיק" counts ${sh} cars for ${sp(R.kinuy_mishari)} ${y}, of which ${X.cohort} carry this exact model name (variants folded together)`); } }
  // "partial data" message: a register that did not answer (the app asks the same ones, plus the tag list)
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
let audited = 0, skipped = [], infra = []; const CASE_MAKERS = new Set();
const act = cases.filter(c => c.from === "active"), rar = cases.filter(c => c.from !== "active"), order = [];
// the other registers' cars spread between the active ones, all before the last active ones, so the time limit never cuts a register out
const every = Math.max(1, Math.floor(act.length / (rar.length + 1)));
for (let i = 0, j = 0; i < act.length || j < rar.length; i++) { if (i < act.length) order.push(act[i]); if (j < rar.length && (i >= act.length || (i + 1) % every === 0)) order.push(rar[j++]); }
for (const c of order) {
  if (ONLY && !ONLY.has(c.id)) continue;
  if (Date.now() - T0 > BUDGET) { skipped.push(c.id); continue; }
  let P = await readPage(c.plate);
  if (P.net.bad.length) { LIMIT = Math.max(30, Math.round(LIMIT * 0.9)); console.log(`  ${c.id}: the ministry refused ${P.net.bad.length} of the app's ${P.net.n} requests (${[...new Set(P.net.bad)].join(",")}); cooling down 75s, limit now ${LIMIT}/min, opening it again`); cool(75000); P = await readPage(c.plate); }
  // the app's "the ministry does not answer" page after requests that failed in the browser (25.10.2026: 18 of 18 within a second, one car of 40):
  // a network blip between the runner and the ministry, not something the app shows wrong. Opened again once; twice in a row it counts as refused,
  // so many such cars still ring through "too few cars read"
  const blip = P => !!P.edge && /לא עונים/.test(P.edge) && P.net.failed > 0;
  if (blip(P)) { console.log(`  ${c.id}: the app could not reach the ministry (${P.net.failed} of ${P.net.n} requests failed in the browser); opening it again in 30s`); cool(30000); P = await readPage(c.plate); }
  let X; try { X = await raw(c); } catch (e) { console.log(`CASE ${c.id} ${mask(c.plate)} raw read failed: ${e.message}`); continue; }
  if (blip(P) && X.primary) { infra.push(c.id); console.log(`CASE ${c.id} ${mask(c.plate)} skipped: the app could not reach the ministry twice (${P.net.failed} of ${P.net.n} requests failed in the browser), while my reads did`); continue; }
  if (P.net.bad.length) { infra.push(c.id); cool(60000); console.log(`CASE ${c.id} ${mask(c.plate)} skipped: the ministry refused ${P.net.bad.length} of the app's requests again`); continue; }
  const R = X.R;
  if (P.edge) { const ln = `CASE ${c.id} ${mask(c.plate)} ${X.primary || "-"} page: ${P.edge.slice(0, 90)} | after ${Math.round(P.net.ms / 1000)}s, app requests=${P.net.n} failed-in-browser=${P.net.failed} | in my reads: ${Object.entries(X.sets).filter(([, r]) => r.length).map(([k]) => k).join(",") || "nothing"} errs: ${Object.keys(X.errs).join(",") || "-"}`; console.log(ln);
    check(c, "page.result", !X.primary, P.edge.slice(0, 60), X.primary ? `the car (found in ${X.primary})` : "not found", `after ${Math.round(P.net.ms / 1000)}s, ${P.net.n} app requests, ${P.net.failed} failed in the browser`); audited++; continue; }
  if (!E(R.tozeret_nm)) CASE_MAKERS.add(String(R.tozeret_nm).trim());
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
  // "distinct" on data.gov.il returns only part of the values, so the model catalogue is read whole (one field) and the audited cars are added
  for (let off = 0; off < 200000; off += 20000) {
    try { const r = await search(MODEL.wltp, {fields: "tozeret_nm", limit: 20000, offset: off}); for (const x of r.records) { const n = String(x.tozeret_nm || "").trim(); if (n && !names.has(n)) names.set(n, "active"); } if (r.records.length < 20000) break; }
    catch (e) { MAKERS_OUT.push(`makers model list at ${off}: ${e.message}`); break; } }
  for (const n of CASE_MAKERS) if (!names.has(n)) names.set(n, "active");
  if (coolUntil > Date.now()) await sleep(coolUntil - Date.now());
  await slot(16);
  const page = await ctx.newPage();
  page.on("request", r => { if (/data\.gov\.il/.test(r.url())) HITS.push(Date.now()); });
  await page.goto(BASE, {waitUntil: "domcontentloaded", timeout: 30000});
  await page.waitForFunction(() => typeof SETTLEMENTS !== "undefined" && typeof makeName === "function", null, {timeout: 30000});
  await page.evaluate(async () => { if (typeof loadSettlements === "function") await loadSettlements(); });   // the list comes from settlements.json since 1.35
  const res = await page.evaluate(list => {
    const pickF = (...a) => a.find(x => x != null && String(x).trim() !== "") || "";
    const Dof = n => { const v = {tozeret_nm: n}; return {v, make: makeName(v), price: null, modelRecalls: [], pick: pickF}; };
    return list.map(n => { const D = Dof(n), S = Dof(D.make);
      const imp = x => { try { return importerRecall(x).name; } catch (e) { return "error " + e.message; } };
      const tier = x => { try { return brandTier(x, false).k; } catch (e) { return "error"; } };
      const stl = x => SETTLEMENTS.filter(s => s.mk.test(normS(typeof makerOnly === "function" ? makerOnly(x) : [x.v.tozeret_nm, x.make].join(" ")))).map(s => s.id);
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

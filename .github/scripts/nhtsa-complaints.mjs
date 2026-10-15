// Builds complaints.json: owner complaints (NHTSA, US market) per registry model and model year, for the "known issues" card.
// Registry model = tozeret_cd|KINUY (same keys as modelstats.json). Maker + model names are matched to NHTSA's own model list
// (so a name is only ever sent to the API when NHTSA knows it for that year). Runs on a GitHub runner.
// Env: MIN_YEAR (default 2012), ONLY (comma list of NHTSA makes, for tests). Prints coverage: share of models and of active cars.
import fs from "node:fs";
const dict = JSON.parse(fs.readFileSync(new URL("./makers-dict.json", import.meta.url), "utf8"));
const ms = JSON.parse(fs.readFileSync("modelstats.json", "utf8")).m;
const MIN_YEAR = Number(process.env.MIN_YEAR || 2012), MAX_YEAR = new Date().getFullYear() + 1, ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;
const T0 = Date.now(), log = m => console.log(`[${Math.round((Date.now() - T0) / 1000)}s] ${m}`), sleep = ms => new Promise(r => setTimeout(r, ms));
const strip = s => String(s || "").replace(/[\s.'"׳״`\-_,]/g, "");
const alnum = s => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const MAKERS = Object.entries(dict.makers).map(([k, v]) => [strip(k), v]).sort((a, b) => b[0].length - a[0].length);
const makerOf = name => { const k = strip(name); const hit = MAKERS.find(([p]) => k.startsWith(p)); return hit ? {found: true, make: hit[1]} : {found: false, make: null}; };

// only 400/404 mean "no such vehicle"; a 403 block, 429 or 5xx is retried and finally thrown, never read as "no data"
async function api(path, params, tries = 5) {
  const u = "https://api.nhtsa.gov/" + path + "?" + new URLSearchParams(params);
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(u, {signal: AbortSignal.timeout(40000)}); if (r.ok) return (await r.json()).results || []; if (r.status === 400 || r.status === 404) return []; } catch {}
    await sleep(2000 * (i + 1));
  }
  throw new Error("NHTSA failed " + u.slice(0, 140));
}
async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({length: n}, async () => { while (i < items.length) { const it = items[i++]; await fn(it); } })); }

// 1. which models does NHTSA hold complaints for, per make and model year
const makes = [...new Set(Object.values(dict.makers).filter(Boolean))].filter(m => !ONLY || ONLY.has(m));
const known = {};   // make -> Map(alnum name -> {name, years:Set})
const jobs = []; for (const m of makes) { known[m] = new Map(); for (let y = MIN_YEAR; y <= MAX_YEAR; y++) jobs.push([m, y]); }
await pool(jobs, 4, async ([m, y]) => {
  for (const r of await api("products/vehicle/models", {modelYear: String(y), issueType: "c", make: m})) {
    const k = alnum(r.model), e = known[m].get(k) || {name: r.model, years: new Set()}; e.years.add(y); known[m].set(k, e);
  }
  await sleep(100);
});
log("NHTSA models: " + makes.map(m => m + " " + known[m].size).join(", "));

// 2. match a registry model to an NHTSA model
const DROP = new Set(dict.dropTokens);
function matchModel(make, kinuy) {
  const raw = String(kinuy || "").toUpperCase().trim(); if (!raw) return null;
  const K = known[make], al = dict.aliases[make] || {};
  const pick = k => K.get(alnum(k)) || null;
  if (make === "BMW") { const m = raw.match(/^([1-8])\d\d/); if (m) return pick(m[1] + " SERIES"); }
  if (make === "MERCEDES-BENZ") { const m = raw.match(/^(CLA|CLS|GLA|GLB|GLC|GLE|GLS|[ABCES])\s?\d{3}/); if (m) return pick(m[1] + "-CLASS") || pick(m[1] + " CLASS") || pick(m[1]); }
  const toks = raw.split(/[\s\/]+/).filter(Boolean);
  // the registry often repeats the maker inside the model name ("MAZDA CX-5", "TOYOTA C-HR", "LEXUS NX350H")
  while (toks.length > 1 && (toks[0] === make || make.startsWith(toks[0] + "-"))) toks.shift();
  // Lexus/Infiniti/Acura names carry the engine ("NX350H", "IS300"): NHTSA lists the family ("NX")
  if (["LEXUS", "INFINITI", "ACURA"].includes(make) && /^[A-Z]{2,3}\d{3}[A-Z]?$/.test(toks[0])) toks[0] = toks[0].replace(/\d.*$/, "");
  while (toks.length > 1 && DROP.has(toks[toks.length - 1])) toks.pop();
  for (let n = toks.length; n >= 1; n--) {      // longest name first: "COROLLA CROSS" before "COROLLA"
    const key = alnum(toks.slice(0, n).join(" "));
    if (al[key]) { const hit = pick(al[key]); if (hit) return hit; }
    const hit = K.get(key); if (hit) return hit;
  }
  return null;
}

// 3. cohorts to fetch
const COMP_HE_SKIP = new Set(["UNKNOWN OR OTHER"]);
const comps = [], compIx = c => { let i = comps.indexOf(c); if (i < 0) { comps.push(c); i = comps.length - 1; } return i; };
const out = {}, todo = [];
let wAll = 0, wCov = 0, wRecent = 0, wRecentCov = 0, nCov = 0; const miss = [], perMaker = {};
for (const [key, m] of Object.entries(ms)) {
  const kinuy = key.split("|")[1], mk = makerOf(m.name);
  const recent = Object.entries(m.y).filter(([y]) => Number(y) >= 2016).reduce((s, [, v]) => s + v[0], 0);
  wAll += m.total; wRecent += recent;
  const pm = perMaker[m.name.split(" ")[0]] ||= {w: 0, c: 0}; pm.w += recent;
  if (!mk.make || (ONLY && !ONLY.has(mk.make))) { if (mk.found === false) miss.push(["(maker?) " + m.name + " " + kinuy, recent]); continue; }
  const hit = matchModel(mk.make, kinuy);
  if (!hit) { miss.push([m.name + " " + kinuy, recent]); continue; }
  wCov += m.total; wRecentCov += recent; nCov++; pm.c += recent;
  out[key] = {mk: mk.make, md: hit.name, y: {}}; for (const y of hit.years) todo.push([key, mk.make, hit.name, y]);
}
if (nCov < 150 && !ONLY) throw new Error(`only ${nCov} models matched: NHTSA lists look incomplete (blocked or rate limited?), keeping the previous complaints.json`);
log(`matched models ${nCov}/${Object.keys(ms).length}; active cars ${(100 * wCov / wAll).toFixed(1)}% (all years), ${(100 * wRecentCov / wRecent).toFixed(1)}% (2016+ cohorts)`);
console.log("coverage per maker (2016+ cars):", Object.entries(perMaker).filter(([, v]) => v.w > 20000).sort((a, b) => b[1].w - a[1].w).map(([k, v]) => `${k} ${Math.round(100 * v.c / v.w)}%/${Math.round(v.w / 1000)}k`).join(" | "));
console.log("largest unmatched:", miss.sort((a, b) => b[1] - a[1]).slice(0, 45).map(([n, w]) => `${n} ${Math.round(w / 1000)}k`).join(" | "));

// 4. complaints per (model, year)
let failed = 0;
await pool(todo, 3, async ([key, make, model, y]) => {
  try {
    const rows = await api("complaints/complaintsByVehicle", {make, model, modelYear: String(y)});
    if (!rows.length) return;
    const c = new Map(); for (const r of rows) for (const x of new Set(String(r.components || "").split(",").map(s => s.trim()).filter(Boolean))) if (!COMP_HE_SKIP.has(x)) c.set(x, (c.get(x) || 0) + 1);
    out[key].y[y] = [rows.length, rows.filter(r => r.crash).length, rows.filter(r => r.fire).length, rows.reduce((s, r) => s + (r.numberOfInjuries || 0), 0), rows.reduce((s, r) => s + (r.numberOfDeaths || 0), 0),
      [...c].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([n, k]) => [compIx(n), k])];
  } catch (e) { failed++; out[key].fail = 1; }
  await sleep(250);
});
for (const k of Object.keys(out)) if (!Object.keys(out[k].y).length) delete out[k];
fs.mkdirSync("out", {recursive: true});
const res = {updated: new Date().toISOString().slice(0, 10), source: "NHTSA owner complaints (US market)", cols: ["n", "crash", "fire", "injuries", "deaths", "top"], comps, m: out};
fs.writeFileSync("out/complaints.json", JSON.stringify(res));
log(`complaints.json: ${Object.keys(out).length} models, ${(JSON.stringify(res).length / 1024).toFixed(0)} KB, failed calls ${failed}`);
const ex = out["413|COROLLA"]; if (ex) console.log("sample", JSON.stringify(ex).slice(0, 500));

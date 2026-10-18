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
let reqN = 0;
async function call(act, params, {tries = 4, quiet = false} = {}) {
  let last;
  for (let a = 0; a < tries; a++) {
    await sleep(250);
    reqN++;
    try {
      const r = await fetch(API + act + "?" + new URLSearchParams(params), {headers: {Accept: "application/json", "User-Agent": "luchit-data-audit/1.0"}, signal: AbortSignal.timeout(60000)});
      if (r.status === 429 || r.status >= 500) { last = new Error("HTTP " + r.status); await sleep(3000 * (a + 1)); continue; }
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

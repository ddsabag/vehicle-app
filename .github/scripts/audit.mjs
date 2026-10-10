// Audit: every dataset id the app and workers use (rows, fields, a lookup for a known plate) and every external link in the app
import fs from "node:fs"; import path from "node:path";
const API = "https://data.gov.il/api/3/action/";
const files = [];
(function walk(d){ for (const f of fs.readdirSync(d, {withFileTypes: true})) { if (["node_modules", ".git", "out", "model"].includes(f.name)) continue; const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (/\.(html|java|kt|kts|mjs|js|yml)$/.test(f.name)) files.push(p); } })(".");
const ids = new Map(), urls = new Map();
for (const f of files) {
  const t = fs.readFileSync(f, "utf8");
  for (const m of t.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)) (ids.get(m[0]) || ids.set(m[0], new Set()).get(m[0])).add(f);
  if (/index\.html$|privacy\.html$/.test(f) || f.endsWith(".java")) for (const m of t.matchAll(/https?:\/\/[^\s"'`<>)\\]+/g)) { const u = m[0].replace(/[.,;]+$/, ""); (urls.get(u) || urls.set(u, new Set()).get(u)).add(f); }
}
const PLATE = 38548003;
console.log("== DATASETS", ids.size);
for (const [id, fs_] of ids) {
  const out = {id, used: [...fs_].join(",")};
  try {
    const j = await (await fetch(API + "datastore_search?limit=1&resource_id=" + id, {signal: AbortSignal.timeout(40000)})).json();
    out.ok = j.success; out.total = j.result?.total; out.fields = (j.result?.fields || []).map(f => f.id).filter(x => x !== "_id").slice(0, 60).join(",");
    if (j.success && out.fields.split(",").includes("mispar_rechev")) {
      const k = await (await fetch(API + "datastore_search?limit=1&resource_id=" + id + "&filters=" + encodeURIComponent(JSON.stringify({mispar_rechev: PLATE})))).json();
      out.plateRows = k.result?.total;
    }
    if (!j.success) out.err = JSON.stringify(j.error).slice(0, 200);
  } catch (e) { out.err = String(e.message || e); }
  console.log(JSON.stringify(out));
}
console.log("== LINKS", urls.size);
for (const [u, f_] of urls) {
  if (/\$\{|\{|%s/.test(u) || /w3\.org|schema\.org|googleapis\.com\/css|gstatic|localhost|\.\.\.$/.test(u)) continue;
  try {
    const r = await fetch(u, {redirect: "follow", signal: AbortSignal.timeout(25000), headers: {"user-agent": "Mozilla/5.0 (Linux; Android 14) Chrome/124 Mobile Safari/537.36"}});
    console.log(r.status, u, r.url !== u ? "-> " + r.url : "", [...f_].map(x => path.basename(x)).join(","));
  } catch (e) { console.log("ERR", u, String(e.cause?.code || e.message), [...f_].map(x => path.basename(x)).join(",")); }
}

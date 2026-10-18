// Daily snapshot of the ministry datasets the app reads: size and last update, written to status.json
// Run by Ministry watch right after its health check (data-health-check.mjs). SEEN (optional JSON, that check's step output) carries what the check
// already read, so a dataset is not asked twice: { <key>: { id, tries, ok, total, modified } }, tries = unfiltered datastore_search reads made,
// ok/total = from the first that found rows (else the last), modified = the resource_show answer (absent when that read failed).
// Whatever is missing, or a dataset that has not been seen with rows in 3 reads, is read here as before; without SEEN everything is.
// The output (out/status.json, same keys and format as always) is published on the data-status branch, which index.html reads.
import { writeFileSync, mkdirSync } from "node:fs";
const API = "https://data.gov.il/api/3/action/";
const SETS = {
  active: "053cea08-09bc-40ec-8f7a-156f0677aff3",
  tech: "56063a99-8a3e-4ff4-912e-5966c0279bad",
  owners: "bb2355dc-9ec7-4f06-9c3f-3344672171da",
  recalls: "36bf1404-0be4-49d2-82dc-2f1ead4a8b93",
  wltp: "142afde2-6228-49f9-8a29-9b6c3a0cbe40",
};
let seen = {};
try { seen = JSON.parse(process.env.SEEN || "{}") || {}; } catch { console.log("SEEN is not JSON, reading every dataset"); }
const out = { checked: new Date().toISOString(), sets: {} };
for (const [k, id] of Object.entries(SETS)) {
  const p = seen[k] && typeof seen[k] === "object" && seen[k].id === id ? seen[k] : {};
  const s = { ok: p.ok === true, total: Number.isFinite(p.total) ? p.total : 0, modified: null };
  // the ministry reloads these tables overnight and a read can briefly return 0 rows: look again a few times before calling a dataset down
  for (let i = Math.min(Math.max(Number(p.tries) || 0, 0), 3); i < 3 && !s.ok; i++) {
    if (i) await new Promise(r => setTimeout(r, 20000));
    try {
      const j = await (await fetch(API + "datastore_search?limit=0&resource_id=" + id, { signal: AbortSignal.timeout(30000) })).json();
      s.total = j?.result?.total ?? 0; s.ok = !!j.success && s.total > 0;
    } catch {}
  }
  if ("modified" in p) s.modified = typeof p.modified === "string" && p.modified ? p.modified : null;
  else try {
    const j = await (await fetch(API + "resource_show?id=" + id, { signal: AbortSignal.timeout(30000) })).json();
    s.modified = j?.result?.last_modified || j?.result?.metadata_modified || null;
  } catch {}
  out.sets[k] = s; console.log(k, s, "modified" in p || p.tries ? "(partly from the health check)" : "");
}
mkdirSync("out", { recursive: true });
writeFileSync("out/status.json", JSON.stringify(out));

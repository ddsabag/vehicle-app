// Daily snapshot of the ministry datasets the app reads: size and last update, written to status.json
import { writeFileSync, mkdirSync } from "node:fs";
const API = "https://data.gov.il/api/3/action/";
const SETS = {
  active: "053cea08-09bc-40ec-8f7a-156f0677aff3",
  tech: "56063a99-8a3e-4ff4-912e-5966c0279bad",
  owners: "bb2355dc-9ec7-4f06-9c3f-3344672171da",
  recalls: "36bf1404-0be4-49d2-82dc-2f1ead4a8b93",
  wltp: "142afde2-6228-49f9-8a29-9b6c3a0cbe40",
};
const out = { checked: new Date().toISOString(), sets: {} };
for (const [k, id] of Object.entries(SETS)) {
  const s = { ok: false, total: 0, modified: null };
  try {
    const j = await (await fetch(API + "datastore_search?limit=0&resource_id=" + id, { signal: AbortSignal.timeout(30000) })).json();
    s.total = j?.result?.total ?? 0; s.ok = !!j.success && s.total > 0;
  } catch {}
  try {
    const j = await (await fetch(API + "resource_show?id=" + id, { signal: AbortSignal.timeout(30000) })).json();
    s.modified = j?.result?.last_modified || j?.result?.metadata_modified || null;
  } catch {}
  out.sets[k] = s; console.log(k, s);
}
mkdirSync("out", { recursive: true });
writeFileSync("out/status.json", JSON.stringify(out));

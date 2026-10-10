// Daily check that the ministry datasets the app depends on still answer with rows
const API = "https://data.gov.il/api/3/action/datastore_search";
const SETS = {
  "רכבים פעילים": ["053cea08-09bc-40ec-8f7a-156f0677aff3", "mispar_rechev", 38548003],
  "היסטוריית בעלויות": ["bb2355dc-9ec7-4f06-9c3f-3344672171da", "mispar_rechev", 38548003],
  "היסטוריית טכני": ["56063a99-8a3e-4ff4-912e-5966c0279bad", "mispar_rechev", 38548003],
  "ריקולים": ["36bf1404-0be4-49d2-82dc-2f1ead4a8b93", null, null],
  "מפרט WLTP": ["142afde2-6228-49f9-8a29-9b6c3a0cbe40", null, null],
};
let bad = [];
for (const [name, [id, key, val]] of Object.entries(SETS)) {
  try {
    const q = new URLSearchParams({ resource_id: id, limit: "1" });
    if (key) q.set("filters", JSON.stringify({ [key]: val }));
    const r = await fetch(API + "?" + q, { signal: AbortSignal.timeout(30000) });
    const j = await r.json();
    const n = j?.result?.total ?? 0;
    console.log(name, r.status, "total", n);
    if (!j.success || n === 0) bad.push(name);
  } catch (e) { console.log(name, "ERROR", e.message); bad.push(name); }
}
if (bad.length) { console.log("EMPTY_OR_FAILED:", bad.join(", ")); process.exitCode = 1; }
// also report the unfiltered totals so an empty dataset is told apart from an unknown plate
for (const [name, [id]] of Object.entries(SETS)) {
  const j = await (await fetch(API + "?resource_id=" + id + "&limit=0")).json();
  console.log("unfiltered", name, j?.result?.total);
}

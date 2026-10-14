// One-off probe of the active vehicle register (runs on GitHub; data.gov.il is not reachable from the dev container).
const API = "https://data.gov.il/api/3/action/", id = "053cea08-09bc-40ec-8f7a-156f0677aff3";
const get = async (a, p) => { const r = await fetch(API + a + "?" + new URLSearchParams(p), { headers: { "user-agent": "luchit-probe/1.0" } }); const t = await r.text(); try { return JSON.parse(t); } catch { return { http: r.status, body: t.slice(0, 200) }; } };
const a = await get("datastore_search", { resource_id: id, limit: "1" });
console.log("total:", a.result && a.result.total, "sample:", JSON.stringify(a.result && a.result.records && a.result.records[0]).slice(0, 300), a.http || "");
const b = await get("datastore_search", { resource_id: id, filters: JSON.stringify({ shnat_yitzur: 2018 }), limit: "1", offset: "500" });
console.log("2018 offset500:", JSON.stringify(b.result && b.result.records && b.result.records.length), b.error ? JSON.stringify(b.error) : "", b.http || "");
for (const p of ["38548003", 38548003]) { const c = await get("datastore_search", { resource_id: id, filters: JSON.stringify({ mispar_rechev: p }), limit: "1" }); console.log("plate", typeof p, c.result && c.result.total, c.http || ""); }
const m = await get("resource_show", { id }); console.log("modified:", m.result && m.result.last_modified, m.result && m.result.metadata_modified);

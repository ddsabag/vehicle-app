// One-off (data thread, 11.11.2026): the public descriptions of the ministry's vehicle registers (what they say about vehicles left out)
const API = "https://data.gov.il/api/3/action/";
const get = async (act, p) => { const r = await fetch(API + act, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "luchit-probe/1.0" }, body: JSON.stringify(p) }); return r.ok ? r.json() : null; };
for (const id of ["053cea08-09bc-40ec-8f7a-156f0677aff3", "f6efe89a-fb3d-43a4-bb61-9bf12a9b9099", "851ecab1-0622-4dbe-a6c7-f950cf82abf9"]) {
  const r = await get("resource_show", { id }); const pid = r && r.result && r.result.package_id;
  const p = pid && await get("package_show", { id: pid });
  console.log("=== " + id + " | " + (p && p.result && p.result.title));
  console.log("NOTES: " + (p && p.result && p.result.notes || "").replace(/\s+/g, " "));
  console.log("RES: " + ((r && r.result && r.result.description) || "").replace(/\s+/g, " "));
  console.log("LICENSE: " + (p && p.result && (p.result.license_title || p.result.license_id)));
  for (const e of (p && p.result && p.result.extras) || []) console.log("EXTRA " + e.key + ": " + String(e.value).replace(/\s+/g, " ").slice(0, 400));
}

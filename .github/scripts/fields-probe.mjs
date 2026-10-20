// One-off (probe-go branch, not for main), 20.10: the ministry's own labels for the WLTP and register columns about safety (data dictionary).
const API = "https://data.gov.il/api/3/action/";
for (const [name, id] of [["wltp", "142afde2-6228-49f9-8a29-9b6c3a0cbe40"], ["active", "053cea08-09bc-40ec-8f7a-156f0677aff3"]]) {
  const r = await (await fetch(API + "datastore_search?resource_id=" + id + "&limit=0")).json();
  console.log("==", name, "fields:", r.result.fields.length);
  for (const f of r.result.fields) if (/ind$|_s$|betih|kariot|nikud|blim|bakar|zihuy|hitnag|isa|hayshan|teura|shlita|matzlem|nitur|maarechet/i.test(f.id)) console.log(f.id, "|", f.type, "|", JSON.stringify(f.info || null));
  const rs = await (await fetch(API + "resource_show?id=" + id)).json();
  console.log("resource:", rs.result && rs.result.name, "| last_modified", rs.result && rs.result.last_modified, "| description", String(rs.result && rs.result.description || "").replace(/\s+/g, " ").slice(0, 600));
}

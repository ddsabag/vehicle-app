// Probe: are there old copies of the registers (Wayback Machine, older CKAN resources) to compare against today?
const j = async (u, t = 4) => { for (let i = 0; i < t; i++) { try { const r = await fetch(u, {signal: AbortSignal.timeout(90000)}); const s = await r.text(); return {status: r.status, s}; } catch (e) { await new Promise(r => setTimeout(r, 3000)); } } return {status: 0, s: ""}; };
const IDS = {active: "053cea08-09bc-40ec-8f7a-156f0677aff3", inactive1: "f6efe89a-fb3d-43a4-bb61-9bf12a9b9099", inactive2: "6f6acd03-f351-4a8f-8ecf-df792f4f573a", cancel1: "851ecab1-0622-4dbe-a6c7-f950cf82abf9"};
for (const [k, id] of Object.entries(IDS)) {
  const r = await j(`https://data.gov.il/api/3/action/resource_show?id=${id}`);
  let pkg = ""; try { const x = JSON.parse(r.s).result; pkg = x.package_id; console.log(`\n== ${k}: url=${x.url} created=${x.created} modified=${x.last_modified} size=${x.size}`); } catch { console.log(k, "resource_show", r.status); }
  if (pkg) {
    const p = await j(`https://data.gov.il/api/3/action/package_show?id=${pkg}`);
    try { const x = JSON.parse(p.s).result; console.log(`package ${x.name}: ${x.resources.length} resources`); for (const res of x.resources) console.log(`  ${res.id} ${res.name} ${res.format} created=${res.created} modified=${res.last_modified} size=${res.size} url=${res.url}`); } catch { console.log("package_show", p.status); }
    const a = await j(`https://data.gov.il/api/3/action/package_activity_list?id=${pkg}&limit=10`);
    console.log("activity:", a.status, a.s.slice(0, 600));
  }
  for (const pat of [`data.gov.il/dataset/*${id}*`, `data.gov.il/api/3/action/datastore_search?resource_id=${id}*`, `e.data.gov.il/*${id}*`]) {
    const c = await j(`https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(pat)}&output=txt&limit=40&fl=timestamp,original,mimetype,length,statuscode`);
    console.log(`wayback ${pat}: ${c.status}\n${c.s.slice(0, 2500)}`);
  }
}

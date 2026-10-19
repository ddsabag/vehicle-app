// when did the ministry last update the per-car unfixed-recall list and the recall list (data.gov.il metadata), and how far each reaches
const IDS = {"per-car (כלי רכב שלא ביצעו ריקול)": "36bf1404-0be4-49d2-82dc-2f1ead4a8b93"};
const A = "https://data.gov.il/api/3/action/";
const j = async u => { const r = await fetch(u, {signal: AbortSignal.timeout(30000)}); return r.json(); };
for (const [n, id] of Object.entries(IDS)) {
  try {
    const r = (await j(`${A}resource_show?id=${id}`)).result;
    console.log(n, "| last_modified", r.last_modified, "| metadata_modified", r.metadata_modified, "| created", r.created, "| package", r.package_id);
    const p = (await j(`${A}package_show?id=${r.package_id}`)).result;
    console.log("  package:", p.title, "| metadata_modified", p.metadata_modified, "| maintainer", p.maintainer, p.maintainer_email || "", "| author", p.author, p.author_email || "", "| org", p.organization && p.organization.title);
    for (const x of p.resources || []) console.log("  resource:", x.id, x.name, "| last_modified", x.last_modified, "| format", x.format);
    const s = await j(`${A}datastore_search?resource_id=${id}&limit=1&sort=RECALL_ID desc`);
    console.log("  total rows", s.result && s.result.total, "| max RECALL_ID row", JSON.stringify(s.result && s.result.records && s.result.records[0]).slice(0, 300));
  } catch (e) { console.log(n, "ERR", e.message); }
}
const rl = await j(`${A}package_search?q=${encodeURIComponent("ריקול")}&rows=10`).catch(() => null);
for (const p of (rl && rl.result && rl.result.results) || []) console.log("search:", p.title, "|", p.metadata_modified, "|", (p.resources || []).map(x => x.id + " " + x.last_modified).join(" ; "));

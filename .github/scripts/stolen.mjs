const t = async (u, o) => { try { const r = await fetch(u, { ...o, redirect: "follow", signal: AbortSignal.timeout(30000), headers: { "user-agent": "Mozilla/5.0" } }); const b = await r.text(); return { s: r.status, ct: r.headers.get("content-type"), len: b.length, head: b.slice(0, 300).replace(/\s+/g, " "), b }; } catch (e) { return { s: "ERR " + e.message }; } };
for (const q of ["גנוב", "רכב גנוב", "גניבות רכב", "stolen"]) {
  const r = await t("https://data.gov.il/api/3/action/package_search?rows=20&q=" + encodeURIComponent(q));
  let j; try { j = JSON.parse(r.b); } catch {}
  console.log("SEARCH", q, r.s, j?.result?.count);
  for (const p of j?.result?.results || []) console.log("  -", p.title, "|", p.organization?.title, "|", p.name, "| res:", (p.resources || []).map(x => x.format).join(","));
}
for (const u of ["https://www.police.gov.il/", "https://www.gov.il/he/service/vehicle-stolen-check", "https://www.gov.il/he/departments/policies/stolen-vehicle-check", "https://car.cma.gov.il/"]) {
  const r = await t(u); console.log("URL", u, r.s, r.ct, r.len, r.head);
}

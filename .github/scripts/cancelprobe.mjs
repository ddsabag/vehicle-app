// Probe the three "off the road" datasets with real plates, in the query forms the app uses
const API = "https://data.gov.il/api/3/action/datastore_search";
const IDS = {cancel: "851ecab1-0622-4dbe-a6c7-f950cf82abf9", c2010: "4e6b9724-4c1e-43f0-909a-154d4cc4e046", c2000: "ec8cbc34-72e1-4b69-9c48-22821ba0bd6c"};
async function get(params) { const t = Date.now(); try { const r = await fetch(API + "?" + new URLSearchParams(params), {signal: AbortSignal.timeout(60000)}); const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch {} return {status: r.status, ct: r.headers.get("content-type"), ms: Date.now() - t, ok: j?.success, total: j?.result?.total, body: j ? "" : txt.slice(0, 120).replace(/\s+/g, " "), rec: j?.result?.records}; } catch (e) { return {err: String(e.message), ms: Date.now() - t}; } }
for (const [name, id] of Object.entries(IDS)) {
  const s = await get({resource_id: id, limit: "3", offset: "5000"});
  console.log(name, "sample", s.status, s.ok, s.total, (s.rec || []).map(r => r.mispar_rechev + ":" + typeof r.mispar_rechev).join(","));
  const plates = (s.rec || []).map(r => r.mispar_rechev);
  for (const p of plates.slice(0, 2)) for (const form of [String(p), Number(p)]) for (let i = 0; i < 2; i++) {
    const q = await get({resource_id: id, filters: JSON.stringify({mispar_rechev: form}), limit: "100"});
    console.log(name, typeof form, p, JSON.stringify({status: q.status, ct: q.ct, ms: q.ms, ok: q.ok, total: q.total, body: q.body, err: q.err}));
  }
}

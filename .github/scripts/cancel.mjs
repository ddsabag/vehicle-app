const API = "https://data.gov.il/api/3/action/datastore_search";
const get = async p => (await (await fetch(API + "?" + new URLSearchParams(p))).json()).result;
for (const [n, id] of [["cancel", "851ecab1-0622-4dbe-a6c7-f950cf82abf9"], ["cancel2010", "4e6b9724-4c1e-43f0-909a-154d4cc4e046"], ["cancel2000", "ec8cbc34-72e1-4b69-9c48-22821ba0bd6c"], ["inactive", "f6efe89a-fb3d-43a4-bb61-9bf12a9b9099"], ["inactive2", "6f6acd03-f351-4a8f-8ecf-df792f4f573a"]]) {
  try {
    const r = await get({resource_id: id, limit: "30000"});
    console.log(`\n### ${n} total=${r.total}\nfields: ${r.fields.map(f => f.id + (f.info && f.info.notes ? "(" + f.info.notes + ")" : "")).join(", ")}`);
    console.log(r.records.slice(0, 3).map(x => JSON.stringify(x)).join("\n"));
    for (const f of r.fields.map(x => x.id)) {
      if (/sibat|sibah|reason|bitul|ptira|sug_|status|_nm$/i.test(f) && !/tozeret|degem|kinuy|tzeva|delek/i.test(f)) {
        const c = {}; for (const x of r.records) c[x[f]] = (c[x[f]] || 0) + 1;
        const top = Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 15);
        if (top.length > 1 && top.length < 60) console.log(`values of ${f}: ${top.map(([k, v]) => k + "=" + v).join(" | ")}`);
      }
    }
  } catch (e) { console.log(n, "ERR", e.message); }
}

// Prints fields, size and a few rows of the given data.gov.il resources (IDS env, comma separated)
const API = "https://data.gov.il/api/3/action/datastore_search";
for (const id of (process.env.QUERIES || "").split(",").filter(Boolean)) {
  try {
    const r = (await (await fetch(API + "?" + new URLSearchParams({resource_id: id, limit: "4"}), {signal: AbortSignal.timeout(60000)})).json()).result;
    console.log("\n##", id, "total", r.total, "\nfields", r.fields.map(f => f.id + ":" + f.type).join(" | "));
    for (const x of r.records) console.log(JSON.stringify(x).slice(0, 500));
  } catch (e) { console.log("##", id, "failed", e.message); }
}

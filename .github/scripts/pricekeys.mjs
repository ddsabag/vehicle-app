import fs from "node:fs";
const API = "https://data.gov.il/api/3/action/datastore_search";
const out = [];
for (const id of ["39f455bf-6db0-4926-859d-017f34eacbcb", "142afde2-6228-49f9-8a29-9b6c3a0cbe40"]) {
  const r = await (await fetch(API + "?" + new URLSearchParams({resource_id: id, limit: "3", q: "TUCSON"}))).json();
  out.push(id, JSON.stringify(r.result.fields.map(f => f.id)), JSON.stringify(r.result.records.slice(0, 2)));
}
fs.mkdirSync("out", {recursive: true}); fs.writeFileSync("out/report.txt", out.join("\n"));

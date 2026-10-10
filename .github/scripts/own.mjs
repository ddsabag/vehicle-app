import { createInterface } from "node:readline";
import { Readable } from "node:stream";
const ID = "bb2355dc-9ec7-4f06-9c3f-3344672171da", PKG = "273c5e33-25ab-4980-8522-a2f7ba0bb62d", P = (process.env.PLATES || "38548003").split(",")[0].trim();
const H = { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36", accept: "text/csv,*/*", "accept-language": "he,en;q=0.8" };
const J = async (u, h = H) => { try { const r = await fetch(u, { headers: h }); return { r, text: r.headers.get("content-type")?.includes("json") || r.headers.get("content-type")?.includes("text") ? (await r.text()).slice(0, 3000) : "" }; } catch (e) { return { r: { status: 0, headers: new Map() }, text: String(e) }; } };
let x = await J("https://data.gov.il/api/3/action/package_show?id=" + PKG);
try { const pk = JSON.parse(x.text.length < 3000 ? x.text : await (await fetch("https://data.gov.il/api/3/action/package_show?id=" + PKG, { headers: H })).text()); console.log("package:", pk.result.title, pk.result.metadata_modified); for (const rs of pk.result.resources) console.log(" res", rs.id, rs.name, rs.format, rs.last_modified, rs.datastore_active, rs.url); } catch (e) { console.log("package_show failed", x.r.status, x.text.slice(0, 300)); }
const urls = [
  "https://data.gov.il/dataset/" + PKG + "/resource/" + ID + "/download/" + ID + ".csv",
  "https://e.data.gov.il/dataset/" + PKG + "/resource/" + ID + "/download/" + ID + ".csv",
  "https://data.gov.il/api/3/action/datastore_search?resource_id=" + ID + "&limit=1",
  "https://data.gov.il/dataset/" + PKG + "/resource/" + ID + "/download/" + ID + ".csv?x=1",
];
for (const u of urls) { const y = await J(u); console.log("GET", u, y.r.status, y.r.headers.get("content-type"), y.r.headers.get("content-length"), (y.text || "").slice(0, 120).replace(/\n/g, " ")); }
const res = await fetch(urls[0], { headers: H });
if (res.ok && !String(res.headers.get("content-type")).includes("html")) {
  const rl = createInterface({ input: Readable.fromWeb(res.body) }); let n = 0; const head = [], hit = [];
  for await (const line of rl) { n++; if (n <= 3) head.push(line); if (line.includes(P)) hit.push(line); }
  console.log("csv lines", n, JSON.stringify(head), "hits", JSON.stringify(hit.slice(0, 10)));
}

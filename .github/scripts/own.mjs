// probe: is the ownership-history resource empty in the datastore, and does its CSV still hold the data?
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
const ID = "bb2355dc-9ec7-4f06-9c3f-3344672171da", PLATES = (process.env.PLATES || "38548003").split(",").map(s => s.trim());
const J = async u => { try { const r = await fetch(u, { headers: { "user-agent": "Mozilla/5.0" } }); const t = await r.text(); return { status: r.status, text: t }; } catch (e) { return { status: 0, text: String(e) }; } };
const base = "https://data.gov.il/api/3/action/";
let r = await J(base + "datastore_search?resource_id=" + ID + "&limit=2");
console.log("datastore limit=2:", r.status, r.text.slice(0, 600));
for (const p of PLATES) { r = await J(base + "datastore_search?resource_id=" + ID + "&filters=" + encodeURIComponent(JSON.stringify({ mispar_rechev: Number(p) })) + "&limit=20"); console.log("plate", p, r.status, r.text.slice(0, 600)); }
r = await J(base + "resource_show?id=" + ID);
console.log("resource_show:", r.status, r.text.slice(0, 1500));
let url = ""; try { url = JSON.parse(r.text).result.url; } catch {}
console.log("csv url:", url);
if (url) {
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
  console.log("csv status", res.status, res.headers.get("content-length"), res.headers.get("content-type"), res.headers.get("last-modified"));
  if (res.ok) {
    const rl = createInterface({ input: Readable.fromWeb(res.body) });
    let n = 0; const found = {}, head = [];
    for await (const line of rl) {
      n++; if (n <= 4) head.push(line);
      for (const p of PLATES) if (line.includes(p)) (found[p] ||= []).push(line);
    }
    console.log("csv lines", n, "head", JSON.stringify(head));
    console.log("matches", JSON.stringify(found));
  }
}

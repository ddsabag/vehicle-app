// Mirrors the ministry's ownership-history file (resource bb2355dc…) into small static shards the app can fetch
// when the ministry's datastore API returns nothing. Shard = last three digits of the plate (without leading zeros).
// Line format in a shard: plate|yyyymm:type,yyyymm:type  (type = index into meta.json "types"), oldest first.
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { mkdirSync, writeFileSync } from "node:fs";
const ID = "bb2355dc-9ec7-4f06-9c3f-3344672171da", PKG = "273c5e33-25ab-4980-8522-a2f7ba0bb62d";
const URL_ = process.env.CSV_URL || `https://data.gov.il/dataset/${PKG}/resource/${ID}/download/${ID}.csv`;
const OUT = process.env.OUT || "own-out";
const H = { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36", accept: "text/csv,*/*" };
const res = await fetch(URL_, { headers: H });
if (!res.ok || String(res.headers.get("content-type")).includes("html")) throw new Error("csv download failed: " + res.status + " " + res.headers.get("content-type"));
const types = [], typeIdx = new Map();
const shards = new Map();          // shard -> Map(plate -> [[ym, type]])
let n = 0, bad = 0;
const rl = createInterface({ input: Readable.fromWeb(res.body), crlfDelay: Infinity });
for await (const line of rl) {
  if (++n === 1) { if (!/mispar_rechev/.test(line)) throw new Error("unexpected header: " + line.slice(0, 80)); continue; }
  const f = line.split("|").map(s => s.replace(/^"|"$/g, ""));
  if (f.length < 3 || !/^\d+$/.test(f[0]) || !/^\d{6}$/.test(f[1])) { bad++; continue; }
  const plate = String(Number(f[0])), t = f[2].trim();
  let ti = typeIdx.get(t); if (ti === undefined) { ti = types.length; types.push(t); typeIdx.set(t, ti); }
  const key = plate.slice(-3).padStart(3, "0");
  let m = shards.get(key); if (!m) shards.set(key, m = new Map());
  let a = m.get(plate); if (!a) m.set(plate, a = []);
  a.push([f[1], ti]);
}
if (n < 1e6 || bad > n * 0.01) throw new Error(`implausible file: ${n} lines, ${bad} bad`);
mkdirSync(OUT + "/o", { recursive: true });
let plates = 0, bytes = 0;
for (let i = 0; i < 1000; i++) {
  const key = String(i).padStart(3, "0"), m = shards.get(key) || new Map(), out = [];
  for (const [plate, a] of m) { a.sort((x, y) => x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0); out.push(plate + "|" + a.map(r => r[0] + ":" + r[1]).join(",")); }
  plates += m.size; const txt = out.join("\n"); bytes += txt.length;
  writeFileSync(`${OUT}/o/${key}.txt`, txt);
}
writeFileSync(OUT + "/meta.json", JSON.stringify({ updated: new Date().toISOString(), rows: n - 1, plates, types }));
console.log(JSON.stringify({ lines: n, bad, plates, types, bytes, mb: Math.round(bytes / 1048576) }));

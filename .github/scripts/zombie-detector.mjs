// "Back on the road" detector: finds plates that left the Ministry of Transport's active register and later came back
// (a red flag worth asking about: a total-loss car rebuilt, a long deposit, a re-registration).
// Monthly on a GitHub runner. State lives on the zombie-data branch (checked out into DIR):
//   state/active.u32.gz  sorted plates of the active register at the last snapshot
//   state/gone.bin.gz    plates that left it: [plate u32][month u16][via u8] (via: i = moved to an inactive register, c = to a final-cancel register, n = to none of them)
//   z/XXX.txt            the flagged plates, by last three digits: "plate|goneYYYYMM|backYYYYMM|via" (backYYYYMM 0 = back before our first snapshot)
//   meta.json            {updated, snapshots, flagged, first}
// The first run only records a baseline (plus plates that sit in a final-cancel register and the active one at the same time);
// returns are found from the second monthly run on.
import fs from "node:fs"; import path from "node:path"; import zlib from "node:zlib";
const DIR = process.env.DIR || "zombie-out", API = "https://data.gov.il/api/3/action/datastore_search", PAGE = 30000, T0 = Date.now();
const log = m => console.log(`[${Math.round((Date.now() - T0) / 1000)}s] ${m}`);
const ACTIVE = "053cea08-09bc-40ec-8f7a-156f0677aff3";
const INACTIVE = ["f6efe89a-fb3d-43a4-bb61-9bf12a9b9099", "6f6acd03-f351-4a8f-8ecf-df792f4f573a"];
const CANCEL = ["851ecab1-0622-4dbe-a6c7-f950cf82abf9", "4e6b9724-4c1e-43f0-909a-154d4cc4e046", "ec8cbc34-72e1-4b69-9c48-22821ba0bd6c"];
async function call(params, tries = 8) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(API + "?" + new URLSearchParams(params), {signal: AbortSignal.timeout(120000)}); const j = await r.json(); if (j.success) return j.result; } catch {}
    await new Promise(r => setTimeout(r, 4000 * (i + 1)));
  }
  throw new Error("failed " + JSON.stringify(params).slice(0, 100));
}
async function scan(id, fields, f) {
  let n = 0, total = null;
  for (let off = 0; ; off += PAGE) {
    const r = await call({resource_id: id, limit: String(PAGE), offset: String(off), fields});
    if (total === null) total = r.total;
    for (const x of r.records) f(x); n += r.records.length;
    if (r.records.length < PAGE) break;
  }
  // a half-read register would look like thousands of cars leaving the road: refuse to continue
  if (total && n < total * 0.995) throw new Error(`${id}: read ${n} of ${total}`);
  return n;
}
const ym = d => { const t = new Date(d || Date.now()); return t.getUTCFullYear() * 100 + t.getUTCMonth() + 1; };
const toM = y => Math.floor(y / 100) * 12 + (y % 100) - 1, fromM = m => Math.floor(m / 12) * 100 + (m % 12) + 1;   // month index for u16 storage
const NOW = ym(), file = p => path.join(DIR, p);
const readGz = p => fs.existsSync(file(p)) ? zlib.gunzipSync(fs.readFileSync(file(p))) : null;
const writeGz = (p, buf) => { fs.mkdirSync(path.dirname(file(p)), {recursive: true}); fs.writeFileSync(file(p), zlib.gzipSync(buf, {level: 9})); };

// 1. this month's active register
const cur = new Set();
log("active rows " + await scan(ACTIVE, "mispar_rechev", r => { const p = Number(r.mispar_rechev); if (p > 0) cur.add(p); }) + ", plates " + cur.size);
if (cur.size < 3e6) throw new Error("active register too small (" + cur.size + "), not trusting this snapshot");

// 2. last state
const prevBuf = readGz("state/active.u32.gz"), prev = prevBuf ? new Uint32Array(prevBuf.buffer.slice(prevBuf.byteOffset, prevBuf.byteOffset + prevBuf.length)) : null;   // copied: a gunzipped buffer need not be 4-byte aligned
const gone = new Map();   // plate -> [monthIndex, via]
{ const b = readGz("state/gone.bin.gz"); if (b) for (let o = 0; o + 7 <= b.length; o += 7) gone.set(b.readUInt32LE(o), [b.readUInt16LE(o + 4), String.fromCharCode(b[o + 6])]); }
const flagged = new Map();   // plate -> line
for (const f of fs.existsSync(file("z")) ? fs.readdirSync(file("z")) : []) for (const l of fs.readFileSync(file("z/" + f), "utf8").split("\n")) if (l) flagged.set(Number(l.split("|")[0]), l);
const meta = fs.existsSync(file("meta.json")) ? JSON.parse(fs.readFileSync(file("meta.json"), "utf8")) : {snapshots: 0, first: NOW};
if (meta.last === NOW) { log("already ran this month, nothing to do"); process.exit(0); }

// 3. where are the other registers (only needed to label why a car left, and for the first-run seed)
const inInactive = new Set(), cancelDate = new Map();
for (const id of INACTIVE) log("inactive rows " + await scan(id, "mispar_rechev", r => inInactive.add(Number(r.mispar_rechev))));
for (const id of CANCEL) log("cancel rows " + await scan(id, "mispar_rechev,bitul_dt", r => cancelDate.set(Number(r.mispar_rechev), String(r.bitul_dt || ""))));

let left = 0, back = 0, seeded = 0;
if (prev) {
  // left the active register since last month
  for (const p of prev) if (!cur.has(p) && !gone.has(p)) { gone.set(p, [toM(NOW), cancelDate.has(p) ? "c" : inInactive.has(p) ? "i" : "n"]); left++; }
  // came back: it was gone at some earlier snapshot
  for (const p of cur) { const g = gone.get(p); if (!g) continue; flagged.set(p, `${p}|${fromM(g[0])}|${NOW}|${g[1]}`); gone.delete(p); back++; }
}
// an active car that also sits in a final-cancel register was cancelled once and registered again (any run)
for (const [p, d] of cancelDate) if (cur.has(p) && !flagged.has(p)) { const m = /^(\d{4})-?(\d{2})/.exec(d); flagged.set(p, `${p}|${m ? m[1] + m[2] : 0}|${prev ? NOW : 0}|c`); seeded++; }
log(`left ${left}, came back ${back}, active+cancelled ${seeded}, still gone ${gone.size}, flagged total ${flagged.size}`);

// 4. save state and the shards the app reads
const arr = Uint32Array.from(cur).sort();
writeGz("state/active.u32.gz", Buffer.from(arr.buffer));
const gb = Buffer.alloc(gone.size * 7); let o = 0;
for (const [p, [m, v]] of gone) { gb.writeUInt32LE(p, o); gb.writeUInt16LE(m, o + 4); gb[o + 6] = v.charCodeAt(0); o += 7; }
writeGz("state/gone.bin.gz", gb);
fs.rmSync(file("z"), {recursive: true, force: true}); fs.mkdirSync(file("z"), {recursive: true});
const shards = {}; for (const [p, l] of flagged) (shards[String(p).slice(-3).padStart(3, "0")] ||= []).push(l);
for (const [k, ls] of Object.entries(shards)) fs.writeFileSync(file(`z/${k}.txt`), ls.sort().join("\n") + "\n");
const via = {}; for (const l of flagged.values()) { const v = l.split("|")[3]; via[v] = (via[v] || 0) + 1; }
fs.writeFileSync(file("meta.json"), JSON.stringify({...meta, updated: new Date().toISOString().slice(0, 10), last: NOW, snapshots: meta.snapshots + 1, flagged: flagged.size, via}));
log("written: " + JSON.stringify(via));

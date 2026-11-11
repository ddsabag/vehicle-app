// Vanished cars (data thread, 11.11.2026; Dudu "תבנה את הבוט שאוסף"): a plate that leaves the active register without moving to an inactive or a
// final-cancel register is gone from the ministry's open data with no word why. The inactive register says it holds only cars that are "not
// stolen", so many of these may be stolen cars; some may be withheld for other reasons. This bot keeps the last details the active register showed
// for each such car, so a later app version can say "ייתכן" and show what the register said until then (not before 22.11, and never "stolen").
// Twice a week on a runner. Nothing readable goes to the public repository (constitution rules 10-11):
//   DIR (an Actions cache, private to the repository)  details.bin.gz  every active car's compact record at the last run (REC bytes each, by plate)
//                                                        vanished.json   {plate: {gone, seen, rec}} for the cars still gone
//                                                        last.json       {date, cars}
//   OUT (the vanished-data branch, public)              vanished.enc.json  vanished.json encrypted with .github/seo-data.pub.pem (data thread decrypts)
//                                                        meta.json          counts only
// A lost cache starts a new baseline: the log says so and nothing is lost but the weeks since the last run.
//   node vanished.mjs            node vanished.mjs selftest (offline)
import fs from "node:fs"; import path from "node:path"; import zlib from "node:zlib";
import { encrypt } from "./camp-data.mjs";
const API = "https://data.gov.il/api/3/action/datastore_search", PAGE = 30000, T0 = Date.now();
const log = m => console.log(`[${Math.round((Date.now() - T0) / 1000)}s] ${m}`);
const ACTIVE = "053cea08-09bc-40ec-8f7a-156f0677aff3";
const INACTIVE = ["f6efe89a-fb3d-43a4-bb61-9bf12a9b9099", "6f6acd03-f351-4a8f-8ecf-df792f4f573a"];
const CANCEL = ["851ecab1-0622-4dbe-a6c7-f950cf82abf9", "4e6b9724-4c1e-43f0-909a-154d4cc4e046", "ec8cbc34-72e1-4b69-9c48-22821ba0bd6c"];
const FIELDS = "mispar_rechev,tozeret_cd,degem_cd,sug_degem,shnat_yitzur,tzeva_cd,mivchan_acharon_dt,tokef_dt,moed_aliya_lakvish";

// one car in REC bytes: plate u32, maker u16, model u32, year u16, colour u16, last test u16, licence u16 (days from 1990-01-01), on the road u16
// (month index), model type u8 (P, M, ...)
export const REC = 25;
const D0 = Date.UTC(1990, 0, 1);
const day = s => { const t = Date.parse(String(s || "").slice(0, 10)); return isNaN(t) ? 0 : Math.max(0, Math.min(65535, Math.round((t - D0) / 864e5))); };
const unday = n => n ? new Date(D0 + n * 864e5).toISOString().slice(0, 10) : "";
const mon = s => { const m = /^(\d{4})-(\d{1,2})/.exec(String(s || "")); return m ? +m[1] * 12 + +m[2] - 1 : 0; };
const unmon = n => n ? `${Math.floor(n / 12)}-${n % 12 + 1}` : "";
const u = (v, max) => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= max ? Math.round(n) : 0; };
export function pack(r, buf, o) {
  buf.writeUInt32LE(u(r.mispar_rechev, 4294967295), o); buf.writeUInt16LE(u(r.tozeret_cd, 65535), o + 4); buf.writeUInt32LE(u(r.degem_cd, 4294967295), o + 6);
  buf.writeUInt16LE(u(r.shnat_yitzur, 65535), o + 10); buf.writeUInt16LE(u(r.tzeva_cd, 65535), o + 12); buf.writeUInt16LE(day(r.mivchan_acharon_dt), o + 14);
  buf.writeUInt16LE(day(r.tokef_dt), o + 16); buf.writeUInt16LE(mon(r.moed_aliya_lakvish), o + 18); buf[o + 20] = String(r.sug_degem || " ").charCodeAt(0) & 255;
  buf.fill(0, o + 21, o + REC);
}
export const unpack = (buf, o) => ({ tozeret_cd: buf.readUInt16LE(o + 4), degem_cd: buf.readUInt32LE(o + 6), shnat_yitzur: buf.readUInt16LE(o + 10),
  tzeva_cd: buf.readUInt16LE(o + 12), mivchan_acharon_dt: unday(buf.readUInt16LE(o + 14)), tokef_dt: unday(buf.readUInt16LE(o + 16)),
  moed_aliya_lakvish: unmon(buf.readUInt16LE(o + 18)), sug_degem: String.fromCharCode(buf[o + 20]).trim() });
// records sorted by plate, so last run's file is read in one pass
export function sortRecs(buf, n) {
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => buf.readUInt32LE(a * REC) - buf.readUInt32LE(b * REC));
  const out = Buffer.alloc(n * REC); idx.forEach((i, k) => buf.copy(out, k * REC, i * REC, i * REC + REC)); return out;
}

// the comparison itself: last run's records, this run's plates, the other registers' plates, and the cars still gone
export function compare({ prev, cur, elsewhere, vanished, today, prevDate }) {
  let left = 0, back = 0;
  for (const p of Object.keys(vanished)) if (cur.has(Number(p))) { delete vanished[p]; back++; }
  if (prev) for (let o = 0; o + REC <= prev.length; o += REC) {
    const p = prev.readUInt32LE(o);
    if (!p || cur.has(p) || elsewhere.has(p) || vanished[p]) continue;
    vanished[p] = { gone: today, seen: prevDate, rec: unpack(prev, o) }; left++;
  }
  return { left, back };
}

async function call(params, tries = 8) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(API + "?" + new URLSearchParams(params), { signal: AbortSignal.timeout(120000) }); const j = await r.json(); if (j.success) return j.result; } catch {}
    await new Promise(r => setTimeout(r, 4000 * (i + 1)));
  }
  throw new Error("failed " + JSON.stringify(params).slice(0, 100));
}
async function scan(id, fields, f) {
  let n = 0, total = null;
  for (let off = 0; ; off += PAGE) {
    const r = await call({ resource_id: id, limit: String(PAGE), offset: String(off), fields });
    if (total === null) total = r.total;
    for (const x of r.records) f(x); n += r.records.length;
    if (r.records.length < PAGE) break;
  }
  // a half-read register would look like thousands of cars vanishing: refuse to continue
  if (total && n < total * 0.995) throw new Error(`register read ${n} of ${total}`);
  return n;
}

async function run() {
  const DIR = process.env.DIR || "vanished-state", OUT = process.env.OUT || "vanished-out", today = new Date().toISOString().slice(0, 10);
  fs.mkdirSync(DIR, { recursive: true }); fs.mkdirSync(OUT, { recursive: true });
  const rd = f => { try { return JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")); } catch { return null; } };
  const last = rd("last.json"), vanished = rd("vanished.json") || {};
  const prev = last && fs.existsSync(path.join(DIR, "details.bin.gz")) ? zlib.gunzipSync(fs.readFileSync(path.join(DIR, "details.bin.gz"))) : null;
  log(prev ? `last run ${last.date}: ${last.cars} cars` : "no state from a last run: this run records a new baseline");
  // 1. the active register, every car's record
  let buf = Buffer.alloc(5e6 * REC), n = 0; const cur = new Set();
  log("active rows " + await scan(ACTIVE, FIELDS, r => {
    const p = Number(r.mispar_rechev); if (!(p > 0) || cur.has(p)) return;
    if ((n + 1) * REC > buf.length) { const b = Buffer.alloc(buf.length * 1.5); buf.copy(b); buf = b; }
    cur.add(p); pack(r, buf, n * REC); n++;
  }) + ", cars " + n);
  if (n < 3e6) throw new Error("active register too small (" + n + "), not trusting this run");
  // 2. the other registers, plates only: a car there left the road the usual way
  const elsewhere = new Set();
  for (const id of [...INACTIVE, ...CANCEL]) log("other register rows " + await scan(id, "mispar_rechev", r => elsewhere.add(Number(r.mispar_rechev))));
  // 3. compare and save
  const { left, back } = compare({ prev, cur, elsewhere, vanished, today, prevDate: last && last.date });
  const total = Object.keys(vanished).length;
  log(`vanished since the last run ${left}, back on the register ${back}, still vanished ${total}`);
  fs.writeFileSync(path.join(DIR, "details.bin.gz"), zlib.gzipSync(sortRecs(buf, n), { level: 6 }));
  fs.writeFileSync(path.join(DIR, "vanished.json"), JSON.stringify(vanished));
  fs.writeFileSync(path.join(DIR, "last.json"), JSON.stringify({ date: today, cars: n }));
  fs.writeFileSync(path.join(OUT, "vanished.enc.json"), JSON.stringify(encrypt(vanished, fs.readFileSync(".github/seo-data.pub.pem", "utf8"))));
  fs.writeFileSync(path.join(OUT, "meta.json"), JSON.stringify({ updated: today, baseline: !prev, left, back, vanished: total }) + "\n");
  log("written");
}

function selftest() {
  let bad = 0; const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) bad++; };
  const rows = [
    { mispar_rechev: 3000001, tozeret_cd: 413, degem_cd: 1234, sug_degem: "P", shnat_yitzur: 2025, tzeva_cd: 10, mivchan_acharon_dt: "2025-12-29T00:00:00", tokef_dt: "2027-01-01", moed_aliya_lakvish: "2025-1" },
    { mispar_rechev: 1000002, tozeret_cd: 100, degem_cd: 9, sug_degem: "M", shnat_yitzur: 2019, tzeva_cd: 3, mivchan_acharon_dt: "", tokef_dt: "2026-05-01", moed_aliya_lakvish: "2019-11" },
    { mispar_rechev: 2000003, tozeret_cd: 7, degem_cd: 70000, sug_degem: "P", shnat_yitzur: 2010, tzeva_cd: 1, mivchan_acharon_dt: "2024-02-02", tokef_dt: "2025-02-02", moed_aliya_lakvish: "2010-3" }];
  const b = Buffer.alloc(rows.length * REC); rows.forEach((r, i) => pack(r, b, i * REC));
  const s = sortRecs(b, rows.length);
  ok([0, 1, 2].map(i => s.readUInt32LE(i * REC)).join() === "1000002,2000003,3000001", "records sorted by plate");
  const r0 = unpack(s, 2 * REC);
  ok(r0.tozeret_cd === 413 && r0.degem_cd === 1234 && r0.shnat_yitzur === 2025 && r0.mivchan_acharon_dt === "2025-12-29" && r0.tokef_dt === "2027-01-01" && r0.moed_aliya_lakvish === "2025-1" && r0.sug_degem === "P", "a record keeps every field");
  ok(unpack(s, 0).mivchan_acharon_dt === "" && unpack(s, REC).degem_cd === 70000, "an empty date stays empty, a large model code fits");
  // 3000001 vanished, 2000003 moved to a final-cancel register, 1000002 still active; 999 was gone and came back
  const vanished = { 999: { gone: "2026-11-01", seen: "2026-10-28", rec: {} } };
  const c = compare({ prev: s, cur: new Set([1000002, 999]), elsewhere: new Set([2000003]), vanished, today: "2026-11-15", prevDate: "2026-11-11" });
  ok(c.left === 1 && c.back === 1 && Object.keys(vanished).join() === "3000001" && vanished[3000001].seen === "2026-11-11" && vanished[3000001].rec.shnat_yitzur === 2025, "a car gone to no register is kept, one gone elsewhere is not, one back leaves the list");
  const c2 = compare({ prev: s, cur: new Set([1000002]), elsewhere: new Set([2000003]), vanished, today: "2026-11-18", prevDate: "2026-11-15" });
  ok(c2.left === 0 && vanished[3000001].gone === "2026-11-15", "a car already on the list keeps the date it vanished");
  ok(compare({ prev: null, cur: new Set([1]), elsewhere: new Set(), vanished: {}, today: "x" }).left === 0, "no last run: a baseline, nothing vanished");
  console.log(bad ? `selftest: ${bad} failed` : "selftest ok"); process.exit(bad ? 1 : 0);
}

if (process.argv[1] && process.argv[1].endsWith("vanished.mjs")) { if (process.argv[2] === "selftest") selftest(); else await run(); }

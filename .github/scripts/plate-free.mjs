// Finds plate numbers that no Ministry of Transport register holds, for a made-up example plate in marketing images.
// Candidates are generated here at run time (patterns + random 7-digit numbers); nothing about any plate is printed in clear:
// the whole result is encrypted to .github/seo-data.pub.pem (the log and inspect-output are public).
import fs from "node:fs"; import crypto from "node:crypto";
const SETS = [["active","053cea08-09bc-40ec-8f7a-156f0677aff3"],["moto","bf9df4e2-d90d-4c0a-a400-19e15af8e95f"],["heavy","cd3acc5c-03c3-4c89-9c54-d40f93c0d790"],
  ["inactive","f6efe89a-fb3d-43a4-bb61-9bf12a9b9099"],["inactive2","6f6acd03-f351-4a8f-8ecf-df792f4f573a"],["cancel","851ecab1-0622-4dbe-a6c7-f950cf82abf9"],
  ["cancel2010","4e6b9724-4c1e-43f0-909a-154d4cc4e046",1],["cancel2000","ec8cbc34-72e1-4b69-9c48-22821ba0bd6c",1],["public","cf29862d-ca25-4691-84f6-1be60dcb4a1e"],
  ["import","03adc637-b6fe-402b-9937-7c3d3afc9140"],["cont","0866573c-40cd-4ca8-91d2-9dd2d7a492e5"],["tech","56063a99-8a3e-4ff4-912e-5966c0279bad"],
  ["owners","bb2355dc-9ec7-4f06-9c3f-3344672171da"],["recall","36bf1404-0be4-49d2-82dc-2f1ead4a8b93",0,"MISPAR_RECHEV"],["tag","c8b9f9c8-4612-4068-934f-d4acd2e3c06e",0,"MISPAR RECHEV"],
  ["dpf","7cb2bd95-bf2e-49b6-aea1-fcb5ff6f0473"]];
const cands = new Set(["7654321", "1234567"]);
for (let d = 1; d <= 9; d++) { cands.add(String(d).repeat(7)); cands.add(String(d).repeat(8)); }
const seqU = "1234567890123", seqD = "9876543210987";
for (let i = 0; i < 4; i++) { cands.add(seqU.slice(i, i + 7)); cands.add(seqD.slice(i, i + 7)); cands.add(seqU.slice(i, i + 8)); cands.add(seqD.slice(i, i + 8)); }
for (const a of ["12", "21", "10", "90", "77", "11", "99"]) cands.add((a.repeat(4)).slice(0, 7));
while (cands.size < 90) cands.add(String(1000000 + crypto.randomInt(9000000)));
async function hit(id, field, v) {
  const u = `https://data.gov.il/api/3/action/datastore_search?resource_id=${id}&limit=1&filters=${encodeURIComponent(JSON.stringify({ [field]: v }))}`;
  for (let t = 0; t < 4; t++) {
    try { const r = await fetch(u, { signal: AbortSignal.timeout(30000) }); const j = await r.json(); if (j.success) return j.result.records.length > 0; } catch {}
    await new Promise(r => setTimeout(r, 2000 * (t + 1)));
  }
  return null;
}
const out = [];
for (const p of cands) {
  const res = { plate: p, found: [], unknown: [] };
  for (const [key, id, pad, field] of SETS) {
    const forms = pad ? [p, p.padStart(8, "0")] : [p];
    let any = false, unk = false;
    for (const f of forms) { const h = await hit(id, field || "mispar_rechev", Number(f) && !pad ? Number(f) : f); if (h) any = true; if (h === null) unk = true; }
    if (any) res.found.push(key); else if (unk) res.unknown.push(key);
  }
  out.push(res);
}
const k = crypto.randomBytes(32), iv = crypto.randomBytes(12), ci = crypto.createCipheriv("aes-256-gcm", k, iv);
const data = Buffer.concat([ci.update(JSON.stringify(out)), ci.final()]);
const ek = crypto.publicEncrypt({ key: fs.readFileSync(".github/seo-data.pub.pem", "utf8"), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, k);
console.log(`checked ${out.length} candidates in ${SETS.length} registers`);
console.log("ENC " + JSON.stringify({ v: 1, ek: ek.toString("base64"), iv: iv.toString("base64"), tag: ci.getAuthTag().toString("base64"), data: data.toString("base64") }));

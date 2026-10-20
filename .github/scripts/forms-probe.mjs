// Which plate form each ministry register answers to, and what the app's form-by-form retries cost a car check (20.10).
// Read-only; prints aggregates only (no plates). Runs on GitHub: data.gov.il is not reachable from the dev container.
import fs from "node:fs";
const html = fs.readFileSync("index.html", "utf8");
const block = html.slice(html.indexOf("const PLATE_SETS"), html.indexOf("const MODEL_SETS"));
const ALL = [...block.matchAll(/\{key:"([^"]+)",\s*id:"([0-9a-f-]{36})"([^}]*)\}/g)].map(m => ({ key: m[1], id: m[2], field: (m[3].match(/field:"([^"]+)"/) || [])[1] || "mispar_rechev", pad: /pad:true/.test(m[3]) }));
// what the app asks for a car found in the active register (fetchVehicle): the rare vehicle types only when it is not there
const sets = ALL.filter(s => ["active", "public", "import", "cont", "tech", "owners", "recall", "tag", "dpf"].includes(s.key));
const API = "https://data.gov.il/api/3/action/datastore_search";
const now = () => Number(process.hrtime.bigint() / 1000000n);
const say = (...a) => console.log(...a);
const med = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : NaN; };
const pct = (n, d) => d ? Math.round(100 * n / d) + "%" : "-";
async function ask(id, filters) {
  const t = now();
  try {
    const r = await fetch(`${API}?` + new URLSearchParams({ resource_id: id, filters: JSON.stringify(filters), limit: "100" }), { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20000) });
    const txt = await r.text(); let rows = -1; try { const j = JSON.parse(txt); rows = j.success ? j.result.records.length : -1; } catch {}
    return { ms: now() - t, status: r.status, rows };
  } catch (e) { return { ms: now() - t, status: /timeout|abort/i.test(String(e)) ? "timeout" : "neterr", rows: -1 }; }
}
// the app's forms, in its order (byPlate)
const formsOf = (s, plate) => { const f = [["text", plate], ["number", Number(plate)]]; if (s.pad && plate.length < 8) f.push(["pad7", plate.padStart(7, "0")], ["pad8", plate.padStart(8, "0")]); const seen = new Set(); return f.filter(([, v]) => { const k = typeof v + v; if (seen.has(k)) return false; seen.add(k); return true; }); };

// GENTLE: the first run sent ~27 requests at once per car and the ministry's firewall answered 403 to 85% of them, so this run asks one
// thing at a time, 1.2 s apart, and first reads each register's own column types (one request per register)
const gap = () => new Promise(r => setTimeout(r, 1200));
say(`at ${new Date().toISOString()}: plate column type per register (datastore_search limit=0 fields)`);
for (const s of ALL) {
  try { const j = await (await fetch(`${API}?resource_id=${s.id}&limit=0`, { signal: AbortSignal.timeout(60000) })).json(); const f = (j.result && j.result.fields || []).find(x => x.id === s.field); say(`  ${s.key.padEnd(10)} ${s.field}: ${f ? f.type : "NOT FOUND (" + (j.success ? "fields " + (j.result.fields || []).map(x => x.id).slice(0, 6).join(",") : "error") + ")"} total ${j.result ? j.result.total : "?"}${s.pad ? " (app pads)" : ""}`); }
  catch (e) { say(`  ${s.key}: failed ${String(e).slice(0, 60)}`); }
  await gap();
}
const N = Number(process.env.N || 12);
const plates = new Set();
let total = 4188823;
for (let i = 0; plates.size < N && i < N * 3; i++) {
  try { const r = await (await fetch(`${API}?resource_id=${sets[0].id}&limit=1&offset=${Math.floor(Math.random() * (total - 1))}&fields=mispar_rechev`, { signal: AbortSignal.timeout(90000) })).json(); const p = r.success && r.result.records[0] && String(r.result.records[0].mispar_rechev); if (p) plates.add(p); } catch {}
  await gap();
}
const P = [...plates];
say(`\n${P.length} random cars of the active register; plate length: ${JSON.stringify(P.reduce((o, p) => (o[p.length] = (o[p.length] || 0) + 1, o), {}))}`);
const per = {};
for (const plate of P) for (const s of sets) {
  const out = [];
  for (const [name, v] of formsOf(s, plate)) { out.push({ name, ...(await ask(s.id, { [s.field]: v })) }); await gap(); }
  (per[s.key] ||= []).push({ len: plate.length, forms: out });
}
say("\nper register: rows found by each form (same cars), errors, time per request; the app stops at the first form with rows");
for (const s of sets) {
  const L = per[s.key] || []; if (!L.length) continue;
  const names = [...new Set(L.flatMap(x => x.forms.map(f => f.name)))];
  const parts = names.map(n => { const fs_ = L.map(x => x.forms.find(f => f.name === n)).filter(Boolean); return `${n}: rows ${fs_.filter(f => f.rows > 0).length}/${fs_.length}, err ${JSON.stringify(fs_.filter(f => f.rows < 0).reduce((o, f) => (o[f.status] = (o[f.status] || 0) + 1, o), {}))}, median ${med(fs_.map(f => f.ms))} ms`; });
  const onlyLater = L.filter(x => !(x.forms[0].rows > 0) && x.forms.some(f => f.rows > 0)).length;
  const reqs = L.map(x => { const i = x.forms.findIndex(f => f.rows > 0); return i < 0 ? x.forms.length : i + 1; });
  const sameRows = L.filter(x => x.forms.length > 1 && x.forms[0].rows === x.forms[1].rows).length;
  say(`${s.key.padEnd(8)} | cars with rows ${L.filter(x => x.forms.some(f => f.rows > 0)).length}/${L.length} | found only by a later form ${onlyLater} | text and number gave the same rows ${sameRows}/${L.length} | the app's requests one after the other: ${JSON.stringify(reqs.reduce((o, n) => (o[n] = (o[n] || 0) + 1, o), {}))}`);
  say(`         ${parts.join(" | ")}`);
}
say("done", new Date().toISOString());

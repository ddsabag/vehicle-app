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

const N = Number(process.env.N || 40);
const plates = new Set();
let total = 4188823;
try { const r = await (await fetch(`${API}?resource_id=${sets[0].id}&limit=0`, { signal: AbortSignal.timeout(60000) })).json(); if (r.success) total = r.result.total; } catch {}
for (let i = 0; plates.size < N && i < N * 3; i++) {
  try { const r = await (await fetch(`${API}?resource_id=${sets[0].id}&limit=1&offset=${Math.floor(Math.random() * (total - 1))}&fields=mispar_rechev`, { signal: AbortSignal.timeout(90000) })).json(); const p = r.success && r.result.records[0] && String(r.result.records[0].mispar_rechev); if (p) plates.add(p); } catch {}
}
const P = [...plates];
say(`at ${new Date().toISOString()}: ${P.length} random cars of the active register (${total}); plate length: ${JSON.stringify(P.reduce((o, p) => (o[p.length] = (o[p.length] || 0) + 1, o), {}))}`);

const per = {};   // key -> list of { len, forms: [{name, ms, status, rows}] }
const checks = [];  // per plate: chain ms of every register as the app runs it, and as a single (first) form
for (const plate of P) {
  // every register at once, as the app does; inside a register every form one after the other (all of them, to see which ones answer)
  const got = await Promise.all(sets.map(async s => { const out = []; for (const [name, v] of formsOf(s, plate)) out.push({ name, ...(await ask(s.id, { [s.field]: v })) }); return [s.key, out]; }));
  const c = { len: plate.length, chain: {}, first: {} };
  for (const [k, out] of got) {
    (per[k] ||= []).push({ len: plate.length, forms: out });
    // the app stops at the first form with rows; a form that errs with HTTP 4xx moves to the next form, any other error retries once after 700 ms
    let ms = 0; for (const f of out) { ms += f.ms + (f.rows < 0 && !/^4/.test(String(f.status)) && f.status !== "timeout" ? 700 + f.ms : 0); if (f.rows > 0) break; }
    c.chain[k] = ms; c.first[k] = out[0].ms;
  }
  checks.push(c);
  await new Promise(r => setTimeout(r, 400));
}

say("\nper register: which form found the car's rows, errors, and time per request");
for (const s of sets) {
  const L = per[s.key] || []; if (!L.length) continue;
  const names = [...new Set(L.flatMap(x => x.forms.map(f => f.name)))];
  const parts = names.map(n => { const fs_ = L.map(x => x.forms.find(f => f.name === n)).filter(Boolean); return `${n}: rows ${pct(fs_.filter(f => f.rows > 0).length, fs_.length)}, err ${pct(fs_.filter(f => f.rows < 0).length, fs_.length)} ${JSON.stringify(fs_.filter(f => f.rows < 0).reduce((o, f) => (o[f.status] = (o[f.status] || 0) + 1, o), {}))}, ${med(fs_.map(f => f.ms))} ms`; });
  const any = L.filter(x => x.forms.some(f => f.rows > 0)).length;
  const onlyLater = L.filter(x => !(x.forms[0].rows > 0) && x.forms.some(f => f.rows > 0)).length;
  const reqs = L.map(x => { const i = x.forms.findIndex(f => f.rows > 0); return i < 0 ? x.forms.length : i + 1; });
  say(`${s.key.padEnd(8)} field ${s.field}${s.pad ? " pad" : ""} | car has rows ${pct(any, L.length)} | rows only by a later form ${onlyLater} of ${L.length} | the app's requests one after the other: median ${med(reqs)}, max ${Math.max(...reqs)}`);
  say(`         ${parts.join(" | ")}`);
}

const crit = checks.map(c => Math.max(...Object.values(c.chain))), one = checks.map(c => Math.max(...Object.values(c.first)));
say(`\nthe registers' part of a check (all at once, the slowest decides; model data and drawing not included):`);
say(`  as the app asks today:        median ${med(crit)} ms, p75 ${q(crit, .75)}, p90 ${q(crit, .9)}, max ${Math.max(...crit)}`);
say(`  one form per register:        median ${med(one)} ms, p75 ${q(one, .75)}, p90 ${q(one, .9)}, max ${Math.max(...one)}`);
for (const len of [7, 8]) { const cs = checks.filter(c => c.len === len); if (!cs.length) continue; say(`  ${len}-digit plates (${cs.length}): today median ${med(cs.map(c => Math.max(...Object.values(c.chain))))} ms, one form median ${med(cs.map(c => Math.max(...Object.values(c.first))))} ms`); }
const slowest = {}; checks.forEach(c => { const k = Object.entries(c.chain).sort((a, b) => b[1] - a[1])[0][0]; slowest[k] = (slowest[k] || 0) + 1; });
say("  the register that finished last, as the app asks today:", JSON.stringify(slowest));
say("done", new Date().toISOString());

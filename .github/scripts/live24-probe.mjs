// One-off (probe-go branch, not for main): runs the live dashboard's new collect() (live-24, working tree) with the real keys, counts its
// outside calls (a Worker request may make 50) and prints what it returned. Aggregates only; search terms have their digits masked.
const env = { GA_SERVICE_ACCOUNT_JSON: process.env.GA_SERVICE_ACCOUNT_JSON, GA_PROPERTY_ID: process.env.GA_PROPERTY_ID || "557990379", CF_API_TOKEN: process.env.CF_API_TOKEN, CF_ACCOUNT_ID: process.env.CF_ACCOUNT_ID, PLAY_REPORTS_BUCKET: "pubsite_prod_4688106336294834537" };
const real = globalThis.fetch; let calls = 0; const hosts = {};
globalThis.fetch = (u, o) => { calls++; const h = new URL(String(u)).hostname; hosts[h] = (hosts[h] || 0) + 1; return real(u, o); };
const m = await import("./live24.mjs");
const mask = d => { if (d && d.seo && d.seo.queries) d.seo.queries = d.seo.queries.map(q => [String(q[0]).replace(/\d/g, "#"), ...q.slice(1)]); return d; };
const t0 = Date.now(); const d1 = await m.collect(env);
console.log("cold collect: " + calls + " outside calls in " + (Date.now() - t0) + " ms", JSON.stringify(hosts));
console.log(JSON.stringify(mask(JSON.parse(JSON.stringify(d1))), null, 1).slice(0, 40000));

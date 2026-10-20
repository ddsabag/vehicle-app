// One-off (probe-go branch, not for main), 20.10: the /live data snapshot from the next-branch worker (live-25: channels per network, installed
// now), to render the reviewed page in a test browser. Aggregates only; digits in search terms are masked.
const env = { GA_SERVICE_ACCOUNT_JSON: process.env.GA_SERVICE_ACCOUNT_JSON, GA_PROPERTY_ID: process.env.GA_PROPERTY_ID || "557990379", CF_API_TOKEN: process.env.CF_API_TOKEN, CF_ACCOUNT_ID: process.env.CF_ACCOUNT_ID, PLAY_REPORTS_BUCKET: "pubsite_prod_4688106336294834537" };
const m = await import("./live-ui.mjs");
const d = JSON.parse(JSON.stringify(await m.collect(env)));
if (d.seo && d.seo.queries) d.seo.queries = d.seo.queries.map(q => [String(q[0]).replace(/\d/g, "#"), ...q.slice(1)]);
console.log(JSON.stringify({ at: new Date().toISOString(), live: { ...d, flashes: (await m.getFlashes()).slice(0, 15), metrics: await m.getMetrics() } }));

// One-off (probe-live branch, not for main), 20.10 evening: replays Live watch's fixed judgement (wall time in microseconds, cut requests)
// over luchit-live's record since 19.10 00:00 UTC, at every :12 and :42 the cron would have run, and prints the incident's rows in full
// (the self-test's fixtures). Read-only; prints the Worker's request counts and times only.
import { judge } from "./live-watch.mjs";
const say = (...a) => console.log(a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" "));
const clean = raw => { raw = String(raw || ""); const m = raw.match(/Bearer\s+([A-Za-z0-9_\-]{20,})/i); return (m ? m[1] : raw).trim().replace(/^["']|["']$/g, "").replace(/[^\x21-\x7e]/g, ""); };
const tok = clean(process.env.CF_API_TOKEN), acc = String(process.env.CF_ACCOUNT_ID || "").trim();
const gql = async (query, variables = {}) => (await fetch("https://api.cloudflare.com/client/v4/graphql", { method: "POST", headers: { authorization: "Bearer " + tok, "content-type": "application/json" }, body: JSON.stringify({ query, variables }) })).json();
say("at", new Date().toISOString());
const q = `query($acc: string!, $since: Time!, $until: Time!) { viewer { accounts(filter: {accountTag: $acc}) { workersInvocationsAdaptive(limit: 2000, filter: {scriptName: "luchit-live", datetime_geq: $since, datetime_leq: $until}, orderBy: [datetimeFiveMinutes_ASC]) { dimensions { datetimeFiveMinutes status } sum { requests } quantiles { wallTimeP50 wallTimeP99 } } } } }`;
const now = Date.now(), start = Date.parse("2026-10-19T00:00:00Z"), rows = [];
for (let t = start; t < now; t += 3 * 3600e3) {
  const j = await gql(q, { acc, since: new Date(t).toISOString(), until: new Date(Math.min(now, t + 3 * 3600e3 - 1000)).toISOString() });
  if (j.errors) { say("query error at", new Date(t).toISOString(), j.errors.map(e => e.message).join(" | ").slice(0, 300)); continue; }
  rows.push(...(j.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive || []));
}
say("rows", rows.length, "first", rows[0]?.dimensions?.datetimeFiveMinutes, "last", rows.at(-1)?.dimensions?.datetimeFiveMinutes);
const st = {}; for (const r of rows) st[r.dimensions.status] = (st[r.dimensions.status] || 0) + r.sum.requests; say("requests by status", st);
say("\nrows 20.10 13:30-16:45 UTC (microseconds, as Cloudflare gives them):");
for (const r of rows) { const d = r.dimensions.datetimeFiveMinutes; if (d >= "2026-10-20T13:30" && d <= "2026-10-20T16:45") say(" ", d.slice(5, 16), r.dimensions.status, r.sum.requests, Math.round(r.quantiles.wallTimeP50), Math.round(r.quantiles.wallTimeP99)); }
say("\nrows elsewhere that are not success, or took 10 s or more (ms):");
for (const r of rows) { const d = r.dimensions.datetimeFiveMinutes; if (d >= "2026-10-20T13:30" && d <= "2026-10-20T16:45") continue;
  if (r.dimensions.status !== "success" || r.quantiles.wallTimeP99 >= 10e6) say(" ", d.slice(5, 16), r.dimensions.status, r.sum.requests, "p50", Math.round(r.quantiles.wallTimeP50 / 1000), "p99", Math.round(r.quantiles.wallTimeP99 / 1000)); }
say("\nthe cron's runs (:12 and :42), 35-minute windows:");
let alerts = 0, quiet = 0, slowOnly = 0;
const first = Math.ceil(start / 18e5) * 18e5 + 12 * 6e4;
for (let tick = first; tick <= now; tick += 18e5) {
  const lo = tick - 35 * 6e4 - 5 * 6e4, win = rows.filter(r => { const t = Date.parse(r.dimensions.datetimeFiveMinutes); return t > lo && t <= tick; });
  const v = judge(win);
  if (v.stuck || v.failing) { alerts++; say(" ", new Date(tick).toISOString().slice(5, 16), v.stuck ? "STUCK" : "", v.failing ? "FAILING " + JSON.stringify(v.errBy) : "", "requests", v.requests, "steps", v.steps, "slow", v.slowSteps); }
  else if (v.slowSteps) { slowOnly++; say(" ", new Date(tick).toISOString().slice(5, 16), "one slow step, quiet", "requests", v.requests, "steps", v.steps); }
  else quiet++;
}
say(`runs that would alert ${alerts}, one slow step and quiet ${slowOnly}, quiet ${quiet}`);
say("done", new Date().toISOString());

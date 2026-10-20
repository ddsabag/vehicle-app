// One-off (probe-live branch, not for main), 20.10 evening: the unit of wallTime in Cloudflare's workersInvocationsAdaptive (the schema's own
// descriptions), and luchit-live's last 3 hours with sums beside the quantiles. Read-only; prints the Worker's request times only.
const say = (...a) => console.log(a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" "));
const clean = raw => { raw = String(raw || ""); const m = raw.match(/Bearer\s+([A-Za-z0-9_\-]{20,})/i); return (m ? m[1] : raw).trim().replace(/^["']|["']$/g, "").replace(/[^\x21-\x7e]/g, ""); };
const tok = clean(process.env.CF_API_TOKEN), acc = String(process.env.CF_ACCOUNT_ID || "").trim();
const gql = async (query, variables = {}) => (await fetch("https://api.cloudflare.com/client/v4/graphql", { method: "POST", headers: { authorization: "Bearer " + tok, "content-type": "application/json" }, body: JSON.stringify({ query, variables }) })).json();
say("at", new Date().toISOString());
for (const t of ["AccountWorkersInvocationsAdaptiveQuantiles", "AccountWorkersInvocationsAdaptiveSum"]) {
  const j = await gql(`{ __type(name: "${t}") { name fields { name description } } }`);
  if (j.errors) { say(t, "introspection error:", j.errors.map(e => e.message).join(" | ").slice(0, 200)); continue; }
  for (const f of (j.data.__type?.fields || []).filter(f => /wall|duration|cpu|request|subrequest|clientDisconnect/i.test(f.name))) say(" ", t.replace("AccountWorkersInvocationsAdaptive", ""), f.name, "-", f.description);
}
const until = new Date(), since = new Date(until - 3 * 3600e3);
const q = `query($acc: string!, $since: Time!, $until: Time!) { viewer { accounts(filter: {accountTag: $acc}) { workersInvocationsAdaptive(limit: 500, filter: {scriptName: "luchit-live", datetime_geq: $since, datetime_leq: $until}, orderBy: [datetimeFiveMinutes_ASC]) { dimensions { datetimeFiveMinutes status } sum { requests subrequests wallTime duration cpuTime } quantiles { wallTimeP50 wallTimeP99 cpuTimeP50 } } } } }`;
let j = await gql(q, { acc, since: since.toISOString(), until: until.toISOString() });
if (j.errors) { say("query error:", j.errors.map(e => e.message).join(" | ").slice(0, 300)); j = await gql(q.replace(" duration cpuTime", ""), { acc, since: since.toISOString(), until: until.toISOString() }); }
if (j.errors) say("query error again:", j.errors.map(e => e.message).join(" | ").slice(0, 300));
for (const r of j.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive || []) {
  const s = r.sum, n = s.requests || 1;
  say(r.dimensions.datetimeFiveMinutes.slice(11, 16), r.dimensions.status.padEnd(19), "req", s.requests, "subreq", s.subrequests, "| sum wallTime/req", Math.round(s.wallTime / n), "| p50", Math.round(r.quantiles.wallTimeP50), "p99", Math.round(r.quantiles.wallTimeP99), "| sum duration", s.duration, "| cpu sum/req", s.cpuTime != null ? Math.round(s.cpuTime / n) : "-", "cpu p50", Math.round(r.quantiles.cpuTimeP50));
}
say("done", new Date().toISOString());

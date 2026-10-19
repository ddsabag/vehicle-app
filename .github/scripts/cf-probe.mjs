// One-off (probe-go branch, not for main): which Cloudflare Web Analytics site tag is the page's own beacon and which is the zone's automatic one.
const env = process.env, CF_TAG = "9bb0e756882c478a808d95596e0deade";
const cfTok = String(env.CF_API_TOKEN || "").replace(/^[\s"']*(bearer\s+)?/i, "").replace(/[\s"']+$/, ""), acc = String(env.CF_ACCOUNT_ID || "").trim();
const gql = async (query, variables) => { const r = await fetch("https://api.cloudflare.com/client/v4/graphql", {method: "POST", headers: {authorization: "Bearer " + cfTok, "content-type": "application/json"}, body: JSON.stringify({query, variables})}); const j = await r.json().catch(() => null); if (!r.ok || j?.errors) { console.log("CF GQL ERR", r.status, JSON.stringify(j?.errors || j).slice(0, 300)); return null; } return j.data; };
const since = d => new Date(Date.now() - d * 864e5).toISOString(), tNow = new Date().toISOString();
const q = async (dims, days, extra = [], limit = 60, order = "sum_visits_DESC") => {
  const d = await gql(`query($acc:String!,$f:AccountRumPageloadEventsAdaptiveGroupsFilter_InputObject){viewer{accounts(filter:{accountTag:$acc}){rumPageloadEventsAdaptiveGroups(filter:$f,limit:${limit},orderBy:[${order}]){count sum{visits} dimensions{${dims}}}}}}`, {acc, f: {AND: [{datetime_geq: since(days), datetime_lt: tNow}, ...extra]}});
  return (d?.viewer?.accounts?.[0]?.rumPageloadEventsAdaptiveGroups || []).map(g => [...dims.split(" ").map(k => g.dimensions[k]), g.count, Math.round(g.sum.visits)]);
};
console.log("at", tNow);
const tags = (await q("siteTag", 30)).map(r => r[0]);
console.log("tags with data in 30 days:", JSON.stringify(tags));
for (const [label, dims, days, lim] of [["by date", "date", 30, 40], ["by path (top)", "requestPath", 14, 40], ["by browser", "userAgentBrowser", 14, 15], ["by device", "deviceType", 14, 10], ["by referer (top)", "refererHost", 14, 20], ["by country (top)", "countryName", 14, 10], ["by OS", "userAgentOS", 14, 10]]) {
  for (const t of tags) console.log(`\n# ${t.slice(0, 6)}… ${label}:`, JSON.stringify(await q(dims, days, [{siteTag: t}], lim, dims === "date" ? "date_ASC" : "sum_visits_DESC")));
}
// the same page loads in both? per hour on the busiest day, side by side
const hours = {};
for (const t of tags) for (const [h, c] of await q("datetimeHour", 7, [{siteTag: t}], 200, "datetimeHour_ASC")) (hours[h] ||= {})[t.slice(0, 6)] = c;
console.log("\n# page loads per hour, each tag (7 days):");
for (const [h, o] of Object.entries(hours).sort()) console.log(h, JSON.stringify(o));

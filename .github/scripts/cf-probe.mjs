// One-off (probe-go branch, not for main): the Cloudflare Web Analytics filter the live dashboard will use (both site tags, /live left out).
// Aggregates only: counts, visits, our own page paths and referring host names.
const token = String(process.env.CF_API_TOKEN || "").trim(), acc = String(process.env.CF_ACCOUNT_ID || "").trim();
const TAGS = ["03eb6fb7a75440649781d7a00b29c4ff", "5c0a33a14f5f4201b25fd680a29ae723"];
const ilDay = t => new Date(t).toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" });
const ilStart = day => { for (const h of [3, 2]) { const t = Date.parse(day + "T00:00:00Z") - h * 3600e3; if (ilDay(t) === day && ilDay(t - 1) !== day) return new Date(t).toISOString(); } return day + "T00:00:00Z"; };
const addDays = (day, k) => new Date(Date.parse(day + "T12:00:00Z") + k * 864e5).toISOString().slice(0, 10);
const today = ilDay(Date.now()), yday = addDays(today, -1), wk0 = addDays(today, -7);
async function q(label, f, dim, limit = 20, order = "sum_visits_DESC") {
  const dims = dim ? `dimensions{${dim}}` : "";
  const query = `query($acc:String!,$f:AccountRumPageloadEventsAdaptiveGroupsFilter_InputObject){viewer{accounts(filter:{accountTag:$acc}){rumPageloadEventsAdaptiveGroups(filter:$f,limit:${limit},orderBy:[${order}]){count sum{visits} ${dims}}}}}`;
  const r = await fetch("https://api.cloudflare.com/client/v4/graphql", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify({ query, variables: { acc, f } }) });
  const j = await r.json().catch(() => null);
  console.log("\n## " + label + " (HTTP " + r.status + ")");
  if (!j || j.errors) { console.log("ERRORS", JSON.stringify(j && j.errors).slice(0, 400)); return null; }
  const rows = j.data.viewer.accounts[0].rumPageloadEventsAdaptiveGroups;
  for (const x of rows) console.log((dim ? String(x.dimensions[dim.split(" ")[0]] ?? "") + " | " : "") + "views " + x.count + " | visits " + Math.round(x.sum.visits));
  const t = rows.reduce((a, x) => [a[0] + x.count, a[1] + x.sum.visits], [0, 0]); console.log("rows " + rows.length + " | sum views " + t[0] + " | sum visits " + Math.round(t[1]));
  return rows;
}
const day = d => ({ datetime_geq: ilStart(d), datetime_lt: ilStart(addDays(d, 1)) }), week = { datetime_geq: ilStart(wk0), datetime_lt: ilStart(today) };
console.log("at", new Date().toISOString(), "today", today, "yday", yday, "week", wk0, "..", addDays(today, -1));
await q("A yesterday, both tags, /live excluded (new filter)", { AND: [day(yday), { siteTag_in: TAGS }, { requestPath_notlike: "/live%" }] }, "", 1);
await q("B yesterday, by site tag, /live excluded", { AND: [day(yday), { siteTag_in: TAGS }, { requestPath_notlike: "/live%" }] }, "siteTag", 5);
await q("C yesterday, both tags, only /live", { AND: [day(yday), { siteTag_in: TAGS }, { requestPath_like: "/live%" }] }, "", 1);
await q("D today so far, both tags, /live excluded", { AND: [day(today), { siteTag_in: TAGS }, { requestPath_notlike: "/live%" }] }, "", 1);
await q("E 7 days, by referring host, /live excluded, limit 100", { AND: [week, { siteTag_in: TAGS }, { requestPath_notlike: "/live%" }] }, "refererHost", 100);
await q("F 7 days, total, /live excluded", { AND: [week, { siteTag_in: TAGS }, { requestPath_notlike: "/live%" }] }, "", 1);
await q("G 7 days, pages by views, /live excluded", { AND: [week, { siteTag_in: TAGS }, { requestPath_notlike: "/live%" }] }, "requestPath", 12, "count_DESC");
await q("H 7 days, old filter (token as site tag)", { AND: [week, { siteTag: "9bb0e756882c478a808d95596e0deade" }] }, "", 1);

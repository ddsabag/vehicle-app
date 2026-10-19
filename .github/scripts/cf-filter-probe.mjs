// One-off (probe-go branch, not for main): can the Cloudflare numbers leave out automated (headless) browsers, and how much do they change?
const token = String(process.env.CF_API_TOKEN || "").trim(), acc = String(process.env.CF_ACCOUNT_ID || "").trim();
const TAGS = ["03eb6fb7a75440649781d7a00b29c4ff", "5c0a33a14f5f4201b25fd680a29ae723"];
const ilDay = t => new Date(t).toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" });
const ilStart = day => { for (const h of [3, 2]) { const t = Date.parse(day + "T00:00:00Z") - h * 3600e3; if (ilDay(t) === day && ilDay(t - 1) !== day) return new Date(t).toISOString(); } return day + "T00:00:00Z"; };
const addDays = (day, k) => new Date(Date.parse(day + "T12:00:00Z") + k * 864e5).toISOString().slice(0, 10);
const today = ilDay(Date.now()), yday = addDays(today, -1), wk0 = addDays(today, -7);
async function q(label, f, dim = "") {
  const query = `query($acc:String!,$f:AccountRumPageloadEventsAdaptiveGroupsFilter_InputObject){viewer{accounts(filter:{accountTag:$acc}){rumPageloadEventsAdaptiveGroups(filter:$f,limit:30,orderBy:[count_DESC]){count sum{visits} ${dim ? `dimensions{${dim}}` : ""}}}}}`;
  const r = await fetch("https://api.cloudflare.com/client/v4/graphql", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify({ query, variables: { acc, f } }) });
  const j = await r.json().catch(() => null);
  console.log("\n## " + label + " (HTTP " + r.status + ")");
  if (!j || j.errors) { console.log("ERRORS", JSON.stringify(j && j.errors).slice(0, 500)); return; }
  for (const x of j.data.viewer.accounts[0].rumPageloadEventsAdaptiveGroups) console.log("  " + (dim ? dim.split(" ").map(d => String(x.dimensions[d] ?? "")).join(" | ") + " | " : "") + "views " + x.count + " | visits " + Math.round(x.sum.visits));
}
const base = [{ siteTag_in: TAGS }, { requestPath_notlike: "/live%" }], day = d => ({ datetime_geq: ilStart(d), datetime_lt: ilStart(addDays(d, 1)) }), week = { datetime_geq: ilStart(wk0), datetime_lt: ilStart(today) };
const noBots = { userAgentBrowser_neq: "ChromeHeadless" };
console.log("at", new Date().toISOString(), "today", today, "yday", yday);
await q("yesterday: the new filter", { AND: [day(yday), ...base] });
await q("yesterday: the new filter, headless left out", { AND: [day(yday), ...base, noBots] });
await q("week: the new filter", { AND: [week, ...base] });
await q("week: the new filter, headless left out", { AND: [week, ...base, noBots] });
await q("week: headless only, by tag x page", { AND: [week, ...base, { userAgentBrowser: "ChromeHeadless" }] }, "siteTag requestPath");
await q("week: browser x OS for the Unknown browser", { AND: [week, ...base, { userAgentBrowser: "Unknown" }] }, "userAgentOS deviceType");
await q("week: by browser (both tags)", { AND: [week, ...base] }, "userAgentBrowser");

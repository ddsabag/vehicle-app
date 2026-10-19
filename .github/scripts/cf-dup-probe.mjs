// One-off (probe-go branch, not for main): do the two Cloudflare Web Analytics site tags count the same page view twice?
// Loads the home page and a model page in Chrome with every analytics request stopped before it leaves (nothing is recorded anywhere),
// and lists the beacons on the page and the page-view reports they tried to send, by site token. Then the stored numbers by tag and page.
import { chromium } from "playwright-core";
const UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36";
console.log("at", new Date().toISOString());

// 1. the raw HTML as Cloudflare serves it: an auto-injected beacon shows up here, the page's own one is added later by script
for (const u of ["https://luchit.app/", "https://luchit.app/model/"]) {
  const r = await fetch(u, { headers: { "user-agent": UA, accept: "text/html" } }).catch(e => ({ ok: false, status: e.name }));
  const h = r.ok ? await r.text() : "";
  const tags = [...h.matchAll(/<script[^>]*cloudflareinsights[^>]*>/g)].map(m => m[0].replace(/\s+/g, " ").slice(0, 220));
  console.log(`\n## raw HTML ${u} (HTTP ${r.status}, ${h.length} chars): beacon tags in the HTML: ${tags.length}`); for (const t of tags) console.log("  " + t);
}

// 2. the beacon script: is there a guard that keeps a second copy from reporting?
{
  const r = await fetch("https://static.cloudflareinsights.com/beacon.min.js", { headers: { "user-agent": UA } }).catch(() => null);
  const js = r && r.ok ? await r.text() : "";
  console.log(`\n## beacon.min.js: ${js.length} chars`);
  for (const k of ["__cfBeacon", "__cfRUM", "cfBeacon"]) { const i = js.indexOf(k); console.log(`  ${k}: ${i < 0 ? "absent" : "at " + i + ": " + js.slice(Math.max(0, i - 120), i + 160).replace(/\s+/g, " ")}`); }
}

// 3. real page loads in Chrome, analytics requests stopped
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true });
for (const u of ["https://luchit.app/", "https://luchit.app/model/"]) {
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 412, height: 860 }, locale: "he-IL" });
  await ctx.addInitScript(() => { Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false }); });
  const rum = [], ga = [], beaconLoads = [];
  await ctx.route(/\/cdn-cgi\/rum/, r => { const q = r.request(); let tok = "", et = ""; try { const b = JSON.parse(q.postData() || "{}"); tok = b.siteToken || ""; et = b.eventType ?? ""; } catch {} rum.push(`${new URL(q.url()).host} token ${tok.slice(0, 8)}… type ${et}`); return r.abort(); });
  await ctx.route(/\/api\/e$|google-analytics\.com|googletagmanager\.com/, r => { ga.push(r.request().url().slice(0, 60)); return r.abort(); });
  ctx.on("request", q => { if (/beacon\.min\.js/.test(q.url())) beaconLoads.push(q.url().slice(0, 80)); });
  const page = await ctx.newPage();
  await page.goto(u, { waitUntil: "load", timeout: 45000 }).catch(e => console.log("goto", e.message));
  await page.waitForTimeout(7000);
  const dom = await page.evaluate(() => [...document.querySelectorAll("script[src*='cloudflareinsights']")].map(s => s.getAttribute("data-cf-beacon"))).catch(() => []);
  await page.goto("about:blank").catch(() => {});   // pagehide: the beacons send what they hold
  await page.waitForTimeout(2500);
  console.log(`\n## page load ${u}`);
  console.log("  beacon script elements on the page (data-cf-beacon): " + JSON.stringify(dom));
  console.log("  beacon.min.js requests: " + beaconLoads.length);
  console.log("  page-view reports the beacons tried to send (stopped): " + rum.length); for (const x of rum) console.log("    " + x);
  console.log("  GA requests stopped: " + ga.length);
  await ctx.close();
}
await browser.close();

// 4. the stored numbers: the same pages under each tag (a page view counted twice shows up under both tags at a similar count)
const token = String(process.env.CF_API_TOKEN || "").trim(), acc = String(process.env.CF_ACCOUNT_ID || "").trim();
const TAGS = ["03eb6fb7a75440649781d7a00b29c4ff", "5c0a33a14f5f4201b25fd680a29ae723"];
async function q(label, f, dim, limit = 40, order = "count_DESC") {
  const query = `query($acc:String!,$f:AccountRumPageloadEventsAdaptiveGroupsFilter_InputObject){viewer{accounts(filter:{accountTag:$acc}){rumPageloadEventsAdaptiveGroups(filter:$f,limit:${limit},orderBy:[${order}]){count sum{visits} dimensions{${dim}}}}}}`;
  const r = await fetch("https://api.cloudflare.com/client/v4/graphql", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify({ query, variables: { acc, f } }) });
  const j = await r.json().catch(() => null);
  console.log("\n## " + label + " (HTTP " + r.status + ")");
  if (!j || j.errors) { console.log("ERRORS", JSON.stringify(j && j.errors).slice(0, 400)); return; }
  for (const x of j.data.viewer.accounts[0].rumPageloadEventsAdaptiveGroups) console.log("  " + dim.split(" ").map(d => String(x.dimensions[d] ?? "")).join(" | ") + " | views " + x.count + " | visits " + Math.round(x.sum.visits));
}
const since = new Date(Date.now() - 7 * 864e5).toISOString(), since14 = new Date(Date.now() - 14 * 864e5).toISOString();
await q("7 days: tag x page (top 40 by views, /live left out)", { AND: [{ datetime_geq: since }, { siteTag_in: TAGS }, { requestPath_notlike: "/live%" }] }, "siteTag requestPath");
await q("14 days: home page by day x tag", { AND: [{ datetime_geq: since14 }, { siteTag_in: TAGS }, { requestPath: "/" }] }, "date siteTag", 60, "date_ASC");
await q("7 days: tag x device type", { AND: [{ datetime_geq: since }, { siteTag_in: TAGS }, { requestPath_notlike: "/live%" }] }, "siteTag deviceType", 20);
await q("7 days: tag x user agent browser", { AND: [{ datetime_geq: since }, { siteTag_in: TAGS }, { requestPath_notlike: "/live%" }] }, "siteTag userAgentBrowser", 30);

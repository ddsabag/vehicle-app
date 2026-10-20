// One-off (probe-go branch, not for main): after Cloudflare's automatic Web Analytics setup was turned off for luchit.app (20.10),
// is the injected beacon (token d14a5fea…) gone from the pages, does the page's own beacon (9bb0e756…) still report, and do the stored
// numbers keep coming in under the page's own tag? Analytics requests from the test browser are stopped before they leave.
import { chromium } from "playwright-core";
const UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36";
const PAGES = ["https://luchit.app/", "https://luchit.app/model/", "https://luchit.app/magazine/"];
console.log("at", new Date().toISOString());

// 1. the raw HTML as Cloudflare serves it (an injected beacon is in the HTML; the page's own one is added later by script)
for (const u of PAGES) {
  const r = await fetch(u + "?nc=" + Date.now(), { headers: { "user-agent": UA, accept: "text/html" } }).catch(e => ({ ok: false, status: e.name }));
  const h = r.ok ? await r.text() : "";
  const tags = [...h.matchAll(/<script[^>]*cloudflareinsights[^>]*>/g)].map(m => m[0].replace(/\s+/g, " ").replace(/("token":\s*"[0-9a-f]{8})[0-9a-f]+/, "$1…").slice(0, 200));
  console.log(`\n## raw HTML ${u} (HTTP ${r.status}, cf-cache-status ${r.headers?.get?.("cf-cache-status") || "-"}, ${h.length} chars): beacon tags in the HTML: ${tags.length}`); for (const t of tags) console.log("  " + t);
}

// 2. real page loads in Chrome: which beacons are on the page, and which site token the page-view report carries
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true });
for (const u of PAGES) {
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 412, height: 860 }, locale: "he-IL" });
  await ctx.addInitScript(() => { Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false }); });
  const rum = [];
  await ctx.route(/\/cdn-cgi\/rum/, r => { const q = r.request(); let tok = "", et = ""; try { const b = JSON.parse(q.postData() || "{}"); tok = b.siteToken || ""; et = b.eventType ?? ""; } catch {} rum.push(`token ${tok.slice(0, 8)}… type ${et}`); return r.abort(); });
  await ctx.route(/\/api\/e$|google-analytics\.com|googletagmanager\.com/, r => r.abort());
  const page = await ctx.newPage();
  await page.goto(u, { waitUntil: "load", timeout: 45000 }).catch(e => console.log("goto", e.message));
  await page.waitForTimeout(7000);
  const dom = await page.evaluate(() => [...document.querySelectorAll("script[src*='cloudflareinsights']")].map(s => (s.getAttribute("data-cf-beacon") || "").replace(/([0-9a-f]{8})[0-9a-f]{24}/, "$1…"))).catch(() => []);
  await page.goto("about:blank").catch(() => {});   // pagehide: the beacon sends what it holds
  await page.waitForTimeout(2500);
  console.log(`\n## page load ${u}`);
  console.log("  beacon elements on the page: " + JSON.stringify(dom));
  console.log("  page-view reports (stopped before sending): " + rum.length); for (const x of rum) console.log("    " + x);
  await ctx.close();
}
await browser.close();

// 3. the stored numbers by hour and tag, last 12 hours (the automatic tag should stop, the page's own tag should go on)
const token = String(process.env.CF_API_TOKEN || "").trim(), acc = String(process.env.CF_ACCOUNT_ID || "").trim();
const TAGS = { "03eb6fb7a75440649781d7a00b29c4ff": "own (9bb0e756)", "5c0a33a14f5f4201b25fd680a29ae723": "auto (d14a5fea)" };
async function q(label, f, dim, limit = 60, order = "datetimeHour_ASC") {
  const query = `query($acc:String!,$f:AccountRumPageloadEventsAdaptiveGroupsFilter_InputObject){viewer{accounts(filter:{accountTag:$acc}){rumPageloadEventsAdaptiveGroups(filter:$f,limit:${limit},orderBy:[${order}]){count sum{visits} dimensions{${dim}}}}}}`;
  const r = await fetch("https://api.cloudflare.com/client/v4/graphql", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify({ query, variables: { acc, f } }) });
  const j = await r.json().catch(() => null);
  console.log("\n## " + label + " (HTTP " + r.status + ")");
  if (!j || j.errors) { console.log("ERRORS", JSON.stringify(j && j.errors).slice(0, 400)); return; }
  for (const x of j.data.viewer.accounts[0].rumPageloadEventsAdaptiveGroups) console.log("  " + dim.split(" ").map(d => TAGS[x.dimensions[d]] || String(x.dimensions[d] ?? "")).join(" | ") + " | views " + x.count + " | visits " + Math.round(x.sum.visits));
}
const since = new Date(Date.now() - 12 * 3600e3).toISOString();
await q("last 12 hours: hour (UTC) x tag, /live left out", { AND: [{ datetime_geq: since }, { siteTag_in: Object.keys(TAGS) }, { requestPath_notlike: "/live%" }] }, "datetimeHour siteTag");
await q("last 12 hours: tag x browser", { AND: [{ datetime_geq: since }, { siteTag_in: Object.keys(TAGS) }, { requestPath_notlike: "/live%" }] }, "siteTag userAgentBrowser", 30, "count_DESC");

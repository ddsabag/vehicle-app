// One-off probe (strategy audit 22.11.2026, U4): what the Cloudflare Web Analytics beacon sends when the page address carries the sample
// plate (76-543-21 only, the one plate allowed in public logs), as ?plate= on landing and as #plate after a check.
import { chromium } from "playwright";
const PLATE = "7654321";
const b = await chromium.launch(), ctx = await b.newContext({ userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36" });
const page = await ctx.newPage(), seen = [];
page.on("request", r => { const u = r.url(); if (/cloudflareinsights|\/cdn-cgi\/rum/.test(u)) seen.push({ u, body: r.postData() || "" }); });
const report = label => {
  console.log(`== ${label}: ${seen.length} beacon requests`);
  for (const s of seen) {
    let fields = {}; try { const j = JSON.parse(s.body); for (const k of ["location", "referrer", "landingPath", "pageloadId", "eventType", "si", "startTime"]) if (k in j) fields[k] = j[k]; } catch { fields = { raw: s.body.slice(0, 300) }; }
    console.log(s.u.split("?")[0], "| plate in url:", s.u.includes(PLATE), "| plate in body:", s.body.includes(PLATE), "|", JSON.stringify(fields));
  }
  seen.length = 0;
};
await page.goto(`https://luchit.app/?plate=${PLATE}&s=share`, { waitUntil: "load" });
await page.waitForTimeout(8000); console.log("address now:", page.url());
await page.evaluate(() => { document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("pagehide")); });
await page.waitForTimeout(3000); report("landing with ?plate=");
await page.goto("https://luchit.app/", { waitUntil: "load" }); await page.waitForTimeout(4000); seen.length = 0;
try { await page.fill("#plate", PLATE); await page.keyboard.press("Enter"); } catch (e) { console.log("no plate field", String(e).slice(0, 100)); }
await page.waitForTimeout(10000); console.log("address now:", page.url());
await page.goto("https://luchit.app/about.html").catch(() => {}); await page.waitForTimeout(4000);
report("after a check (#plate), then leaving the page");
await b.close();

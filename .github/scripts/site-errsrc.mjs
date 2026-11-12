// Which scripts the live site runs, and where an error thrown on it comes from (12.11.2026: since 5.11 most web js_error rows are
// efile "site", line 2, on every browser: a same-origin file other than the page). Opens luchit.app as a phone, a computer and Facebook's
// in-app browser, with the example plate only; prints each same-origin script and any error's file, line and first words.
import { chromium } from "playwright";
const UAS = {
  android: "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  desktop: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  fb: "Mozilla/5.0 (Linux; Android 14; Pixel 7 Build/AP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/480.0.0.0;]",
};
const b = await chromium.launch();
for (const [name, ua] of Object.entries(UAS)) for (const url of ["https://luchit.app/", "https://luchit.app/?plate=7654321&s=wa"]) {
  const ctx = await b.newContext({ userAgent: ua, viewport: name === "desktop" ? { width: 1280, height: 900 } : { width: 390, height: 844 }, isMobile: name !== "desktop", locale: "he-IL" });
  await ctx.addInitScript(() => { window.__errs = []; addEventListener("error", (e) => window.__errs.push({ f: e.filename, l: e.lineno, c: e.colno, m: String(e.message || "").slice(0, 80) }), true); addEventListener("unhandledrejection", (e) => window.__errs.push({ rej: String(e.reason && (e.reason.message || e.reason)).slice(0, 80) })); });
  const p = await ctx.newPage(), scripts = new Set();
  p.on("request", (r) => { if (r.resourceType() === "script") scripts.add(r.url().split("?")[0]); });
  p.on("console", (m) => { if (m.type() === "error") console.log(`  [${name}] console error: ${m.text().slice(0, 120)}`); });
  try { await p.goto(url, { waitUntil: "networkidle", timeout: 45000 }); } catch (e) { console.log(`  [${name}] ${url}: ${e.message.slice(0, 80)}`); }
  await p.waitForTimeout(4000);
  // walk the screens a visitor uses: every tab of the car, the share sheet, compare, settings, the cars list, back home
  const steps = [".tabs [data-tab=buy]", ".tabs [data-tab=specs]", ".tabs [data-tab=overview]", ".chead [data-act=share]", "#closeShare", "[data-act=compare]", "#openSettings", "[data-nav=cars]", "[data-nav=search]"];
  for (const sel of steps) { try { const el = await p.$(sel); if (el) { await el.click({ timeout: 3000 }); await p.waitForTimeout(1200); } } catch {} try { await p.keyboard.press("Escape"); } catch {} }
  if (url.endsWith("luchit.app/")) { try { await p.fill("#plate", "7654321"); await p.press("#plate", "Enter"); await p.waitForTimeout(6000); for (const sel of steps) { try { const el = await p.$(sel); if (el) { await el.click({ timeout: 3000 }); await p.waitForTimeout(1000); } } catch {} } } catch {} }
  const errs = await p.evaluate(() => window.__errs).catch(() => []);
  const inline = await p.evaluate(() => [...document.scripts].filter((s) => !s.src).length).catch(() => -1);
  console.log(`${name} ${url}\n  scripts: ${[...scripts].join(" ") || "none"}\n  inline scripts: ${inline}\n  errors: ${JSON.stringify(errs)}`);
  await ctx.close();
}
await b.close();

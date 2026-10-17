// One-off live check of the comparison picker on the deployed site, in a fresh browser (no service worker, no cache):
// the registry is reachable from GitHub, so this exercises the path a real visitor gets. Prints JSON lines; writes out/report.txt when out/ exists.
import fs from "node:fs";
const SITE = (process.env.SITE || "https://luchit.app/").replace(/\/?$/, "/");
const CASES = (process.env.CASES || "קורולה::COROLLA::2026|טויוטה CHR::CHR::2026").split("|").map(s => { const [q, pick, y] = s.split("::"); return { q, pick, y }; });
const { chromium } = await import("playwright");
const b = await chromium.launch(); const lines = [];
const say = o => { const t = JSON.stringify(o); console.log(t); lines.push(t); };
try {
  const ctx = await b.newContext({ viewport: { width: 390, height: 800 }, locale: "he-IL" });
  await ctx.addInitScript(() => { try { localStorage.setItem("analyticsOff", "1"); localStorage.setItem("reviewAsked", "1"); } catch {} });
  const page = await ctx.newPage(); const errs = []; page.on("pageerror", e => errs.push(String(e).slice(0, 160)));
  await page.goto(SITE + "?r=1", { waitUntil: "domcontentloaded", timeout: 40000 }); await page.waitForTimeout(1500);
  const ver = await page.evaluate(() => ({ app: typeof APP_VERSION === "string" ? APP_VERSION : null, script: [...document.scripts].map(s => s.src).filter(s => /app\./.test(s)).map(s => s.split("/").pop()), sw: !!navigator.serviceWorker }));
  say({ site: SITE, ...ver });
  const res = async () => page.evaluate(() => ({ msg: document.querySelector("#compareMsg").textContent, head: (document.querySelector("#mres .mhead b") || {}).textContent, year: [...document.querySelectorAll("#mres .yrow .chip")].filter(c => c.getAttribute("aria-pressed") === "true").map(c => c.textContent), secs: [...document.querySelectorAll("#mres .qsec")].map(e => e.textContent), rows: [...document.querySelectorAll("#mres .row")].map(r => r.textContent.trim().replace(/\s+/g, " ").slice(0, 70)), more: (document.querySelector("#mres [data-mpar]") || {}).textContent || null }));
  for (const c of CASES) {
    await page.evaluate(() => openCompare()); await page.fill("#mq", ""); await page.fill("#mq", c.q);
    await page.waitForTimeout(1500);
    await page.waitForFunction(() => !/מחפש/.test(document.querySelector("#compareMsg").textContent), null, { timeout: 40000 }).catch(() => null); await page.waitForTimeout(800);
    const groups = await page.$$eval("#mres [data-mg]", a => a.map(b => b.textContent.trim().replace(/\s+/g, " ").slice(0, 60)));
    const idx = groups.findIndex(g => g.toUpperCase().startsWith(c.pick.toUpperCase()));
    if (idx < 0) { say({ q: c.q, groups, error: "group not found: " + c.pick }); continue; }
    const els = await page.$$("#mres [data-mg]"); await els[idx].click();
    await page.waitForFunction(() => document.querySelector("#mres .mhead") || /לא נמצאו|נכשל/.test(document.querySelector("#compareMsg").textContent), null, { timeout: 40000 }).catch(() => null);
    await page.waitForTimeout(500);
    if (c.y) { const chip = await page.$(`#mres [data-my="${c.y}"]`); if (chip) { await chip.click(); await page.waitForTimeout(400); } }
    const s = await res(); say({ q: c.q, picked: groups[idx], groups, ...s });
  }
  if (errs.length) say({ pageErrors: errs });
} finally { await b.close(); }
try { if (fs.existsSync("out")) fs.writeFileSync("out/report.txt", lines.join("\n") + "\n"); } catch {}

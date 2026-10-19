// Probe: how the live site's value estimate is built for given plates (price-list row, age, curve, maker tier, adjustments).
// PLATES may be "b64:<base64 of a comma-separated list>" so the plate is not written into the public run log; the report masks it.
import { chromium } from "playwright";
const raw = process.env.PLATES || "";
const plates = (raw.startsWith("b64:") ? Buffer.from(raw.slice(4), "base64").toString("utf8") : raw).split(",").map(s => s.replace(/\D/g, "")).filter(Boolean);
const mask = p => p.slice(0, 2) + "***" + p.slice(-1);
const browser = await chromium.launch();
const ctx = await browser.newContext({ locale: "he-IL", timezoneId: "Asia/Jerusalem" });
await ctx.addInitScript(() => { try { localStorage.setItem("analyticsOff", "1"); localStorage.setItem("reviewAsked", "1"); } catch {} });
for (const plate of plates) {
  const page = await ctx.newPage();
  try {
    await page.goto("https://luchit.app/?r=1&plate=" + plate, { waitUntil: "domcontentloaded", timeout: 40000 });
    await page.waitForFunction(() => typeof current !== "undefined" && current && current.v, null, { timeout: 60000 });
    await page.waitForTimeout(2500);
    const o = await page.evaluate(() => {
      const D = current, v = D.v, c = costs(D), pick = (x, ks) => Object.fromEntries(ks.filter(k => x && x[k] !== undefined).map(k => [k, x[k]]));
      return { car: pick(v, ["tozeret_nm", "kinuy_mishari", "degem_nm", "ramat_gimur", "shnat_yitzur", "moed_aliya_lakvish", "sug_degem", "sug_delek_nm", "nefach_manoa", "mkoriut_nm", "baalut", "tozeret_cd", "degem_cd"]),
        price: D.price, priceRows: (D.priceRows || D.prices || null), km: D.km, kmYears: D.kmYears, ownersFloor: D.ownersFloor, own: (D.own || []).map(r => [r.baalut, r.baalut_dt]),
        hands: typeof handsOf === "function" ? handsOf(D) : null, value: pick(c, ["newPrice", "age", "baseValue", "adj", "valueLow", "valueHigh", "tierK", "range"]) };
    });
    console.log("=== plate " + mask(plate) + "\n" + JSON.stringify(o, null, 1));
  } catch (e) { console.log("=== plate " + mask(plate) + " failed: " + String(e).slice(0, 300)); }
  await page.close();
}
await browser.close();

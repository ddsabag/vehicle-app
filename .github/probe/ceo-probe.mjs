// One-off (ops, 7.11.2026, the CEO checklist): domain renewal (public RDAP), luchit-api's binding names (Cloudflare API, names and types
// only, never a value), and an end-to-end run of the two site forms with our own test address. Prints statuses only.
setTimeout(() => { console.log("probe: 6 min, stopping"); process.exit(0); }, 6 * 60000).unref();
const PART = process.argv[2];
const E = process.env, TEST = "luchit.app.service+e2e1107@gmail.com";
const get = (u, o = {}) => fetch(u, { signal: AbortSignal.timeout(20000), ...o });
const out = (k, v) => console.log(k.padEnd(28), typeof v === "string" ? v : JSON.stringify(v));
try {
  if (PART !== "api") throw new Error("skip");
  const r = await get("https://pubapi.registry.google/rdap/domain/luchit.app", { headers: { accept: "application/rdap+json" } }), j = await r.json();
  const reg = (j.entities || []).find(e => (e.roles || []).includes("registrar"));
  out("rdap http", String(r.status)); out("rdap registrar", reg?.vcardArray?.[1]?.find(v => v[0] === "fn")?.[3] || "?");
  out("rdap events", (j.events || []).map(e => `${e.eventAction} ${e.eventDate}`)); out("rdap status", j.status || []);
} catch (e) { if (PART === "api") out("rdap error", String(e).slice(0, 120)); }
const tokRaw = String(E.CLOUDFLARE_API_TOKEN || ""), m = /\bBearer\s+([A-Za-z0-9_-]{20,})/.exec(tokRaw), tok = m ? m[1] : tokRaw.replace(/\s/g, "");
const CF = "https://api.cloudflare.com/client/v4/accounts/" + E.CF_ACCOUNT_ID, H = { Authorization: "Bearer " + tok };
if (PART === "api") {
try {
  const j = await (await get(CF + "/workers/scripts/luchit-api/settings", { headers: H })).json();
  out("luchit-api bindings", j.success ? (j.result.bindings || []).map(b => `${b.type}:${b.name}`) : (j.errors || []).map(e => e.code + " " + e.message));
} catch (e) { out("bindings error", String(e).slice(0, 120)); }
try {
  const j = await (await get(CF + "/registrar/domains/luchit.app", { headers: H })).json();
  out("cf registrar", j.success ? { expires_at: j.result.expires_at, auto_renew: j.result.auto_renew, locked: j.result.locked } : (j.errors || []).map(e => e.code + " " + e.message));
} catch (e) { out("cf registrar error", String(e).slice(0, 120)); }
}
if (PART === "forms") {
const { chromium } = await import("playwright");

const browser = await chromium.launch(), page = await browser.newPage(); page.setDefaultTimeout(20000);
const watch = path => new Promise(res => { const t = setTimeout(() => res("no request in 20 s"), 20000);
  page.on("response", async r => { if (r.url().includes(path)) { clearTimeout(t); let b = ""; try { b = await r.text(); } catch {} res(`${r.status()} ${b.slice(0, 60)}`); } }); });
try {   // the business form, as a visitor fills it
  await page.goto("https://luchit.app/business/", { waitUntil: "domcontentloaded" });
  const f = page.locator("#wl");
  await f.locator('[name="name"]').fill("בדיקת מערכת");
  await f.locator('[name="company"]').fill("לוחית, בדיקה פנימית");
  await f.locator('[name="type"]').selectOption("אחר");
  if (await f.locator('[name="interest"]').count()) await f.locator('[name="interest"]').selectOption("אחר").catch(() => {});
  await f.locator('[name="email"]').fill(TEST);
  if (await f.locator('[name="notes"]').count()) await f.locator('[name="notes"]').fill("בדיקה מקצה לקצה של הטופס (תפעול, 7.11). אפשר להתעלם.");
  await f.locator('[name="consent"]').check();
  const resp = watch("/api/waitlist");
  await f.locator("button").click();
  out("business /api/waitlist", await resp); await page.waitForTimeout(1500); out("business status line", (await page.locator("#st").textContent()) || "");
} catch (e) { out("business error", String(e).slice(0, 160)); }
try {   // the magazine form with our address (it has an "s"), as a visitor
  await page.goto("https://luchit.app/magazine/", { waitUntil: "domcontentloaded" });
  const f = page.locator("form.sub").first();
  await f.locator('[name="email"]').fill(TEST); await f.locator('[name="consent"]').check();
  let sent = false; page.on("request", r => { if (r.url().includes("/api/subscribe")) sent = true; });
  await f.locator("button").click(); await page.waitForTimeout(3000);
  out("magazine form sent request", String(sent)); out("magazine status line", (await f.locator(".st").textContent()) || "");
  out("magazine page check", String(await page.evaluate(e => /^[^s@]+@[^s@.]+(.[^s@.]+)+$/.test(e), "moshe@gmail.com")));
  // the Worker behind it, as the form would call it (same origin, from the page), so the confirmation mail can be checked
  const r = await page.evaluate(async e => { const x = await fetch("/api/subscribe", { signal: AbortSignal.timeout(15000), method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: e, website: "", consent: true }) }); return x.status + " " + (await x.text()).slice(0, 60); }, TEST);
  out("magazine /api/subscribe", r);
} catch (e) { out("magazine error", String(e).slice(0, 160)); }
await browser.close().catch(() => {});
}
process.exit(0);

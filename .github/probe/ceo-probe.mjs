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
const T0 = Date.now(), step = t => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)} s] ${t}`);
step("import"); const { chromium } = await import("playwright"); step("launch");

const browser = await chromium.launch({ timeout: 60000 }); step("page"); const page = await browser.newPage(); page.setDefaultTimeout(20000); page.setDefaultNavigationTimeout(30000);
const watch = path => new Promise(res => { const t = setTimeout(() => res("no request in 20 s"), 20000);
  page.on("response", async r => { if (r.url().includes(path)) { clearTimeout(t); let b = ""; try { b = await r.text(); } catch {} res(`${r.status()} ${b.slice(0, 60)}`); } }); });
const call = (path, body) => page.evaluate(async ([p, b]) => { try { const x = await fetch(p, { method: "POST", signal: AbortSignal.timeout(15000), headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  return x.status + " " + (await x.text()).slice(0, 60); } catch (e) { return "error " + String(e).slice(0, 80); } }, [path, body]);
try {   // the business form's request, sent from the page as the form sends it (same origin)
  step("goto business"); const g = await page.goto("https://luchit.app/business/", { waitUntil: "domcontentloaded" }); step(`business ${g && g.status()} form=${await page.locator("#wl").count()}`);
  out("business /api/waitlist", await call("/api/waitlist", { name: "בדיקת מערכת", company: "לוחית, בדיקה פנימית", type: "אחר", interest: "אחר", email: TEST, phone: "",
    notes: "בדיקה מקצה לקצה של הטופס (תפעול, 7.11). אפשר להתעלם.", website: "", consent: true }));
} catch (e) { out("business error", String(e).slice(0, 160)); }
try {   // the magazine: the page's own check, then the Worker as the form calls it
  step("goto magazine"); const g2 = await page.goto("https://luchit.app/magazine/", { waitUntil: "domcontentloaded" }); step(`magazine ${g2 && g2.status()} forms=${await page.locator("form.sub").count()}`);
  const html = await page.content(), re = /var em=f\.email\.value\.trim\(\);if\(!(\/[^\n]*?\/)\.test/.exec(html);
  out("magazine served check", re ? re[1].slice(0, 60) : "not found");
  out("magazine /api/subscribe", await call("/api/subscribe", { email: TEST, website: "", consent: true }));
} catch (e) { out("magazine error", String(e).slice(0, 160)); }
await browser.close().catch(() => {});
}
process.exit(0);

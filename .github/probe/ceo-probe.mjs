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
if (PART === "confirm") {   // 7.11 second round: click the first confirm mail's button (Brevo's tracked link), read the contact's lists, ask a fresh test address
  const TRACK = "https://bceehhee.r.af.d.sendibt2.com/tr/cl/1kzcsGELySoif6G4AWnPD9rCfp542EIiEG9wvLl9g2kDJy2skQ87ZCZS-AUGfLrSDkH1PdtJYyrUhmCy3o2knyYpeFQbiudnYxNRB9ERzeiG_DPZX3W_Acl2jZfT9jDzUh8ualgch1-silZa6NbEgaDsi90ljHG8sgw7PnJgqI6mrCjvD3QupHBl0KGzdoimQjd0-2YSf9AuWHgl2WppP8KPk5WSfWifNM4B2KwmuHaauc-LuIHxV6srSZqouqPzvMzuC9wyXIlgrkz_wCBDfS75vdbloEQ2KZVEYqwFlh4Z-iee4Gz4PdPq-RZvxObiejuJJm0IMp-rfwFBdSKBRto6tjfEZca7574Ogt1qkYdiJdV84lKi-PbiWQrlNL8nPo_WmI5pgTlGNO1HtqiBY9-Wb2evFUUQGSsxLyW3sRL-KWz6jikUzdBT1bQyIBxIf0y6yGnMC54pqesd4zDgMFg";
  const UA = { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36" };
  const hops = []; let u = TRACK;
  try {
    for (let i = 0; i < 5; i++) {
      const here = new URL(u), r = await get(u, { redirect: "manual", headers: UA }), loc = r.headers.get("location");
      hops.push(`${r.status} ${here.host}/${here.pathname.split("/")[1] || ""}${here.host === "luchit.app" ? here.pathname.replace(/^\/[^/]*/, "") : ""}`);
      if (!loc) break;
      u = new URL(loc, u).href; const n = new URL(u);
      if (n.host === "luchit.app" && n.pathname.startsWith("/magazine")) { hops.push("-> " + n.pathname + n.search); break; }
    }
  } catch (e) { hops.push("error " + String(e).slice(0, 100)); }
  out("confirm hops", hops);
  let lists = {};
  try {
    const j = await (await get(CF + "/workers/scripts/luchit-api/settings", { headers: H })).json();
    for (const b of (j.result && j.result.bindings) || []) if (/^BREVO_(B2B_)?LIST_ID$/.test(b.name)) lists[b.name] = Number(b.text);
  } catch {}
  const look = async email => { try {
    const r = await get("https://api.brevo.com/v3/contacts/" + encodeURIComponent(email), { headers: { "api-key": E.BREVO_API_KEY || "", accept: "application/json" } });
    if (r.status !== 200) return { http: r.status };
    const c = await r.json(), ids = c.listIds || [];
    return { http: 200, magazine_list: ids.includes(lists.BREVO_LIST_ID), business_list: ids.includes(lists.BREVO_B2B_LIST_ID), blocked: !!c.emailBlacklisted, source: (c.attributes || {}).SOURCE || "-" };
  } catch (e) { return { error: String(e).slice(0, 80) }; } };
  await new Promise(r => setTimeout(r, 3000));
  out("lists known", { magazine: !!lists.BREVO_LIST_ID, business: !!lists.BREVO_B2B_LIST_ID });
  out("brevo e2e1107", await look(TEST));
  const FRESH = "luchit.app.service+e2e1107m@gmail.com";   // never in Brevo: its confirm must create the contact (201), the path that counts on /live
  out("brevo fresh before", await look(FRESH));
  try {
    const r = await get("https://luchit.app/api/subscribe", { method: "POST", headers: { ...UA, origin: "https://luchit.app", "content-type": "application/json" }, body: JSON.stringify({ email: FRESH, website: "", consent: true }) });
    out("fresh /api/subscribe", r.status + " " + (await r.text()).slice(0, 60));
  } catch (e) { out("fresh subscribe error", String(e).slice(0, 120)); }
}
process.exit(0);

// One-off (probe-live branch, not for main), 20.10 evening: Dudu reports that /live does not load. Read-only: (1) how the luchit-live
// Worker's requests ended over the last 24 hours (Cloudflare analytics, by status and hour), (2) which code it runs against main's file,
// (3) what an outside request gets (Access in front), (4) main's /live code run with the real keys: outside calls, time, CPU, source
// errors, (5) the page in Chrome with that data. Prints diagnostics only: no numbers from the dashboard, no tokens.
import fs from "node:fs";
import { createHash } from "node:crypto";
const say = (...a) => console.log(a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" "));
const clean = raw => { raw = String(raw || ""); const mm = raw.match(/Bearer\s+([A-Za-z0-9_\-]{20,})/i); return (mm ? mm[1] : raw).trim().replace(/^["']|["']$/g, "").replace(/[^\x21-\x7e]/g, ""); };
const acc = String(process.env.CF_ACCOUNT_ID || "").trim(), TOKS = { CF_API_TOKEN: clean(process.env.CF_API_TOKEN), CLOUDFLARE_API_TOKEN: clean(process.env.CLOUDFLARE_API_TOKEN) };
say("at", new Date().toISOString(), "| account id set:", !!acc, "| tokens set:", Object.fromEntries(Object.entries(TOKS).map(([k, v]) => [k, !!v])));

// 1. the Worker's requests by status and hour (GraphQL analytics)
const until = new Date(), since = new Date(until - 24 * 3600e3);
const gql = async (tok, q) => { const r = await fetch("https://api.cloudflare.com/client/v4/graphql", { method: "POST", headers: { authorization: "Bearer " + tok, "content-type": "application/json" }, body: JSON.stringify({ query: q, variables: { acc, since: since.toISOString(), until: until.toISOString() } }) }); return r.json(); };
const Q = fields => `query($acc: string!, $since: Time!, $until: Time!) { viewer { accounts(filter: {accountTag: $acc}) { workersInvocationsAdaptive(limit: 500, filter: {scriptName: "luchit-live", datetime_geq: $since, datetime_leq: $until}, orderBy: [datetimeHour_ASC]) { dimensions { datetimeHour status } ${fields} } } } }`;
let inv = null;
for (const [name, tok] of Object.entries(TOKS)) {
  if (!tok || inv) continue;
  for (const f of ["sum { requests errors subrequests } quantiles { cpuTimeP50 cpuTimeP99 wallTimeP50 wallTimeP99 }", "sum { requests errors subrequests } quantiles { cpuTimeP50 cpuTimeP99 }", "sum { requests errors subrequests }"]) {
    const j = await gql(tok, Q(f));
    if (j.errors && j.errors.length) { say(`analytics with ${name} (${f.slice(0, 40)}...):`, j.errors.map(e => e.message).join(" | ").slice(0, 300)); continue; }
    inv = j.data.viewer.accounts[0]?.workersInvocationsAdaptive || []; say(`analytics read with ${name}`); break;
  }
}
if (inv) {
  const byStatus = {}; for (const r of inv) byStatus[r.dimensions.status] = (byStatus[r.dimensions.status] || 0) + r.sum.requests;
  say("last 24 h, requests by status:", byStatus);
  for (const r of inv) say(" ", r.dimensions.datetimeHour, r.dimensions.status, "requests", r.sum.requests, "errors", r.sum.errors, "subrequests", r.sum.subrequests, r.quantiles ? "cpu p50/p99 ms " + [r.quantiles.cpuTimeP50, r.quantiles.cpuTimeP99].map(x => x == null ? "-" : Math.round(x / 10) / 100).join("/") + (r.quantiles.wallTimeP50 != null ? " wall p50/p99 ms " + [r.quantiles.wallTimeP50, r.quantiles.wallTimeP99].map(x => Math.round(x / 1000)).join("/") : "") : "");
}

// 2. the code the Worker runs, against main's file
const mainCode = await (await fetch("https://raw.githubusercontent.com/ddsabag/vehicle-app/main/worker/live/worker.js?x=" + Date.now())).text();
say("main file", mainCode.length, "chars, sha256", createHash("sha256").update(mainCode).digest("hex").slice(0, 12), "| BUILD:", (mainCode.match(/const BUILD = "([^"]+)"/) || [])[1]);
const API = `https://api.cloudflare.com/client/v4/accounts/${acc}/workers/scripts/luchit-live`;
const get = async (p, asText) => { const r = await fetch(API + p, { headers: { authorization: "Bearer " + TOKS.CLOUDFLARE_API_TOKEN } }); if (!r.ok) return { err: r.status + " " + (await r.text()).slice(0, 200) }; return asText ? r.text() : r.json(); };
const dep = await get("/deployments"), list = (dep.result && dep.result.deployments) || [];
if (dep.err) say("deployments", dep.err);
for (const x of list.slice(0, 2)) say("deployment", x.created_on, x.versions, x.annotations || {});
const vid = list[0] && list[0].versions && list[0].versions[0] && list[0].versions[0].version_id;
if (vid) { const code = await get(`/content/v2?version=${vid}`, true); const txt = typeof code === "string" ? code : JSON.stringify(code); say("live code", txt.length, "chars | holds main's whole file byte for byte:", txt.includes(mainCode)); }

// 3. an outside request (no Access login): Access should answer with its login redirect before the Worker runs
for (const p of ["/live", "/live/data"]) {
  try { const t0 = Date.now(), r = await fetch("https://luchit.app" + p, { redirect: "manual", signal: AbortSignal.timeout(30000) }); const loc = r.headers.get("location") || "";
    say(`outside GET ${p}:`, r.status, "in", Date.now() - t0, "ms | redirect to", loc ? new URL(loc).hostname.replace(/^[^.]+\./, "*.") : "-", "| cf-ray", !!r.headers.get("cf-ray"), "| server", r.headers.get("server")); }
  catch (e) { say(`outside GET ${p}: failed`, e.message); }
}

// 4. main's code with the real keys: outside calls (a Worker request may make 50), time, CPU, source errors
const env = { GA_SERVICE_ACCOUNT_JSON: process.env.GA_SERVICE_ACCOUNT_JSON, GA_PROPERTY_ID: "557990379", CF_API_TOKEN: process.env.CF_API_TOKEN, CF_ACCOUNT_ID: process.env.CF_ACCOUNT_ID, PLAY_REPORTS_BUCKET: "pubsite_prod_4688106336294834537" };
fs.writeFileSync("/tmp/live-main.mjs", mainCode + "\nexport { collect, getFlashes, getMetrics, PAGE };\n");
const real = globalThis.fetch; let calls = 0; const hosts = {}, slow = [];
globalThis.fetch = async (u, o) => { calls++; const url = new URL(String(u && u.url ? u.url : u)), h = url.hostname; hosts[h] = (hosts[h] || 0) + 1; const t = Date.now(); try { return await real(u, o); } finally { const ms = Date.now() - t; if (ms > 4000) slow.push(`${h}${url.pathname.slice(0, 40)} ${ms} ms`); } };
const m = await import("/tmp/live-main.mjs");
const t0 = Date.now(), c0 = process.cpuUsage();
let d = null;
try { d = await m.collect(env); } catch (e) { say("collect threw:", String(e && e.stack || e).slice(0, 400)); }
const cpu = process.cpuUsage(c0);
say("cold collect:", calls, "outside calls in", Date.now() - t0, "ms, CPU", Math.round((cpu.user + cpu.system) / 1000), "ms", hosts, "| slow calls:", slow.length ? slow : "none");
globalThis.fetch = real;
if (d) {
  const errs = []; (function walk(o, p) { if (!o || typeof o !== "object") return; for (const [k, v] of Object.entries(o)) { if (k === "errors" && v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length) errs.push([p + k, v]); else walk(v, p + k + "."); } })(d, "");
  say("build:", d.build, "| stale:", d.stale, "| top keys:", Object.keys(d).join(","));
  say("source errors:", errs.length ? errs : "none");
  const empty = Object.entries(d).filter(([, v]) => v === null || v === undefined).map(([k]) => k);
  say("empty sections:", empty.length ? empty : "none");
  // the same answer the Worker sends (collect + flashes + metrics) as JSON: size, and whether it serializes at all
  try { const full = { ...d, flashes: (await m.getFlashes()).slice(0, 15), metrics: await m.getMetrics() }; say("/live/data body:", JSON.stringify(full).length, "chars"); globalThis.__full = full; }
  catch (e) { say("/live/data body failed:", e.message); }
}

// 5. the page in Chrome with that data
if (globalThis.__full) {
  const full = globalThis.__full;
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  for (const [name, vp, scheme] of [["phone", { width: 390, height: 844 }, "light"], ["phone", { width: 390, height: 844 }, "dark"], ["desktop", { width: 1280, height: 900 }, "light"]]) {
    const page = await browser.newPage({ viewport: vp, locale: "he-IL", timezoneId: "Asia/Jerusalem", colorScheme: scheme });
    const bad = [];
    page.on("pageerror", e => bad.push("pageerror: " + e.message.slice(0, 300)));
    page.on("console", x => { if (x.type() === "error") bad.push("console: " + x.text().slice(0, 200)); });
    await page.route("**/*", r => {
      const u = new URL(r.request().url());
      if (u.pathname === "/live/data") return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(full) });
      if (u.hostname === "luchit.app" && (u.pathname === "/live" || u.pathname === "/live/")) return r.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: m.PAGE });
      return r.abort();
    });
    await page.goto("https://luchit.app/live", { waitUntil: "load" });
    await page.waitForTimeout(3000);
    const r = await page.evaluate(() => {
      const t = document.body.innerText, meta = document.querySelector("#meta, .meta");
      const hits = ["NaN", "undefined", "null", "Infinity", "[object"].filter(w => new RegExp("(^|[^A-Za-z])" + w.replace("[", "\\[") + "([^A-Za-z]|$)").test(t));
      return { textLen: t.length, meta: meta ? meta.innerText.replace(/\d/g, "#").slice(0, 80) : "(no meta)", hits, scrollW: document.documentElement.scrollWidth, innerW: innerWidth, build: (t.match(/live-\d+/) || [""])[0] };
    });
    say(`page ${name}/${scheme}:`, r, "| errors:", bad.length ? bad : "none");
    await page.close();
  }
  await browser.close();
}
say("done", new Date().toISOString());

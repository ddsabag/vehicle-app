// One-off (probe-slow branch, not for main), 20.10.2026: Dudu asks whether most car checks are "slow" (the app's lookup_slow = no answer
// after 3.5 s) and what can be done. Read-only. (A) GA4, real users: car_lookup by the app's own duration bucket (dur), the slow, aborted and
// timed-out checks, by platform and week. (B) Chrome on this runner: the same random active cars looked up with the 1.34 page (main da376370,
// 7 registers per car) and the 1.35 page (main 28aed769, 9 registers), one fresh browser each, against the live data.gov.il: time to the
// result, whether the app showed its "slower than usual" note, and per ministry request the wait for a connection, the server's answer time
// and the protocol. Prints totals and medians only, never a plate.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createSign } from "node:crypto";
const say = (...a) => console.log(a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" "));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const q = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const med = a => q(a, 0.5), r1 = x => x == null ? "-" : (x / 1000).toFixed(1);
say("at", new Date().toISOString());

// ---------- (A) GA4 ----------
async function gaToken() {
  const sa = JSON.parse(process.env.GA_SERVICE_ACCOUNT_JSON), now = Math.floor(Date.now() / 1000);
  const enc = o => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = enc({ alg: "RS256", typ: "JWT" }) + "." + enc({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/analytics.readonly", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3000 });
  const sig = createSign("RSA-SHA256").update(unsigned).sign(sa.private_key).toString("base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: unsigned + "." + sig }) });
  if (!r.ok) throw new Error("google auth " + r.status);
  return (await r.json()).access_token;
}
const PROP = "557990379";
// the /live filter: the site anywhere (web) or the app in Israel
const REAL = { orGroup: { expressions: [{ filter: { fieldName: "platform", stringFilter: { value: "web" } } }, { filter: { fieldName: "countryId", stringFilter: { value: "IL" } } }] } };
const EVS = ["car_lookup", "lookup_repeat", "lookup_slow", "lookup_timeout", "lookup_abort", "lookup_failed", "lookup_from_cache"];
async function report(tok, body) {
  const r = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${PROP}:runReport`, { method: "POST", headers: { authorization: "Bearer " + tok, "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error("ga4 " + r.status + " " + (await r.text()).slice(0, 200));
  return ((await r.json()).rows || []).map(x => [...x.dimensionValues.map(d => d.value), ...x.metricValues.map(m => Number(m.value))]);
}
const evIn = names => ({ filter: { fieldName: "eventName", inListFilter: { values: names } } });
try {
  const tok = await gaToken();
  const ranges = [["13.10-19.10", "2026-10-13", "2026-10-19"], ["6.10-12.10", "2026-10-06", "2026-10-12"], ["20.10 so far", "2026-10-20", "2026-10-20"]];
  for (const [name, a, b] of ranges) {
    const ev = await report(tok, { dateRanges: [{ startDate: a, endDate: b }], dimensions: [{ name: "eventName" }, { name: "platform" }], metrics: [{ name: "eventCount" }],
      dimensionFilter: { andGroup: { expressions: [REAL, evIn(EVS)] } }, limit: 100 });
    const by = {}; for (const [e, p, n] of ev) (by[p] ||= {})[e] = n;
    for (const [p, o] of Object.entries(by)) {
      const looks = (o.car_lookup || 0) + (o.lookup_failed || 0), slow = o.lookup_slow || 0;
      say(`GA4 ${name} ${p}: car_lookup ${o.car_lookup || 0}, lookup_failed ${o.lookup_failed || 0}, lookup_slow ${slow} (= ${looks ? Math.round(100 * slow / looks) : "-"}% of checks with an answer or a failure), lookup_timeout ${o.lookup_timeout || 0}, lookup_abort ${o.lookup_abort || 0}, lookup_repeat ${o.lookup_repeat || 0}, from_cache ${o.lookup_from_cache || 0}`);
    }
    const dur = await report(tok, { dateRanges: [{ startDate: a, endDate: b }], dimensions: [{ name: "platform" }, { name: "customEvent:dur" }], metrics: [{ name: "eventCount" }],
      dimensionFilter: { andGroup: { expressions: [REAL, evIn(["car_lookup"])] } }, limit: 100 });
    const dp = {}; for (const [p, d, n] of dur) (dp[p] ||= {})[d] = n;
    for (const [p, o] of Object.entries(dp)) { const t = Object.values(o).reduce((s, n) => s + n, 0); say(`GA4 ${name} ${p}: car_lookup by time to the answer:`, Object.fromEntries(["lt2", "2to5", "5to10", "gt10", "(not set)"].filter(k => o[k]).map(k => [k, `${o[k]} (${Math.round(100 * o[k] / t)}%)`]))); }
    const fails = await report(tok, { dateRanges: [{ startDate: a, endDate: b }], dimensions: [{ name: "customEvent:kind" }, { name: "customEvent:dur" }], metrics: [{ name: "eventCount" }],
      dimensionFilter: { andGroup: { expressions: [REAL, evIn(["lookup_failed"])] } }, limit: 100 });
    if (fails.length) say(`GA4 ${name} lookup_failed by kind and time:`, fails.map(([k, d, n]) => `${k}/${d} ${n}`).join(", "));
  }
  // the app by version over two weeks (1.33 and 1.34 ask 7 registers per car; 1.35 reached phones on 20.10)
  const ver = await report(tok, { dateRanges: [{ startDate: "2026-10-06", endDate: "2026-10-20" }], dimensions: [{ name: "appVersion" }, { name: "customEvent:dur" }], metrics: [{ name: "eventCount" }],
    dimensionFilter: { andGroup: { expressions: [{ filter: { fieldName: "platform", stringFilter: { value: "Android" } } }, { filter: { fieldName: "countryId", stringFilter: { value: "IL" } } }, evIn(["car_lookup"])] } }, limit: 100 });
  const vb = {}; for (const [v, d, n] of ver) (vb[v] ||= {})[d] = n;
  for (const [v, o] of Object.entries(vb)) say(`GA4 Android ${v} car_lookup by time:`, o);
  // by hour of the day in Israel (is the ministry slower at some hours?), both weeks
  const hr = await report(tok, { dateRanges: [{ startDate: "2026-10-06", endDate: "2026-10-19" }], dimensions: [{ name: "hour" }, { name: "customEvent:dur" }], metrics: [{ name: "eventCount" }],
    dimensionFilter: { andGroup: { expressions: [REAL, evIn(["car_lookup"])] } }, limit: 200 });
  const hb = {}; for (const [h, d, n] of hr) { const b = Number(h) < 7 ? "00-07" : Number(h) < 12 ? "07-12" : Number(h) < 17 ? "12-17" : Number(h) < 21 ? "17-21" : "21-24"; (hb[b] ||= {})[d] = ((hb[b] ||= {})[d] || 0) + n; }
  for (const b of Object.keys(hb).sort()) { const o = hb[b], t = Object.values(o).reduce((s, n) => s + n, 0); say(`GA4 6.10-19.10 Israel hours ${b}: ${t} checks, over 5 s ${Math.round(100 * ((o["5to10"] || 0) + (o.gt10 || 0)) / t)}%, under 2 s ${Math.round(100 * (o.lt2 || 0) / t)}%`); }
} catch (e) { say("GA4 part failed:", e.message); }

// ---------- (B) Chrome ----------
const API = "https://data.gov.il/api/3/action/datastore_search";
const KEYS = { "053cea08": "active", bf9df4e2: "moto", cd3acc5c: "heavy", f6efe89a: "inactive", "6f6acd03": "inactive2", "851ecab1": "cancel", "4e6b9724": "cancel2010", ec8cbc34: "cancel2000",
  cf29862d: "public", "03adc637": "import", "0866573c": "cont", "56063a99": "tech", bb2355dc: "owners", "36bf1404": "recall", c8b9f9c8: "tag", "7cb2bd95": "dpf",
  "142afde2": "m.wltp", "5e87a7a1": "m.counts", "39f455bf": "m.price", "2c33523f": "m.recall1" };
const keyOf = u => { try { const id = new URL(u).searchParams.get("resource_id") || ""; return KEYS[id.slice(0, 8)] || id.slice(0, 8) || "other"; } catch { return "other"; } };
async function randomPlates(n) {
  const out = new Set();
  let total = 4188823;
  try { const r = await (await fetch(`${API}?resource_id=053cea08-09bc-40ec-8f7a-156f0677aff3&limit=0`, { signal: AbortSignal.timeout(60000) })).json(); if (r.success) total = r.result.total; } catch {}
  for (let i = 0; out.size < n && i < n * 3; i++) {
    const off = Math.floor(Math.random() * (total - 1));
    try { const r = await (await fetch(`${API}?resource_id=053cea08-09bc-40ec-8f7a-156f0677aff3&limit=1&offset=${off}&fields=mispar_rechev`, { signal: AbortSignal.timeout(90000) })).json(); const p = r.success && r.result.records[0] && String(r.result.records[0].mispar_rechev); if (p) out.add(p); } catch {}
  }
  say(`sampled ${out.size} random active cars of ${total}`);
  return [...out];
}
function serve(root) {
  const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json", ".ico": "image/x-icon" };
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname); if (p.endsWith("/")) p += "index.html";
    const f = path.join(root, p);
    if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream" }); fs.createReadStream(f).pipe(res);
  });
  return new Promise(r => server.listen(0, "127.0.0.1", () => { server.unref(); r(`http://127.0.0.1:${server.address().port}/`); }));
}
const BLOCK = /googletagmanager|google-analytics|cloudflareinsights|doubleclick|clarity\.ms/;
async function one(browser, base, plate) {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 900 }, locale: "he-IL", timezoneId: "Asia/Jerusalem", serviceWorkers: "block" });
  await ctx.addInitScript(() => {
    try { localStorage.setItem("analyticsOff", "1"); localStorage.setItem("reviewAsked", "1"); } catch {}
    new MutationObserver(() => {
      if (!window.__slowAt && document.querySelector("#slowNote")) window.__slowAt = Date.now();
      if (!window.__doneAt && document.querySelector("#out .id-card, #out .msg.edge")) window.__doneAt = Date.now();
    }).observe(document, { childList: true, subtree: true });
  });
  await ctx.route("**/*", r => BLOCK.test(r.request().url()) ? r.abort() : r.continue());
  const page = await ctx.newPage(), cdp = await ctx.newCDPSession(page), R = new Map();
  await cdp.send("Network.enable");
  cdp.on("Network.requestWillBeSent", e => { if (/data\.gov\.il/.test(e.request.url) && !R.has(e.requestId)) R.set(e.requestId, { key: keyOf(e.request.url), wall: e.wallTime * 1000, ts: e.timestamp }); });
  cdp.on("Network.responseReceived", e => { const x = R.get(e.requestId); if (x) { x.proto = e.response.protocol; x.t = e.response.timing; x.status = e.response.status; } });
  cdp.on("Network.loadingFinished", e => { const x = R.get(e.requestId); if (x) x.end = e.timestamp; });
  cdp.on("Network.loadingFailed", e => { const x = R.get(e.requestId); if (x) { x.end = e.timestamp; x.failed = e.errorText; } });
  let res = { ok: false };
  try {
    await page.goto(base + "?plate=" + plate, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForFunction(() => window.__doneAt, null, { timeout: 60000, polling: 100 });
    await sleep(300);
    const w = await page.evaluate(() => ({ done: window.__doneAt, slow: window.__slowAt || 0, edge: !!document.querySelector("#out .msg.edge") }));
    const reqs = [...R.values()], first = Math.min(...reqs.map(x => x.wall));
    const per = reqs.filter(x => x.end && x.t).map(x => {
      const sent = x.t.requestTime + x.t.sendStart / 1000;
      return { key: x.key, proto: x.proto, start: x.wall - first, wait: (sent - x.ts) * 1000, conn: x.t.connectStart >= 0 ? x.t.connectEnd - x.t.connectStart : 0,
        server: x.t.receiveHeadersEnd - x.t.sendEnd, total: (x.end - x.ts) * 1000, endWall: x.wall + (x.end - x.ts) * 1000 };
    });
    // most ministry requests open at the same moment: how many were in flight at once
    let peak = 0; for (const a of per) peak = Math.max(peak, per.filter(b => b.start <= a.start && b.start + b.total > a.start).length);
    const beforeDone = per.filter(x => x.endWall <= w.done + 5), last = beforeDone.sort((a, b) => b.endWall - a.endWall)[0];
    res = { ok: !w.edge, edge: w.edge, lookup: w.done - first, slow: !!w.slow, n: reqs.length, peak, per, last: last && last.key, failed: reqs.filter(x => x.failed).length };
  } catch (e) { res = { ok: false, err: String(e.message || e).replace(/\d{5,8}/g, "<n>").slice(0, 80) }; }
  await ctx.close();
  return res;
}
try {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  const NEW = await serve(path.resolve(".")), OLD = await serve(path.resolve("old"));
  const plates = await randomPlates(Number(process.env.N || 24));
  const runs = { "1.34": [], "1.35": [] };
  for (const [i, p] of plates.entries()) {
    // alternate which page goes first, so neither one always meets a server that just answered the same plate
    const order = i % 2 ? [["1.34", OLD], ["1.35", NEW]] : [["1.35", NEW], ["1.34", OLD]];
    for (const [v, base] of order) { runs[v].push(await one(browser, base, p)); await sleep(1500); }
  }
  await browser.close();
  for (const [v, rs] of Object.entries(runs)) {
    const ok = rs.filter(r => r.ok), L = ok.map(r => r.lookup);
    say(`\nChrome ${v}: ${rs.length} checks, ${ok.length} with a car, ${rs.filter(r => r.edge).length} with a message, ${rs.filter(r => r.err).length} not finished (${[...new Set(rs.filter(r => r.err).map(r => r.err))].join(" | ")})`);
    if (!ok.length) continue;
    say(`  time from the first ministry request to the result (s): median ${r1(med(L))}, p75 ${r1(q(L, .75))}, p90 ${r1(q(L, .9))}, max ${r1(Math.max(...L))}; showed the "slower than usual" note ${ok.filter(r => r.slow).length} of ${ok.length}`);
    say(`  buckets like the app's dur: under 2 s ${L.filter(x => x < 2000).length}, 2-5 s ${L.filter(x => x >= 2000 && x < 5000).length}, 5-10 s ${L.filter(x => x >= 5000 && x < 10000).length}, over 10 s ${L.filter(x => x >= 10000).length}`);
    say(`  ministry requests per check: median ${med(ok.map(r => r.n))}, most in flight at once: median ${med(ok.map(r => r.peak))}, max ${Math.max(...ok.map(r => r.peak))}; failed requests ${ok.reduce((s, r) => s + r.failed, 0)}`);
    const protos = {}; ok.forEach(r => r.per.forEach(x => protos[x.proto] = (protos[x.proto] || 0) + 1)); say("  protocol of the ministry answers:", protos);
    const lastBy = {}; ok.forEach(r => lastBy[r.last] = (lastBy[r.last] || 0) + 1); say("  the request that finished last before the result:", lastBy);
    const byKey = {}; ok.forEach(r => r.per.forEach(x => (byKey[x.key] ||= []).push(x)));
    for (const [k, xs] of Object.entries(byKey).sort((a, b) => med(b[1].map(x => x.total)) - med(a[1].map(x => x.total))))
      say(`  ${k.padEnd(10)} n ${String(xs.length).padStart(3)} | total median ${r1(med(xs.map(x => x.total)))} p90 ${r1(q(xs.map(x => x.total), .9))} | waiting for a connection median ${r1(med(xs.map(x => x.wait)))} p90 ${r1(q(xs.map(x => x.wait), .9))} | server answer median ${r1(med(xs.map(x => x.server)))} p90 ${r1(q(xs.map(x => x.server), .9))} | starts at median ${r1(med(xs.map(x => x.start)))}`);
    const conns = ok.flatMap(r => r.per.filter(x => x.conn > 0).map(x => x.conn)); say(`  new connections: ${conns.length}, setup median ${Math.round(med(conns) || 0)} ms (one round trip plus TLS from this runner)`);
  }
  // paired: the same car with both pages
  const pairs = runs["1.34"].map((a, i) => [a, runs["1.35"][i]]).filter(([a, b]) => a.ok && b.ok);
  if (pairs.length) { const d = pairs.map(([a, b]) => b.lookup - a.lookup); say(`\npaired (${pairs.length} cars): 1.35 minus 1.34, median ${r1(med(d))} s, p25 ${r1(q(d, .25))}, p75 ${r1(q(d, .75))}; 1.35 slower in ${d.filter(x => x > 0).length} of ${d.length}`); }
} catch (e) { say("Chrome part failed:", String(e.stack || e).slice(0, 400)); }
say("done", new Date().toISOString());

// One-off (probe-perf branch, not for main), 20.10 evening: why /live's "installed now" fell from 227 to 120 within an hour. Reads what the
// Worker reads (GA4 first opens and removals in Israel by day and by hour, GA4 realtime by minute, Google Play's installs report) and
// Cloudflare's record of the luchit-live Worker's requests (by 5 minutes, status, data centre when the dataset has it). Business numbers
// never reach the log or the branch in clear: the JSON is encrypted with .github/seo-data.pub.pem and the log says only which part answered.
import crypto from "node:crypto";
import fs from "node:fs";
const E = process.env, PKG = "com.ddsabag.pratirechev", PROP = "557990379", BUCKET = "pubsite_prod_4688106336294834537";
const out = { generated: new Date().toISOString(), parts: {} }, log = (part, ok, why = "") => console.log(part, ok ? "ok" : "failed " + String(why).replace(/\d/g, "#").slice(0, 160));
const sa = JSON.parse(E.GA_SERVICE_ACCOUNT_JSON || "null");
const b64 = b => Buffer.from(b).toString("base64url");
async function token() {
  const now = Math.floor(Date.now() / 1000), head = b64(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const scope = ["analytics.readonly", "devstorage.read_only"].map(x => "https://www.googleapis.com/auth/" + x).join(" ");
  const claim = b64(JSON.stringify({ iss: sa.client_email, scope, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3000 }));
  const sig = crypto.createSign("RSA-SHA256").update(`${head}.${claim}`).sign(sa.private_key, "base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claim}.${sig}` }) });
  if (!r.ok) throw new Error("auth " + r.status);
  return (await r.json()).access_token;
}
const T = await token(), H = { authorization: "Bearer " + T, "content-type": "application/json" };
async function call(url, body, raw = false) {
  const r = await fetch(url, { ...(body ? { method: "POST", body: JSON.stringify(body) } : {}), headers: H, signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(r.status + " " + (await r.text()).slice(0, 200));
  return raw ? Buffer.from(await r.arrayBuffer()) : r.json();
}
async function part(name, fn) { try { out.parts[name] = await fn(); log(name, true); } catch (e) { out.parts[name] = { error: String(e.message || e).slice(0, 400) }; log(name, false, e.message || e); } }
const flat = j => ({ dims: (j.dimensionHeaders || []).map(h => h.name), mets: (j.metricHeaders || []).map(h => h.name), rows: (j.rows || []).map(r => [...r.dimensionValues.map(v => v.value), ...r.metricValues.map(v => Number(v.value))]), rowCount: j.rowCount || 0 });
const ga = body => call(`https://analyticsdata.googleapis.com/v1beta/properties/${PROP}:runReport`, { limit: 100000, ...body }).then(flat);
const gaRT = body => call(`https://analyticsdata.googleapis.com/v1beta/properties/${PROP}:runRealtimeReport`, body).then(flat);
const eq = (f, v) => ({ filter: { fieldName: f, stringFilter: { value: v } } }), inList = (f, values) => ({ filter: { fieldName: f, inListFilter: { values } } });
const REAL = { orGroup: { expressions: [eq("platform", "web"), eq("countryId", "IL")] } };
const APP = { andGroup: { expressions: [eq("platform", "Android"), eq("countryId", "IL")] } };
const FO = inList("eventName", ["first_open", "app_remove"]);

// GA4: as the Worker asks (daily.life), today by hour (how far GA4 has processed today), and realtime by minute (rtToday)
await part("ga.life", () => ga({ dateRanges: [{ startDate: "2026-10-01", endDate: "today" }], dimensions: [{ name: "date" }, { name: "eventName" }], metrics: [{ name: "eventCount" }], dimensionFilter: { andGroup: { expressions: [APP, FO] } } }));
await part("ga.hourly", () => ga({ dateRanges: [{ startDate: "yesterday", endDate: "today" }], dimensions: [{ name: "dateHour" }, { name: "eventName" }], metrics: [{ name: "eventCount" }], dimensionFilter: { andGroup: { expressions: [APP, FO] } } }));
await part("ga.hourlyChecks", () => ga({ dateRanges: [{ startDate: "today", endDate: "today" }], dimensions: [{ name: "dateHour" }, { name: "platform" }], metrics: [{ name: "eventCount" }], dimensionFilter: { andGroup: { expressions: [REAL, eq("eventName", "car_lookup")] } } }));
await part("ga.rtMinutes", () => gaRT({ dimensions: [{ name: "minutesAgo" }, { name: "eventName" }], metrics: [{ name: "eventCount" }], dimensionFilter: { andGroup: { expressions: [REAL, inList("eventName", ["first_open", "car_lookup"])] } }, limit: 200 }));
await part("ga.rtPlatform", () => gaRT({ dimensions: [{ name: "platform" }, { name: "countryId" }, { name: "eventName" }], metrics: [{ name: "eventCount" }], dimensionFilter: inList("eventName", ["first_open", "app_remove"]), limit: 200 }));

// Google Play: the installs report the Worker reads (Israel rows only), and when each file was last written
const decode = buf => buf[0] === 0xff && buf[1] === 0xfe ? buf.slice(2).toString("utf16le") : buf.toString("utf8").replace(/^﻿/, "");
if (!E.LIGHT) await part("play.installs", async () => {
  const j = await call(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o?` + new URLSearchParams({ prefix: "stats/installs/installs_" + PKG + "_2026", maxResults: "200" }));
  const items = (j.items || []).map(x => ({ name: x.name, updated: x.updated, size: Number(x.size) }));
  const o = { items, rows: {} };
  for (const x of items.filter(x => /_202610_country\.csv$/.test(x.name))) {
    const t = decode(await call(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${encodeURIComponent(x.name)}?alt=media`, null, true)).split(/\r?\n/);
    o.rows[x.name] = [t[0], ...t.slice(1).filter(l => /,IL,/.test(l))];
  }
  return o;
});

// Cloudflare: the luchit-live Worker's requests since 16:00 UTC. Data centre (coloCode) first; without it, the same without the data centre.
const cleanTok = raw => { raw = String(raw || ""); const m = raw.match(/Bearer\s+([A-Za-z0-9_\-]{20,})/i); return (m ? m[1] : raw).trim().replace(/^["']|["']$/g, "").replace(/[^\x21-\x7e]/g, ""); };
async function gql(query, variables) {
  const r = await fetch("https://api.cloudflare.com/client/v4/graphql", { method: "POST", headers: { authorization: "Bearer " + cleanTok(E.CF_API_TOKEN), "content-type": "application/json" }, body: JSON.stringify({ query, variables }) });
  const j = await r.json();
  if (j.errors) throw new Error(j.errors.map(e => e.message).join(" | "));
  return j.data;
}
const since = new Date(Date.now() - 5 * 36e5).toISOString(), until = new Date().toISOString(), acc = String(E.CF_ACCOUNT_ID || "").trim();
const inv = dims => gql(`query($acc:String!,$since:Time!,$until:Time!){viewer{accounts(filter:{accountTag:$acc}){workersInvocationsAdaptive(limit:2000,filter:{scriptName:"luchit-live",datetime_geq:$since,datetime_leq:$until},orderBy:[datetimeFiveMinutes_ASC]){dimensions{${dims}} sum{requests subrequests errors} quantiles{wallTimeP50 wallTimeP99}}}}}`, { acc, since, until })
  .then(d => d.viewer.accounts[0].workersInvocationsAdaptive.map(x => ({ ...x.dimensions, ...x.sum, p50: x.quantiles.wallTimeP50, p99: x.quantiles.wallTimeP99 })));
if (!E.LIGHT) await part("cf.byColo", () => inv("datetimeFiveMinutes status coloCode"));
await part("cf.byVersion", () => inv("datetimeFiveMinutes status scriptVersion"));
if (!E.LIGHT) await part("cf.plain", () => inv("datetimeFiveMinutes status"));
if (!E.LIGHT) await part("cf.zone", async () => {
  const r = await fetch("https://api.cloudflare.com/client/v4/zones?name=luchit.app", { headers: { authorization: "Bearer " + cleanTok(E.CF_API_TOKEN) } });
  const j = await r.json(); if (!j.success) throw new Error("zones " + r.status + " " + JSON.stringify(j.errors).slice(0, 160));
  const zone = j.result[0]?.id; if (!zone) throw new Error("no zone");
  const d = await gql(`query($z:String!,$since:Time!,$until:Time!){viewer{zones(filter:{zoneTag:$z}){httpRequestsAdaptiveGroups(limit:2000,filter:{datetime_geq:$since,datetime_leq:$until,clientRequestPath_like:"/live%"},orderBy:[datetimeFiveMinutes_ASC]){count dimensions{datetimeFiveMinutes coloCode clientRequestPath edgeResponseStatus clientCountryName cacheStatus}}}}}`, { z: zone, since, until });
  return d.viewer.zones[0].httpRequestsAdaptiveGroups.map(x => ({ ...x.dimensions, n: x.count }));
});

// live-30 check: today's tally in Workers KV (luchit-alerts, key lv:rt:<Israel day>), read with the deploy token (read-only GETs)
await part("kv.tally", async () => {
  const tok = cleanTok(E.CLOUDFLARE_API_TOKEN), A = "https://api.cloudflare.com/client/v4/accounts/" + acc + "/storage/kv/namespaces";
  const ns = await (await fetch(A + "?per_page=100", { headers: { authorization: "Bearer " + tok } })).json();
  if (!ns.success) throw new Error("namespaces " + JSON.stringify(ns.errors).slice(0, 160));
  const id = (ns.result || []).find(n => n.title === "luchit-alerts")?.id; if (!id) throw new Error("no luchit-alerts");
  const day = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" }), r = await fetch(A + "/" + id + "/values/" + encodeURIComponent("lv:rt:" + day), { headers: { authorization: "Bearer " + tok } });
  if (r.status === 404) return { day, present: false };
  if (!r.ok) throw new Error("value " + r.status);
  const v = JSON.parse(await r.text()), mins = Object.keys(v.m || {}).map(Number).sort((a, b) => a - b);
  return { day, present: true, ageSec: Math.round((Date.now() - v.at) / 1000), minutes: mins.length, first: mins.length ? new Date(mins[0] * 6e4).toISOString() : null, last: mins.length ? new Date(mins[mins.length - 1] * 6e4).toISOString() : null,
    first_open: Object.values(v.m || {}).reduce((t, x) => t + x[0], 0), car_lookup: Object.values(v.m || {}).reduce((t, x) => t + x[1], 0) };
});

const data = Buffer.from(JSON.stringify(out));
const key = crypto.randomBytes(32), iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key, iv);
const enc = Buffer.concat([c.update(data), c.final()]);
const ek = crypto.publicEncrypt({ key: fs.readFileSync(".github/seo-data.pub.pem", "utf8"), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key);
fs.mkdirSync("out", { recursive: true });
fs.writeFileSync("out/inst.enc.json", JSON.stringify({ v: 1, ek: ek.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: enc.toString("base64") }));
console.log("written, encrypted");

// One-off (24.11.2026): can GA4 give the three save rows (CEO save plan)? Saves by door, notifications by kind, saver return at 30/60 days by funnel. Encrypted output.
import crypto from "node:crypto"; import fs from "node:fs";
const PROP = "557990379", sa = JSON.parse(process.env.GA_SERVICE_ACCOUNT_JSON);
const b64 = b => Buffer.from(b).toString("base64url"), now = Math.floor(Date.now() / 1000), head = b64(JSON.stringify({ alg: "RS256", typ: "JWT" }));
const claim = b64(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/analytics.readonly", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3000 }));
const sig = crypto.createSign("RSA-SHA256").update(`${head}.${claim}`).sign(sa.private_key, "base64url");
const T = (await (await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claim}.${sig}` }) })).json()).access_token;
const ga = async body => { const r = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${PROP}:runReport`, { method: "POST", headers: { authorization: "Bearer " + T, "content-type": "application/json" }, body: JSON.stringify({ limit: 10000, ...body }) }); const j = await r.json(); return { status: r.status, err: j.error?.message, dims: (j.dimensionHeaders || []).map(h => h.name), rows: (j.rows || []).map(x => [...x.dimensionValues.map(v => v.value), ...x.metricValues.map(v => +v.value)]) }; };
const f = { andGroup: { expressions: [{ filter: { fieldName: "eventName", stringFilter: { value: "js_error" } } }, { filter: { fieldName: "platform", stringFilter: { value: "web" } } }] } };
const out = {}, g = b => ga(b).catch(e => ({ error: String(e.message || e).slice(0, 300) }));
const ev = n => ({ filter: { fieldName: "eventName", stringFilter: { value: n } } }), any = v => ({ filter: { fieldName: "eventName", inListFilter: { values: v } } });
const W = [{ startDate: "2026-11-16", endDate: "2026-11-22" }, { startDate: "2026-11-09", endDate: "2026-11-15" }];
out.door = await g({ dateRanges: W, dimensions: ["platform", "eventName", "customEvent:from"].map(name => ({ name })), metrics: [{ name: "eventCount" }, { name: "totalUsers" }], dimensionFilter: any(["car_save", "car_unsave"]) });
out.checks = await g({ dateRanges: W, dimensions: [{ name: "platform" }], metrics: [{ name: "eventCount" }], dimensionFilter: ev("car_lookup") });
out.notif = await g({ dateRanges: [{ startDate: "2026-10-26", endDate: "2026-11-22" }], dimensions: ["isoYearIsoWeek", "eventName", "customEvent:kind"].map(name => ({ name })), metrics: [{ name: "eventCount" }, { name: "totalUsers" }], dimensionFilter: any(["notif_sent", "notif_open"]) });
const fun = async body => { const r = await fetch(`https://analyticsdata.googleapis.com/v1alpha/properties/${PROP}:runFunnelReport`, { method: "POST", headers: { authorization: "Bearer " + T, "content-type": "application/json" }, body: JSON.stringify(body) });
  const t = await r.text(); if (!r.ok) return { error: r.status + " " + t.slice(0, 300) }; const j = JSON.parse(t); return { table: j.funnelTable, viz: undefined }; };
const app = { funnelFieldFilter: { fieldName: "platform", stringFilter: { value: "Android" } } };
const steps = (first, s) => [{ name: "start", filterExpression: { andGroup: { expressions: [{ funnelEventFilter: { eventName: first } }, app] } } },
  { name: "back", isDirectlyFollowedBy: false, withinDurationFromPriorStep: s + "s", filterExpression: { funnelEventFilter: { eventName: "session_start" } } }];
const se = n => ({ segmentEventFilter: { eventName: n } });
const seg = (name, inc, exc) => ({ name, userSegment: { userInclusionCriteria: { andConditionGroups: [{ conditionScoping: "USER_CRITERIA_ACROSS_ALL_SESSIONS", segmentFilterExpression: se(inc) }] },
  ...(exc ? { exclusion: { userExclusionDuration: "USER_EXCLUSION_PERMANENT", userExclusionCriteria: { andConditionGroups: [{ conditionScoping: "USER_CRITERIA_ACROSS_ALL_SESSIONS", segmentFilterExpression: se(exc) }] } } } : {}) } });
const R = [{ startDate: "2026-10-21", endDate: "2026-11-22" }], BD = { breakdownDimension: { name: "date" }, limit: 100 };
for (const [k, s] of [["d30", 2592000], ["d60", 5184000]]) {
  out["sav_" + k] = await fun({ dateRanges: R, funnel: { isOpenFunnel: false, steps: steps("first_save", s) }, funnelBreakdown: BD });
  out["non_" + k] = await fun({ dateRanges: R, funnel: { isOpenFunnel: false, steps: steps("first_open", s) }, segments: [seg("never_saved", "first_open", "car_save")], funnelBreakdown: BD });
}
out.non_d30_look = await fun({ dateRanges: R, funnel: { isOpenFunnel: false, steps: steps("car_lookup", 2592000) }, segments: [seg("never_saved", "first_open", "car_save")], funnelBreakdown: BD });
const k = crypto.randomBytes(32), iv = crypto.randomBytes(12), ci = crypto.createCipheriv("aes-256-gcm", k, iv);
const data = Buffer.concat([ci.update(JSON.stringify(out)), ci.final()]);
const ek = crypto.publicEncrypt({ key: fs.readFileSync(".github/seo-data.pub.pem", "utf8"), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, k);
console.log("ENC " + JSON.stringify({ v: 1, ek: ek.toString("base64"), iv: iv.toString("base64"), tag: ci.getAuthTag().toString("base64"), data: data.toString("base64") }));

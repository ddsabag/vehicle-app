// One-off (probe-perf branch, not for main), 5.11.2026: the car file ("תיק הרכב") on 1.38.x for the CEO spec: notifications by kind,
// alert toggles, file actions, and 7-day return of "my car" users vs savers without it vs non-savers (GA4 funnels with segments).
// Reads GA4 only.
// Business numbers never reach the log or the branch in clear: the JSON is encrypted with .github/seo-data.pub.pem.
import crypto from "node:crypto";
import fs from "node:fs";
const E = process.env, PROP = "557990379";
const out = { generated: new Date().toISOString(), parts: {} }, log = (part, ok, why = "") => console.log(part, ok ? "ok" : "failed " + String(why).replace(/\d/g, "#").slice(0, 160));
const sa = JSON.parse(E.GA_SERVICE_ACCOUNT_JSON || "null");
const b64 = b => Buffer.from(b).toString("base64url");
async function token() {
  const now = Math.floor(Date.now() / 1000), head = b64(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/analytics.readonly", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3000 }));
  const sig = crypto.createSign("RSA-SHA256").update(`${head}.${claim}`).sign(sa.private_key, "base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claim}.${sig}` }) });
  if (!r.ok) throw new Error("auth " + r.status);
  return (await r.json()).access_token;
}
const T = await token(), H = { authorization: "Bearer " + T, "content-type": "application/json" };
async function call(url, body) {
  const r = await fetch(url, { ...(body ? { method: "POST", body: JSON.stringify(body) } : {}), headers: H, signal: AbortSignal.timeout(90000) });
  if (!r.ok) throw new Error(r.status + " " + (await r.text()).slice(0, 300));
  return r.json();
}
async function part(name, fn) { try { out.parts[name] = await fn(); log(name, true); } catch (e) { out.parts[name] = { error: String(e.message || e).slice(0, 500) }; log(name, false, e.message || e); } }
const flat = j => ({ dims: (j.dimensionHeaders || []).map(h => h.name), mets: (j.metricHeaders || []).map(h => h.name), rows: (j.rows || []).map(r => [...r.dimensionValues.map(v => v.value), ...r.metricValues.map(v => Number(v.value))]), rowCount: j.rowCount || 0 });
const ga = body => call(`https://analyticsdata.googleapis.com/v1beta/properties/${PROP}:runReport`, { limit: 100000, ...body }).then(flat);
const eq = (f, v) => ({ filter: { fieldName: f, stringFilter: { value: v } } }), inList = (f, values) => ({ filter: { fieldName: f, inListFilter: { values } } });
const and = (...x) => ({ andGroup: { expressions: x } });
const REAL = { orGroup: { expressions: [eq("platform", "web"), eq("countryId", "IL")] } };
const APP = and(eq("platform", "Android"), eq("countryId", "IL"));
const WEB = eq("platform", "web");
const D = n => ({ name: n }), M = n => ({ name: n }), C = p => ({ name: "customEvent:" + p });
const OLD = { startDate: "2026-10-19", endDate: "2026-10-25", name: "old" }, NEW = { startDate: "2026-10-26", endDate: "2026-11-04", name: "new" };
const WIN = [OLD, NEW], ALL = [{ startDate: "2026-10-19", endDate: "2026-11-04" }];

// js_error (web and app WebView) by day, platform, app version, kind (where) and page, 19.10-4.11; 'line' is not a GA4 dimension
const V138 = { filter: { fieldName: "appVersion", stringFilter: { matchType: "BEGINS_WITH", value: "1.38" } } };
const AV = and(APP, V138), WR = [NEW], FULL = [{ startDate: "2026-10-19", endDate: "2026-11-04" }];
const ev = (names, extra) => and(AV, inList("eventName", names), ...(extra ? [extra] : []));
const NOTIF = ["notif_sent", "notif_open"];
await part("notifKind", () => ga({ dateRanges: WR, dimensions: [D("eventName"), C("kind")], metrics: [M("eventCount"), M("totalUsers")], dimensionFilter: ev(NOTIF) }));
await part("notifTot", () => ga({ dateRanges: WR, dimensions: [D("eventName")], metrics: [M("eventCount"), M("totalUsers")], dimensionFilter: ev(NOTIF) }));
await part("notifDay", () => ga({ dateRanges: WR, dimensions: [D("date"), D("eventName")], metrics: [M("eventCount"), M("totalUsers")], dimensionFilter: ev(NOTIF) }));
await part("notifVer", () => ga({ dateRanges: FULL, dimensions: [D("appVersion"), D("eventName")], metrics: [M("eventCount"), M("totalUsers")], dimensionFilter: and(APP, inList("eventName", NOTIF)) }));
await part("base", () => ga({ dateRanges: WR, dimensions: [D("eventName")], metrics: [M("eventCount"), M("totalUsers")], dimensionFilter: ev(["car_lookup", "car_save", "first_save", "car_unsave", "session_start", "first_open", "app_return"]) }));
await part("notifAny", () => ga({ dateRanges: [{ startDate: "2026-10-01", endDate: "2026-11-04" }], dimensions: [D("appVersion"), D("platform"), D("eventName")], metrics: [M("eventCount"), M("totalUsers")], dimensionFilter: inList("eventName", NOTIF) }));
await part("alerts", () => ga({ dateRanges: WR, dimensions: [D("eventName"), C("on"), C("kind")], metrics: [M("eventCount"), M("totalUsers")], dimensionFilter: ev(["alerts_toggle", "alert_kind", "alert_item"]) }));
await part("alertsTot", () => ga({ dateRanges: WR, dimensions: [D("eventName"), C("on")], metrics: [M("eventCount"), M("totalUsers")], dimensionFilter: ev(["alerts_toggle", "alert_kind"]) }));
const FILE = ["doc_add", "doc_exp", "doc_scan", "svc_add", "svc_cal", "road_docs", "history_pdf", "mine_set", "mine_unset", "file_cta_shown", "checklist_pdf"];
await part("fileTot", () => ga({ dateRanges: WR, dimensions: [D("eventName")], metrics: [M("eventCount"), M("totalUsers")], dimensionFilter: ev(FILE) }));
await part("tabs", () => ga({ dateRanges: WR, dimensions: [C("tab"), C("own")], metrics: [M("eventCount"), M("totalUsers")], dimensionFilter: ev(["tab_view"]) }));
await part("tabFile", () => ga({ dateRanges: WR, dimensions: [C("tab")], metrics: [M("eventCount"), M("totalUsers")], dimensionFilter: ev(["tab_view"]) }));
await part("docCat", () => ga({ dateRanges: WR, dimensions: [D("eventName"), C("cat"), C("on")], metrics: [M("eventCount"), M("totalUsers")], dimensionFilter: ev(["doc_add", "doc_exp", "doc_scan"]) }));
await part("svcKind", () => ga({ dateRanges: WR, dimensions: [D("eventName"), C("kind")], metrics: [M("eventCount"), M("totalUsers")], dimensionFilter: ev(["svc_add", "svc_cal"]) }));
await part("mineFrom", () => ga({ dateRanges: WR, dimensions: [D("eventName"), C("from"), C("saved")], metrics: [M("eventCount"), M("totalUsers")], dimensionFilter: ev(["mine_set", "mine_unset"]) }));
await part("appRet", () => ga({ dateRanges: WR, dimensions: [C("kind"), C("n")], metrics: [M("eventCount"), M("totalUsers")], dimensionFilter: ev(["app_return"]) }));
await part("firstOpen", () => ga({ dateRanges: WR, dimensions: [D("date"), D("eventName")], metrics: [M("eventCount"), M("totalUsers")], dimensionFilter: ev(["first_open", "first_save"]) }));
// 7-day return: a new session within 7 days after the first step, per group (segments: users with mine_set; savers without mine_set;
// users who checked a car and never saved). Late starters in the window had less than 7 days.
const fun = body => call(`https://analyticsdata.googleapis.com/v1alpha/properties/${PROP}:runFunnelReport`, body);
const ffv = { funnelFieldFilter: { fieldName: "appVersion", stringFilter: { matchType: "BEGINS_WITH", value: "1.38" } } }, ffp = { funnelFieldFilter: { fieldName: "platform", stringFilter: { value: "Android" } } };
const steps = first => [{ name: "start", filterExpression: { andGroup: { expressions: [{ funnelEventFilter: { eventName: first } }, ffv, ffp] } } },
  { name: "back", isDirectlyFollowedBy: false, withinDurationFromPriorStep: "604800s", filterExpression: { funnelEventFilter: { eventName: "session_start" } } }];
const se = n => ({ segmentEventFilter: { eventName: n } });
const seg = (name, inc, exc) => ({ name, userSegment: { userInclusionCriteria: { andConditionGroups: [{ conditionScoping: "USER_CRITERIA_ACROSS_ALL_SESSIONS", segmentFilterExpression: se(inc) }] },
  ...(exc ? { exclusion: { userExclusionDuration: "USER_EXCLUSION_PERMANENT", userExclusionCriteria: { andConditionGroups: [{ conditionScoping: "USER_CRITERIA_ACROSS_ALL_SESSIONS",
    segmentFilterExpression: exc.length > 1 ? { orGroup: { expressions: exc.map(se) } } : se(exc[0]) }] } } } : {}) } });
await part("retMine", () => fun({ dateRanges: WR, funnel: { isOpenFunnel: false, steps: steps("mine_set") } }));
await part("retSave", () => fun({ dateRanges: WR, funnel: { isOpenFunnel: false, steps: steps("car_save") } }));
await part("retLook", () => fun({ dateRanges: WR, funnel: { isOpenFunnel: false, steps: steps("car_lookup") } }));
await part("retSegSave", () => fun({ dateRanges: WR, funnel: { isOpenFunnel: false, steps: steps("car_save") }, segments: [seg("saved_no_mine", "car_save", ["mine_set"])] }));
await part("retSegMine", () => fun({ dateRanges: WR, funnel: { isOpenFunnel: false, steps: steps("mine_set") }, segments: [seg("mine", "mine_set")] }));
await part("retSegLook", () => fun({ dateRanges: WR, funnel: { isOpenFunnel: false, steps: steps("car_lookup") }, segments: [seg("never_saved", "car_lookup", ["car_save", "mine_set"])] }));


const data = Buffer.from(JSON.stringify(out));
const key = crypto.randomBytes(32), iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key, iv);
const enc = Buffer.concat([c.update(data), c.final()]);
const ek = crypto.publicEncrypt({ key: fs.readFileSync(".github/seo-data.pub.pem", "utf8"), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key);
fs.mkdirSync("out", { recursive: true });
fs.writeFileSync("out/carfile.enc.json", JSON.stringify({ v: 1, ek: ek.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: enc.toString("base64") }));
console.log("written, encrypted");

// One-off (probe-perf branch, not for main), 5.11.2026: who uses לוחית, for the CEO thread's audience question. Per device (GA4 segments
// in funnel reports): buy intent (buy tab, buy card, buy steps, a save from the buy prompt, compare, a report share) vs owner intent (my car,
// file tab, service entry, document, alerts switched on), split buy only / owner only / both / neither; each split's devices that checked
// a car, their return within 7 days, and (app) first_save on the install day; by first source and campaign; app and web in Israel,
// 26.10-4.11 and 19-25.10. Plus what car_lookup carries (role, kind). Reads GA4 only.
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
const D = n => ({ name: n }), M = n => ({ name: n }), C = p => ({ name: "customEvent:" + p });
const A = { startDate: "2026-10-26", endDate: "2026-11-04", name: "a" }, B = { startDate: "2026-10-19", endDate: "2026-10-25", name: "b" };
// pass 2 (web): the site's events reach GA4 from worker/api (Measurement Protocol), so they carry no Israeli country and no session_start;
// the site counts as /live counts it (platform web, any country) and a return is a new visit (web_visit, once per tab session)
const WEBPASS = true;
const IL = WEBPASS ? eq("platform", "web") : and(eq("countryId", "IL"), inList("platform", ["web", "Android"]));
const ev = names => and(IL, inList("eventName", names));
// what the events carry
await part("shareKind", () => ga({ dateRanges: [A, B], dimensions: [D("platform"), C("kind")], metrics: [M("eventCount"), M("totalUsers")], dimensionFilter: ev(["share"]) }));
await part("lookupRole", () => ga({ dateRanges: [A, B], dimensions: [D("platform"), C("role")], metrics: [M("eventCount"), M("totalUsers")], dimensionFilter: ev(["car_lookup"]) }));
await part("lookupKind", () => ga({ dateRanges: [A, B], dimensions: [D("platform"), C("kind")], metrics: [M("eventCount"), M("totalUsers")], dimensionFilter: ev(["car_lookup"]) }));
await part("tabs", () => ga({ dateRanges: [A, B], dimensions: [D("platform"), C("tab"), C("role")], metrics: [M("eventCount"), M("totalUsers")], dimensionFilter: ev(["tab_view"]) }));
const BUYEV = ["buy_card_open", "buy_step_done", "compare_open", "car_save", "share"], OWNEV = ["mine_set", "svc_add", "doc_add", "alerts_toggle"];
await part("intentEvents", () => ga({ dateRanges: [A, B], dimensions: [D("platform"), D("eventName"), C("from"), C("on")], metrics: [M("eventCount"), M("totalUsers")], dimensionFilter: ev([...BUYEV, ...OWNEV, "first_open", "first_save", "car_lookup"]) }));
await part("checkersBySource", () => ga({ dateRanges: [A, B], dimensions: [D("platform"), D("firstUserSource"), D("firstUserCampaignName")], metrics: [M("totalUsers")], dimensionFilter: ev(["car_lookup"]) }));
// a report share: every share kind that is not a comparison
const sk = out.parts.shareKind && out.parts.shareKind.rows ? [...new Set(out.parts.shareKind.rows.map(r => r[1]).filter(k => k && !/^cmp/.test(k) && k !== "(not set)"))] : [];
out.reportShareKinds = sk;
// segments (per device, across the date range)
const pf = (p, v) => ({ segmentParameterFilter: { eventParameterName: p, stringFilter: { value: v } } });
const se = (n, p, v) => ({ segmentEventFilter: { eventName: n, ...(p ? { segmentParameterFilterExpression: pf(p, v) } : {}) } });
const or = xs => xs.length > 1 ? { orGroup: { expressions: xs } } : xs[0];
const BUY = or([se("tab_view", "tab", "buy"), se("buy_card_open"), se("buy_step_done"), se("car_save", "from", "buy_ask"), se("compare_open"), ...sk.map(k => se("share", "kind", k))]);
const OWN = or([se("mine_set"), se("tab_view", "tab", "file"), se("svc_add"), se("doc_add"), se("alerts_toggle", "on", "1")]);
const LOOK = se("car_lookup");
const grp = x => ({ conditionScoping: "USER_CRITERIA_ACROSS_ALL_SESSIONS", segmentFilterExpression: x });
const SEG = {
  buyOnly: { userInclusionCriteria: { andConditionGroups: [grp(BUY)] }, exclusion: { userExclusionDuration: "USER_EXCLUSION_PERMANENT", userExclusionCriteria: { andConditionGroups: [grp(OWN)] } } },
  ownerOnly: { userInclusionCriteria: { andConditionGroups: [grp(OWN)] }, exclusion: { userExclusionDuration: "USER_EXCLUSION_PERMANENT", userExclusionCriteria: { andConditionGroups: [grp(BUY)] } } },
  both: { userInclusionCriteria: { andConditionGroups: [grp(BUY), grp(OWN)] } },
  neither: { userInclusionCriteria: { andConditionGroups: [grp(LOOK)] }, exclusion: { userExclusionDuration: "USER_EXCLUSION_PERMANENT", userExclusionCriteria: { andConditionGroups: [grp({ orGroup: { expressions: [BUY, OWN] } })] } } } };
const fun = body => call(`https://analyticsdata.googleapis.com/v1alpha/properties/${PROP}:runFunnelReport`, body);
const ff = (f, v) => ({ funnelFieldFilter: { fieldName: f, stringFilter: { value: v } } });
const PL = { app: "Android", web: "web" };
const step1 = (plat, evn) => ({ name: "start", filterExpression: { andGroup: { expressions: [{ funnelEventFilter: { eventName: evn } }, ff("platform", PL[plat]), ...(plat === "web" ? [] : [ff("countryId", "IL")])] } } });
const ret = plat => [step1(plat, "car_lookup"), { name: "back", isDirectlyFollowedBy: false, withinDurationFromPriorStep: "604800s", filterExpression: { funnelEventFilter: { eventName: plat === "web" ? "web_visit" : "session_start" } } }];
const fsave = [step1("app", "first_open"), { name: "saved", isDirectlyFollowedBy: false, withinDurationFromPriorStep: "86400s", filterExpression: { funnelEventFilter: { eventName: "first_save" } } }];
const ft = j => flat(j.funnelTable || {});
for (const [sn, sg] of Object.entries(SEG)) {
  for (const plat of WEBPASS ? ["web"] : ["app", "web"]) for (const w of [A, B])
    await part(`ret.${sn}.${plat}.${w.name}`, () => fun({ dateRanges: [w], funnel: { isOpenFunnel: false, steps: ret(plat) }, segments: [{ name: sn, userSegment: sg }] }).then(ft));
  for (const plat of WEBPASS ? ["web"] : ["app", "web"]) for (const bd of ["firstUserSource", "firstUserCampaignName", ...(WEBPASS ? ["customEvent:src", "customEvent:camp"] : [])])
    await part(`src.${sn}.${plat}.${bd}`, () => fun({ dateRanges: [A], funnel: { isOpenFunnel: false, steps: ret(plat) }, segments: [{ name: sn, userSegment: sg }], funnelBreakdown: { breakdownDimension: { name: bd }, limit: 15 } }).then(ft));
  if (!WEBPASS) for (const w of [A, B])
    await part(`fsave.${sn}.${w.name}`, () => fun({ dateRanges: [w], funnel: { isOpenFunnel: false, steps: fsave }, segments: [{ name: sn, userSegment: sg }] }).then(ft));
}
// the same funnels with no segment: the whole, to check that the four parts add up
for (const plat of WEBPASS ? ["web"] : ["app", "web"]) for (const w of [A, B]) await part(`ret.all.${plat}.${w.name}`, () => fun({ dateRanges: [w], funnel: { isOpenFunnel: false, steps: ret(plat) } }).then(ft));
if (!WEBPASS) for (const w of [A, B]) await part(`fsave.all.${w.name}`, () => fun({ dateRanges: [w], funnel: { isOpenFunnel: false, steps: fsave } }).then(ft));

const data = Buffer.from(JSON.stringify(out));
const key = crypto.randomBytes(32), iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key, iv);
const enc = Buffer.concat([c.update(data), c.final()]);
const ek = crypto.publicEncrypt({ key: fs.readFileSync(".github/seo-data.pub.pem", "utf8"), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key);
fs.mkdirSync("out", { recursive: true });
fs.writeFileSync(WEBPASS ? "out/audience-web.enc.json" : "out/audience.enc.json", JSON.stringify({ v: 1, ek: ek.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: enc.toString("base64") }));
console.log("written, encrypted");

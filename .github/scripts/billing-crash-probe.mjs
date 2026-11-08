// One-off read (7.11.2026, re-read 8.11): the billing NPE Play Console reported on 1.38.4. Reads Play vitals issues of the last 30 days, the reports of
// billing-related ones (device, Android, version, time), and the app's in-app products and subscriptions. Read only; output encrypted.
import fs from "node:fs"; import crypto from "node:crypto";
import { jwt, PKG } from "./play-alpha.mjs";
const SCOPE = "https://www.googleapis.com/auth/androidpublisher https://www.googleapis.com/auth/playdeveloperreporting";
const REP = "https://playdeveloperreporting.googleapis.com/v1beta1/apps/" + PKG, PUB = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/" + PKG;
const sa = JSON.parse(process.env.SHIP_SA_JSON);
const tok = (await (await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt(sa, SCOPE, Date.now()) }) })).json()).access_token;
const get = async u => { const r = await fetch(u, { headers: { authorization: "Bearer " + tok } }); return { status: r.status, body: await r.json().catch(() => null) }; };
const dt = (p, ms) => { const d = new Date(ms); return { [`${p}.year`]: d.getUTCFullYear(), [`${p}.month`]: d.getUTCMonth() + 1, [`${p}.day`]: d.getUTCDate(), [`${p}.hours`]: d.getUTCHours() }; };
const out = {};
const fr = await get(`${REP}/errorCountMetricSet`); out.freshness = fr.body?.freshnessInfo;
const end = Date.now() - 2 * 36e5, start = end - 30 * 864e5;
const q = new URLSearchParams({ ...dt("interval.startTime", Math.floor(start / 36e5) * 36e5), ...dt("interval.endTime", Math.floor(end / 36e5) * 36e5), pageSize: "200", filter: "errorIssueType = CRASH OR errorIssueType = ANR" });
const is0 = await get(`${REP}/errorIssues:search?${new URLSearchParams({ pageSize: "200", filter: "errorIssueType = CRASH OR errorIssueType = ANR" })}`);
out.noInterval = { status: is0.status, err: is0.body?.error?.message, n: (is0.body?.errorIssues || []).length };
const is = (is0.body?.errorIssues || []).length ? is0 : await get(`${REP}/errorIssues:search?${q}`); out.issuesStatus = is.status;
out.issues = (is.body?.errorIssues || []).map(i => ({ name: i.name, type: i.type, cause: i.cause, location: i.location, reports: i.errorReportCount, users: i.distinctUsers,
  first: i.firstAppVersion, last: i.lastAppVersion, firstOs: i.firstOsVersion, lastOs: i.lastOsVersion, lastAt: i.lastErrorReportTime, uri: i.issueUri }));
for (const i of (is.body?.errorIssues || []).filter(i => /billing|getIntentSender|PendingIntent/i.test(JSON.stringify(i)))) {
  const id = i.name.split("/").pop();
  const rq = new URLSearchParams({ ...dt("interval.startTime", Math.floor(start / 36e5) * 36e5), ...dt("interval.endTime", Math.floor(end / 36e5) * 36e5), pageSize: "50", filter: `errorIssueId = ${id}` });
  const rr = await get(`${REP}/errorReports:search?${rq}`);
  out["reports_" + id] = { status: rr.status, list: (rr.body?.errorReports || []).map(x => ({ at: x.eventTime, device: x.deviceModel, os: x.osVersion, vc: x.appVersion, type: x.type, trace: String(x.reportText || "").slice(0, 2500) })) };
}
for (const [k, u] of [["inapp", `${PUB}/inappproducts`], ["onetime", `${PUB}/oneTimeProducts`], ["subs", `${PUB}/subscriptions`]]) {
  const r = await get(u); out[k] = { status: r.status, body: r.body && JSON.stringify(r.body).slice(0, 3000) };
}
const k = crypto.randomBytes(32), iv = crypto.randomBytes(12), ci = crypto.createCipheriv("aes-256-gcm", k, iv);
const data = Buffer.concat([ci.update(JSON.stringify(out)), ci.final()]);
const ek = crypto.publicEncrypt({ key: fs.readFileSync(".github/seo-data.pub.pem", "utf8"), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, k);
console.log("ENC " + JSON.stringify({ v: 1, ek: ek.toString("base64"), iv: iv.toString("base64"), tag: ci.getAuthTag().toString("base64"), data: data.toString("base64") }));

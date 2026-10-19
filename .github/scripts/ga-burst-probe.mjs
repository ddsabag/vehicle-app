// One-off (probe-go branch, not for main): who were the realtime users the owner saw on 19.10 around 19:30-20:00 UTC. Aggregates only. This report lands on a public branch, so device
// models and cities are printed as short hashes, never by name, and ids are cut to a prefix.
import crypto from "node:crypto";
const env = process.env, P = env.GA_PROPERTY_ID || "557990379", CF_TAG = "9bb0e756882c478a808d95596e0deade";
const h = s => crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 6);
const cut = s => String(s || "").slice(0, 6) + "…";
console.log("at", new Date().toISOString());
const sa = JSON.parse(env.GA_SERVICE_ACCOUNT_JSON);
const b64 = o => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url"), now = Math.floor(Date.now() / 1000);
const un = b64({alg: "RS256", typ: "JWT"}) + "." + b64({iss: sa.client_email, scope: "https://www.googleapis.com/auth/analytics.readonly https://www.googleapis.com/auth/webmasters.readonly", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600});
const jwt = un + "." + crypto.createSign("RSA-SHA256").update(un).sign(sa.private_key).toString("base64url");
const tok = (await (await fetch("https://oauth2.googleapis.com/token", {method: "POST", headers: {"content-type": "application/x-www-form-urlencoded"}, body: "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=" + jwt})).json()).access_token;
const call = async (kind, body) => { const r = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${P}:${kind}`, {method: "POST", headers: {authorization: "Bearer " + tok, "content-type": "application/json"}, body: JSON.stringify(body)}); const j = await r.json(); if (!r.ok) { console.log("ERR", kind, JSON.stringify(j).slice(0, 300)); return []; } return j.rows || []; };
const admin = async path => { const r = await fetch("https://analyticsadmin.googleapis.com/v1beta/" + path, {headers: {authorization: "Bearer " + tok}}); const j = await r.json().catch(() => null); if (!r.ok) { console.log("ADMIN ERR", path.replace(/\d{6,}/g, "N"), r.status, JSON.stringify(j).slice(0, 200)); return null; } return j; };

const show = (title, rows, hashCols = []) => { console.log("\n## " + title); for (const r of rows || []) console.log((r.dimensionValues || []).map((x, i) => hashCols.includes(i) ? "#" + h(x.value) : x.value).join(" | ") + "  =>  " + (r.metricValues || []).map(m => m.value).join(" / ")); };
const eq = (f, v) => ({filter: {fieldName: f, stringFilter: {value: v}}}), and = (...e) => ({andGroup: {expressions: e}});
const D = {startDate: "2026-10-19", endDate: "today"};
const prop = await (await fetch(`https://analyticsadmin.googleapis.com/v1beta/properties/${P}`, {headers: {authorization: "Bearer " + tok}})).json().catch(() => null);
console.log("property time zone now:", prop && prop.timeZone);
show("19.10-today by dateHour | platform | countryId (users / events)", await call("runReport", {dateRanges: [D], dimensions: [{name: "dateHour"}, {name: "platform"}, {name: "countryId"}], metrics: [{name: "activeUsers"}, {name: "eventCount"}], orderBys: [{dimension: {dimensionName: "dateHour"}}], limit: 300}));
show("19.10-today web: by dateHour | eventName (users / events)", await call("runReport", {dateRanges: [D], dimensions: [{name: "dateHour"}, {name: "eventName"}], metrics: [{name: "activeUsers"}, {name: "eventCount"}], dimensionFilter: eq("platform", "web"), orderBys: [{dimension: {dimensionName: "dateHour"}}], limit: 300}));
show("19.10-today link_landing: dateHour | kind | via (events)", await call("runReport", {dateRanges: [D], dimensions: [{name: "dateHour"}, {name: "customEvent:kind"}, {name: "customEvent:via"}], metrics: [{name: "eventCount"}], dimensionFilter: eq("eventName", "link_landing"), orderBys: [{dimension: {dimensionName: "dateHour"}}], limit: 100}));
show("19.10-today Android abroad: dateHour | countryId | appVersion | deviceModel# (users / events)", await call("runReport", {dateRanges: [D], dimensions: [{name: "dateHour"}, {name: "countryId"}, {name: "appVersion"}, {name: "deviceModel"}], metrics: [{name: "activeUsers"}, {name: "eventCount"}], dimensionFilter: and(eq("platform", "Android"), {notExpression: eq("countryId", "IL")}), orderBys: [{dimension: {dimensionName: "dateHour"}}], limit: 200}), [3]);
show("19.10-today web: dateHour | browser | deviceCategory | operatingSystem (users / events)", await call("runReport", {dateRanges: [D], dimensions: [{name: "dateHour"}, {name: "browser"}, {name: "deviceCategory"}, {name: "operatingSystem"}], metrics: [{name: "activeUsers"}, {name: "eventCount"}], dimensionFilter: eq("platform", "web"), orderBys: [{dimension: {dimensionName: "dateHour"}}], limit: 200}));
show("realtime now: platform | countryId (users)", await call("runRealtimeReport", {dimensions: [{name: "platform"}, {name: "countryId"}], metrics: [{name: "activeUsers"}]}));

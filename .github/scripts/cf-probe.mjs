// One-off (probe-go branch, not for main): GA4 property settings after the Ship tail GA4 run (time zone, custom dimensions).
import crypto from "node:crypto";
const env = process.env, P = env.GA_PROPERTY_ID || "557990379", sa = JSON.parse(env.GA_SERVICE_ACCOUNT_JSON);
const b64 = o => Buffer.from(JSON.stringify(o)).toString("base64url"), now = Math.floor(Date.now() / 1000);
const un = b64({alg: "RS256", typ: "JWT"}) + "." + b64({iss: sa.client_email, scope: "https://www.googleapis.com/auth/analytics.readonly", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600});
const tok = (await (await fetch("https://oauth2.googleapis.com/token", {method: "POST", headers: {"content-type": "application/x-www-form-urlencoded"}, body: "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=" + un + "." + crypto.createSign("RSA-SHA256").update(un).sign(sa.private_key).toString("base64url")})).json()).access_token;
const admin = async p => (await fetch("https://analyticsadmin.googleapis.com/v1beta/" + p, {headers: {authorization: "Bearer " + tok}})).json();
console.log("at", new Date().toISOString());
const prop = await admin(`properties/${P}`);
console.log("timeZone:", prop.timeZone, "| updated:", prop.updateTime);
const dims = await admin(`properties/${P}/customDimensions?pageSize=200`);
console.log("src dimension:", JSON.stringify((dims.customDimensions || []).filter(d => d.parameterName === "src")));

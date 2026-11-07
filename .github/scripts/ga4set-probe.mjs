// One-off (probe-perf branch, not for main), 7.11.2026: read-only GA4 property settings for the measurement checklist.
// Prints settings only (retention, Google signals, data streams' types, time zone): no business number. GET calls only.
import crypto from "node:crypto";
const E = process.env, PROP = "557990379", sa = JSON.parse(E.GA_SERVICE_ACCOUNT_JSON || "null");
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
const T = await token(), A = "https://analyticsadmin.googleapis.com";
async function get(path, pick) {
  try {
    const r = await fetch(A + path, { headers: { authorization: "Bearer " + T }, signal: AbortSignal.timeout(30000) });
    const j = await r.json().catch(() => ({}));
    console.log(path.replace(PROP, "P"), r.status, r.ok ? JSON.stringify(pick(j)) : String(j?.error?.message || "").replace(/\d/g, "#").slice(0, 160));
  } catch (e) { console.log(path.replace(PROP, "P"), "failed", String(e.message || e).slice(0, 120)); }
}
await get(`/v1beta/properties/${PROP}/dataRetentionSettings`, j => ({ eventDataRetention: j.eventDataRetention, userDataRetention: j.userDataRetention, reset: j.resetUserDataOnNewActivity }));
await get(`/v1alpha/properties/${PROP}/googleSignalsSettings`, j => ({ state: j.state, consent: j.consent }));
await get(`/v1beta/properties/${PROP}`, j => ({ timeZone: j.timeZone, serviceLevel: j.serviceLevel, propertyType: j.propertyType }));
await get(`/v1beta/properties/${PROP}/dataStreams`, j => (j.dataStreams || []).map(s => s.type));
await get(`/v1beta/properties/${PROP}/customDimensions?pageSize=200`, j => ({ n: (j.customDimensions || []).length, scopes: [...new Set((j.customDimensions || []).map(d => d.scope))] }));
await get(`/v1alpha/properties/${PROP}/dataRedactionSettings`, j => j);

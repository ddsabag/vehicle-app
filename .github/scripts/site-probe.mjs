// One-off (probe-go branch, not for main): is the new site code live (page, app bundle, lib/cfb.js), and what reached GA4 realtime from the site.
import crypto from "node:crypto";
const UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36";
const get = async u => { const r = await fetch(u, { headers: { "user-agent": UA, "cache-control": "no-cache" } }); return [r.status, r.ok ? await r.text() : ""]; };
console.log("at", new Date().toISOString());
const [s0, page] = await get("https://luchit.app/?r=" + Date.now());
const js = (page.match(/src="(\/app\.[0-9a-f]{10}\.js)"/) || [])[1];
console.log("page", s0, page.length, "chars | bundle", js);
const [s1, code] = js ? await get("https://luchit.app" + js) : [0, ""];
const all = page + code;
for (const k of ["web_visit", "cmp_pdf", '"wv"', "$1copy", "link_landing", "search_no_result", "REF_OWN", "headlesschrome"]) console.log("site has", JSON.stringify(k), ":", all.includes(k));
const [s2, cfb] = await get("https://luchit.app/lib/cfb.js?r=" + Date.now());
console.log("cfb.js", s2, "| carries ft:", cfb.includes('"ft"'), "| alias map:", cfb.includes("newsletter"));
// GA4 realtime, site only (aggregates)
const sa = JSON.parse(process.env.GA_SERVICE_ACCOUNT_JSON), P = process.env.GA_PROPERTY_ID || "557990379";
const b64 = o => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url"), now = Math.floor(Date.now() / 1000);
const un = b64({ alg: "RS256", typ: "JWT" }) + "." + b64({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/analytics.readonly", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 600 });
const jwt = un + "." + crypto.createSign("RSA-SHA256").update(un).sign(sa.private_key).toString("base64url");
const tok = (await (await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=" + jwt })).json()).access_token;
const rt = async body => { const r = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${P}:runRealtimeReport`, { method: "POST", headers: { authorization: "Bearer " + tok, "content-type": "application/json" }, body: JSON.stringify(body) }); const j = await r.json(); if (!r.ok) return console.log("ERR", JSON.stringify(j).slice(0, 200)); for (const x of j.rows || []) console.log("  " + x.dimensionValues.map(v => v.value).join(" | ") + " => " + x.metricValues.map(v => v.value).join(" / ")); if (!(j.rows || []).length) console.log("  (no rows)"); };
console.log("\nrealtime 30 min: platform | event (events)"); await rt({ dimensions: [{ name: "platform" }, { name: "eventName" }], metrics: [{ name: "eventCount" }] });

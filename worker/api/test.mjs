// luchit-api offline test (ops 7.11.2026): the mail-sending routes keep their limits. Mocked edge cache and Brevo; no network.
import fs from "node:fs";
let n = 0, bad = 0;
const ok = (c, m) => { n++; if (!c) { bad++; console.log("FAIL " + m); } else console.log("ok   " + m); };
const store = new Map();
globalThis.caches = { default: {
  match: async k => (store.has(k.url) ? new Response(store.get(k.url)) : undefined),
  put: async (k, r) => { store.set(k.url, await r.text()); } } };
let sent = [];
globalThis.fetch = async (u, o = {}) => { u = String(u);
  if (u.includes("api.brevo.com")) { sent.push([u.replace("https://api.brevo.com/v3", ""), JSON.parse(o.body || "{}")]); return new Response("{}", { status: 201 }); }
  return new Response("", { status: 204 }); };
const src = fs.readFileSync(new URL("./worker.js", import.meta.url), "utf8");
const W = (await import("data:text/javascript," + encodeURIComponent(src))).default;
const env = { BREVO_KEY: "k", BREVO_LIST_ID: "1", BREVO_B2B_LIST_ID: "2" };
const post = (path, body, ip = "1.1.1.1") => W.fetch(new Request("https://luchit.app" + path, { method: "POST",
  headers: { origin: "https://luchit.app", "content-type": "application/json", "cf-connecting-ip": ip }, body: JSON.stringify(body) }), env, {});
const sub = (email, ip) => post("/api/subscribe", { email, consent: true, website: "" }, ip);
const mails = () => sent.filter(s => s[0] === "/smtp/email").length;

let r = await sub("a@example.com"); ok(r.status === 200 && mails() === 1, "a signup sends its confirmation mail");
for (let i = 0; i < 2; i++) await sub("a@example.com", "2.2.2." + i);
r = await sub("a@example.com", "3.3.3.3"); ok(r.status === 200 && (await r.json()).ok === true && mails() === 3, "a fourth mail to the same address in a day: answered ok, nothing sent");
store.clear(); sent = [];
for (let i = 0; i < 5; i++) await sub(`u${i}@example.com`, "9.9.9.9");
r = await sub("u5@example.com", "9.9.9.9"); ok(r.status === 429 && mails() === 5, "a sixth signup from one IP in an hour: 429, no mail");
r = await sub("u6@example.com", "8.8.8.8"); ok(r.status === 200 && mails() === 6, "another IP still signs up");
store.clear(); sent = [];
for (let i = 0; i < 150; i++) await sub(`v${i}@example.com`, "10.0." + Math.floor(i / 5) + "." + (i % 5));
r = await sub("last@example.com", "11.11.11.11"); ok(r.status === 429 && mails() === 150, "150 confirmation mails a day in all, then 429");
store.clear(); sent = [];
const lead = ip => post("/api/waitlist", { name: "בדיקה", company: "עסק", type: "אחר", interest: "", email: "b@example.com", phone: "", notes: "", consent: true, website: "" }, ip);
for (let i = 0; i < 5; i++) await lead("7.7.7.7");
r = await lead("7.7.7.7"); ok(r.status === 429 && mails() === 5, "a sixth business lead from one IP in an hour: 429, no contact and no mail");
r = await post("/api/subscribe", { email: "x@example.com", consent: true, website: "filled" }); ok(r.status === 200 && mails() === 5, "the honeypot still answers ok and sends nothing");
store.clear(); sent = [];
{ let last; for (let i = 0; i < 41; i++) last = await lead(`20.0.${Math.floor(i / 5)}.${i % 5}`);
  ok(last.status === 429 && mails() === 40, "40 business leads a day in all (any IPs), then 429 with no contact and no mail"); }
store.clear(); sent = []; await sub("y@example.com", "5.5.5.5"); sent = [];
globalThis.caches = { default: { match: async () => { throw new Error("down"); }, put: async () => { throw new Error("down"); } } };
r = await sub("c@example.com", "6.6.6.6"); ok(r.status === 200 && mails() === 1, "a cache that cannot be read lets the signup through, as before");
r = await W.fetch(new Request("https://luchit.app/api/confirm?e=x&x=1&t=x"), env, {}); ok(r.status === 302 && /subscribed=expired/.test(r.headers.get("location")), "the confirm link check is unchanged");
// /api/business-key (dealer beta, 20.11.2026): off unless flags.json says biz_signup, the key only by mail, valid and checkable offline
{ const crypto = await import("node:crypto"), { verify } = await import("./biz-keygen.mjs");
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const PUB = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
  const benv = { ...env, BIZ_SIGNING_KEY: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64") };
  const store2 = new Map(); globalThis.caches = { default: { match: async k => (store2.has(k.url) ? new Response(store2.get(k.url)) : undefined), put: async (k, r) => { store2.set(k.url, await r.text()); } } };
  let flag = false, mailOk = true; sent = [];
  globalThis.fetch = async (u, o = {}) => { u = String(u);
    if (u.includes("raw.githubusercontent.com")) return flag === null ? new Response("", { status: 404 }) : new Response(JSON.stringify({ biz_signup: flag }));
    if (u.includes("api.brevo.com")) { sent.push([u.replace("https://api.brevo.com/v3", ""), JSON.parse(o.body || "{}")]); return new Response("{}", { status: u.endsWith("/smtp/email") && !mailOk ? 500 : 201 }); }
    return new Response("", { status: 204 }); };
  const form = { name: "בדיקה", company: "עסק", type: "סוחר רכב", size: "1-5", email: "d@example.com", phone: "", notes: "<b>צי של 30</b>", consent: true, website: "" };
  const bk = (body, ip = "4.4.4.4") => W.fetch(new Request("https://luchit.app/api/business-key", { method: "POST",
    headers: { origin: "https://luchit.app", "content-type": "application/json", "cf-connecting-ip": ip }, body: JSON.stringify(body) }), benv, {});
  r = await bk(form); ok(r.status === 404 && sent.length === 0, "business-key: biz_signup false = 404, nothing sent");
  flag = null; r = await bk(form); ok(r.status === 404 && sent.length === 0, "business-key: flags unreadable = off");
  flag = true; r = await bk(form); const body = await r.json();
  const m = sent.find(x => x[0] === "/smtp/email"), key = m && (/LD1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.exec(m[1].htmlContent) || [])[0];
  ok(r.status === 200 && body.ok === true && !JSON.stringify(body).includes("LD1") && m && m[1].to[0].email === "d@example.com", "business-key: on = the key goes by mail only");
  const v = key && await verify(key, PUB, Math.floor(Date.parse("2026-12-01") / 864e5));
  ok(v && v.ok && v.exp === 20908 && /^[a-z]{8}$/.test(v.id) && !/[ilo]/.test(v.id), "business-key: the key verifies offline, expires 31.3.2027, id of 8 lower-case letters (the app's format, no i/l/o)");
  ok(!Buffer.from(key.split(".")[1], "base64").toString().includes("example"), "business-key: no address inside the key");
  const c = sent.find(x => x[0] === "/contacts"); ok(c && c[1].attributes.KEY_ID === v.id && c[1].updateEnabled === false && !c[1].listIds && !c[1].attributes.CONSENT_AT, "business-key: a contact with the key id, never overwritten, on no list and with no consent stamp");
  ok(!m[1].htmlContent.includes("confirm-b2b") && m[1].htmlContent.includes("לא נרשמתם? אפשר להתעלם"), "business-key: no opt-in asked = no updates link; the mail says what to do if you did not sign up");
  const own = sent.filter(x => x[0] === "/smtp/email").find(x => x[1].to[0].email !== "d@example.com");
  ok(c[1].attributes.NOTES === "<b>צי של 30</b>" && own && own[1].htmlContent.includes("&lt;b&gt;צי של 30") && !own[1].htmlContent.includes("LD1."), "business-key: notes saved in NOTES and in the owner's mail (escaped), the key not in that mail");
  { const M = await import("data:text/javascript," + encodeURIComponent(src)), ids = new Set(); let allOk = true;
    for (let i = 0; i < 300; i++) { const { id } = await M.dealerKey(benv.BIZ_SIGNING_KEY, 1); if (!/^[a-z]{8}$/.test(id) || /[ilo]/.test(id)) allOk = false; ids.add(id); }
    ok(allOk && ids.size === 300, "business-key: 300 ids, all lower-case letters and all different"); }
  sent = []; r = await bk({ ...form, email: "o@example.com", marketing: true }, "4.4.9.9");
  const om = sent.find(x => x[0] === "/smtp/email" && x[1].to[0].email === "o@example.com"), link = om && (/https:\/\/luchit\.app\/api\/confirm-b2b\?[^"]+/.exec(om[1].htmlContent) || [])[0];
  ok(r.status === 200 && link && !sent.some(x => x[0] === "/contacts" && x[1].listIds), "business-key: opt-in ticked = the key mail carries a signed updates link, still no list");
  const cb = u => W.fetch(new Request(u.replaceAll("&amp;", "&")), benv, {});
  sent = []; r = await cb(link);
  const lc = sent.find(x => x[0] === "/contacts");
  ok(r.status === 302 && r.headers.get("location").endsWith("/business/?updates=1") && lc && lc[1].listIds[0] === 2 && lc[1].attributes.CONSENT_AT && Object.keys(lc[1].attributes).length === 1, "confirm-b2b: the click puts the address on the business list with CONSENT_AT only");
  sent = []; r = await cb(link.replace(/t=[^&]+/, "t=AAAA")); ok(r.headers.get("location").endsWith("updates=expired") && sent.length === 0, "confirm-b2b: a bad signature does nothing");
  const mag = new URL(link); const mlink = `https://luchit.app/api/confirm?e=${mag.searchParams.get("e")}&x=${mag.searchParams.get("x")}&t=${mag.searchParams.get("t")}`;
  sent = []; r = await cb(mlink); ok(r.headers.get("location").endsWith("subscribed=expired") && sent.length === 0, "confirm-b2b: its token does not open the magazine confirm");
  ok((await verify(key, PUB, 20909)).why === "expired" && (await verify(key, PUB, 1, [v.id])).why === "revoked", "verify: expired and revoked");
  ok((await verify(key.slice(0, -3) + "AAA", PUB)).why === "signature" && (await verify("hello", PUB)).why === "format", "verify: wrong signature and malformed input");
  const other = crypto.generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
  ok((await verify(key, other)).why === "signature", "verify: a key signed by another private key fails");
  sent = []; r = await bk({ ...form, website: "x" }); ok(r.status === 200 && sent.length === 0, "business-key: honeypot answers ok, sends nothing");
  r = await bk({ ...form, size: "huge" }); ok(r.status === 400, "business-key: an unknown size is refused");
  mailOk = false; sent = []; r = await bk({ ...form, email: "f@example.com" }, "5.5.5.5"); ok(r.status === 502 && !sent.some(x => x[0] === "/contacts"), "business-key: a Brevo mail failure = 502 (the page says try again), no contact saved");
  mailOk = true; store2.clear(); sent = [];
  for (let i = 0; i < 3; i++) await bk(form, "6.6.0." + i);
  r = await bk(form, "6.6.1.1"); ok(r.status === 200 && sent.filter(x => x[0] === "/smtp/email" && x[1].to[0].email === "d@example.com").length === 3, "business-key: a fourth key to one address in a day: ok, nothing sent");
  store2.clear(); sent = [];
  for (let i = 0; i < 5; i++) await bk({ ...form, email: `k${i}@example.com` }, "7.7.0.1");
  r = await bk({ ...form, email: "k9@example.com" }, "7.7.0.1"); ok(r.status === 429, "business-key: a sixth from one IP in an hour: 429");
  const nb = { ...benv }; delete nb.BIZ_SIGNING_KEY; sent = [];
  r = await W.fetch(new Request("https://luchit.app/api/business-key", { method: "POST", headers: { origin: "https://luchit.app", "content-type": "application/json", "cf-connecting-ip": "8.1.1.1" }, body: JSON.stringify(form) }), nb, {});
  ok(r.status === 502 && sent.length === 0, "business-key: no signing key pasted yet = 502, nothing sent"); }
console.log(bad ? `api test: ${bad} of ${n} checks FAILED` : `api test ok (${n} checks)`); process.exit(bad ? 1 : 0);

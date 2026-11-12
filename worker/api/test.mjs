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
globalThis.caches = { default: { match: async () => { throw new Error("down"); }, put: async () => { throw new Error("down"); } } };
r = await sub("c@example.com", "6.6.6.6"); ok(r.status === 200 && mails() === 6, "a cache that cannot be read lets the signup through, as before");
r = await W.fetch(new Request("https://luchit.app/api/confirm?e=x&x=1&t=x"), env, {}); ok(r.status === 302 && /subscribed=expired/.test(r.headers.get("location")), "the confirm link check is unchanged");
console.log(bad ? `api test: ${bad} of ${n} checks FAILED` : `api test ok (${n} checks)`); process.exit(bad ? 1 : 0);

// One-off end-to-end proof of the magazine sign-up (22.11.2026, CEO weekly review). Our own service mailbox only (a "+e2e" alias of the
// router's EMAIL_TO), never anyone else's. Stage 1 (no .github/e2e-link.txt): the site's form request to /api/subscribe. Stage 2 (the file
// holds the link from the mail): open the link as a browser would, then read the contact back from Brevo and mark it SOURCE=test.
import fs from "node:fs";
const TO = "luchit.app.service+e2e2211@gmail.com", SITE = "https://luchit.app";
const linkFile = ".github/e2e-link.txt";
if (!fs.existsSync(linkFile)) {
  const r = await fetch(SITE + "/api/subscribe", { method: "POST", headers: { origin: SITE, "content-type": "application/json", "user-agent": "Mozilla/5.0 (luchit e2e)" },
    body: JSON.stringify({ email: TO, consent: true, website: "" }) });
  console.log("stage 1: /api/subscribe", r.status, (await r.text()).slice(0, 80));
  process.exit(r.ok ? 0 : 1);
}
let link = fs.readFileSync(linkFile, "utf8").trim();
if (/^https:\/\/[a-z0-9.-]+\.sendibt2\.com\/tr\/cl\//.test(link)) {   // Brevo wraps the button in its click tracker: one hop to our link
  const t = await fetch(link, { redirect: "manual", headers: { "user-agent": "Mozilla/5.0 (luchit e2e)" } });
  console.log("stage 2: click tracker", t.status); link = t.headers.get("location") || "";
}
if (!link.startsWith(SITE + "/api/confirm?e=" + encodeURIComponent(TO))) { console.log("stage 2: the link is not this test's confirm link"); process.exit(1); }
const r = await fetch(link, { redirect: "manual", headers: { "user-agent": "Mozilla/5.0 (luchit e2e)" } });
console.log("stage 2: confirm", r.status, "->", (r.headers.get("location") || "").replace(/^https:\/\/luchit\.app/, ""));
const h = { "api-key": process.env.BREVO_KEY, accept: "application/json", "content-type": "application/json" };
const c = await fetch("https://api.brevo.com/v3/contacts/" + encodeURIComponent(TO), { headers: h }); const j = await c.json().catch(() => ({}));
console.log("brevo contact:", c.status, "on the magazine list:", (j.listIds || []).includes(Number(process.env.BREVO_LIST_ID || 3)), "source:", j.attributes?.SOURCE);
const m = await fetch("https://api.brevo.com/v3/contacts/" + encodeURIComponent(TO), { method: "PUT", headers: h, body: JSON.stringify({ attributes: { SOURCE: "test" } }) });
console.log("marked SOURCE=test:", m.status);
process.exit(r.status === 302 && (r.headers.get("location") || "").endsWith("subscribed=1") ? 0 : 1);

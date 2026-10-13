// Creates (and optionally sends) the Brevo campaign for the newest magazine article.
// Env: BREVO_KEY, BREVO_LIST_ID; MODE = preview (default, writes out/newsletter.html) | draft (campaign saved in Brevo, not sent) | send
// A campaign is named "magazine-<slug>"; if one already exists the script stops, so a re-run never mails twice.
import fs from "node:fs";
const MODE = process.env.MODE || "preview", KEY = process.env.BREVO_KEY, LIST = Number(process.env.BREVO_LIST_ID);
const post = JSON.parse(fs.readFileSync("magazine/posts.json", "utf8"))[0];
if (!post) { console.log("no posts"); process.exit(0); }
const esc = t => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const lead = (post.lead || "").length > 280 ? post.lead.slice(0, 280).replace(/[^.\s][^.]*$/, "").trim() || post.lead.slice(0, 280) : post.lead;
const html = fs.readFileSync("email/newsletter.html", "utf8")
  .replace(/<meta name="robots"[^>]*>/, "")
  .replaceAll("[[PREHEADER]]", esc(lead.slice(0, 110)))
  .replaceAll("[[MONTH]]", esc(post.month))
  .replaceAll("[[TITLE]]", esc(post.title))
  .replaceAll("[[LEAD]]", esc(lead))
  .replaceAll("[[PLAY_URL]]", `https://play.google.com/store/apps/details?id=com.ddsabag.pratirechev&referrer=${encodeURIComponent(`utm_source=newsletter&utm_medium=email&utm_campaign=${post.slug}`)}`)
  .replaceAll("[[URL]]", `https://luchit.app/magazine/${post.slug}/?utm_source=newsletter&utm_medium=email&utm_campaign=${post.slug}`);
fs.mkdirSync("out", { recursive: true }); fs.writeFileSync("out/newsletter.html", html);
console.log(`rendered newsletter for ${post.slug}: ${post.title}`);
if (MODE === "preview") process.exit(0);
if (!KEY || !LIST) { console.error("BREVO_KEY / BREVO_LIST_ID missing"); process.exit(1); }

const api = (path, init = {}) => fetch("https://api.brevo.com/v3" + path, { ...init, headers: { "api-key": KEY, "content-type": "application/json", accept: "application/json", ...(init.headers || {}) } });
const name = `magazine-${post.slug}`;
const list = await (await api("/emailCampaigns?limit=50&sort=desc")).json();
if ((list.campaigns || []).some(c => c.name === name)) { console.log("campaign already exists, nothing to do"); process.exit(0); }
const r = await api("/emailCampaigns", { method: "POST", body: JSON.stringify({
  name, subject: `פרסומת: ${post.title}`, sender: { name: "לוחית", email: "updates@luchit.app" }, replyTo: "updates@luchit.app",
  htmlContent: html, recipients: { listIds: [LIST] } }) });
const j = await r.json(); if (!r.ok) { console.error("create failed", r.status, JSON.stringify(j).slice(0, 300)); process.exit(1); }
console.log("campaign created", j.id);
if (MODE === "send") {
  const s = await api(`/emailCampaigns/${j.id}/sendNow`, { method: "POST" });
  if (!s.ok) { console.error("send failed", s.status, (await s.text()).slice(0, 300)); process.exit(1); }
  console.log("sent");
} else console.log("left as a draft in Brevo: review it there and press Send");

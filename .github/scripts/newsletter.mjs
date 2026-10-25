// Creates (and optionally sends) the Brevo campaign for the newest monthly magazine issue (slug YYYY-MM).
// Env: BREVO_KEY, BREVO_LIST_ID; MODE = preview (default, writes out/newsletter.html) | draft (campaign saved in Brevo, not sent) | send
// A campaign is named "magazine-<slug>"; if one already exists the script stops, so a re-run never mails twice.
// After a draft or a send, one Telegram line (alert router, day) tells Dudu, so a draft never waits in Brevo unseen.
import fs from "node:fs";
import { msg } from "./tg-text.mjs";
const MODE = process.env.MODE || "preview", KEY = process.env.BREVO_KEY, LIST = Number(process.env.BREVO_LIST_ID);
const posts = JSON.parse(fs.readFileSync("magazine/posts.json", "utf8"));
const post = posts.find(p => /^\d{4}-\d{2}$/.test(p.slug)) || posts[0];   // the monthly issue (slug YYYY-MM); a weekly data article can be newer
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
  .replaceAll("[[URL]]", `https://luchit.app/magazine/${post.slug}/?utm_source=newsletter&utm_medium=email&utm_campaign=${post.slug}`)
  // the logo and "luchit.app" in the text lead to the home page: tagged too, so the dashboard counts those visits under the newsletter
  .replaceAll('href="https://luchit.app/"', `href="https://luchit.app/?utm_source=newsletter&amp;utm_medium=email&amp;utm_campaign=${post.slug}"`);
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
  await tell(msg({ kind: "done", area: "marketing", title: `הניוזלטר של ${esc(post.month)} נשלח לרשימה`, text: esc(post.title) }), true);
} else {
  console.log("left as a draft in Brevo: review it there and press Send");
  await tell(msg({ kind: "today", area: "marketing", title: `טיוטת הניוזלטר של ${esc(post.month)} מחכה לך`, text: esc(post.title), what: `ב-Brevo, Campaigns, לפתוח את ${esc(name)}, לקרוא וללחוץ Send.` }));
}

async function telegram(text, silent = false){
  const e = process.env;
  try {
    const r = await fetch(`https://api.telegram.org/bot${e.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: e.TELEGRAM_CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true, disable_notification: silent }), signal: AbortSignal.timeout(20000) });
    console.log("telegram " + r.status); return r.ok;
  } catch (x) { console.log("telegram failed " + x.message); return false; }
}
// text is HTML (tg-text.mjs msg); silent for a newsletter that went out (✅), loud for a draft that waits for Dudu
async function tell(text, silent = false){
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) { console.log("no Telegram credentials:\n" + text); return; }
  let router = null; try { router = await import("./alert.mjs"); } catch {}
  const legacy = () => telegram(text, silent);
  if (router) await router.alert("day", name, text, "https://app.brevo.com/", { today: silent ? "silent" : "loud", legacy });
  else await legacy();
}

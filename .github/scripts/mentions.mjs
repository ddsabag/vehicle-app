// Daily: new mentions of "luchit.app" on the web, from the Google Alerts RSS (Atom) feed, as one silent Telegram message.
// Sends nothing when there is no new mention. A mention is "new" when Google published it in the last 25 hours (the job runs daily).
// DRY_RUN=1 prints instead of sending. MENTIONS_FEED overrides the feed address.
const FEED = process.env.MENTIONS_FEED || "https://www.google.com/alerts/feeds/14590558401768836826/8440425513311009327";
const DRY = process.env.DRY_RUN === "1";
const WINDOW_H = 25;

const decode = s => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const text = s => decode(s || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const tag = (xml, name) => (xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`)) || [])[1] || "";

// Alerts links go through google.com/url?...&url=<real>; keep the real address.
function realUrl(href) {
  try { const u = new URL(decode(href)); return u.searchParams.get("url") || u.href; } catch { return decode(href); }
}

async function telegram(msg) {
  const tok = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (DRY || !tok || !chat) { console.log("--- Telegram (" + (DRY ? "dry run" : "no credentials") + ") ---\n" + msg); return; }
  const r = await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text: msg, parse_mode: "HTML", disable_web_page_preview: true, disable_notification: true }) });
  if (!r.ok) console.log("telegram failed", r.status);
}

const r = await fetch(FEED, { signal: AbortSignal.timeout(30000) });
if (!r.ok) { console.log("feed failed", r.status); process.exit(0); }
const xml = await r.text();
const since = Date.now() - WINDOW_H * 3600e3;
const items = [...xml.matchAll(/<entry[^>]*>([\s\S]*?)<\/entry>/g)].map(m => {
  const e = m[1];
  const href = (e.match(/<link[^>]*href="([^"]+)"/) || [])[1] || "";
  return { title: text(tag(e, "title")), url: realUrl(href), when: Date.parse(tag(e, "published") || tag(e, "updated")), snippet: text(tag(e, "content")) };
}).filter(i => i.url && !(i.when < since));
console.log(`feed entries in the last ${WINDOW_H}h: ${items.length}`);
if (!items.length) process.exit(0);

const host = u => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };
const lines = ["🔎 <b>מישהו כתב על לוחית</b>", ""];
for (const i of items.slice(0, 10)) {
  lines.push(`• <a href="${esc(i.url)}">${esc(i.title || host(i.url))}</a> (${esc(host(i.url))})`);
  if (i.snippet) lines.push("  " + esc(i.snippet.slice(0, 160)));
}
if (items.length > 10) lines.push(`ועוד ${items.length - 10}.`);
lines.push("", "אם אין שם קישור לאתר, זו הזדמנות לבקש אחד.");
await telegram(lines.join("\n"));

// Daily infrastructure watch: site and Worker liveness, free-quota headroom (Cloudflare Workers, Brevo), and on the 1st of the month a list of stale branches.
// Alerts to Telegram only when something needs attention (needs TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID). DRY_RUN=1 prints instead of sending.
// Optional: CF_API_TOKEN + CF_ACCOUNT_ID (Workers usage), BREVO_API_KEY (daily send count), GITHUB_TOKEN + GITHUB_REPOSITORY (branches).
const DRY = process.env.DRY_RUN === "1", E = process.env;
const SITE = "https://luchit.app";
const CF_DAILY_LIMIT = 100000, BREVO_DAILY_LIMIT = 300, WARN = 0.8;
const problems = [], notes = [];
const day = d => d.toISOString().slice(0, 10);
const esc = t => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function retry(fn) { try { return await fn(); } catch { await sleep(3000); return fn(); } }
const get = (url, opt = {}) => fetch(url, { signal: AbortSignal.timeout(15000), ...opt });

async function liveness() {
  const checks = [
    ["האתר", async () => (await get(SITE + "/")).status === 200],
    ["sitemap.xml", async () => (await get(SITE + "/sitemap.xml")).status === 200],
    ["Worker ההרשמה (/api/confirm)", async () => { const r = await get(SITE + "/api/confirm?e=x&x=1&t=x", { redirect: "manual" }); return r.status === 302 && /subscribed=expired/.test(r.headers.get("location") || ""); }],
  ];
  for (const [name, fn] of checks) { let ok = false; try { ok = await retry(fn); } catch { /* counted as down */ } if (!ok) problems.push(`${name} לא מגיב כצפוי`); }
}

async function cloudflareQuota() {
  if (!E.CF_API_TOKEN || !E.CF_ACCOUNT_ID) return notes.push("מכסת Cloudflare: דילוג (אין CF_API_TOKEN)");
  const since = new Date(Date.now() - 86400e3).toISOString(), now = new Date().toISOString();
  const q = `query($a:String!,$f:AccountWorkersInvocationsAdaptiveFilter_InputObject){viewer{accounts(filter:{accountTag:$a}){workersInvocationsAdaptive(limit:1000,filter:$f){sum{requests}}}}}`;
  const r = await get("https://api.cloudflare.com/client/v4/graphql", { method: "POST", headers: { Authorization: `Bearer ${E.CF_API_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ query: q, variables: { a: E.CF_ACCOUNT_ID, f: { datetime_geq: since, datetime_leq: now } } }) }).then(r => r.json());
  if (r.errors) return notes.push("מכסת Cloudflare: אין הרשאת קריאה לשימוש ב-Workers (" + String(r.errors[0]?.message).slice(0, 80) + ")");
  const n = (r.data.viewer.accounts[0]?.workersInvocationsAdaptive || []).reduce((s, x) => s + x.sum.requests, 0);
  console.log("cloudflare workers requests (24h):", n);
  if (n >= CF_DAILY_LIMIT * WARN) problems.push(`Cloudflare Workers: ${n.toLocaleString("en")} בקשות ב-24 שעות מתוך מכסה יומית של ${CF_DAILY_LIMIT.toLocaleString("en")}`);
}

async function brevoQuota() {
  if (!E.BREVO_API_KEY) return notes.push("מכסת Brevo: דילוג (אין BREVO_API_KEY)");
  let peak = 0;
  for (let i = 0; i < 3; i++) {
    const d = day(new Date(Date.now() - i * 86400e3));
    const r = await get(`https://api.brevo.com/v3/smtp/statistics/aggregatedReport?startDate=${d}&endDate=${d}`, { headers: { "api-key": E.BREVO_API_KEY, accept: "application/json" } });
    if (!r.ok) return notes.push("מכסת Brevo: שגיאת API " + r.status);
    peak = Math.max(peak, (await r.json()).requests || 0);
  }
  console.log("brevo peak sends/day (3d, transactional):", peak);
  if (peak >= BREVO_DAILY_LIMIT * WARN) problems.push(`Brevo: ${peak} שליחות ביום מתוך ${BREVO_DAILY_LIMIT} (מכסה חינמית)`);
}

async function staleBranches() {
  if (new Date().getUTCDate() !== 1 && !DRY) return;
  if (!E.GITHUB_TOKEN || !E.GITHUB_REPOSITORY) return;
  const H = { Authorization: `Bearer ${E.GITHUB_TOKEN}`, accept: "application/vnd.github+json" }, repo = E.GITHUB_REPOSITORY, keep = new Set(["main", "next", "data-status", "gh-pages"]);
  const bs = await get(`https://api.github.com/repos/${repo}/branches?per_page=100`, { headers: H }).then(r => r.json());
  const old = [];
  for (const b of bs) {
    if (keep.has(b.name)) continue;
    const c = await get(`https://api.github.com/repos/${repo}/commits/${b.commit.sha}`, { headers: H }).then(r => r.json());
    const age = (Date.now() - Date.parse(c.commit.committer.date)) / 86400e3;
    if (age > 30) old.push(`${b.name} (${Math.round(age)} ימים)`);
  }
  if (old.length) notes.push("ענפים ישנים שאפשר למחוק: " + old.join(", "));
}

async function telegram(text) {
  if (DRY || !E.TELEGRAM_BOT_TOKEN) return console.log("[telegram]\n" + text);
  const r = await fetch(`https://api.telegram.org/bot${E.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: E.TELEGRAM_CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true }) });
  if (!r.ok) console.log("telegram failed", r.status);
}

for (const step of [liveness, cloudflareQuota, brevoQuota, staleBranches]) {
  try { await step(); } catch (e) { notes.push(`${step.name}: ${String(e.message).slice(0, 100)}`); }
}
console.log(notes.join("\n") || "no notes");
if (problems.length) {
  await telegram(`⚠️ <b>לוחית: בדיקת תשתיות</b>\n${problems.map(p => "• " + esc(p)).join("\n")}${notes.length ? "\n\nהערות:\n" + notes.map(esc).join("\n") : ""}`);
  process.exit(1);
}
if (notes.some(n => n.startsWith("ענפים"))) await telegram(`🧹 <b>לוחית: תחזוקה חודשית</b>\n${esc(notes.find(n => n.startsWith("ענפים")))}`);
console.log("all clear");

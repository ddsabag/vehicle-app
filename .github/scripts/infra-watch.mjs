// Daily infrastructure watch, the infra part of Site smoke test's daily run: sign-up Worker liveness, free-quota headroom (Cloudflare Workers, Brevo),
// and on the 1st of the month a list of stale branches. The home page and sitemap.xml are checked by site-smoke.mjs, so not here.
import fs from "node:fs";
import { flash } from "./flash.mjs";
import { msg, heError } from "./tg-text.mjs";
// Alerts to Telegram only when something needs attention (needs TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID). DRY_RUN=1 prints instead of sending.
// Optional: CF_API_TOKEN + CF_ACCOUNT_ID (Workers usage), BREVO_API_KEY (daily send count), GITHUB_TOKEN + GITHUB_REPOSITORY (branches).
// STALE_BRANCHES=yes|no picks the stale-branch list by the cron line that fired; unset = on the 1st by the clock (and always with DRY_RUN=1).
// INFRA_HANDOFF=1: check only, and write the messages as the step output "report" (JSON {alert, notice}) for site-smoke.mjs to send in its
// one morning message. Either way, a run that read everything and found nothing closes the open infra alerts (alert.mjs resolve).
// INFRA_REPORT=<that JSON>: send those messages as this script would have (the fallback when site-smoke.mjs did not);
// with INFRA_FLASHED=1 site-smoke.mjs already wrote the /live line, so only Telegram is tried again.
const DRY = process.env.DRY_RUN === "1", E = process.env;
const SITE = "https://luchit.app";
const CF_DAILY_LIMIT = 100000, BREVO_DAILY_LIMIT = 300, WARN = 0.8;
// problems: {he, raw, urgent}; notes: Hebrew lines; raws: the technical side of the notes (secret names, API errors), folded in the message
const problems = [], notes = [], raws = [];
const read = new Set();   // the checks that got a reading this run (api, quota-cf, quota-brevo): open infra items close only when all three did
let stale = [];
const he = raw => heError(raw).split("\n<blockquote")[0].replace(/\.$/, "");
const day = d => d.toISOString().slice(0, 10);
const esc = t => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function retry(fn) { try { return await fn(); } catch { await sleep(3000); return fn(); } }
const get = (url, opt = {}) => fetch(url, { signal: AbortSignal.timeout(15000), ...opt });

async function liveness() {
  const checks = [
    ["שירות ההרשמה למגזין", "/api/confirm", async () => { const r = await get(SITE + "/api/confirm?e=x&x=1&t=x", { redirect: "manual" }); return r.status === 302 && /subscribed=expired/.test(r.headers.get("location") || ""); }],
  ];
  for (const [name, raw, fn] of checks) { let ok = false; try { ok = await retry(fn); } catch { /* counted as down */ } if (!ok) problems.push({ id: "api", he: `${name} לא מגיב כצפוי, ולכן הרשמות חדשות לא מאושרות`, raw: `Worker ${raw}`, urgent: true }); }
  read.add("api");
}

async function cloudflareQuota() {
  if (!E.CF_API_TOKEN || !E.CF_ACCOUNT_ID) { raws.push("Cloudflare: no CF_API_TOKEN/CF_ACCOUNT_ID"); return notes.push("מכסת הבקשות היומית לא נבדקה (חסר מפתח)"); }
  const since = new Date(Date.now() - 86400e3).toISOString(), now = new Date().toISOString();
  const q = `query($a:String!,$f:AccountWorkersInvocationsAdaptiveFilter_InputObject){viewer{accounts(filter:{accountTag:$a}){workersInvocationsAdaptive(limit:1000,filter:$f){sum{requests}}}}}`;
  const r = await get("https://api.cloudflare.com/client/v4/graphql", { method: "POST", headers: { Authorization: `Bearer ${E.CF_API_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ query: q, variables: { a: E.CF_ACCOUNT_ID, f: { datetime_geq: since, datetime_leq: now } } }) }).then(r => r.json());
  if (r.errors) { raws.push("Cloudflare GraphQL: " + String(r.errors[0]?.message).slice(0, 80)); return notes.push("מכסת הבקשות היומית לא נבדקה: למפתח אין הרשאת קריאה לנתוני השימוש"); }
  const n = (r.data.viewer.accounts[0]?.workersInvocationsAdaptive || []).reduce((s, x) => s + x.sum.requests, 0);
  console.log("cloudflare workers requests (24h):", n);
  read.add("quota-cf");
  if (n >= CF_DAILY_LIMIT * WARN) problems.push({ id: "quota-cf", he: `מכסת הבקשות היומית של שרתי האתר: ${n.toLocaleString("en")} ב-24 שעות מתוך ${CF_DAILY_LIMIT.toLocaleString("en")}`, raw: "Cloudflare Workers requests" });
}

async function brevoQuota() {
  if (!E.BREVO_API_KEY) { raws.push("Brevo: no BREVO_API_KEY"); return notes.push("מכסת המיילים היומית לא נבדקה (חסר מפתח)"); }
  let peak = 0;
  for (let i = 0; i < 3; i++) {
    const d = day(new Date(Date.now() - i * 86400e3));
    const r = await get(`https://api.brevo.com/v3/smtp/statistics/aggregatedReport?startDate=${d}&endDate=${d}`, { headers: { "api-key": E.BREVO_API_KEY, accept: "application/json" } });
    if (!r.ok) { raws.push("Brevo API HTTP " + r.status); return notes.push(`מכסת המיילים היומית לא נבדקה: ${he("HTTP " + r.status)}`); }
    peak = Math.max(peak, (await r.json()).requests || 0);
  }
  console.log("brevo peak sends/day (3d, transactional):", peak);
  read.add("quota-brevo");
  if (peak >= BREVO_DAILY_LIMIT * WARN) problems.push({ id: "quota-brevo", he: `מכסת המיילים היומית: ${peak} שליחות ביום מתוך ${BREVO_DAILY_LIMIT} (המכסה החינמית)`, raw: "Brevo transactional" });
}

async function staleBranches() {
  const pick = E.STALE_BRANCHES;
  if (!DRY && (pick === "no" || (pick !== "yes" && new Date().getUTCDate() !== 1))) return;
  if (!E.GITHUB_TOKEN || !E.GITHUB_REPOSITORY) return;
  const H = { Authorization: `Bearer ${E.GITHUB_TOKEN}`, accept: "application/vnd.github+json" }, repo = E.GITHUB_REPOSITORY, keep = new Set(["main", "next", "data-status", "gh-pages", "flashes", "guard-baseline", "ui-baseline", "inspect-output", "seo-data", "seo-track", "own-data", "zombie-data", "web-watch", "seo-auto", "catalog-data"]);
  const bs = await get(`https://api.github.com/repos/${repo}/branches?per_page=100`, { headers: H }).then(r => r.json());
  const old = [];
  for (const b of bs) {
    if (keep.has(b.name)) continue;
    const c = await get(`https://api.github.com/repos/${repo}/commits/${b.commit.sha}`, { headers: H }).then(r => r.json());
    const age = (Date.now() - Date.parse(c.commit.committer.date)) / 86400e3;
    if (age > 30) old.push(`${b.name} (${Math.round(age)} ימים)`);
  }
  stale = old;
}

const toLive = (text, silent) => E.INFRA_REPORT && E.INFRA_FLASHED === "1" ? null : flash("infra", silent ? "info" : "alert", text);   // INFRA_FLASHED=1: site-smoke.mjs already put it on /live
async function telegram(text, silent = false) {
  if (DRY || !E.TELEGRAM_BOT_TOKEN) { console.log("[telegram]\n" + text); return DRY; }
  const r = await fetch(`https://api.telegram.org/bot${E.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: E.TELEGRAM_CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true, disable_notification: silent }) });
  if (!r.ok) console.log("telegram failed", r.status);
  return r.ok;
}

// 🔴 when a service users need is down, 🟠 when a quota nears its limit; the monthly branch list is 🔵, silent
const alertText = () => msg({ kind: problems.some(p => p.urgent) ? "urgent" : "today", area: "site", title: "שירות באתר או מכסה דורשים תשומת לב",
  text: problems.map(p => "• " + esc(p.he)).join("\n") + (notes.length ? "\n" + notes.map(n => "• " + esc(n)).join("\n") : ""),
  what: problems.some(p => p.urgent) ? 'לכתוב בשרשור "תפעול, בוטים ומייל", ואבדוק.' : "כרגע אין תקלה. כדאי לדעת לפני שהשירות ייחסם; אם זה נמשך כמה ימים, לכתוב בשרשור \"תפעול, בוטים ומייל\".",
  raw: [...problems.map(p => p.raw), ...raws].filter(Boolean).join(" · ") });
const noticeText = () => msg({ kind: "info", area: "bots", title: "🧹 תחזוקה חודשית: ענפים ישנים במאגר הקוד",
  text: `${stale.length} ענפים בלי שינוי יותר מ-30 יום. אפשר למחוק אותם כשנוח, הם לא מפריעים לכלום.`, raw: stale.join(", ") });

// send what was found, through the alert router (alert.mjs) with the direct send as its fallback: the alert (infra:<ids>, critical when a
// service is down, else day) rings; the monthly branch list (infra-branches) is a silent notice for the Sunday summary
async function route(level, key, text, silent) {
  await toLive(text, silent);
  let router = null; try { router = await import("./alert.mjs"); } catch { /* direct below */ }
  if (!router) return telegram(text, silent);
  const run = E.GITHUB_SERVER_URL && E.GITHUB_RUN_ID ? `${E.GITHUB_SERVER_URL}/${E.GITHUB_REPOSITORY}/actions/runs/${E.GITHUB_RUN_ID}` : "";
  return !!(await router.alert(level, key, text, run, { today: silent ? "silent" : "loud", legacy: () => telegram(text, silent) })).delivered;
}
async function deliver({ alert, notice, key, level }) {
  if (alert) {
    const sent = await route(level || "day", key || "infra:site", alert, false);
    process.exit(sent ? 0 : 1);   // alert delivered: finish green so GitHub does not also mail "workflow failed"
  }
  if (notice) await route("summary", "infra-branches", notice, true);
  console.log("all clear");
}

if (E.INFRA_REPORT) {   // fallback in Site smoke test: the report the infra job handed over was not sent by site-smoke.mjs
  let report = {}; try { report = JSON.parse(E.INFRA_REPORT) || {}; } catch (e) { console.log("unreadable INFRA_REPORT:", e.message); process.exit(1); }
  await deliver(report);
} else {
  for (const step of [liveness, cloudflareQuota, brevoQuota, staleBranches]) {
    try { await step(); } catch (e) { notes.push(`בדיקה אחת לא רצה עד הסוף: ${he(e.message)}`); raws.push(`${step.name}: ${String(e.message).slice(0, 100)}`); }
  }
  console.log([...notes, ...raws].join("\n") || "no notes");
  const report = problems.length ? { alert: alertText(), key: "infra:" + [...new Set(problems.map(p => p.id))].sort().join("+"), level: problems.some(p => p.urgent) ? "critical" : "day" }
    : stale.length ? { notice: noticeText(), key: "infra-branches", level: "summary" } : {};
  // the services and both quotas were read and are fine: the open infra items close (the router tells each announced one "חזר לתקין");
  // a quota that could not be read leaves them open, since this run cannot say it ended
  if (!problems.length && read.size === 3) {
    let router = null; try { router = await import("./alert.mjs"); } catch { /* nothing to close without it */ }
    if (router?.resolve) try { await router.resolve(["infra:"]); } catch { /* the morning ledger still shows them open */ }
  } else if (!problems.length) console.log(`open infra alerts stay open: not read this run: ${["api", "quota-cf", "quota-brevo"].filter(x => !read.has(x)).join(", ")}`);
  if (E.INFRA_HANDOFF === "1") {
    console.log(report.alert || report.notice || "all clear: nothing to hand over");
    const line = report.alert || report.notice ? `report=${JSON.stringify(report)}\n` : "";   // one line: JSON escapes the newlines
    if (line && E.GITHUB_OUTPUT) fs.appendFileSync(E.GITHUB_OUTPUT, line);
  } else await deliver(report);
}

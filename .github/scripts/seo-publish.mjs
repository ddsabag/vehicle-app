// SEO auto-publish: site-only SEO changes staged on branch "seo-auto" go to main by themselves after a 24 h window, if every check passes.
// Telegram says what is going out and when (silent; a change that needs Dudu or failed its checks rings); deleting the branch (or telling Claude) cancels. Never touches the app, workflows or code:
// only the paths in ALLOW. A changed existing page must not have been changed in the last 21 days (analytics/seo-changes.json on main), new pages are exempt.
// Env: GITHUB_TOKEN, GITHUB_REPOSITORY (git credentials come from actions/checkout), TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID. DRY=1 prints only.
// CHECK=1 (the workflow's lock-free "check" job): notices, tags and the 24 h window as usual, but a change that is due is not merged:
// it writes ready=true to GITHUB_OUTPUT and the "publish" job (main-writer group) runs this script again without CHECK.
import { execSync, execFileSync } from "node:child_process";
import { readFileSync, appendFileSync } from "node:fs";
import { msg } from "./tg-text.mjs";

const BR = "seo-auto", HOURS = 24, COOL_DAYS = 21, DRY = process.env.DRY === "1", CHECK = process.env.CHECK === "1";
const ALLOW = [/^(check|brand|model|magazine|guide)\//, /^sitemap\.xml$/, /^robots\.txt$/, /^404\.html$/, /^analytics\/seo-changes\.json$/];
const sh = c => execSync(c, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const trysh = c => { try { return sh(c); } catch { return null; } };

// m = msg() fields (tg-text.mjs, HTML); 🔵 and ✅ are silent, a message that asks for something rings.
// key = the alert router family (alert.mjs, Dudu 25.10): a message that needs Dudu is "day", the rest "summary" (Sunday summary).
async function tg(m, key) {
  const text = msg({ area: "seo", ...m }), silent = m.kind === "info" || m.kind === "done";
  console.log("TG:", text);
  const t = process.env.TELEGRAM_BOT_TOKEN, c = process.env.TELEGRAM_CHAT_ID;
  if (DRY || !t || !c) return;
  const direct = () => fetch(`https://api.telegram.org/bot${t}/sendMessage`, { method: "POST", body: new URLSearchParams({ chat_id: c, text, parse_mode: "HTML", disable_web_page_preview: "true", disable_notification: String(silent) }) }).then(r => r.ok).catch(() => false);
  let router = null; try { router = await import(new URL("./alert.mjs", import.meta.url)); } catch {}
  if (router) { await router.alert(silent ? "summary" : "day", `${key}:${s7}`, text, "https://github.com/" + (process.env.GITHUB_REPOSITORY || "ddsabag/vehicle-app") + "/tree/" + BR, { today: silent ? "silent" : "loud", legacy: direct }); return; }
  await direct();
}
const esc = x => String(x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
let TAGS = null;
const hasTag = n => {
  if (TAGS === null) TAGS = (tryOut("git ls-remote --tags origin 'seo-auto-*'") || "").split("\n").map(l => l.split("refs/tags/")[1]).filter(Boolean);
  return TAGS.includes(n);
};
function tryOut(c) { try { return sh(c); } catch { return null; } }
const markTag = n => { if (!DRY) tryOut(`git tag -f ${n} && git push -q origin refs/tags/${n} -f`); };

tryOut(`git fetch -q origin ${BR} main`);
const head = tryOut(`git rev-parse origin/${BR}`);
if (!head) { console.log("no staged SEO branch"); process.exit(0); }
const s7 = head.slice(0, 7);
const files = sh(`git diff --name-status origin/main...origin/${BR}`).split("\n").filter(Boolean).map(l => { const [st, ...p] = l.split("\t"); return { st: st[0], f: p[p.length - 1], old: p[0] }; });
if (!files.length) { console.log("branch has nothing new"); if (!DRY) tryOut(`git push -q origin :${BR}`); process.exit(0); }

const bad = files.filter(x => !ALLOW.some(r => r.test(x.f)) || (x.st === "R" && !ALLOW.some(r => r.test(x.old))));
if (bad.length) {
  if (!hasTag("seo-auto-blocked-" + s7)) { await tg({ kind: "today", title: "שינוי SEO מחכה לאישור שלך", text: `הוא נוגע בקבצים שמחוץ לדפי האתר (${esc(bad.slice(0, 3).map(x => x.f).join(", "))}), ולכן לא יעלה לבד.`, what: "לכתוב לי בשרשור SEO אם לאשר אותו." }, "seo-auto:blocked"); markTag("seo-auto-blocked-" + s7); }
  process.exit(0);
}
// 21-day rule against the ledger on main
const ledger = JSON.parse(tryOut("git show origin/main:analytics/seo-changes.json") || "{}");
const urlOf = f => "https://luchit.app/" + f.replace(/index\.html$/, "");
const now = Date.now(), recent = [];
for (const x of files) {
  if (x.st === "A" || /^(sitemap\.xml|robots\.txt|analytics\/)/.test(x.f)) continue;
  const u = urlOf(x.f);
  for (const [k, e] of Object.entries(ledger)) {
    if (k.startsWith("_") || !e?.date) continue;
    const match = k.endsWith("*") ? u.startsWith(k.slice(0, -1)) : u === k;
    if (match && (now - Date.parse(e.date)) / 864e5 < COOL_DAYS) recent.push(`${x.f} (${e.date})`);
  }
}
if (recent.length) {
  if (!hasTag("seo-auto-blocked-" + s7)) { await tg({ kind: "info", title: "שינוי SEO מחכה לסוף 21 הימים", text: `${recent.length} מהדפים שלו שונו לפני פחות מ-21 יום (${esc(recent.slice(0, 3).join(", "))}). הוא יעלה רק אחרי שהחלון ייגמר.` }, "seo-auto:wait"); markTag("seo-auto-blocked-" + s7); }
  process.exit(0);
}
const subject = sh(`git log -1 --format=%s origin/${BR}`);
// the 24 h window starts when the notice goes out (its time is in the tag name), not at commit time
hasTag("");
const noteTag = TAGS.find(t => t.startsWith("seo-auto-notified-" + s7 + "-"));
if (!noteTag) {
  await tg({ kind: "info", title: "שינוי SEO יעלה לאתר בעוד כיום", text: `${esc(subject)}\n${files.length} קבצים (${files.filter(x => x.st === "A").length} חדשים). הוא יעלה בהרצה הקבועה הראשונה אחרי ${HOURS - 1} שעות, בצהריים או בערב. כדי לעצור אותו, לכתוב לי בשרשור SEO.` }, "seo-auto:notice");
  markTag(`seo-auto-notified-${s7}-${Math.floor(now / 6e4)}`);   // minutes since 1970
  process.exit(0);
}
const t = Number(noteTag.split("-").pop()), ageH = now / 36e5 - (t > 1e7 ? t / 60 : t + 1);   // minutes; older tags hold the hour, counted from its end
// an hour of slack: runs start late by different amounts, and the same slot the next day must qualify (else the change waits 32-40 h)
if (ageH < HOURS - 1) { console.log(`waiting: ${ageH.toFixed(1)}h of ${HOURS}h`); process.exit(0); }
if (CHECK) { console.log(`due after ${ageH.toFixed(1)}h: handing over to the publish job`); if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, "ready=true\n"); process.exit(0); }

// merge on a scratch state of main and run the SEO lint before pushing
try {
  sh("git config user.name 'github-actions[bot]' && git config user.email '41898282+github-actions[bot]@users.noreply.github.com'");
  sh("git checkout -q -B seo-merge origin/main");
  execFileSync("git", ["merge", "--no-ff", "-q", "-m", "SEO auto-publish: " + subject, "origin/" + BR], { stdio: ["ignore", "pipe", "pipe"] });   // the subject comes from the branch: never through a shell
  sh("node .github/scripts/seo-check.mjs");
} catch (e) {
  tryOut("git merge --abort");
  if (!hasTag("seo-auto-blocked-" + s7)) { await tg({ kind: "today", title: "שינוי SEO נעצר ולא עלה לאתר", text: "הבדיקות האוטומטיות של הדפים נכשלו, ולכן האתר נשאר כמו שהיה.", what: "לכתוב לי בשרשור SEO, ואבדוק מה נכשל.", raw: String(e.stderr || e.message).split("\n").filter(Boolean).slice(-4).join(" | ") }, "seo-auto:blocked"); markTag("seo-auto-blocked-" + s7); }
  process.exit(0);
}
if (DRY) { console.log("DRY: would push"); process.exit(0); }
sh("git push -q origin seo-merge:main");
tryOut(`git push -q origin :${BR}`);
for (const t of TAGS.filter(t => t.startsWith("seo-auto-") && t.includes(s7))) tryOut(`git push -q origin :refs/tags/${t}`);
await tg({ kind: "done", title: "שינוי SEO עלה לאתר", text: `${esc(subject)} (${files.length} קבצים).` }, "seo-auto:done");

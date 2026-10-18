// SEO auto-publish: site-only SEO changes staged on branch "seo-auto" go to main by themselves after a 24 h window, if every check passes.
// Telegram (silent) says what is going out and when; deleting the branch (or telling Claude) cancels. Never touches the app, workflows or code:
// only the paths in ALLOW. A changed existing page must not have been changed in the last 21 days (analytics/seo-changes.json on main), new pages are exempt.
// Env: GITHUB_TOKEN, GITHUB_REPOSITORY (git credentials come from actions/checkout), TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID. DRY=1 prints only.
// CHECK=1 (the workflow's lock-free "check" job): notices, tags and the 24 h window as usual, but a change that is due is not merged:
// it writes ready=true to GITHUB_OUTPUT and the "publish" job (main-writer group) runs this script again without CHECK.
import { execSync, execFileSync } from "node:child_process";
import { readFileSync, appendFileSync } from "node:fs";

const BR = "seo-auto", HOURS = 24, COOL_DAYS = 21, DRY = process.env.DRY === "1", CHECK = process.env.CHECK === "1";
const ALLOW = [/^(check|brand|model|magazine|guide)\//, /^sitemap\.xml$/, /^robots\.txt$/, /^404\.html$/, /^analytics\/seo-changes\.json$/];
const sh = c => execSync(c, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const trysh = c => { try { return sh(c); } catch { return null; } };

async function tg(text) {
  console.log("TG:", text);
  const t = process.env.TELEGRAM_BOT_TOKEN, c = process.env.TELEGRAM_CHAT_ID;
  if (DRY || !t || !c) return;
  await fetch(`https://api.telegram.org/bot${t}/sendMessage`, { method: "POST", body: new URLSearchParams({ chat_id: c, text, disable_notification: "true" }) }).catch(() => {});
}
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
  if (!hasTag("seo-auto-blocked-" + s7)) { await tg(`🛑 שינוי SEO לא יעלה אוטומטית: נוגע בקבצים שמחוץ לאתר (${bad.slice(0, 3).map(x => x.f).join(", ")}). דורש אישור שלך.`); markTag("seo-auto-blocked-" + s7); }
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
  if (!hasTag("seo-auto-blocked-" + s7)) { await tg(`⏳ שינוי SEO מחכה: ${recent.length} דפים שונו בפחות מ-21 יום (${recent.slice(0, 3).join(", ")}). לא יעלה לפני תום החלון.`); markTag("seo-auto-blocked-" + s7); }
  process.exit(0);
}
const subject = sh(`git log -1 --format=%s origin/${BR}`);
// the 24 h window starts when the notice goes out (its time is in the tag name), not at commit time
hasTag("");
const noteTag = TAGS.find(t => t.startsWith("seo-auto-notified-" + s7 + "-"));
if (!noteTag) {
  await tg(`🕓 שינוי SEO יעלה לאתר בעוד כיום (בהרצה הקבועה הראשונה אחרי ${HOURS - 1} שעות, בצהריים או בערב): ${subject}\n${files.length} קבצים (${files.filter(x => x.st === "A").length} חדשים). לביטול: למחוק את הענף ${BR} או לכתוב לקלוד.`);
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
  if (!hasTag("seo-auto-blocked-" + s7)) { await tg(`🛑 שינוי SEO נעצר: הבדיקות נכשלו (${String(e.stderr || e.message).split("\n").filter(Boolean).slice(-2).join(" | ").slice(0, 200)}). לא פורסם.`); markTag("seo-auto-blocked-" + s7); }
  process.exit(0);
}
if (DRY) { console.log("DRY: would push"); process.exit(0); }
sh("git push -q origin seo-merge:main");
tryOut(`git push -q origin :${BR}`);
for (const t of TAGS.filter(t => t.startsWith("seo-auto-") && t.includes(s7))) tryOut(`git push -q origin :refs/tags/${t}`);
await tg(`✅ שינוי SEO עלה לאתר: ${subject} (${files.length} קבצים).`);

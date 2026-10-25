// Hebrew wording shared by every Telegram sender (24.10.2026, Dudu: "לוודא שהן מסווגות בצורה מסודרת ... מה שמגיע באנגלית לתרגם לעברית קריאה").
//   tag(kind, area)  the message's first line, the same for every bot:  "🔴 דחוף · אתר"  /  "🟠 לטיפול היום · נתונים"  /  "🔵 לידיעה · שיווק"  /  "✅ בוצע · אפליקציה"
//   heError(raw)     a raw error (English API text, HTTP code, JSON) -> one Hebrew sentence; the raw text goes under it, folded (HTML parse mode)
//   botName(name)    a workflow's English name -> its Hebrew name (failure alerts); unknown names come back as they are
//   folded(raw)      English or technical detail as a folded block the reader opens only if needed
//   todo(what)       the closing line, on every message: "👉 מה לעשות: <what>", or with no argument "👌 לא צריך לעשות כלום."
//   Shape of every message (Dudu 24.10 09:18: "לתת הסבר ממש קצר ואם זה דורש טיפול או לא"):
//     <tag line>\n<one short Hebrew sentence: what happened>\n<todo line><folded technical detail>
// Imports only node:fs; Node 20. Used by alert.mjs, reviews-monitor.mjs, social-publish.mjs, workers-deploy.mjs and the failure-alert workflow (`node tg-text.mjs bot "<name>"`).

import { readFileSync } from "node:fs";

export const KINDS = {
  urgent: "🔴 דחוף",          // something users feel now, or a step that is stuck until someone acts
  today: "🟠 לטיפול היום",     // needs a look today, nothing is down
  info: "🔵 לידיעה",           // no action
  done: "✅ בוצע",             // a step that finished as planned
};
// router level -> kind (alert.mjs): critical pages, day is today, summary/silent are for information
export const LEVEL_KIND = { critical: "urgent", day: "today", summary: "info", silent: "info" };
export const AREAS = { site: "אתר", app: "אפליקציה", data: "נתונים", store: "חנות Google Play", marketing: "שיווק", mail: "מייל", bots: "בוטים", seo: "SEO", reviews: "ביקורות", measure: "מדידה" };

export const tag = (kind, area) => `<b>${KINDS[kind] || KINDS.info}${AREAS[area] ? " · " + AREAS[area] : ""}</b>`;
export const tagPlain = (kind, area) => `${KINDS[kind] || KINDS.info}${AREAS[area] ? " · " + AREAS[area] : ""}`;

const esc = t => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// Telegram HTML: an expandable quote shows one line and opens on a tap
export const folded = (raw, title = "פרטים טכניים") => raw ? `\n<blockquote expandable>${esc(title)}:\n${esc(String(raw).replace(/\s+/g, " ").trim().slice(0, 600))}</blockquote>` : "";

export const todo = what => (what ? `👉 מה לעשות: ${what}` : "👌 לא צריך לעשות כלום.");
// a whole message in the shape above (HTML)
export const msg = ({ kind, area, title, text = "", what = "", raw = "" }) =>
  [tag(kind, area), title ? `<b>${title}</b>` : "", text, todo(what)].filter(Boolean).join("\n") + folded(raw);

// first match wins; each test sees the raw text
const ERR = [
  [/\b(401|unauthori[sz]ed|invalid[_ ]token|token (has )?expired|OAuthException|session has expired|auth 4\d\d)\b/i, "המפתח או הטוקן נדחה (פג תוקף או בוטל). צריך להדביק חדש."],
  [/\b(403|forbidden|permission|not allowed|insufficient)\b/i, "אין הרשאה לפעולה הזו. ייתכן שהרשאה הוסרה בחשבון."],
  [/\b404\b|not found/i, "הכתובת או הפריט לא נמצאו אצל השירות."],
  [/\b429\b|rate ?limit|too many requests|quota/i, "השירות ביקש להאט (יותר מדי בקשות או מכסה). בדרך כלל עובר לבד."],
  [/\b(500|502|503|504)\b|bad gateway|service unavailable|internal error|backend error|unavailable/i, "השירות של הצד השני לא ענה כרגע (תקלה אצלם). בדרך כלל עובר לבד."],
  [/timeout|timed out|aborted|ETIMEDOUT|deadline/i, "השירות לא ענה בזמן."],
  [/ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|fetch failed|socket hang up|network/i, "תקלת רשת בדרך לשירות."],
  [/\b400\b|invalid|bad request|malformed/i, "השירות דחה את הבקשה כלא תקינה. כנראה צריך תיקון בקוד."],
];
export function heError(raw) {
  const s = String(raw ?? "");
  if (!s.trim()) return "";
  const hit = ERR.find(([re]) => re.test(s));
  return (hit ? hit[1] : "שגיאה טכנית.") + folded(s);
}
// several raw errors ("vitals: ...", "reviews: ...") -> one Hebrew line each, raw text folded once at the end
export function heErrors(list, names = {}) {
  const lines = list.map(e => { const [, src, rest] = String(e).match(/^([\w-]+):\s*(.*)$/s) || [, "", e]; const h = (ERR.find(([re]) => re.test(rest)) || [, "שגיאה טכנית."])[1]; return `• ${names[src] || (src ? src + ": " : "")}${names[src] ? ": " : ""}${h}`; });
  return lines.join("\n") + folded(list.join("; "));
}

// workflow name (exactly as in its `name:`) -> what the owner calls it; the list lives in bot-names.json so alert.mjs (node builtins only) reads it too
export const BOTS = JSON.parse(readFileSync(new URL("./bot-names.json", import.meta.url), "utf8"));
const PARTS = { data: "נתונים", monthly: "חודשי", newsletter: "ניוזלטר", weekly: "שבועי", daily: "יומי" };
// "Magazine (data)" (a run name) -> the workflow's Hebrew name plus the part
export function botName(name) {
  const s = String(name || "").trim();
  if (BOTS[s]) return BOTS[s];
  const m = s.match(/^(.*) \(([^)]+)\)$/);
  return m && BOTS[m[1]] ? `${BOTS[m[1]]} (${PARTS[m[2]] || m[2]})` : s;
}

// Workflows the failure alert re-runs once by itself (Dudu 25.10: "כשהבוט מזהה בעיה יתקן אותה אוטומטית ורק יעדכן אותי שבוצע").
// Only reads, checks and data rebuilds that are safe to run twice; never one that publishes, sends mail or a report, uploads to Play or deploys a Worker.
export const RETRY = new Set(["Data guard", "Fuel price", "Ministry watch", "Web deploy (build)", "SEO check", "Web watch", "Market data", "Model catalogue",
  "Model names", "Model statistics", "Ownership data mirror", "Reviews monitor", "SEO data snapshot", "Campaign data snapshot", "Site smoke test", "Site smoke test (after deploy)",
  "Back-on-road detector", "Release watch", "Data truth", "Settlements"]);

// failure-alert.yml: a workflow that failed without its own alert. what = failed | repeat | lost | fixed | again; level from alert.mjs WF_LEVELS (passed in).
//   fixed: it failed (or was pushed out of the queue) and the automatic re-run passed: silent ✅.   again: the automatic re-run failed too.
// Returns {text (HTML), silent}: critical/day ring (repeat: silent), summary/silent never ring.
export function wfFailure(what, runName, level, url) {
  const kind = LEVEL_KIND[level] || "today", quiet = kind === "info" || what === "repeat" || what === "fixed", name = botName(runName);
  const T = {
    failed: [`הבוט "${name}" נכשל`, "הוא נעצר באמצע ולא שלח הודעה משלו, אז העבודה שלו הפעם לא הושלמה.",
      kind === "info" ? "" : "לכתוב לי בשרשור \"תפעול, בוטים ומייל\". אם זו פעם ראשונה, לרוב ההרצה הבאה מסתדרת לבד."],
    repeat: [`הבוט "${name}" נכשל שוב`, "גם ההרצה הקודמת נכשלה, לכן ההודעה הזו שקטה.", "אם זה נמשך יותר מיום, לכתוב לי בשרשור \"תפעול, בוטים ומייל\"."],
    fixed: [`הבוט "${name}" נתקע ותוקן לבד`, "ההרצה נכשלה או לא התחילה, אז הפעלתי אותה שוב אוטומטית, והפעם היא עברה.", ""],
    again: [`הבוט "${name}" נכשל גם בהרצה חוזרת`, "הוא נכשל, הפעלתי אותו שוב אוטומטית, וגם ההרצה השנייה נכשלה. כנראה צריך תיקון בקוד.",
      kind === "info" ? "" : "לכתוב לי בשרשור \"תפעול, בוטים ומייל\"."],
    lost: [`הבוט "${name}" לא רץ`, "ההרצה בוטלה לפני שהתחילה, כי בוט אחר תפס את מקומו בתור, והעבודה שלו לא נעשתה.", "להריץ שוב: לפתוח את הקישור וללחוץ Re-run all jobs."],
  }[what] || [];
  return { text: msg({ kind: what === "fixed" ? "done" : what === "repeat" ? "info" : kind, area: "bots", title: esc(T[0] || name), text: T[1], what: T[2] }) + (url ? `\n🔗 ${esc(url)}` : ""), silent: quiet };
}

// CLI for shell callers: node tg-text.mjs bot "<workflow name>"   |   node tg-text.mjs tag <kind> <area>   |   node tg-text.mjs selftest
//   node tg-text.mjs retry "<workflow name>"   prints 1 when the failure alert may re-run it once by itself
//   node tg-text.mjs wf <failed|repeat|lost|fixed|again> "<run name>" "<workflow name>" "<url>"   prints "0" or "1" (silent) on the first line, then the HTML text
if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === "wf") {
    const [, what, run, wf, url] = process.argv.slice(2);
    let level = "day"; try { level = (await import("./alert.mjs")).WF_LEVELS[wf] || "day"; } catch {}
    const r = wfFailure(what, run, level, url);
    console.log((r.silent ? "1" : "0") + "\n" + r.text);
  } else if (cmd === "bot") console.log(botName(a));
  else if (cmd === "retry") console.log(RETRY.has(a) ? "1" : "0");
  else if (cmd === "tag") console.log(tagPlain(a, b));
  else if (cmd === "selftest") {
    let n = 0; const ok = (c, m) => { n++; if (!c) { console.error("FAIL " + m); process.exit(1); } };
    ok(botName("Data guard") === "שומר הנתונים", "bot");
    ok(botName("Magazine (data)") === "המגזין (נתונים)", "bot part");
    ok(botName("Unknown X") === "Unknown X", "bot unknown");
    ok(heError("vitals crashRateMetricSet 503 {\"error\":{}}").startsWith("השירות של הצד השני"), "503");
    ok(heError("auth 401").startsWith("המפתח"), "401");
    ok(heError("ETIMEDOUT").startsWith("השירות לא ענה"), "timeout");
    ok(heError("weird").startsWith("שגיאה טכנית") && heError("weird").includes("<blockquote expandable>"), "fallback + fold");
    ok(heError("<script>").includes("&lt;script&gt;"), "escaped");
    ok(heError("") === "", "empty");
    const w = wfFailure("failed", "Magazine (data)", "summary", "https://x/1");
    ok(w.silent && w.text.startsWith("<b>🔵 לידיעה · בוטים</b>\n<b>הבוט \"המגזין (נתונים)\" נכשל</b>") && w.text.includes("👌") && w.text.endsWith("🔗 https://x/1"), "wf summary");
    ok(!wfFailure("failed", "Web deploy (build)", "critical", "").silent && wfFailure("failed", "Web deploy (build)", "critical", "").text.startsWith("<b>🔴 דחוף"), "wf critical");
    ok(wfFailure("repeat", "Data guard", "day", "").silent, "wf repeat silent");
    ok(wfFailure("lost", "Data guard", "day", "").text.includes("Re-run"), "wf lost");
    const f = wfFailure("fixed", "Data guard", "day", "");
    ok(f.silent && f.text.startsWith("<b>✅ בוצע · בוטים</b>") && f.text.includes("👌"), "wf fixed silent done");
    const g = wfFailure("again", "Data guard", "day", "");
    ok(!g.silent && g.text.startsWith("<b>🟠 לטיפול היום") && g.text.includes("👉"), "wf again loud");
    ok(!RETRY.has("Android build") && !RETRY.has("Social publish") && !RETRY.has("Magazine") && RETRY.has("Data guard"), "retry list");
    for (const w of RETRY) ok(BOTS[w], "retry name known " + w);
    ok(todo() === "👌 לא צריך לעשות כלום." && todo("x") === "👉 מה לעשות: x", "todo");
    ok(msg({ kind: "today", area: "bots", title: "t", what: "" }) === "<b>🟠 לטיפול היום · בוטים</b>\n<b>t</b>\n👌 לא צריך לעשות כלום.", "msg");
    ok(tag("urgent", "site") === "<b>🔴 דחוף · אתר</b>", "tag");
    ok(heErrors(["vitals: x 503", "reviews: auth 401"], { vitals: "שיעור הקריסות", reviews: "הביקורות" }).split("\n")[0] === "• שיעור הקריסות: השירות של הצד השני לא ענה כרגע (תקלה אצלם). בדרך כלל עובר לבד.", "errors");
    for (const name of Object.keys(BOTS)) ok(!/[A-Za-z]{4,}/.test(BOTS[name].replace(/\b(Alpha|Production|Workers|Google|Play|ASO|SEO|data)\b/g, "")), "hebrew " + name);
    console.log(`tg-text selftest ok (${n} checks)`);
  } else { console.error("usage: node tg-text.mjs bot <name> | tag <kind> <area> | selftest"); process.exit(2); }
}

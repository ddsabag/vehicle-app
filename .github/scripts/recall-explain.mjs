// Recall explanations (use #2 of the monthly Claude API credit, Dudu "לבצע" 28.10.2026): for every recall wording of the model catalogue,
// one short Hebrew text that says what it means (what the defect is, what may happen, what the repair does), written by Claude in a
// Message Batch (half price) and kept only when it passes the fixed rules below. It is data for review: the branch recall-explain holds
// explain.json (by wording, with the recall ids that use it) and review.md, and the app shows none of it (display is product's, after
// 22.11 and a Production release). A wording is the ministry's four fields SUG_RECALL | SUG_TAKALA | TEUR_TAKALA | OFEN_TIKUN, so one
// text serves every car and model the recall reaches; the maker, the model, the importer and every plate stay out of the prompt.
// Each text has an urgency (the advisor's contract, strategy 28.10): "stop" when the ministry's description says to stop using the car,
// "soon" for a critical system (brakes, steering, suspension and wheels, airbags and belts, fuel or fire, high voltage, stability), else
// "routine"; the rules (STOP, critByRules) and the model's own judgement each can raise it, and the model alone never says "stop". When
// the description itself gives an instruction for the time until the repair (stop using it, park it outside), notice restates it.
// The rules (RULES): Hebrew, 2-3 short sentences; "עלול"/"ייתכן", never "זכאי" and never whether a car is included; no cost, steps or
// garage in the text (the app shows the steps and the cost line next to it, and they depend on the car: a personal import is not the
// importer's; fixed lines in LINES); never names or blames the importer, the maker or a dealer; no "you"; calm, without alarm and without
// playing a risk down; no number or Latin word the wording does not have; a service campaign says it is one. A text that breaks a rule
// goes back with the rule it broke (3 tries).
// Weekly: only wordings that are new since the last run are sent (redo=1 sends all again, after a change of the prompt). A batch that has
// not ended by the deadline is collected by the next run. With no key, no SDK or an API error the run keeps what it had, says why in one
// line, and stays green: ai:recalls goes to the router (ai:key when the key or the credit is the cause, which needs Dudu), and the next
// good call closes both. Nothing here logs a plate, a cost or a token count.
//   env   CAT=<dir> (catalog-data: r/<maker>.json)   PREV=<dir> (the last run's files, branch recall-explain)   OUT=<dir>
//         QUERIES="sample=20 max=3000 wait=50 rounds=3 effort=low redo=1 dry=1" (the workflow's input), or RUN_FILE (a file holding them)
//   node recall-explain.mjs --selftest   offline: the rules, the critical systems, the sample spread, whole runs through a fake API
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { client, batch, collect, answer } from "./claude.mjs";

export const MODEL = "claude-sonnet-5-5", PROMPT_V = 1, TRIES = 3;
const CAMPAIGN = "קמפיין שרות טכני", CUT = 118;   // TEUR_TAKALA is cut at 120 characters in the ministry's dataset
export const SYS = ["brakes", "steering", "suspension", "wheels", "airbags", "seatbelts", "seats", "fuel", "high_voltage", "fire", "stability",
  "lights", "engine", "exhaust", "transmission", "electrical", "software", "body", "other"];
// fixed text for product and the advisor (the model never writes steps): by urgency, and the cost line the app already shows (not for a
// personal import, whose repair is not the importer's: the app decides)
export const LINES = { stop: "הודעת הריקול מורה להפסיק את השימוש ברכב עד לתיקון.", soon: "זו מערכת בטיחות: אם הרכב כלול בקריאה, כדאי לתקן אותו בהקדם במוסך מורשה.",
  cost: "התיקון ניתן בדרך כלל ללא עלות אצל היבואן של הרכב." };
const RANK = { routine: 0, soon: 1, stop: 2 };

const HE = "א-ת";   // the Hebrew letters, final forms included
// a whole Hebrew word of the list after up to two one-letter prefixes (ו ה ב ל מ ש כ); exact(): the word only as listed
const words = list => new RegExp(`(?<![${HE}])[והבלמשכ]{0,2}(?:${list.join("|")})(?![${HE}])`);
const exact = list => new RegExp(`(?<![${HE}])(?:${list.join("|")})(?![${HE}])`);

// a critical system by the ministry's own field or by a word of its description, beside the model's own judgement (either is enough):
// whole words, so "משענת הראש" is not fire (אש), "גלגלת" is not a wheel and "הדלקת" is not fuel
const CRIT_SYS = new Set(["בלמים", "היגוי ומתלים", "כריות אוויר", "חגורות בטיחות", "מערכת הדלק", "מערכת יציבות"]);
const CRIT_WORDS = words(["בלם", "בלמים", "בלמי", "בלימה", "בלימת", "הגה", "היגוי", "מתלה", "מתלים", "מתלי", "זרוע", "זרועות", "זרועת", "גלגל", "גלגלים",
  "גלגלי", "צמיג", "צמיגים", "צמיגי", "כרית", "כריות", "חגורה", "חגורת", "חגורות", "דלק", "סולר", "בנזין", "שריפה", "שרפה", "דליקה", "התלקחות", "בעירה",
  "אש", "מתח גבוה", "סוללת המתח", "סוללת ההנעה", "סוללת הנעה", "סוללת ליתיום"]);
export const critByRules = w => CRIT_SYS.has(w.s) || CRIT_WORDS.test(w.d) || /\b(ABS|ESP|ESC|EBD)\b/.test(w.d);
// the higher of the rules' urgency and the model's; the model's "stop" counts only where the description gives an instruction at all
export function urgencyOf(w, o) {
  const rules = STOP.test(w.d) ? "stop" : critByRules(w) ? "soon" : "routine";
  const model = o.urgency === "stop" && !INSTR.test(w.d) ? "soon" : o.urgency === "routine" && CRIT.has(o.sys) ? "soon" : o.urgency;
  const u = RANK[rules] >= RANK[model] ? rules : model;
  return { urgency: u, urgencyBy: u === "routine" ? "" : rules === u && model === u ? "both" : rules === u ? "rules" : "model" };
}
const CRIT = new Set(["brakes", "steering", "suspension", "wheels", "airbags", "seatbelts", "fuel", "high_voltage", "fire", "stability"]);
// the description says to stop using the car until the repair (an Opel airbag recall: "חובה לעצור שימוש ברכב באופן מידי"); "may stop working" is not it
const STOP = /(לעצור|להפסיק|הפסקת) (את )?(ה)?שימוש|אין לנסוע|לא לנסוע|(אין|לא) להשתמש ברכב|\bstop (driving|using)\b|\bdo not drive\b/i;
// the description gives some instruction for the time until the repair (park outside, do not charge near buildings): only then a notice
const INSTR = /יש ל|חובה|מבקש|להימנע|הנחה|הנחיה|אין ל|לא ל(נסוע|השתמש|שטוף|חנות|החנות|טעון|הטעין|הושיב|שבת)|לעצור|להפסיק (את )?(ה)?שימוש|\b(do not|avoid|park)\b/i;

const LATIN_OK = new Set(["ABS", "ESP", "ESC", "EBD", "ECU", "EGR", "DPF", "LED", "USB", "ADAS", "AEB", "TPMS", "SRS", "GPS", "EV"]);
// [id, broken(text, wording), what the model is told when its text broke it]
export const RULES = [
  ["entitled", t => /זכא/.test(t), "Never say entitled (זכאי, זכאות) or anything like it."],
  ["included", t => words(["כלול", "כלולה", "כלולים", "כלולות", "נכלל", "נכללת", "נכללים", "נכללות", "נכללו", "נכללה"]).test(t),
    "Do not say whether a car is included in the recall."],
  ["cost", t => exact(["חינם", "בחינם", "עלות", "העלות", "ללא עלות", "בלי עלות", "תשלום", "בתשלום", "התשלום", "ללא תשלום", "לשלם", "מחיר", "המחיר", "כסף", "על חשבון"]).test(t),
    "Nothing about cost or payment."],
  ["steps", t => words(["מוסך", "מוסכים", "התקשרו", "להתקשר", "לתאם", "תאמו", "בדקו"]).test(t)
    || /צרו קשר|ליצור קשר|יצירת קשר|מספר (ה)?שלדה|מספר (ה)?רישוי|אתר (ה)?אינטרנט|באתר|לבדוק (אם|האם)/.test(t),
    "No steps: nothing about contacting anyone, scheduling, checking whether a car is included, a garage, a website or a VIN (the app shows those)."],
  ["blame", t => words(["יבואן", "יבואנים", "יבואנית", "יצרן", "יצרנים", "יצרנית", "סוחר", "סוחרים", "רשלנות", "אשמה", "הזנחה"]).test(t),
    "Never name or blame the importer, the maker or a dealer (יבואן, יצרן, סוחר)."],
  ["you", t => exact(["אתה", "אתם", "שלך", "שלכם", "ושלך", "ושלכם", "לך", "לכם", "ולך", "ולכם", "עליך", "עליכם", "בשבילך", "בשבילכם", "עבורך", "עבורכם",
    "אותך", "אתכם", "ממך", "תוכל", "תוכלו", "תצטרך", "תצטרכו", "שימו", "זכרו", "דעו"]).test(t), "No \"you\" in any form: write about הרכב or רכבים."],
  ["alarm", t => /!/.test(t) || words(["מוות", "קטלני", "קטלנית", "קטלניים", "אסון", "סכנת חיים", "מיד", "מייד", "בדחיפות", "דחוף"]).test(t) || exact(["למות"]).test(t),
    "Calm wording: no alarm words (מוות, סכנת חיים, מיד, דחוף) and no exclamation mark."],
  ["downplay", t => /אין (כל |שום )?(סכנה|סיכון|חשש|מה לדאוג|צורך לדאוג)|לא מסוכנ|בטוח לנסוע|להמשיך לנסוע|אין צורך (בתיקון|לתקן)/.test(t),
    "Do not play a risk down (אין סכנה, אפשר להמשיך לנסוע)."],
  ["campaign", (t, w) => w.t === CAMPAIGN && !/קריאת (שירות|שרות)|קמפיין/.test(t), "This is a service campaign (קמפיין שרות טכני): say in the text that it is a service campaign (קריאת שירות)."],
  ["number", (t, w) => (t.match(/\d+/g) || []).some(n => !w.d.includes(n)), "No numbers that the description does not have."],
  ["latin", (t, w) => (t.match(/[A-Za-z][A-Za-z0-9-]*/g) || []).some(x => !w.d.toUpperCase().includes(x.toUpperCase()) && !LATIN_OK.has(x.toUpperCase())),
    "No Latin-letter words the description does not have (no model names, no English)."],
  ["length", t => t.length < 50 || t.length > 320, "Two or three short sentences, 50 to 320 characters."],
  ["hebrew", t => (t.match(/[א-ת]/g) || []).length < 0.7 * (t.match(/[A-Za-zא-ת]/g) || []).length, "Write in Hebrew."],
];
// a notice may hold the instruction's own steps and words like "מיד", so it gets the rest of the rules, calm without those
const NOTICE_RULES = new Set(["entitled", "included", "cost", "blame", "you", "downplay", "number", "latin", "hebrew"]);
const calm = t => /!/.test(t) || words(["מוות", "קטלני", "קטלנית", "קטלניים", "אסון", "סכנת חיים"]).test(t);
export function check(o, w) {
  const out = [];
  if (!o.unclear) {
    if (!o.text) out.push({ id: "empty", say: "The text is empty while unclear is false." });
    else for (const [id, bad, say] of RULES) if (bad(o.text, w)) out.push({ id, say });
  }
  if (o.notice) {
    if (!INSTR.test(w.d)) out.push({ id: "notice", say: 'The description gives no instruction for the time until the repair, so notice is "".' });
    else {
      if (!o.notice.startsWith("לפי הודעת הריקול")) out.push({ id: "notice-start", say: 'notice starts with "לפי הודעת הריקול".' });
      for (const [id, bad, say] of RULES) if (NOTICE_RULES.has(id) && bad(o.notice, w)) out.push({ id: "notice-" + id, say: "In notice: " + say });
      if (calm(o.notice)) out.push({ id: "notice-alarm", say: "In notice: calm wording, no alarm words and no exclamation mark." });
      if (o.notice.length > 220) out.push({ id: "notice-length", say: "notice is one short sentence." });
    }
  }
  return out;
}
export const textCheck = (t, w) => check({ text: t, notice: "", unclear: false }, w);

const SYSTEM = `You write the short explanation that appears under a recall in לוחית, an Israeli app that checks a car by its licence plate in the Ministry of Transport's open data. The app shows the ministry's record of the recall: its type, the affected system, the ministry's description of the defect and the repair method. Your text appears under it as "מה זה אומר?" and tells an ordinary car owner, in plain Hebrew, what the defect is, what may happen because of it, and what the repair does.

The same text is shown for every car and model the recall reaches, and the app cannot know whether a particular car is included or was already repaired. So the text explains the recall, never a car.

How to write it:
- Hebrew, 2 or 3 short sentences, about 80 to 280 characters. Plain words a driver knows; when the description names a technical part, say in a few words what that part does.
- Say only what the description says, plus general knowledge about the part it names. No numbers, dates, model names, quantities or causes that the description does not give.
- The ministry's database cuts the description at 120 characters. When the message says it was cut, explain what is there and do not guess how it goes on.
- A description in English: explain it in Hebrew. A Latin abbreviation the description uses (ABS, ECU) may stay.
- What may happen is "עלול" or "ייתכן", never certain. Never "זכאי" or "זכאות", and never whether a car is included in the recall.
- Calm and factual: no alarm words (מוות, סכנת חיים, קטלני, מיד, דחוף) and no exclamation marks, and no reassurance that plays a risk down (אין סכנה, אפשר להמשיך לנסוע). Say what may happen as the description says it, for example "עלול לפגוע בבלימה" or "עלול לגרום לפציעה בתאונה".
- Impersonal: no "you" in any form (אתה, אתם, שלך, שלכם, לכם). Write about "הרכב" or "רכבים".
- No steps: nothing about contacting anyone, scheduling, checking, a garage (מוסך), a phone, a website or a VIN, and nothing about cost or payment. The app shows those next to your text.
- Never name or blame the importer, the maker or a dealer (יבואן, יצרן, סוחר). A recall is the routine way a defect found after sale is repaired.
- A "קמפיין שרות טכני" is a service campaign rather than a safety recall: say in the text that it is a service campaign (קריאת שירות). If its description itself names a risk, explain the risk as written.

The fields:
- text: the explanation, or "" when unclear is true.
- notice: only when the description itself gives an instruction for the time until the repair (stop using the car, park it outside, avoid charging near buildings, do not seat a passenger in a seat): that instruction in plain impersonal Hebrew, one sentence that starts with "לפי הודעת הריקול". Only what the description says; when there is no such instruction, or it is cut before it is clear, "". This is the one place for steps, and only the description's own.
- sys: the system the defect is in.
- urgency: "stop" when the description says to stop using the car until the repair; "soon" when the defect may affect braking, steering, the suspension or the wheels and tyres, the airbags or the seatbelts, a fuel leak or a fire, a high-voltage battery or its charging, or stability control; otherwise "routine" (for example emissions, displays, comfort).
- unclear: true only when the description says too little to explain anything beyond repeating it (for example a bare "מערכת חשמל" with the repair "בדיקה").

Four examples of the tone (do not copy their wording):

סוג הקריאה: תקלה סידרתית בטיחותית
מערכת: כריות אוויר
תיאור התקלה: חשש לכשל במנפח כרית האוויר של הנהג בעת פתיחתה
אופן התיקון: החלפה
text: "המנפח הוא החלק שממלא את כרית האוויר בגז ברגע של תאונה. ייתכן שהוא ייכשל כשהכרית נפתחת, ואז הכרית עלולה לא להגן כראוי ואף לגרום לפציעה. בתיקון מחליפים את המנפח בחלק חדש." (notice "", sys airbags, urgency soon)

סוג הקריאה: קמפיין שרות טכני
מערכת: חשמל אליקטרוניקה ומיזוג
תיאור התקלה: עדכון תוכנת מערכת המולטימדיה
אופן התיקון: עדכון תוכנה
text: "זו קריאת שירות ולא ריקול בטיחותי. מערכת המולטימדיה, שמפעילה את המסך והרדיו, מקבלת עדכון תוכנה." (notice "", sys software, urgency routine)

סוג הקריאה: תקלה סידרתית בטיחותית
מערכת: היגוי ומתלים
תיאור התקלה (נקטע במאגר אחרי 120 תווים): בחלק מהרכבים ייתכן שהבורג המחבר את זרוע המתלה הקדמית לשלדה לא הודק כנדרש בייצור, ולכן עלול להשתחרר במהלך הנסיעה ולגרום ל
אופן התיקון: הידוק
text: "זרוע המתלה מחברת את הגלגל הקדמי לשלדה ומחזיקה אותו במקומו. ייתכן שבורג שלה לא הודק כנדרש, ובורג כזה עלול להשתחרר בנסיעה. בתיקון מהדקים את הבורג." (notice "", sys suspension, urgency soon)

סוג הקריאה: תקלה סידרתית בטיחותית
מערכת: חשמל אליקטרוניקה ומיזוג
תיאור התקלה: לחות עלולה לחדור למחבר החשמלי של המאוורר ולגרום להתחממות. עד לתיקון יש להחנות את הרכב מחוץ למבנים
אופן התיקון: החלפה
text: "לחות עלולה לחדור למחבר החשמלי של המאוורר ולגרום להתחממות שלו. בתיקון מחליפים את המחבר בחלק חדש." (notice "לפי הודעת הריקול, עד התיקון יש להחנות את הרכב מחוץ למבנים.", sys electrical, urgency soon)`;

const SCHEMA = { type: "object", additionalProperties: false, required: ["text", "notice", "sys", "urgency", "unclear"],
  properties: { text: { type: "string" }, notice: { type: "string" }, sys: { type: "string", enum: SYS }, urgency: { type: "string", enum: ["stop", "soon", "routine"] },
    unclear: { type: "boolean" } } };

const norm = s => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
export const wording = r => ({ t: norm(r.SUG_RECALL), s: norm(r.SUG_TAKALA), d: norm(r.TEUR_TAKALA), f: norm(r.OFEN_TIKUN) });
export const keyOf = w => crypto.createHash("sha1").update([w.t, w.s, w.d, w.f].join("|")).digest("hex").slice(0, 16);

// what the model reads: the four fields only, and on a retry its rejected draft with the rule it broke
export function prompt(w, fb) {
  const lines = [`סוג הקריאה: ${w.t}`, `מערכת: ${w.s}`, `תיאור התקלה${w.d.length >= CUT ? " (נקטע במאגר אחרי 120 תווים)" : ""}: ${w.d}`, `אופן התיקון: ${w.f}`];
  if (fb) lines.push("", `A previous draft was rejected: "${fb.text}"`, `What it broke: ${fb.say}`, "Write it again.");
  return lines.join("\n");
}
export const params = (w, fb, effort = "low") => ({
  model: MODEL, max_tokens: 3000,
  output_config: { effort, format: { type: "json_schema", schema: SCHEMA } },
  system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
  messages: [{ role: "user", content: prompt(w, fb) }],
});

export function queries(s) {
  const q = { sample: 0, max: 3000, wait: 50, rounds: TRIES, redo: false, dry: false, effort: "low" }, n = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(+v) || 0));
  for (const [, k, v] of String(s || "").matchAll(/(\w+)=([\w.-]+)/g)) {
    if (k === "sample") q.sample = n(v, 0, 200);
    else if (k === "max") q.max = n(v, 1, 5000);
    else if (k === "wait") q.wait = n(v, 0, 120);
    else if (k === "rounds") q.rounds = n(v, 1, TRIES);
    else if (k === "redo" || k === "dry") q[k] = v === "1" || v === "true";
    else if (k === "effort" && ["low", "medium", "high"].includes(v)) q.effort = v;
  }
  return q;
}

export function readCatalogue(dir) {
  const out = new Map(), rd = path.join(dir, "r");
  for (const f of fs.readdirSync(rd).filter(f => f.endsWith(".json")).sort())
    for (const r of JSON.parse(fs.readFileSync(path.join(rd, f), "utf8")).rows || []) {
      const w = wording(r);
      if (!w.d) continue;   // nothing to explain
      const k = keyOf(w), e = out.get(k) || out.set(k, { w, ids: new Set() }).get(k);
      if (r.RECALL_ID != null && r.RECALL_ID !== "") e.ids.add(+r.RECALL_ID || r.RECALL_ID);
    }
  return out;
}
function readPrev(dir) {
  const rd = f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { return null; } };
  const ex = rd("explain.json"), st = rd("state.json") || {};
  return { items: (ex && ex.items) || {}, state: { pending: st.pending || null, retry: st.retry || {}, held: st.held || {} } };
}

// a sample spread over the kinds of wording: each system, service campaigns, English descriptions and cut ones, in turn
export function pickSample(keys, cat, n) {
  const buckets = new Map();
  for (const k of [...keys].sort()) {
    const w = cat.get(k).w, b = w.t === CAMPAIGN ? "~campaign" : /[A-Za-z]{4,}/.test(w.d) ? "~english" : w.d.length >= CUT ? "~cut" : w.s;
    (buckets.get(b) || buckets.set(b, []).get(b)).push(k);
  }
  const lists = [...buckets.keys()].sort().map(b => buckets.get(b)), out = [];
  for (let i = 0; out.length < n && lists.some(l => i < l.length); i++) for (const l of lists) if (i < l.length && out.length < n) out.push(l[i]);
  return out;
}

function parse(msg) {
  const a = answer(msg);
  if (!a.text) return { why: a.why };
  let o; try { o = JSON.parse(a.text); } catch { return { why: "not json" }; }
  if (!o || typeof o.text !== "string" || typeof o.notice !== "string" || !SYS.includes(o.sys) || !(o.urgency in RANK) || typeof o.unclear !== "boolean") return { why: "bad fields" };
  return { o: { ...o, text: norm(o.text), notice: norm(o.notice) } };
}

function review(items, st, day) {
  const all = Object.values(items), held = Object.entries(st.held), he = { brakes: "בלמים", steering: "היגוי", suspension: "מתלים", wheels: "גלגלים וצמיגים",
    airbags: "כריות אוויר", seatbelts: "חגורות בטיחות", seats: "מושבים ומשענות", fuel: "מערכת הדלק", high_voltage: "מתח גבוה", fire: "סכנת שריפה", stability: "מערכת יציבות",
    lights: "תאורה", engine: "מנוע", exhaust: "פליטה", transmission: "העברת כוח", electrical: "חשמל", software: "תוכנה", body: "מרכב", other: "אחר" };
  const head = w => `**${w.d}**${w.d.length >= CUT ? "…" : ""} · ${w.s} · ${w.f}${w.t === CAMPAIGN ? " · קמפיין שירות" : ""}`;
  const mark = { stop: " · ⛔ להפסיק שימוש", soon: " · 🟠 בהקדם", routine: "" };
  const out = [`# הסברי ריקולים לבדיקה`, "", `עודכן ${day} · ${all.length} ניסוחים עם הסבר · ${held.length} מחכים לאדם · גרסת ההנחיה ${PROMPT_V}`, "",
    `ההסברים לא מוצגים באפליקציה. מתחת להסבר תופיע שורה קבועה לפי הדחיפות: ⛔ "${LINES.stop}" · 🟠 "${LINES.soon}"`, ""];
  if (held.length) out.push(`## מחכים לאדם (${held.length})`, "", ...held.map(([k, h]) => `- ${h.w ? head(h.w) : k} · ${h.why}${h.text ? ` · טיוטה אחרונה: "${h.text}"` : ""}`), "");
  for (const s of SYS) {
    const list = all.filter(x => x.sys === s).sort((a, b) => (a.s + a.d).localeCompare(b.s + b.d, "he"));
    if (!list.length) continue;
    out.push(`## ${he[s]} (${list.length})`, "");
    for (const x of list) out.push(`- ${head(x)}${mark[x.urgency] || ""}`, x.unclear ? "  > (הניסוח לא מספיק להסבר)" : `  > ${x.text}`, ...(x.notice ? [`  > **${x.notice}**`] : []));
    out.push("");
  }
  return out.join("\n");
}
function write(out, items, st, day) {
  fs.mkdirSync(out, { recursive: true });
  const sorted = Object.fromEntries(Object.keys(items).sort().map(k => [k, items[k]]));
  fs.writeFileSync(path.join(out, "explain.json"), JSON.stringify({ v: PROMPT_V, u: day, lines: LINES, n: Object.keys(items).length, items: sorted }, null, 1) + "\n");
  fs.writeFileSync(path.join(out, "state.json"), JSON.stringify(st, null, 1) + "\n");
  fs.writeFileSync(path.join(out, "review.md"), review(items, st, day) + "\n");
}

// the router (alert.mjs): a failed call is ai:recalls (summary), the key or the credit is ai:key (day, Dudu acts); a good call closes both
async function tell(router, err, env) {
  if (!router) return;
  const { tag, todo, folded } = await import("./tg-text.mjs");
  const text = err.key
    ? [tag("today", "bots"), "מפתח ה-Claude API לא עובד או שהקרדיט החודשי נגמר, ולכן הסברי הריקולים לא נכתבו הפעם. ההסברים הקיימים נשמרו.",
        todo("לבדוק ב-Console של Anthropic שהמפתח פעיל ושנשאר קרדיט, או להדביק מחדש את ANTHROPIC_API_KEY ב-GitHub")].join("\n") + folded(err.why)
    : [tag("info", "data"), "הסברי הריקולים לא נכתבו הפעם: הפנייה ל-Claude נכשלה. ההסברים הקיימים נשמרו, והבוט ינסה שוב בהרצה הבאה.", todo()].join("\n") + folded(err.why);
  try { await router.alert(err.key ? "day" : "summary", err.key ? "ai:key" : "ai:recalls", text, env.RUN_URL || "", { today: err.key ? "loud" : "silent", legacy: () => false }); } catch { /* the log line says it */ }
}
async function settle(router) {
  if (!router) return;
  try { await router.resolve(["ai:recalls"]); await router.resolve(["ai:key"]); } catch { /* the morning ledger still shows it */ }
}

export async function run({ env = process.env, api, router, log = console.log, now = new Date() } = {}) {
  const q = queries(env.QUERIES || (env.RUN_FILE && fs.existsSync(env.RUN_FILE) ? fs.readFileSync(env.RUN_FILE, "utf8") : ""));
  const out = env.OUT || "out", day = now.toISOString().slice(0, 10), cat = readCatalogue(env.CAT || "cat"), { items, state: st } = readPrev(env.PREV || "prev");
  if (router === undefined) router = await import("./alert.mjs").catch(() => null);
  for (const [k, e] of cat) if (items[k]) items[k].ids = [...e.ids].sort((a, b) => a - b);   // a new recall whose wording is already explained
  const rep = { wordings: cat.size, sent: 0, kept: 0, held: 0, pending: false, why: "" };
  const done = () => { write(out, items, st, day); log(`recall explanations: ${rep.wordings} wordings, ${Object.keys(items).length} explained, sent ${rep.sent}, kept ${rep.kept}, held ${rep.held}${rep.pending ? ", a batch still running (the next run collects it)" : ""}${rep.why ? " · " + rep.why : ""}`); return rep; };
  // retries first (with what they broke), then wordings that have no text yet and did not use up their tries (redo: all of them again)
  const retry = Object.entries(st.retry).filter(([k]) => cat.has(k)).map(([k, r]) => ({ k, n: r.n, fb: r.fb }));
  const due = [...cat.keys()].filter(k => !retry.some(e => e.k === k) && (q.redo || (!items[k] && !st.held[k]))).sort();
  let queue = [...retry, ...(q.sample ? pickSample(due, cat, q.sample) : due.slice(0, q.max)).map(k => ({ k, n: 1, fb: null }))];
  if (q.dry) { log(`dry run: ${queue.length} to send, nothing sent`); if (queue[0]) log(prompt(cat.get(queue[0].k).w, queue[0].fb)); return done(); }
  if (!queue.length && !st.pending) return done();
  const c = api ? { api } : await client(env);
  if (!c.api) { rep.why = c.why; if (!/ANTHROPIC_API_KEY/.test(c.why)) await tell(router, { why: c.why, key: false }, env); return done(); }   // no key: switched off on purpose

  const hold = (k, n, why, text) => { st.held[k] = { n, why, text: text || "", at: day, w: cat.get(k).w }; rep.held++; };
  const handle = (results, reqs) => {
    const next = [];
    const again = (k, n, why, fb) => (n >= TRIES ? hold(k, n, why, fb && fb.text) : next.push({ k, n: n + 1, fb }));
    for (const [cid, { k, n }] of Object.entries(reqs)) {
      if (!cat.has(k)) continue;   // the wording left the catalogue meanwhile
      const w = cat.get(k).w, res = results.get(cid);
      if (!res || !res.ok) { again(k, n, (res && res.why) || "no result", null); continue; }
      const p = parse(res.msg);
      if (p.why) { if (/^refusal/.test(p.why)) hold(k, n, p.why, ""); else again(k, n, p.why, null); continue; }
      const o = p.o, broken = check(o, w);
      if (broken.length) { again(k, n, "rule " + broken.map(b => b.id).join("+"), { text: o.text + (o.notice ? ` / notice: "${o.notice}"` : ""), say: broken.map(b => b.say).join(" ") }); continue; }
      const u = urgencyOf(w, o);
      items[k] = { ...w, text: o.unclear ? "" : o.text, notice: o.notice, sys: o.sys, ...u, crit: u.urgency !== "routine", unclear: o.unclear,
        checked: { by: "rules", at: day }, v: PROMPT_V, ids: [...cat.get(k).ids].sort((a, b) => a - b) };
      delete st.held[k]; rep.kept++;
    }
    return next;
  };
  let good = false, failed = null;
  if (st.pending) {
    const r = await collect(c.api, st.pending.id, { minutes: q.wait, every: 30 });
    if (r.error) { failed = r.error; if (/^404/.test(r.error.why)) st.pending = null; }   // a batch the API no longer has: its wordings are simply due again
    else if (!r.ended) { good = true; rep.pending = true; await settle(router); return done(); }
    else {   // what that batch held is answered now (kept, held, or back with its next try), so this run does not send it again
      good = true;
      const was = new Set(Object.values(st.pending.reqs).map(x => x.k)), back = handle(r.results, st.pending.reqs);
      st.pending = null; queue = [...back, ...queue.filter(e => !was.has(e.k))];
    }
  }
  for (let round = 0; !failed && queue.length && round < q.rounds; round++) {
    const reqs = {}, requests = [], seen = new Set();
    for (const e of queue) {
      if (seen.has(e.k)) continue;
      seen.add(e.k);
      const cid = `r${e.k}_${e.n}`;
      reqs[cid] = { k: e.k, n: e.n };
      requests.push({ custom_id: cid, params: params(cat.get(e.k).w, e.fb, q.effort) });
    }
    const r = await batch(c.api, requests, { minutes: q.wait, every: 30 });
    if (r.error && !r.id) { failed = r.error; break; }   // nothing was sent: the same wordings are due next run
    good = true; rep.sent += requests.length;
    if (!r.ended) { st.pending = { id: r.id, at: now.toISOString(), reqs }; rep.pending = true; queue = []; if (r.error) failed = r.error; break; }
    // every request of the batch errored (a request this code builds wrong, or the API down): a failed call, and no try is used up
    const res = [...r.results.values()];
    if (res.length && res.every(x => !x.ok && /^errored/.test(x.why))) { failed = { why: "batch " + res[0].why, key: false }; queue = queue.filter(e => e.n > 1); break; }
    queue = handle(r.results, reqs);
  }
  // retries the rounds did not reach go first next run, with what they broke
  st.retry = Object.fromEntries(queue.filter(e => e.n > 1).map(e => [e.k, { n: e.n, fb: e.fb }]));
  if (failed) { rep.why = failed.why; await tell(router, failed, env); } else if (good) await settle(router);
  return done();
}

if (process.argv[1] && process.argv[1].endsWith("recall-explain.mjs") && !process.argv.includes("--selftest")) {
  try { await run(); } catch (e) { console.log("recall explanations skipped: " + (e && e.message ? e.message.slice(0, 200) : e)); }   // never red over this bot
}

if (process.argv[1] && process.argv[1].endsWith("recall-explain.mjs") && process.argv.includes("--selftest")) {
  let bad = 0; const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) bad++; };
  const W = (d, s = "בלמים", f = "החלפה", t = "תקלה סידרתית בטיחותית") => ({ t, s, d, f });
  // the rules: each one catches its own fault, and none catches the examples of the prompt
  const good = [[W("חשש לכשל במנפח כרית האוויר של הנהג בעת פתיחתה", "כריות אוויר"), "המנפח הוא החלק שממלא את כרית האוויר בגז ברגע של תאונה. ייתכן שהוא ייכשל כשהכרית נפתחת, ואז הכרית עלולה לא להגן כראוי ואף לגרום לפציעה. בתיקון מחליפים את המנפח בחלק חדש."],
    [W("עדכון תוכנת מערכת המולטימדיה", "חשמל אליקטרוניקה ומיזוג", "עדכון תוכנה", CAMPAIGN), "זו קריאת שירות ולא ריקול בטיחותי. מערכת המולטימדיה, שמפעילה את המסך והרדיו, מקבלת עדכון תוכנה."],
    [W("כשל אפשרי בתוכנת מחשב ניהול הבלמים ABS", "בלמים", "עדכון תוכנה"), "מחשב הבלמים מנהל את מערכת ה-ABS, שמונעת מהגלגלים להינעל בבלימה חזקה. ייתכן כשל בתוכנה שלו, שעלול לפגוע בבלימה. בתיקון מעדכנים את התוכנה."],
    [W("לחות עלולה לחדור למחבר החשמלי של המאוורר ולגרום להתחממות. עד לתיקון יש להחנות את הרכב מחוץ למבנים", "חשמל אליקטרוניקה ומיזוג"), "לחות עלולה לחדור למחבר החשמלי של המאוורר ולגרום להתחממות שלו. בתיקון מחליפים את המחבר בחלק חדש."]];
  for (const [w, t] of good) ok(textCheck(t, w).length === 0, "a good text passes: " + t.slice(0, 30));
  const base = good[0][0], fault = (t, id, w = base) => ok(textCheck(t, w).some(b => b.id === id), `rule ${id}: ${t.slice(0, 40)}`);
  fault("כרית האוויר עלולה להיפתח מאוחר מדי. בעלי הרכב זכאים לתיקון של כרית האוויר בכל מקרה שהוא.", "entitled");
  fault("ייתכן שהרכב כלול בקריאה, וכרית האוויר עלולה להיפתח מאוחר מדי בעת תאונה ולגרום לפציעה.", "included");
  fault("כרית האוויר עלולה להיפתח מאוחר מדי בעת תאונה. התיקון ניתן בחינם ומחליף את המנפח בחלק חדש.", "cost");
  fault("כרית האוויר עלולה להיפתח מאוחר מדי בעת תאונה. כדאי לתאם תור במוסך מורשה ולהחליף את המנפח.", "steps");
  fault("כרית האוויר עלולה להיפתח מאוחר מדי בעת תאונה. אפשר לבדוק אם הרכב ברשימה לפי מספר השלדה.", "steps");
  fault("היבואן לא בדק את כרית האוויר כנדרש, והיא עלולה להיפתח מאוחר מדי בעת תאונה ולגרום לפציעה.", "blame");
  fault("כרית האוויר ברכב שלכם עלולה להיפתח מאוחר מדי בעת תאונה. התיקון מחליף את המנפח בחלק חדש.", "you");
  fault("סכנת חיים! כרית האוויר עלולה להיפתח מאוחר מדי בעת תאונה. התיקון מחליף את המנפח בחלק חדש.", "alarm");
  fault("כרית האוויר עלולה להיפתח מאוחר מדי, אבל אין סכנה ואפשר להמשיך לנסוע כרגיל עד התיקון שלה.", "downplay");
  fault("מערכת המולטימדיה, שמפעילה את המסך והרדיו, מקבלת עדכון תוכנה שמשפר את הפעולה שלה ברכב.", "campaign", good[1][0]);
  fault("כרית האוויר עלולה להיפתח באיחור של 30 אלפיות שנייה בעת תאונה. בתיקון מחליפים את המנפח.", "number");
  fault("כרית האוויר בדגם Corolla עלולה להיפתח מאוחר מדי בעת תאונה. בתיקון מחליפים את המנפח בחלק חדש.", "latin");
  fault("כרית האוויר עלולה להיכשל.", "length");
  fault("The airbag inflator may rupture when the airbag opens, and parts of it may injure people in the car.", "hebrew", W("airbag inflator may rupture", "כריות אוויר"));
  ok(textCheck("זו קריאת שירות. ייתכן שהבורג רופף, ובורג כזה עלול להשתחרר בנסיעה. בתיקון מהדקים את הבורג ובודקים את החיבור.", W("בורג רופף", "אחר", "הידוק", CAMPAIGN)).length === 0
    && textCheck("משענת הראש עלולה להשתחרר ממקומה בתאונה, ואז היא לא תגן על הראש כראוי. התיקון מחבר אותה בפין נעילה חדש.", W("משענת הראש יוצרה ללא פין נעילה", "אחר")).length === 0,
    "an accusative את, a bare בודקים and a head restraint pass");
  // the notice: only the description's own instruction, with its own steps, calm, and never on a description without one
  const park = good[3][0], o = (text, notice) => ({ text, notice, unclear: false });
  ok(check(o(good[3][1], "לפי הודעת הריקול, עד התיקון יש להחנות את הרכב מחוץ למבנים."), park).length === 0, "a notice with the description's own instruction passes, steps and all");
  ok(check(o(good[0][1], "לפי הודעת הריקול, עד התיקון כדאי להחנות את הרכב בחוץ."), base).some(b => b.id === "notice"), "no instruction in the description: no notice");
  ok(check(o(good[3][1], "עד התיקון יש להחנות את הרכב מחוץ למבנים."), park).some(b => b.id === "notice-start")
    && check(o(good[3][1], "לפי הודעת הריקול, היבואן מבקש להחנות את הרכב מחוץ למבנים!"), park).some(b => b.id === "notice-blame")
    && check(o(good[3][1], "לפי הודעת הריקול, היבואן מבקש להחנות את הרכב מחוץ למבנים!"), park).some(b => b.id === "notice-alarm"), "a notice starts with its source, names no one and stays calm");
  const stopW = W("חשש לתקלה בעת התנפחות כרית אוויר של גלגל ההגה. חובה לעצור שימוש ברכב באופן מידי תוך תיאום כניסה למרכז שירות.", "כריות אוויר");
  ok(check(o("כרית האוויר שבגלגל ההגה עלולה לא להתנפח כראוי בתאונה, ואז היא לא תגן על הנהג כמו שצריך. בתיקון מחליפים את כרית האוויר.",
    "לפי הודעת הריקול, יש להפסיק מיד את השימוש ברכב ולתאם הגעה למרכז שירות."), stopW).length === 0, "a stop notice may say מיד and לתאם");
  // urgency: the higher of the rules and the model; the model alone never says stop
  const U = (w, urgency, sys = "other") => urgencyOf(w, { urgency, sys }).urgency;
  ok(U(stopW, "soon") === "stop" && urgencyOf(stopW, { urgency: "stop", sys: "airbags" }).urgencyBy === "both", "a description that says to stop using the car is stop, by rules and model");
  ok(U(W("רעש מגלגלת המתח של הרצועה", "מנוע ומערכותיו"), "stop") === "soon" && U(W("רעש מגלגלת המתח של הרצועה", "מנוע ומערכותיו"), "routine") === "routine", "the model's stop without an instruction is soon; routine stays routine");
  ok(U(W("צינור הבלם עלול להשתפשף", "אחר"), "routine") === "soon" && urgencyOf(W("צינור הבלם עלול להשתפשף", "אחר"), { urgency: "routine", sys: "other" }).urgencyBy === "rules"
    && U(W("x", "אחר"), "routine", "airbags") === "soon", "a critical system is soon whatever the model says, and a critical sys from the model is soon");
  // critical systems by rules: whole words only
  ok(critByRules(W("צינור הבלם עלול להשתפשף", "אחר")) && critByRules(W("דליפת דלק מהמשאבה", "מנוע ומערכותיו")) && critByRules(W("x", "בלמים"))
    && critByRules(W("תקלה ביחידת ABS", "אחר")) && critByRules(W("חשש לשריפה בתא המנוע", "אחר")), "critical: brake hose, fuel leak, the brakes system, ABS, fire");
  ok(!critByRules(W("משענת הראש עלולה להשתחרר", "אחר")) && !critByRules(W("רעש מגלגלת המתח של הרצועה", "מנוע ומערכותיו")) && !critByRules(W("כשל בהדלקת נורית האזהרה", "חשמל אליקטרוניקה ומיזוג")),
    "not critical: a head restraint (ראש), a pulley (גלגלת), turning a light on (הדלקת)");
  ok(keyOf(wording({ SUG_RECALL: "א", SUG_TAKALA: "ב", TEUR_TAKALA: "  ג  ד ", OFEN_TIKUN: "ה" })) === keyOf({ t: "א", s: "ב", d: "ג ד", f: "ה" }) && /^[0-9a-f]{16}$/.test(keyOf(base)), "the key of a wording ignores spacing");
  ok(JSON.stringify(queries("sample=20 wait=500 redo=1 effort=xhigh bogus=1")) === JSON.stringify({ sample: 20, max: 3000, wait: 120, rounds: 3, redo: true, dry: false, effort: "low" }), "queries: clamped, unknown dropped");
  ok(JSON.stringify(params(base, null).output_config.format.schema.required) === JSON.stringify(["text", "notice", "sys", "urgency", "unclear"]) && params(base, null).system[0].cache_control
    && params(base, null).output_config.effort === "low" && !("thinking" in params(base, null)) && !("temperature" in params(base, null)), "the request: structured output, a cached system prompt, low effort, no thinking or sampling field");
  // whole runs on a made-up catalogue through a fake API: the replies depend on the description
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rx-")), catDir = path.join(tmp, "cat"), dirs = n => ({ CAT: catDir, PREV: path.join(tmp, "run" + (n - 1)), OUT: path.join(tmp, "run" + n) });
  fs.mkdirSync(path.join(catDir, "r"), { recursive: true });
  const row = (id, d, s = "בלמים", f = "החלפה", t = "תקלה סידרתית בטיחותית") => ({ RECALL_ID: id, TOZAR_TEUR: "TESTMAKER", DEGEM: "TESTMODEL", YEVUAN_TEUR: "TESTIMPORTER", TELEPHONE: "*1234", SUG_RECALL: t, SUG_TAKALA: s, TEUR_TAKALA: d, OFEN_TIKUN: f });
  const rows = [row(1, "צינור הבלם הקדמי עלול להשתפשף"), row(2, "עדכון תוכנת המולטימדיה", "חשמל אליקטרוניקה ומיזוג", "עדכון תוכנה", CAMPAIGN), row(3, "משענת הראש עלולה להשתחרר", "אחר", "בדיקה"),
    row(4, "חשש לכשל במנפח FAILONCE", "כריות אוויר"), row(5, "חשש REFUSE", "אחר"), row(6, "חשש ALWAYSBAD", "אחר"), row(7, "מערכת חשמל", "חשמל אליקטרוניקה ומיזוג", "בדיקה"), row(8, "צינור הבלם הקדמי עלול להשתפשף"),
    row(10, stopW.d, "כריות אוויר")];
  fs.writeFileSync(path.join(catDir, "r", "1.json"), JSON.stringify({ u: "2026-10-28", rows }));
  const sentPrompts = [], reply = p => {
    const u = p.messages[0].content; sentPrompts.push(u);
    const msg = x => ({ type: "succeeded", message: { stop_reason: "end_turn", content: [{ type: "thinking", thinking: "" }, { type: "text", text: JSON.stringify({ notice: "", unclear: false, ...x }) }] } });
    const okText = "ייתכן שהחלק הזה ייכשל, וכשל כזה עלול לפגוע בפעולה התקינה של המערכת. בתיקון מחליפים את החלק בחלק חדש.";
    if (u.includes("REFUSE")) return { type: "succeeded", message: { stop_reason: "refusal", stop_details: { category: "general_harms" }, content: [] } };
    if (u.includes("ALWAYSBAD")) return msg({ text: "התיקון ניתן בחינם, וכשל כזה עלול לפגוע בפעולה התקינה של המערכת ברכב.", sys: "other", urgency: "routine" });
    if (u.includes("FAILONCE") && !u.includes("A previous draft")) return msg({ text: "בעלי הרכב זכאים לתיקון, וכשל כזה עלול לפגוע בפעולה התקינה של כרית האוויר.", sys: "airbags", urgency: "soon" });
    if (u.includes("מערכת חשמל")) return msg({ text: "", sys: "electrical", urgency: "routine", unclear: true });
    if (u.includes(CAMPAIGN)) return msg({ text: "זו קריאת שירות ולא ריקול בטיחותי. מערכת המולטימדיה מקבלת עדכון תוכנה שמשפר את פעולתה.", sys: "software", urgency: "routine" });
    if (u.includes("חובה לעצור")) return msg({ text: okText, notice: "לפי הודעת הריקול, יש להפסיק מיד את השימוש ברכב ולתאם הגעה למרכז שירות.", sys: "airbags", urgency: "stop" });
    return msg({ text: okText, sys: u.includes("משענת") ? "seats" : "brakes", urgency: "routine" });
  };
  const fake = ({ slow = false, fail = 0, errored = false } = {}) => {
    const store = new Map(); let n = 0;
    const boom = () => { const e = new Error("boom"); e.status = fail; throw e; };
    return { messages: { batches: {
      create: async ({ requests }) => { if (fail) boom(); const id = "msgbatch_" + (++n); store.set(id, requests); return { id }; },
      retrieve: async id => ({ id, processing_status: slow ? "in_progress" : "ended" }),
      results: async id => (async function* () { for (const r of store.get(id)) yield { custom_id: r.custom_id, result: errored ? { type: "errored", error: { type: "error", error: { type: "invalid_request_error", message: "x" } } } : reply(r.params) }; })(),
      cancel: async () => {},
    } }, store };
  };
  const calls = [], router = { alert: async (lv, key) => { calls.push(["alert", lv, key]); return { delivered: true }; }, resolve: async p => { calls.push(["resolve", p[0]]); return 0; } };
  const quiet = () => {}, readOut = n => JSON.parse(fs.readFileSync(path.join(tmp, "run" + n, "explain.json"), "utf8")), stateOut = n => JSON.parse(fs.readFileSync(path.join(tmp, "run" + n, "state.json"), "utf8"));
  const env = (n, Q = "", extra = {}) => ({ ...dirs(n), QUERIES: Q, ...extra });
  let r = await run({ env: env(1, "wait=0"), api: fake(), router, log: quiet });
  let ex = readOut(1), st = stateOut(1), it = Object.values(ex.items), by = d => it.find(x => x.d.includes(d));
  ok(r.sent === 8 + 2 + 1 && it.length === 6 && r.held === 2, "first run: 8 wordings (two rows share one), 6 kept, 2 held; the retries sent in a second and third round");
  ok(by("צינור הבלם").urgency === "soon" && by("צינור הבלם").urgencyBy === "both" && by("צינור הבלם").crit && by("צינור הבלם").ids.join() === "1,8",
    "a brake hose is soon by rules and by its system (the model said routine); both recalls of the wording are on it");
  ok(by("חובה לעצור").urgency === "stop" && by("חובה לעצור").notice.startsWith("לפי הודעת הריקול") && by("חובה לעצור").checked.by === "rules", "a stop wording: stop, with its notice, checked by the rules");
  ok(by("משענת").urgency === "routine" && !by("משענת").crit && by("משענת").text && !by("מערכת חשמל").text && by("מערכת חשמל").unclear, "a head restraint is routine; a bare 'מערכת חשמל' is unclear, with no text");
  ok(by("FAILONCE") && by("FAILONCE").urgency === "soon" && sentPrompts.some(u => u.includes("FAILONCE") && u.includes("A previous draft was rejected") && u.includes("entitled")), "a text that broke a rule went back with the rule it broke, and the next one was kept");
  ok(st.held[Object.keys(st.held).find(k => st.held[k].w.d.includes("REFUSE"))].n === 1 && st.held[Object.keys(st.held).find(k => st.held[k].w.d.includes("ALWAYSBAD"))].n === 3, "a refusal is held at once; a text that keeps breaking a rule is held after 3 tries");
  ok(!sentPrompts.some(u => /TESTMAKER|TESTMODEL|TESTIMPORTER|1234/.test(u)), "no maker, model, importer or phone in any prompt");
  ok(calls.some(c => c[0] === "resolve" && c[1] === "ai:recalls") && calls.some(c => c[0] === "resolve" && c[1] === "ai:key") && !calls.some(c => c[0] === "alert"), "a good run closes ai:recalls and ai:key, and raises nothing");
  const md = fs.readFileSync(path.join(tmp, "run1", "review.md"), "utf8");
  ok(md.includes("מחכים לאדם (2)") && md.includes("⛔") && md.includes("🟠") && md.includes(LINES.soon) && md.includes("**לפי הודעת הריקול"), "review.md: the held ones first, the urgency marks, the fixed lines and the notice");
  sentPrompts.length = 0; calls.length = 0;
  r = await run({ env: env(2), api: fake(), router, log: quiet });
  ok(r.sent === 0 && sentPrompts.length === 0 && Object.keys(readOut(2).items).length === 6, "the next run sends nothing: every wording has a text or used up its tries");
  // a new wording in the catalogue, and a batch that has not ended by the deadline: the next run collects it
  fs.writeFileSync(path.join(catDir, "r", "2.json"), JSON.stringify({ u: "2026-10-28", rows: [row(9, "חשש לדליפת דלק מצינור ההזנה", "מערכת הדלק")] }));
  const slow = fake({ slow: true });
  r = await run({ env: env(3, "wait=0"), api: slow, router, log: quiet });
  ok(r.sent === 1 && r.pending && stateOut(3).pending && stateOut(3).pending.id === "msgbatch_1" && Object.keys(readOut(3).items).length === 6, "a batch still running at the deadline is kept for the next run");
  r = await run({ env: env(4, "wait=0"), api: { messages: { batches: { ...slow.messages.batches, retrieve: async id => ({ id, processing_status: "ended" }) } } }, router, log: quiet });
  ok(r.sent === 0 && !stateOut(4).pending && readOut(4).items[keyOf(wording(row(9, "חשש לדליפת דלק מצינור ההזנה", "מערכת הדלק")))].urgency === "soon", "the next run collects it, and sends nothing new meanwhile");
  // no key: nothing sent, nothing raised, the files as they were; an API error raises ai:recalls; the key or the credit raises ai:key
  calls.length = 0;
  r = await run({ env: env(5, "redo=1"), router, log: quiet });
  ok(r.why === "no ANTHROPIC_API_KEY" && !calls.length && Object.keys(readOut(5).items).length === 7, "no key: kept what there was, quietly");
  r = await run({ env: env(6, "redo=1"), api: fake({ fail: 529 }), router, log: quiet });
  ok(r.why === "529 server" && calls.some(c => c[0] === "alert" && c[1] === "summary" && c[2] === "ai:recalls") && !calls.some(c => c[0] === "resolve") && Object.keys(readOut(6).items).length === 7, "an API error: ai:recalls (summary), nothing closed, the texts kept");
  calls.length = 0;
  r = await run({ env: env(7, "redo=1"), api: fake({ fail: 401 }), router, log: quiet });
  ok(r.why === "401 key" && calls.some(c => c[0] === "alert" && c[1] === "day" && c[2] === "ai:key"), "a refused key: ai:key (day), for Dudu");
  calls.length = 0;
  r = await run({ env: env(8, "redo=1"), api: fake({ errored: true }), router, log: quiet });
  ok(/^batch errored invalid_request_error/.test(r.why) && calls.some(c => c[2] === "ai:recalls") && !Object.keys(stateOut(8).held).some(k => stateOut(8).held[k].n > 3) && Object.keys(readOut(8).items).length === 7,
    "every request of a batch errored: a failed call (ai:recalls), no try used, the texts kept");
  // dry run and the sample spread
  const logs = [];
  r = await run({ env: env(9, "dry=1 redo=1"), api: fake({ fail: 500 }), router, log: l => logs.push(l) });
  ok(r.sent === 0 && logs.some(l => /^dry run: 9 to send/.test(l)) && logs.some(l => l.startsWith("סוג הקריאה:")), "dry: counts and one prompt, no call");
  const cat = readCatalogue(catDir), pick = pickSample([...cat.keys()], cat, 4).map(k => cat.get(k).w);
  ok(pick.length === 4 && new Set(pick.map(w => w.t === CAMPAIGN ? "c" : w.s)).size === 4, "a sample takes one of each kind first");
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(bad ? `${bad} failed` : "selftest ok"); process.exit(bad ? 1 : 0);
}

// Reference copy of the "answer-lint v1" block: the text rules that the recall explanations (.github/scripts/recall-explain.mjs, which
// imports this file) share with the technical advisor's answers (its Worker pastes everything between the two marker lines byte-identical,
// so it stays one pasteable file; CI compares the copies). Plain JavaScript: no imports and no Node API.
// A rule is [id, broken(text, ctx), say]. ctx is the recall's wording {t, s, d, f} for an explanation and the car data for an answer; a rule
// reads only the fields it knows, and a field ctx lacks is empty. broken returns false, or true or a string that names what broke. say is
// what a model is told when its text broke the rule. Each caller picks its rules by id: the explanations take the 15 below (and a spelling
// rule of their own, which needs hunspell); an answer names the importer, gives steps and may say "בדרך כלל ללא עלות", so the advisor takes
// entitled and hebrew as blocks and refrigerant as a count, beside rules of its own.
// lint(text, ctx, ids): the rules of ids (all when ids is left out) that the text breaks, as [{id, say}].
// >>> answer-lint v1
const LINT_CAMPAIGN = "קמפיין שרות טכני";   // the ministry's SUG_RECALL of a service campaign
const lintCtx = (c, f) => String((c && c[f]) || "");
const LINT_HE = "א-ת";   // the Hebrew letters, final forms included
// a whole Hebrew word of the list after up to two one-letter prefixes (ו ה ב ל מ ש כ); lintExact(): the word only as listed
const lintWords = list => new RegExp(`(?<![${LINT_HE}])[והבלמשכ]{0,2}(?:${list.join("|")})(?![${LINT_HE}])`);
const lintExact = list => new RegExp(`(?<![${LINT_HE}])(?:${list.join("|")})(?![${LINT_HE}])`);
const LINT_LATIN_OK = new Set(["ABS", "ESP", "ESC", "EBD", "ECU", "EGR", "DPF", "LED", "USB", "ADAS", "AEB", "TPMS", "SRS", "GPS", "EV"]);
const lintBare = s => s.toUpperCase().replace(/[\s-]/g, "");   // "eCall" is the description's "E-CALL"
// "מכלול" (an assembly, "במכלול המשאבה") is מ before כלול: a part, never "included"
const LINT_ASSEMBLY = new RegExp(`(?<![${LINT_HE}])[והבלשכ]{0,2}מכלול(?:ים|י|ה|ות|ו|ת)?(?![${LINT_HE}])`, "g");
// "not a safety recall": an Israeli service campaign can be an airbag or a brake booster, so no text says a record is not about safety
const LINT_NOT_SAFETY = /ולא ריקול|ולא קריאת בטיחות|(?:לא|אינו|אינה|אינם|אין זה|אין זו) (?:מדובר ב)?(?:ריקול|תקלה|קריאת|קריאה|בעיה) ?(?:בטיחותי|בטיחותית|בטיחות)|(?:לא|אינו|אינה|אינם) (?:בטיחותי|בטיחותית|בטיחותיים|קשור(?:ה|ים)? לבטיחות|נוגע(?:ת|ים)? לבטיחות)/;
// [id, broken(text, ctx), what the model is told when its text broke it]
const LINT_RULES = [
  ["entitled", t => /זכא/.test(t), "Never say entitled (זכאי, זכאות) or anything like it."],
  ["included", t => lintWords(["כלול", "כלולה", "כלולים", "כלולות", "נכלל", "נכללת", "נכללים", "נכללות", "נכללו", "נכללה"]).test(t.replace(LINT_ASSEMBLY, " ")),
    "Do not say whether a car is included in the recall."],
  ["cost", t => lintExact(["חינם", "בחינם", "עלות", "העלות", "ללא עלות", "בלי עלות", "תשלום", "בתשלום", "התשלום", "ללא תשלום", "לשלם", "מחיר", "המחיר", "כסף", "על חשבון"]).test(t),
    "Nothing about cost or payment."],
  ["steps", t => lintWords(["מוסך", "מוסכים", "התקשרו", "להתקשר", "לתאם", "תאמו", "בדקו"]).test(t)
    || /צרו קשר|ליצור קשר|יצירת קשר|מספר (ה)?שלדה|מספר (ה)?רישוי|אתר (ה)?אינטרנט|באתר|לבדוק (אם|האם)/.test(t),
    "No steps: nothing about contacting anyone, scheduling, checking whether a car is included, a garage, a website or a VIN (the app shows those)."],
  ["blame", t => lintWords(["יבואן", "יבואנים", "יבואנית", "יצרן", "יצרנים", "יצרנית", "סוחר", "סוחרים", "רשלנות", "אשמה", "הזנחה"]).test(t),
    "Never name or blame the importer, the maker or a dealer (יבואן, יצרן, סוחר)."],
  ["you", t => lintExact(["אתה", "אתם", "שלך", "שלכם", "ושלך", "ושלכם", "לך", "לכם", "ולך", "ולכם", "עליך", "עליכם", "בשבילך", "בשבילכם", "עבורך", "עבורכם",
    "אותך", "אתכם", "ממך", "תוכל", "תוכלו", "תצטרך", "תצטרכו", "שימו", "זכרו", "דעו"]).test(t), "No \"you\" in any form: write about הרכב or רכבים."],
  ["alarm", t => /!/.test(t) || lintWords(["מוות", "קטלני", "קטלנית", "קטלניים", "אסון", "סכנת חיים", "מיד", "מייד", "בדחיפות", "דחוף"]).test(t) || lintExact(["למות"]).test(t),
    "Calm wording: no alarm words (מוות, סכנת חיים, מיד, דחוף) and no exclamation mark."],
  ["downplay", t => /אין (כל |שום )?(סכנה|סיכון|חשש|מה לדאוג|צורך לדאוג)|לא מסוכנ|בטוח לנסוע|להמשיך לנסוע|אין צורך (בתיקון|לתקן)/.test(t) || LINT_NOT_SAFETY.test(t),
    "Do not play a risk down (אין סכנה, אפשר להמשיך לנסוע), and never say that a recall or a service campaign is not a safety matter."],
  ["campaign", (t, c) => lintCtx(c, "t") === LINT_CAMPAIGN && !/קריאת (שירות|שרות)|קמפיין/.test(t), "This is a service campaign (קמפיין שרות טכני): say in the text that it is a service campaign (קריאת שירות)."],
  ["record", t => /אופן התיקון|(?<![א-ת])לפי (?:ה)?(?:רשום|נתונים|הודעה|מאגר|דיווח|דווח)(?![א-ת])/.test(t) || lintWords(["תיאור", "רישום", "ניסוח"]).test(t)   // not מאגר alone: a fluid reservoir is a part
    || /(?:לא|אינו|אינה|אין) (?:מפורט|מפורטת|מפרט|מפרטת|צוין|צוינה|מצוין|מצוינת|מציין|מציינת|מוסבר|מוסברת|נאמר)/.test(t),
    "Write about the recall, never about the record or what it leaves out (no \"לפי התיאור\", \"הרישום מציין\", \"אופן התיקון\", \"לא מפורט\"). When the description names only a part, say what the part does and that it may have a fault. The repair is one plain sentence that names the part: \"בתיקון בודקים את וו הגרירה.\""],
  // the air conditioner's refrigerant is a gas: "נוזל הקירור" is the engine's coolant (six texts of 28.10 had it, the advisor's review);
  // not when the ministry's own description says נוזל קירור (an air conditioning hose that leaks it)
  ["refrigerant", (t, c) => /נוזל (?:ה)?קירור/.test(t) && /מזגן|מיזוג/.test(t + " " + lintCtx(c, "d")) && !/נוזל (?:ה)?(?:קירור|קרור)/.test(lintCtx(c, "d")),
    "The air conditioner compresses and circulates גז הקירור; נוזל הקירור is the liquid that cools the engine. Do not write נוזל הקירור in a text about the air conditioner (for the cooling of a battery or an engine, write מערכת הקירור)."],
  ["number", (t, c) => (t.match(/\d+/g) || []).some(n => !lintCtx(c, "d").includes(n)), "No numbers that the description does not have."],
  ["latin", (t, c) => (t.match(/[A-Za-z][A-Za-z0-9-]*/g) || []).some(x => !lintBare(lintCtx(c, "d")).includes(lintBare(x)) && !LINT_LATIN_OK.has(lintBare(x))),
    "No Latin-letter words the description does not have (no model names, no English)."],
  ["length", t => t.length < 50 || t.length > 320, "Two or three short sentences, 50 to 320 characters."],
  ["hebrew", t => (t.match(/[א-ת]/g) || []).length < 0.7 * (t.match(/[A-Za-zא-ת]/g) || []).length, "Write in Hebrew."],
];
function lint(text, ctx, ids) {
  const t = String(text || ""), out = [];
  for (const [id, broken, say] of LINT_RULES) {
    if (ids && !ids.includes(id)) continue;
    const r = broken(t, ctx || {});
    if (r) out.push({ id, say: typeof r === "string" ? `${say} The words: ${r}.` : say });
  }
  return out;
}
// <<< answer-lint v1
export { LINT_CAMPAIGN, LINT_RULES, lint, lintWords, lintExact };   // recall-explain.mjs and its self-test; in a Worker the block stays module-local

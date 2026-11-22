// flags.json on the flags branch (ops, strategy audit 22.11.2026, D16): judgeFlags() for Site smoke test, which reads the live file.
// `node flags-check.mjs selftest` runs in the Alert router check. (Rule 15, PRO_LOCK and ad scripts, is product's app-wiring.mjs.)

export const FLAG_KEYS = ["inspect_fake_door", "biz_signup", "dealer_revoked"];
// keys whose value is not true/false: dealer_revoked = the cancelled dealer key ids (8 lower-case letters each; product/dealer-phase1)
const LISTS = { dealer_revoked: v => Array.isArray(v) && v.every(x => typeof x === "string" && /^[a-z]{8}$/.test(x)) };
// "" = fine. A missing file (404) is "no flags"; a file must be an object of known keys with true/false values.
export function judgeFlags(status, text) {
  if (status === 404) return "";
  if (status !== 200) return `הקובץ לא נקרא (HTTP ${status})`;
  let j; try { j = JSON.parse(text); } catch { return "הקובץ אינו JSON תקין (למשל פסיק חסר או מיותר)"; }
  if (!j || typeof j !== "object" || Array.isArray(j)) return "הקובץ אינו אובייקט של דגלים";
  const unknown = Object.keys(j).filter(k => !FLAG_KEYS.includes(k)), notBool = Object.keys(j).filter(k => !LISTS[k] && typeof j[k] !== "boolean"), badList = Object.keys(LISTS).filter(k => k in j && !LISTS[k](j[k]));
  return [unknown.length ? `דגל לא מוכר: ${unknown.join(", ")}` : "", notBool.length ? `ערך שאינו true/false: ${notBool.join(", ")}` : "", badList.length ? `רשימה שאינה מזהי קוד של 8 אותיות: ${badList.join(", ")}` : ""].filter(Boolean).join("; ");
}

if (process.argv[2] === "selftest") {
  let n = 0, fails = 0; const ok = (c, m) => { n++; if (!c) { fails++; console.log("FAIL " + m); } };
  ok(judgeFlags(404, "") === "", "no file = no flags");
  ok(judgeFlags(200, '{"inspect_fake_door": false}') === "", "a known flag, false: fine");
  ok(judgeFlags(200, '{"inspect_fake_door": true, "biz_signup": false}') === "", "two known flags: fine");
  ok(/JSON/.test(judgeFlags(200, '{"inspect_fake_door": true,}')), "a trailing comma is caught");
  ok(/לא מוכר/.test(judgeFlags(200, '{"inspect_fakedoor": true}')), "a misspelt flag is caught");
  ok(/true\/false/.test(judgeFlags(200, '{"biz_signup": "true"}')), "a string \"true\" is caught");
  ok(judgeFlags(200, '{"biz_signup": true, "dealer_revoked": ["abcdefgh", "kmnpqrst"]}') === "" && judgeFlags(200, '{"dealer_revoked": []}') === "", "dealer_revoked: a list of 8-letter key ids is fine");
  ok(/8 אותיות/.test(judgeFlags(200, '{"dealer_revoked": ["ABC12345"]}')) && /8 אותיות/.test(judgeFlags(200, '{"dealer_revoked": "abcdefgh"}')), "dealer_revoked: a wrong id or a plain string is caught");
  ok(/אובייקט/.test(judgeFlags(200, "[true]")) && /HTTP 500/.test(judgeFlags(500, "")), "an array and a server error are caught");
  console.log(fails ? `flags-check: ${fails} of ${n} FAILED` : `flags-check selftest ok (${n} checks)`); process.exit(fails ? 1 : 0);
}

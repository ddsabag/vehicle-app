// luchit-api: double opt-in for the magazine newsletter, without a database and without Brevo's double-opt-in feature.
//   POST /api/subscribe  { email, consent:true, website:"" }  -> sends a confirmation mail (Brevo transactional API) with a signed, 48h link
//   GET  /api/confirm?e=<email>&x=<expiry>&t=<signature>      -> verifies the signature, adds the contact to the Brevo list, redirects to /magazine/?subscribed=1
// Route: luchit.app/api/*   Secret: BREVO_KEY (also signs the links; CONFIRM_SECRET is used instead if you set it)   Var: BREVO_LIST_ID
// The visible mail is email/confirm.html in the repo; CONFIRM_HTML below is that file with the link as {{CONFIRM_URL}} (regenerate it when the design changes).
const ORIGIN = "https://luchit.app";
const TTL_MS = 48 * 3600 * 1000;
const CONFIRM_HTML = "<!doctype html>\n<html lang=\"he\" dir=\"rtl\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta name=\"color-scheme\" content=\"light dark\"><meta name=\"supported-color-schemes\" content=\"light dark\">\n<title>לוחית</title>\n<style>\nbody{margin:0;padding:0;background:#f1f3f7;-webkit-text-size-adjust:100%}\ntable{border-collapse:collapse}\na{color:#2a56c6}\n@media (max-width:620px){.px{padding-left:22px!important;padding-right:22px!important}.h1{font-size:23px!important}.btn a{display:block!important;text-align:center!important}}\n@media (prefers-color-scheme:dark){\n  body,.bg{background:#0d1118!important}\n  .card{background:#161c27!important}\n  .tx{color:#e9edf3!important}\n  .mu{color:#9aa4b6!important}\n  .ln{border-color:#2a3342!important;background:#2a3342!important}\n  .tile{background:#1d2532!important}\n}\n</style></head>\n<body class=\"bg\" dir=\"rtl\" style=\"margin:0;padding:0;background:#f1f3f7\">\n<div style=\"display:none;max-height:0;overflow:hidden;opacity:0;color:transparent\">עוד צעד אחד: אישור ההרשמה למגזין לוחית</div>\n<table role=\"presentation\" width=\"100%\" dir=\"rtl\" class=\"bg\" style=\"background:#f1f3f7\"><tr><td align=\"center\" style=\"padding:28px 12px\">\n<table role=\"presentation\" width=\"600\" dir=\"rtl\" style=\"width:100%;max-width:600px\">\n  <tr><td class=\"card\" dir=\"rtl\" align=\"right\" style=\"background:#ffffff;border-radius:16px;border-top:5px solid #ffc400;overflow:hidden\">\n    <table role=\"presentation\" width=\"100%\" dir=\"rtl\">\n      <tr><td dir=\"rtl\" align=\"right\" class=\"ff px\" style=\"text-align:right;font-family:Assistant,'Segoe UI',Arial,Helvetica,sans-serif;padding:24px 36px 4px\" ><table role=\"presentation\" dir=\"rtl\"><tr><td dir=\"rtl\" align=\"right\" style=\"padding-left:12px\"><a href=\"https://luchit.app/\"><img src=\"https://luchit.app/icon-512.png\" width=\"48\" height=\"48\" alt=\"לוחית\" style=\"display:block;border:0;border-radius:11px\"></a></td><td dir=\"rtl\" align=\"right\" style=\"font-family:Assistant,'Segoe UI',Arial,Helvetica,sans-serif\"><a href=\"https://luchit.app/\" class=\"tx\" style=\"text-decoration:none;color:#151a24;font-size:22px;font-weight:800;line-height:1.1\">לוחית</a><div class=\"mu\" style=\"color:#6a7384;font-size:13px;margin-top:3px\">בדיקת רכב לפי מספר רישוי</div></td></tr></table></td></tr>\n      <tr><td dir=\"rtl\" align=\"right\" class=\"ff px\" style=\"text-align:right;font-family:Assistant,'Segoe UI',Arial,Helvetica,sans-serif;padding:18px 36px 34px\" ><h1 class=\"tx h1\" dir=\"rtl\" style=\"margin:0 0 14px;font-family:Assistant,'Segoe UI',Arial,Helvetica,sans-serif;font-size:27px;line-height:1.3;color:#151a24;text-align:right\">עוד צעד אחד ואתם רשומים</h1><p class=\"tx\" dir=\"rtl\" style=\"margin:0 0 12px;font-family:Assistant,'Segoe UI',Arial,Helvetica,sans-serif;font-size:16px;line-height:1.75;color:#151a24;text-align:right;\">ביקשתם לקבל את המגזין החודשי של לוחית. כדי לוודא שהכתובת שלכם, לחצו על הכפתור:</p><table role=\"presentation\" dir=\"rtl\" align=\"right\" class=\"btn\" style=\"margin:26px 0 6px\"><tr><td dir=\"rtl\" align=\"center\" style=\"background:#2a56c6;border-radius:10px\"><a href=\"{{CONFIRM_URL}}\" style=\"display:inline-block;padding:15px 34px;color:#ffffff;font-family:Assistant,'Segoe UI',Arial,Helvetica,sans-serif;font-weight:700;font-size:16px;text-decoration:none\">אישור הרשמה</a></td></tr></table><table role=\"presentation\" dir=\"rtl\" width=\"100%\" style=\"margin-top:22px\"><tr><td dir=\"rtl\" align=\"right\" class=\"tile\" style=\"background:#f5f7fa;border-radius:10px;padding:12px 14px;text-align:right;font-family:Assistant,'Segoe UI',Arial,Helvetica,sans-serif\"><table role=\"presentation\" dir=\"rtl\"><tr><td dir=\"rtl\" align=\"right\" valign=\"top\" style=\"font-size:20px;line-height:1.3;padding-left:12px\">📊</td><td dir=\"rtl\" align=\"right\" class=\"tx\" style=\"font-family:Assistant,'Segoe UI',Arial,Helvetica,sans-serif;color:#151a24;font-size:15px;line-height:1.6;text-align:right\"><b>סיכום חודשי של שוק הרכב</b><br><span class=\"mu\" style=\"color:#5d6676;font-size:14px\">מגמות, דגמים ונתונים ממשרד התחבורה, בעברית פשוטה.</span></td></tr></table></td></tr><tr><td style=\"height:8px;line-height:8px;font-size:0\">&nbsp;</td></tr><tr><td dir=\"rtl\" align=\"right\" class=\"tile\" style=\"background:#f5f7fa;border-radius:10px;padding:12px 14px;text-align:right;font-family:Assistant,'Segoe UI',Arial,Helvetica,sans-serif\"><table role=\"presentation\" dir=\"rtl\"><tr><td dir=\"rtl\" align=\"right\" valign=\"top\" style=\"font-size:20px;line-height:1.3;padding-left:12px\">🔔</td><td dir=\"rtl\" align=\"right\" class=\"tx\" style=\"font-family:Assistant,'Segoe UI',Arial,Helvetica,sans-serif;color:#151a24;font-size:15px;line-height:1.6;text-align:right\"><b>פעם בחודש, לא יותר</b><br><span class=\"mu\" style=\"color:#5d6676;font-size:14px\">בלי ספאם. אפשר להסיר את עצמכם בלחיצה אחת בכל מייל.</span></td></tr></table></td></tr><tr><td style=\"height:8px;line-height:8px;font-size:0\">&nbsp;</td></tr></table><p class=\"mu\" dir=\"rtl\" style=\"margin:0;font-family:Assistant,'Segoe UI',Arial,Helvetica,sans-serif;font-size:13px;line-height:1.7;color:#6a7384;text-align:right\">לא נרשמתם? אפשר להתעלם מהמייל, ולא נשלח לכם דבר.</p></td></tr>\n    </table>\n  </td></tr>\n  <tr><td dir=\"rtl\" align=\"right\" class=\"ff px mu\" style=\"text-align:right;font-family:Assistant,'Segoe UI',Arial,Helvetica,sans-serif;padding:20px 36px 8px;color:#6a7384;font-size:12px;line-height:1.75\" ><div style=\"margin-bottom:6px\">הודעת אישור הרשמה שנשלחה בעקבות בקשה באתר <bdi dir=\"ltr\">luchit.app</bdi>. המגזין עצמו הוא פרסומת, והוא יישלח רק אחרי האישור.</div><div><bdi dir=\"ltr\"><a href=\"mailto:updates@luchit.app\" style=\"color:#6a7384\">updates@luchit.app</a></bdi> · <a href=\"https://luchit.app/privacy.html\" style=\"color:#6a7384\">מדיניות פרטיות</a></div></td></tr>\n</table>\n</td></tr></table>\n</body></html>\n";
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const redirect = v => new Response(null, { status: 302, headers: { location: `${ORIGIN}/magazine/?subscribed=${v}`, "cache-control": "no-store" } });
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/;

const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function sign(env, email, exp) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.CONFIRM_SECRET || env.BREVO_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`confirm|${email}|${exp}`)));
}
const brevo = (env, path, body) => fetch("https://api.brevo.com/v3" + path, { method: "POST", headers: { "api-key": env.BREVO_KEY, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (url.pathname === "/api/confirm" && req.method === "GET") {
      const email = (url.searchParams.get("e") || "").toLowerCase(), exp = Number(url.searchParams.get("x")), t = url.searchParams.get("t") || "";
      if (!EMAIL_RE.test(email) || !(exp > Date.now()) || t !== await sign(env, email, exp)) return redirect("expired");
      const r = await brevo(env, "/contacts", { email, listIds: [Number(env.BREVO_LIST_ID)], updateEnabled: true, attributes: { SOURCE: "magazine", CONSENT_AT: new Date().toISOString() } });
      if (!r.ok) { console.log("brevo contacts", r.status, (await r.text()).slice(0, 300)); return redirect("error"); }
      return redirect("1");
    }

    if (url.pathname !== "/api/subscribe") return json({ error: "not found" }, 404);
    if (req.method !== "POST") return json({ error: "method" }, 405);
    if (req.headers.get("origin") !== ORIGIN) return json({ error: "forbidden" }, 403);
    if (!(req.headers.get("content-type") || "").includes("application/json")) return json({ error: "type" }, 415);
    let b; try { b = await req.json(); } catch { return json({ error: "bad request" }, 400); }
    if (b.website) return json({ ok: true });                         // honeypot: bots fill it, answer success and do nothing
    if (b.consent !== true) return json({ error: "consent" }, 400);   // the unticked checkbox must have been ticked
    const email = String(b.email || "").trim().toLowerCase();
    if (email.length > 254 || !EMAIL_RE.test(email)) return json({ error: "email" }, 400);

    const exp = Date.now() + TTL_MS;
    const link = `${ORIGIN}/api/confirm?e=${encodeURIComponent(email)}&x=${exp}&t=${await sign(env, email, exp)}`;
    const r = await brevo(env, "/smtp/email", {
      sender: { name: "לוחית", email: "updates@luchit.app" }, to: [{ email }], subject: "אשרו את ההרשמה למגזין לוחית",
      htmlContent: CONFIRM_HTML.replaceAll("{{CONFIRM_URL}}", link.replaceAll("&", "&amp;")),
    });
    if (r.ok) return json({ ok: true });
    console.log("brevo smtp", r.status, (await r.text()).slice(0, 300));
    return json({ error: "upstream" }, 502);
  },
};

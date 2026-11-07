// Forms check, part of Site smoke test's page check (ops 7.11.2026). Why: from 23.10 to 7.11 the magazine page refused every address with an
// "s" in it (a lost backslash in its address check) and nothing saw it: the daily run only looked for the form. Nothing here sends a mail.
// 1. every address check in a page's own code (a regex literal from ^ to $ with an @) must accept real addresses and refuse broken ones;
// 2. the API Worker still answers a broken address (/api/subscribe) and a form without consent (/api/waitlist) with its own 400, which it
//    does before any mail, Brevo call or rate-limit count.
// node .github/scripts/form-check.mjs --selftest   (offline)
export const GOOD = ["sasha.s@gmail.com", "user+tag@mail.example.co.il", "dana_levi@walla.co.il", "S.Cohen@Outlook.com"];
export const BAD = ["no-at.example.com", "two words@gmail.com"];
export const PAGES = [{ path: "magazine/", name: "טופס ההרשמה למגזין" }, { path: "business/", name: "טופס הפניות העסקי" }];
const LIT = /\/(\^(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^\\\/\n\[])*@(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^\\\/\n\[])*\$)\/([dgimsuy]*)/g;

// the address checks in a page: [{ src, re }] (a literal that does not compile is skipped)
export function patterns(html) {
  const out = [], seen = new Set();
  for (const m of String(html).matchAll(LIT)) {
    if (seen.has(m[0])) continue; seen.add(m[0]);
    try { out.push({ src: m[0], re: new RegExp(m[1], m[2].replace(/g|y/g, "")) }); } catch { /* not a regex after all */ }
  }
  return out;
}
// what is wrong with a page's checks: [{ src, refuses: [good ones refused], accepts: [bad ones accepted] }]
export function judge(html) {
  return patterns(html).map(p => ({ src: p.src, refuses: GOOD.filter(a => !p.re.test(a)), accepts: BAD.filter(a => p.re.test(a)) }))
    .filter(x => x.refuses.length || x.accepts.length);
}
// the API Worker's own answers to two requests it refuses before doing anything
export async function apiCheck(site, fetchImpl = fetch) {
  const origin = new URL(site).origin, H = { origin, "content-type": "application/json", "user-agent": "luchit-smoke/1.0" }, bad = [];
  const ask = async (path, body, want) => {
    try {
      const r = await fetchImpl(new URL(path, site).href, { method: "POST", headers: H, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
      const t = await r.text();
      if (!(r.status === 400 && t.includes(`"${want}"`))) bad.push(`${path}: ${r.status} ${t.slice(0, 40)}`);
    } catch (e) { bad.push(`${path}: ${String(e.message || e).slice(0, 60)}`); }
  };
  await ask("api/subscribe", { email: "not-an-address", consent: true, website: "" }, "email");
  await ask("api/waitlist", {}, "consent");
  return bad;
}

if (process.argv[2] === "--selftest") {
  let n = 0; const ok = (c, m) => { n++; if (!c) { console.error("FAIL " + m); process.exit(1); } console.log("ok   " + m); };
  const good = 'var em=f.email.value.trim();if(!/^[^\\s@]+@[^\\s@.]+(\\.[^\\s@.]+)+$/.test(em))return;';
  const broken = 'var em=f.email.value.trim();if(!/^[^s@]+@[^s@.]+(.[^s@.]+)+$/.test(em))return;';   // the 23.10-7.11 bug: the backslashes lost
  ok(patterns(good).length === 1 && judge(good).length === 0, "the live check (7.11) passes");
  const j = judge(broken);
  ok(j.length === 1 && j[0].refuses.includes("sasha.s@gmail.com") && j[0].refuses.includes("user+tag@mail.example.co.il") && !j[0].refuses.includes("dana_levi@walla.co.il"), "the 23.10 bug is caught: an address with an s is refused (the page as it was before 2b5d96f5 gives the same)");
  ok(judge('if(/^.+@.+$/.test(x))').some(x => x.accepts.includes("two words@gmail.com")), "a check that lets a broken address through is caught");
  ok(patterns('<a href="https://luchit.app/a/b">x</a> mail: support@luchit.app').length === 0, "plain text with an @ is not a pattern");
  ok(patterns('/^[a-z/]+@x\\.co$/').length === 1 && patterns('/^[a-z\\/]+@x\\.co$/').length === 1, "a slash inside a class, escaped or not, as JavaScript reads it");
  ok(patterns(good + good).length === 1, "the same check twice counts once");
  const f = answers => async (url) => { const a = answers[new URL(url).pathname]; if (a instanceof Error) throw a; return { status: a[0], text: async () => a[1] }; };
  ok((await apiCheck("https://luchit.app/", f({ "/api/subscribe": [400, '{"error":"email"}'], "/api/waitlist": [400, '{"error":"consent"}'] }))).length === 0, "api: both refusals as expected");
  const b = await apiCheck("https://luchit.app/", f({ "/api/subscribe": [502, '{"error":"upstream"}'], "/api/waitlist": new Error("timeout") }));
  ok(b.length === 2 && /subscribe: 502/.test(b[0]) && /waitlist: timeout/.test(b[1]), "api: a wrong answer and a dead route are both reported");
  ok((await apiCheck("https://luchit.app/", f({ "/api/subscribe": [403, '{"error":"forbidden"}'], "/api/waitlist": [400, '{"error":"consent"}'] })))[0].startsWith("api/subscribe: 403"), "api: the Origin check refusing us is a finding, not a pass");
  console.log(`form check ok (${n} checks)`);
}

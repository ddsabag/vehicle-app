// luchit-og offline test (ops 12.11.2026): the security headers, and the page itself passes through unchanged. No network.
let n = 0, bad = 0;
const ok = (c, m) => { n++; if (!c) { bad++; console.log("FAIL " + m); } else console.log("ok   " + m); };
const page = '<html><head><meta property="og:title" content="x"></head><body>hi</body></html>';
globalThis.fetch = async req => { const u = new URL(req.url || req);
  if (u.pathname.endsWith(".json")) return new Response("{}", { headers: { "content-type": "application/json" } });
  if (u.pathname === "/hsts") return new Response(page, { headers: { "content-type": "text/html", "strict-transport-security": "max-age=1" } });
  return new Response(page, { status: u.pathname === "/missing" ? 404 : 200, headers: { "content-type": "text/html; charset=utf-8" } }); };
globalThis.HTMLRewriter = class { on() { return this; } transform(r) { return r; } };
const W = await import("./worker.js"), go = (path, ua = "Mozilla/5.0") => W.default.fetch(new Request("https://luchit.app" + path, { headers: { "user-agent": ua } }), {}, {});
let r = await go("/");
ok(r.status === 200 && (await r.text()) === page, "the page passes through unchanged");
ok(r.headers.get("strict-transport-security") === "max-age=15552000" && r.headers.get("x-content-type-options") === "nosniff" && r.headers.get("referrer-policy") === "strict-origin-when-cross-origin", "HSTS, nosniff and Referrer-Policy on a page");
ok(/object-src 'none'/.test(r.headers.get("content-security-policy-report-only")) && !r.headers.has("content-security-policy"), "the CSP is Report-Only, never enforced");
r = await go("/fuel.json"); ok(r.headers.get("x-content-type-options") === "nosniff" && !r.headers.has("content-security-policy-report-only"), "JSON: the three headers, no CSP");
r = await go("/missing"); ok(r.status === 404 && r.headers.get("referrer-policy"), "a 404 keeps its status and gets the headers");
r = await go("/hsts"); ok(r.headers.get("strict-transport-security") === "max-age=1", "a header the origin sends is kept");
r = await go("/?plate=7654321", "facebookexternalhit/1.1"); ok(r.headers.get("x-content-type-options") === "nosniff", "a crawler's preview gets them too");
console.log(bad ? `og test: ${bad} of ${n} checks FAILED` : `og test ok (${n} checks)`); process.exit(bad ? 1 : 0);

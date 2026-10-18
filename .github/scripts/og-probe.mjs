// Does luchit-og answer link previews right now? Fetches the home page with a crawler and a browser user agent, with and without
// ?cmp= / ?plate=, and prints status, the Cloudflare headers and the og:title the page carries. Runs on GitHub (luchit.app is not
// reachable from the development container). No secrets, no plates: ?plate= uses a number no car has.
const ROOT = "https://luchit.app/", N = Date.now().toString(36);
const UAS = { telegram: "TelegramBot (like TwitterBot)", whatsapp: "WhatsApp/2.23.20.0 A", facebook: "facebookexternalhit/1.1", browser: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36" };
const URLS = [`?cmp=W3t9LHt9XQ&st=${N}`, `?cmp=W3t9LHt9XQ`, `?plate=10000001&st=${N}`, `?st=${N}`, `index.html?cmp=W3t9LHt9XQ&st=${N}`];
for (const q of URLS) for (const [k, ua] of Object.entries(UAS)) {
  if (k !== "telegram" && k !== "browser" && q !== URLS[0]) continue;
  try {
    const r = await fetch(ROOT + q, { headers: { "user-agent": ua }, redirect: "manual", signal: AbortSignal.timeout(20000) });
    const t = await r.text(), title = /<meta property="og:title" content="([^"]*)"/.exec(t)?.[1] || "(none)";
    const h = ["server", "cf-cache-status", "x-luchit-version", "age", "cache-control", "content-type", "location"].map(x => r.headers.get(x) ? `${x}=${r.headers.get(x)}` : "").filter(Boolean).join(" ");
    console.log(`${q.padEnd(44)} ${k.padEnd(8)} ${r.status} ${t.length}B og:title="${title.slice(0, 70)}" ${h}`);
  } catch (e) { console.log(`${q} ${k}: ${e.name} ${e.cause?.code || ""}`); }
}

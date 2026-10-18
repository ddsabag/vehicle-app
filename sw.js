/* Luchit app shell for the web version. Stale-while-revalidate for the page, cache-first for icons.
   Lookups (data.gov.il, JSON data files, model pages) are never cached here, so numbers are always fresh.
   Bump SHELL with APP_VERSION at each release: the old cache is deleted on activate. */
const SHELL = "luchit-shell-1.33.0";
const DATA = "luchit-data-";   // the page's own catalogue cache (index.html cachedJson): never deleted here
const PRECACHE = ["/", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png", "/manifest.json", "/lib/fonts/assistant-hebrew-400-normal.woff2", "/lib/fonts/assistant-hebrew-700-normal.woff2", "/lib/fonts/assistant-latin-400-normal.woff2", "/lib/fonts/assistant-latin-700-normal.woff2", "/lib/fonts/ibm-plex-mono-latin-500-normal.woff2"];

/* the published page loads its code from /app.<hash>.js (see .github/scripts/web-build.mjs): keep the script the cached page points at, so the shell also works offline */
const APP_JS = /^\/app\.[0-9a-f]{10}\.js$/;
async function keepAppScript(c, res) {
  try {
    const m = (await res.text()).match(/src="(\/app\.[0-9a-f]{10}\.js)"/);
    if (!m) return true;
    if (!(await c.match(m[1]))) await c.add(m[1]);
    for (const k of await c.keys()) { const p = new URL(k.url).pathname; if (APP_JS.test(p) && p !== m[1]) await c.delete(k); }   // older bundles are dead weight
    return true;
  } catch { return false; }
}
self.addEventListener("install", e => {
  // the page is fetched fresh (not from the HTTP cache), and a shell whose app script could not be stored is not kept: a page without its code is worse than none
  e.waitUntil(caches.open(SHELL).then(async c => { await c.addAll(PRECACHE.filter(p => p !== "/")); const res = await fetch("/", {cache: "reload"}); if (!res.ok) throw new Error("shell " + res.status); if (await keepAppScript(c, res.clone())) await c.put("/", res); }).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== SHELL && !k.startsWith(DATA)).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("message", e => {   // the page asks after a controller change whether its bundle is the one this worker serves
  if (!e.data || e.data.t !== "app" || !e.source) return;
  e.waitUntil(caches.open(SHELL).then(c => c.match(String(e.data.p))).then(h => e.source.postMessage({t: "stale", stale: !h})).catch(() => {}));
});
self.addEventListener("fetch", e => {
  const r = e.request;
  if (r.method !== "GET") return;
  const u = new URL(r.url);
  if (u.origin === location.origin && r.mode === "navigate" && u.pathname === "/") {
    // any query (?plate=, ?cmp=) is served by the cached shell: the page reads it itself
    e.respondWith(caches.open(SHELL).then(async c => {
      const hit = u.searchParams.get("r") === "1" ? null : await c.match("/");   // ?r=1 is the page's own reload after its script failed: network first, so a broken cached shell cannot loop
      const net = fetch("/").then(res => { if (res.ok) { const a = res.clone(), b = res.clone(); e.waitUntil(keepAppScript(c, b).then(ok => { if (ok) return c.put("/", a); })); } return res; }).catch(() => null);
      if (hit) { e.waitUntil(net); return hit; }
      return (await net) || new Response("אין חיבור לאינטרנט", {status: 503, headers: {"Content-Type": "text/plain; charset=utf-8"}});
    }));
    return;
  }
  if (u.origin === location.origin && APP_JS.test(u.pathname)) {
    e.respondWith(caches.open(SHELL).then(async c => c.match(r).then(h => h || fetch(r))));
    return;
  }
  if (u.origin === location.origin && PRECACHE.includes(u.pathname)) {
    e.respondWith(caches.match(r).then(h => h || fetch(r)));
    return;
  }
});

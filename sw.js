/* Luchit app shell for the web version. Stale-while-revalidate for the page, cache-first for fonts and icons.
   Lookups (data.gov.il, JSON data files, model pages) are never cached here, so numbers are always fresh.
   Bump SHELL with APP_VERSION at each release: the old cache is deleted on activate. */
const SHELL = "luchit-shell-1.27.0";
const FONTS = "luchit-fonts-1";
const PRECACHE = ["/", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png", "/manifest.json", "/lib/fonts/assistant-hebrew-400-normal.woff2", "/lib/fonts/assistant-hebrew-700-normal.woff2", "/lib/fonts/assistant-latin-400-normal.woff2", "/lib/fonts/assistant-latin-700-normal.woff2", "/lib/fonts/ibm-plex-mono-latin-500-normal.woff2"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== SHELL && k !== FONTS).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const r = e.request;
  if (r.method !== "GET") return;
  const u = new URL(r.url);
  if (u.origin === location.origin && r.mode === "navigate" && u.pathname === "/") {
    // any query (?plate=, ?cmp=) is served by the cached shell: the page reads it itself
    e.respondWith(caches.open(SHELL).then(async c => {
      const hit = await c.match("/");
      const net = fetch("/").then(res => { if (res.ok) c.put("/", res.clone()); return res; }).catch(() => null);
      if (hit) { e.waitUntil(net); return hit; }
      return (await net) || new Response("אין חיבור לאינטרנט", {status: 503, headers: {"Content-Type": "text/plain; charset=utf-8"}});
    }));
    return;
  }
  if (u.origin === location.origin && PRECACHE.includes(u.pathname)) {
    e.respondWith(caches.match(r).then(h => h || fetch(r)));
    return;
  }
  if (u.hostname === "fonts.googleapis.com" || u.hostname === "fonts.gstatic.com") {
    e.respondWith(caches.open(FONTS).then(async c => {
      const h = await c.match(r); if (h) return h;
      const res = await fetch(r); if (res.ok || res.type === "opaque") c.put(r, res.clone()); return res;
    }));
  }
});

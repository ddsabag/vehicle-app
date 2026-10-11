/* Luchit caching proxy for data.gov.il (Cloudflare Worker). Never logs plates.
   GET /api?resource_id=...&filters=...&limit=...  ->  the same JSON as the ministry's datastore_search.
   - allowlist of resource ids and of query parameters, limit capped
   - fresh copy for FRESH_S; after that tries the ministry (8 s) and, if it fails or answers an error, serves the stored copy
   - an empty answer is kept only EMPTY_S, and never replaces a stored non-empty copy for a plate (a broken datastore answers "no rows" for everything)
   - X-Stale-At (ms) tells the app that the copy is older than the freshness window */
const ORIGIN = "https://data.gov.il/api/3/action/datastore_search";
const FRESH_S = 6 * 3600, EMPTY_S = 600, KEEP_S = 14 * 86400, TIMEOUT_MS = 8000;
const ALLOWED_ORIGINS = ["https://luchit.app", "https://www.luchit.app", "https://ddsabag.github.io", "https://appassets.androidplatform.net"];
const PARAMS = ["resource_id", "filters", "limit", "q", "plain"];
// resource ids (first 8 chars are enough) used by the app; keep in sync with PLATE_SETS / MODEL_SETS in index.html
const RESOURCES = new Set(["053cea08", "bb2355dc", "56063a99", "0866573c", "f6efe89a", "6f6acd03", "851ecab1", "4e6b9724", "ec8cbc34", "cd3acc5c", "bf9df4e2", "cf29862d", "03adc637", "36bf1404", "83bfb278", "c8b9f9c8", "2c33523f", "142afde2", "5e87a7a1", "39f455bf", "bb68386a", "7cb2bd95"]);

const cors = req => {
  const o = req.headers.get("Origin");
  return {"Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(o) ? o : ALLOWED_ORIGINS[0], "Vary": "Origin", "Access-Control-Expose-Headers": "X-Stale-At"};
};
const json = (body, status, extra) => new Response(body, {status, headers: {"Content-Type": "application/json", ...extra}});

export default {
  async fetch(req, env, ctx) {
    const h = cors(req);
    if (req.method === "OPTIONS") return new Response(null, {status: 204, headers: {...h, "Access-Control-Allow-Methods": "GET", "Access-Control-Max-Age": "86400"}});
    const u = new URL(req.url);
    if (req.method !== "GET" || u.pathname !== "/api") return json('{"success":false,"error":"not found"}', 404, h);
    const rid = u.searchParams.get("resource_id") || "";
    if (!RESOURCES.has(rid.slice(0, 8))) return json('{"success":false,"error":"resource not allowed"}', 400, h);

    const q = new URLSearchParams();
    for (const k of PARAMS) if (u.searchParams.has(k)) q.set(k, u.searchParams.get(k));
    if (!(Number(q.get("limit")) >= 0)) q.set("limit", "100");
    if (Number(q.get("limit")) > 1000) q.set("limit", "1000");
    q.sort();
    const key = new Request(`https://cache.luchit.internal/api?${q}`);   // no plate in any log: the key lives only in the cache
    const cache = caches.default, hit = await cache.match(key);
    const born = hit ? Number(hit.headers.get("X-Stored-At")) : 0;
    const age = hit ? (Date.now() - born) / 1000 : Infinity;
    const empty = hit && hit.headers.get("X-Empty") === "1";
    if (hit && age < (empty ? EMPTY_S : FRESH_S)) return new Response(hit.body, {headers: {...Object.fromEntries(hit.headers), ...h}});

    let fresh = null;
    try {
      const r = await fetch(`${ORIGIN}?${q}`, {signal: AbortSignal.timeout(TIMEOUT_MS), headers: {Accept: "application/json"}});
      if (r.ok) { const text = await r.text(); const j = JSON.parse(text); if (j.success) fresh = {text, rows: (j.result.records || []).length}; }
    } catch (e) { /* ministry down or slow: fall through to the stored copy */ }

    if (fresh) {
      // never let an empty answer overwrite a stored non-empty one (broken datastore); serve the stored copy instead
      if (fresh.rows === 0 && hit && !empty) return stale(hit, born, h);
      const headers = {"Content-Type": "application/json", "Cache-Control": `public, max-age=${KEEP_S}`, "X-Stored-At": String(Date.now()), "X-Empty": fresh.rows ? "0" : "1"};
      ctx.waitUntil(cache.put(key, new Response(fresh.text, {headers})));
      return new Response(fresh.text, {headers: {"Content-Type": "application/json", ...h}});
    }
    if (hit) return stale(hit, born, h);
    return json('{"success":false,"error":"upstream unavailable"}', 502, h);
  },
};
const stale = (hit, born, h) => new Response(hit.body, {headers: {"Content-Type": "application/json", "X-Stale-At": String(born), ...h}});

// luchit-live: a private "right now" page for the owner. GET /live is the page, GET /live/data the numbers (GA4 Realtime + Cloudflare Web Analytics).
// Protected twice: Cloudflare Access in front (route luchit.app/live*), and this Worker verifies the Access JWT itself, so a misconfigured Access policy cannot leak data.
// Returns only aggregate counts, never anything personal. Secrets: GA_SERVICE_ACCOUNT_JSON, CF_API_TOKEN. Vars: see wrangler.toml.
const CF_TAG = "9bb0e756882c478a808d95596e0deade";
const b64u = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
const HEAD = { "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...HEAD, "content-type": "application/json; charset=utf-8" } });

let jwks = null, jwksAt = 0;
async function verifyAccess(req, env) {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return false;          // not configured: refuse
  const tok = req.headers.get("cf-access-jwt-assertion"); if (!tok) return false;
  const [h, p, s] = tok.split("."); if (!s) return false;
  const head = JSON.parse(new TextDecoder().decode(unb64u(h))), pay = JSON.parse(new TextDecoder().decode(unb64u(p)));
  if (Date.now() - jwksAt > 3600e3 || !jwks) { jwks = (await (await fetch(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`)).json()).keys; jwksAt = Date.now(); }
  const jwk = jwks.find(k => k.kid === head.kid); if (!jwk) return false;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, unb64u(s), new TextEncoder().encode(h + "." + p));
  const aud = Array.isArray(pay.aud) ? pay.aud : [pay.aud];
  return ok && aud.includes(env.ACCESS_AUD) && pay.exp * 1000 > Date.now() && pay.iss === `https://${env.ACCESS_TEAM_DOMAIN}`;
}

let gtok = null, gexp = 0;
async function googleToken(env) {
  if (gtok && Date.now() < gexp) return gtok;
  const sa = JSON.parse(env.GA_SERVICE_ACCOUNT_JSON), now = Math.floor(Date.now() / 1000);
  const enc = o => b64u(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = enc({ alg: "RS256", typ: "JWT" }) + "." + enc({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/analytics.readonly", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3000 });
  const pem = sa.private_key.replace(/-----[^-]+-----|\s/g, "");
  const key = await crypto.subtle.importKey("pkcs8", Uint8Array.from(atob(pem), c => c.charCodeAt(0)), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = b64u(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned)));
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: unsigned + "." + sig }) });
  if (!r.ok) throw new Error("google auth " + r.status);
  gtok = (await r.json()).access_token; gexp = Date.now() + 2900e3; return gtok;
}
const realtime = async (env, body) => {
  const r = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${env.GA_PROPERTY_ID}:runRealtimeReport`, { method: "POST", headers: { authorization: "Bearer " + await googleToken(env), "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error("ga4 " + r.status);
  return (await r.json()).rows || [];
};
async function cfVisits(env, day) {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) return null;
  const next = new Date(Date.parse(day + "T00:00:00Z") + 864e5).toISOString().slice(0, 10);
  const q = "query($acc:String!,$f:AccountRumPageloadEventsAdaptiveGroupsFilter_InputObject){viewer{accounts(filter:{accountTag:$acc}){rumPageloadEventsAdaptiveGroups(filter:$f,limit:1){count sum{visits}}}}}";
  const f = { AND: [{ datetime_geq: day + "T00:00:00Z", datetime_leq: next + "T00:00:00Z" }, { siteTag: CF_TAG }] };
  const r = await fetch("https://api.cloudflare.com/client/v4/graphql", { method: "POST", headers: { authorization: "Bearer " + env.CF_API_TOKEN, "content-type": "application/json" }, body: JSON.stringify({ query: q, variables: { acc: env.CF_ACCOUNT_ID, f } }) });
  const g = (await r.json())?.data?.viewer?.accounts?.[0]?.rumPageloadEventsAdaptiveGroups?.[0];
  return g ? Math.round(g.sum.visits) : 0;
}

let cache = null, cacheAt = 0;
async function collect(env) {
  if (cache && Date.now() - cacheAt < 15e3) return cache;
  const today = new Date().toISOString().slice(0, 10), yday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  const safe = p => p.catch(() => null);
  const [active, series, events, vToday, vYday] = await Promise.all([
    safe(realtime(env, { metrics: [{ name: "activeUsers" }] })),
    safe(realtime(env, { dimensions: [{ name: "minutesAgo" }], metrics: [{ name: "eventCount" }] })),
    safe(realtime(env, { dimensions: [{ name: "eventName" }], metrics: [{ name: "eventCount" }], limit: 12 })),
    safe(cfVisits(env, today)), safe(cfVisits(env, yday))]);
  const perMin = Array(30).fill(0);
  for (const r of series || []) perMin[29 - Number(r.dimensionValues[0].value)] = Number(r.metricValues[0].value);
  cache = { at: new Date().toISOString(), activeUsers: active ? Number(active[0]?.metricValues[0].value || 0) : null, perMinute: series ? perMin : null,
    events: events ? events.map(r => [r.dimensionValues[0].value, Number(r.metricValues[0].value)]).sort((a, b) => b[1] - a[1]) : null, visitsToday: vToday, visitsYesterday: vYday };
  cacheAt = Date.now(); return cache;
}

const PAGE = `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>לוחית, מצב עכשיו</title>
<style>:root{--bg:#f4f6fa;--card:#fff;--fg:#151a24;--muted:#5d6676;--line:#dfe4ec;--accent:#2457c5;--ok:#1a7f4b}@media(prefers-color-scheme:dark){:root{--bg:#0e121a;--card:#171d28;--fg:#e9edf3;--muted:#98a2b4;--line:#262e3c;--accent:#7ea3f2;--ok:#5bd08a}}
body{margin:0;background:var(--bg);color:var(--fg);font-family:system-ui,"Assistant",sans-serif;line-height:1.5}main{max-width:560px;margin:0 auto;padding:16px}h1{font-size:1.1rem;margin:0}.top{display:flex;justify-content:space-between;align-items:center;gap:8px}.muted{color:var(--muted);font-size:.8rem}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:12px 0}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px;min-width:0}.num{font-size:1.7rem;font-weight:700;font-variant-numeric:tabular-nums}.lbl{font-size:.75rem;color:var(--muted)}li{display:flex;justify-content:space-between;padding:2px 0}ul{list-style:none;margin:6px 0 0;padding:0}.dot{color:var(--ok)}</style></head><body><main>
<div class="top"><h1>לוחית · מצב עכשיו</h1><div class="muted"><span class="dot">●</span> <span id="t">טוען</span></div></div>
<div class="grid"><div class="card"><div class="lbl">פעילים באפליקציה (30 דק׳)</div><div class="num" id="a">-</div></div><div class="card"><div class="lbl">ביקורים באתר היום</div><div class="num" id="v">-</div></div><div class="card"><div class="lbl">ביקורים באתר אתמול</div><div class="num" id="y">-</div></div></div>
<div class="card"><div class="lbl">אירועים לפי דקה, 30 הדקות האחרונות</div><svg id="s" viewBox="0 0 300 60" width="100%" height="60" role="img" aria-label="אירועים לפי דקה"></svg></div>
<div class="card" style="margin-top:8px"><div class="lbl">אירועים ב-30 הדקות האחרונות</div><ul id="e"></ul></div>
<p class="muted">Search Console מתעכב ב-2 עד 3 ימים וקריסות ב-Play ביום או יומיים, ולכן הם לא כאן. מתרענן כל 30 שניות.</p></main>
<script>const $=i=>document.getElementById(i),n=x=>x==null?"-":Number(x).toLocaleString("en-US");
async function go(){try{const r=await fetch("/live/data",{cache:"no-store"});if(!r.ok)throw 0;const d=await r.json();
$("a").textContent=n(d.activeUsers);$("v").textContent=n(d.visitsToday);$("y").textContent=n(d.visitsYesterday);
const m=Math.max(1,...(d.perMinute||[0]));$("s").innerHTML=(d.perMinute||[]).map((v,i)=>'<rect x="'+(i*10+2)+'" y="'+(60-Math.max(1,v/m*56))+'" width="7" height="'+Math.max(1,v/m*56)+'" fill="var(--accent)" rx="1"/>').join("");
$("e").innerHTML=(d.events||[]).map(e=>"<li><span>"+e[0].replace(/[<>&]/g,"")+"</span><b>"+n(e[1])+"</b></li>").join("")||'<li class="muted">אין אירועים</li>';
$("t").textContent=new Date(d.at).toLocaleTimeString("he-IL")}catch{$("t").textContent="אין חיבור"}}
go();setInterval(go,30000)</script></body></html>`;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!(await verifyAccess(req, env).catch(() => false))) return new Response("forbidden", { status: 403, headers: HEAD });
    if (url.pathname === "/live/data") { try { return json(await collect(env)); } catch (e) { return json({ error: "unavailable" }, 502); } }
    if (url.pathname === "/live" || url.pathname === "/live/") return new Response(PAGE, { headers: { ...HEAD, "content-type": "text/html; charset=utf-8" } });
    return new Response("not found", { status: 404, headers: HEAD });
  }
};

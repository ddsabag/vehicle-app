/* Luchit dynamic link preview (Cloudflare Worker, route luchit.app/*).
   Messaging crawlers (WhatsApp, Telegram, Facebook, X, Slack...) get og:title / og:description for
   ?plate= and ?cmp= links; everyone else gets the page untouched. The plate is looked up once and not stored or logged.
   Needs luchit.app proxied by Cloudflare (orange cloud). */
const CRAWLER = /WhatsApp|TelegramBot|facebookexternalhit|Facebot|Twitterbot|Slackbot|LinkedInBot|Discordbot|SkypeUriPreview|Applebot|Google-PageRenderer|Viber/i;
const ORIGIN = "https://data.gov.il/api/3/action/datastore_search?resource_id=053cea08-09bc-40ec-8f7a-156f0677aff3&limit=1&filters=";
const CMP_KEYS = ["tozeret_cd", "degem_cd", "shnat_yitzur", "ramat_gimur", "kinuy_mishari", "tozeret_nm", "degem_nm", "sug_degem"];

const clean = s => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
const label = v => [clean(v.tozeret_nm).split(" ")[0], clean(v.kinuy_mishari || v.degem_nm), v.shnat_yitzur].filter(Boolean).join(" ");

async function plateInfo(plate) {
  try {
    const r = await fetch(ORIGIN + encodeURIComponent(JSON.stringify({mispar_rechev: Number(plate)})), {signal: AbortSignal.timeout(2500), cf: {cacheTtl: 3600, cacheEverything: true}});
    const v = (await r.json()).result?.records?.[0];
    return v ? {label: label(v), fuel: clean(v.sug_delek_nm), color: clean(v.tzeva_rechev)} : null;
  } catch { return null; }
}
function cmpInfo(code) {
  try {
    const t = atob(code.replace(/-/g, "+").replace(/_/g, "/"));
    const items = JSON.parse(decodeURIComponent(escape(t)));
    if (!Array.isArray(items) || !items.length) return null;
    const names = items.slice(0, 6).map(it => it.m ? label(Object.fromEntries(CMP_KEYS.map((k, i) => [k, it.m[i]]))) : it.p ? "רכב " + String(it.p).replace(/\D/g, "") : "").filter(Boolean);
    return {n: items.length, names};
  } catch { return null; }
}

export default {
  async fetch(req, env, ctx) {
    const res = await fetch(req);
    const u = new URL(req.url);
    if (req.method !== "GET" || u.pathname !== "/" || !CRAWLER.test(req.headers.get("User-Agent") || "")) return res;
    const plate = (u.searchParams.get("plate") || "").replace(/\D/g, "");
    const cmp = u.searchParams.get("cmp");
    let title, desc;
    if (cmp && cmp.length < 4000) {
      const c = cmpInfo(cmp);
      if (c) { title = `השוואת ${c.n} רכבים בלוחית`; desc = c.names.join(" מול ") + ". עלות, אמינות וירידת ערך, זה לצד זה."; }
    } else if (plate.length >= 5 && plate.length <= 8) {
      const p = await plateInfo(plate);
      if (p) { title = `${p.label} · בדיקת רכב בלוחית`; desc = [p.fuel, p.color].filter(Boolean).join(" · ") + (p.fuel || p.color ? ". " : "") + "בעלויות, טסט, ריקולים, ק״מ ושווי משוער ממאגרי משרד התחבורה."; }
    }
    if (!title) return res;
    const set = (prop, val) => ({element(e) { e.setAttribute("content", val); }});
    return new HTMLRewriter()
      .on('meta[property="og:title"]', set("t", title))
      .on('meta[name="twitter:title"]', set("t", title))
      .on('meta[property="og:description"]', set("d", desc))
      .on('meta[name="twitter:description"]', set("d", desc))
      .on('meta[property="og:url"]', set("u", u.origin + "/" + u.search))
      .transform(res);
  },
};

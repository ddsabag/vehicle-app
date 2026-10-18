/* Luchit dynamic link preview (Cloudflare Worker, route luchit.app/ : the home page, where ?plate= and ?cmp= links land).
   Messaging crawlers (WhatsApp, Telegram, Facebook, X, Slack...) get og:title / og:description for
   ?plate= and ?cmp= links; everyone else gets the page untouched. The plate is not logged; the ministry answer for that link is held in the Cloudflare edge cache for 10 minutes (cacheTtl below) so repeated previews do not hit the ministry again.
   Needs luchit.app proxied by Cloudflare (orange cloud). */
const CRAWLER = /WhatsApp|TelegramBot|facebookexternalhit|Facebot|Twitterbot|Slackbot|LinkedInBot|Discordbot|SkypeUriPreview|Applebot|Google-PageRenderer|Viber/i;
const DS = "https://data.gov.il/api/3/action/datastore_search?limit=20&resource_id=";
const ACTIVE = "053cea08-09bc-40ec-8f7a-156f0677aff3", RECALL = "36bf1404-0be4-49d2-82dc-2f1ead4a8b93", CANCELLED = "851ecab1-0622-4dbe-a6c7-f950cf82abf9";
const CMP_KEYS = ["tozeret_cd", "degem_cd", "shnat_yitzur", "ramat_gimur", "kinuy_mishari", "tozeret_nm", "degem_nm", "sug_degem"];

const clean = s => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
const label = v => [clean(v.tozeret_nm).split(" ")[0], clean(v.kinuy_mishari || v.degem_nm), v.shnat_yitzur].filter(Boolean).join(" ");
// rows, or null when the ministry did not answer in time (then that check is left out of the preview, never guessed)
const rows = (id, filters) => fetch(DS + id + "&filters=" + encodeURIComponent(JSON.stringify(filters)), {signal: AbortSignal.timeout(2500), cf: {cacheTtl: 600, cacheEverything: true}})
  .then(r => r.ok ? r.json() : null).then(j => j && j.success ? j.result.records : null).catch(() => null);

/* the car and its most important finding: off the road, test expired, open recall, or a clean bill */
async function plateInfo(plate) {
  const [act, rec, can] = await Promise.all([
    rows(ACTIVE, {mispar_rechev: Number(plate)}),
    rows(RECALL, {MISPAR_RECHEV: Number(plate)}),
    rows(CANCELLED, {mispar_rechev: [plate, plate.padStart(7, "0"), plate.padStart(8, "0")]}),   // text column, zero-padded in old rows
  ]);
  const v = (act && act[0]) || (can && can[0]); if (!v) return null;
  const cancelled = act !== null && !act[0] && !!(can && can[0]);   // only when the active register answered and does not list the car
  const exp = Date.parse(v.tokef_dt), testOk = !cancelled && exp ? exp >= Date.now() - 864e5 : null, nRec = rec ? rec.length : null;
  let verdict = "", tone = "";
  if (cancelled) { verdict = "ירד מהכביש"; tone = "bad"; }
  else if (testOk === false) { verdict = "הטסט לא בתוקף"; tone = "bad"; if (nRec) verdict += nRec === 1 ? ", ריקול פתוח" : `, ${nRec} ריקולים פתוחים`; }
  else if (nRec) { verdict = nRec === 1 ? "ריקול פתוח אחד" : `${nRec} ריקולים פתוחים`; tone = "warn"; if (testOk) verdict = "טסט בתוקף, " + verdict; }
  else if (testOk && nRec === 0) { verdict = "טסט בתוקף, אין ריקול פתוח"; tone = "ok"; }
  return {label: label(v), fuel: clean(v.sug_delek_nm), color: clean(v.tzeva_rechev), verdict, tone};
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
    let title, desc, image;
    if (cmp && cmp.length < 4000) {
      const c = cmpInfo(cmp);
      if (c) { title = `השוואת ${c.n} רכבים בלוחית`; desc = c.names.join(" מול ") + ". עלות, אמינות וירידת ערך, זה לצד זה."; }
    } else if (plate.length >= 5 && plate.length <= 8) {
      const p = await plateInfo(plate);
      if (p) {
        title = p.verdict ? `${p.label} · ${p.verdict}` : `${p.label} · בדיקת רכב בלוחית`;
        desc = [p.fuel, p.color].filter(Boolean).join(" · ") + (p.fuel || p.color ? ". " : "") + "בעלויות, טסט, ריקולים, ק״מ ושווי משוער ממאגרי משרד התחבורה. לחצו לדוח המלא.";
        if (p.tone) image = `${u.origin}/og-${p.tone}.png`;
      }
    }
    if (!title) return res;
    const set = (prop, val) => ({element(e) { e.setAttribute("content", val); }});
    const out = new HTMLRewriter()
      .on('meta[property="og:title"]', set("t", title))
      .on('meta[name="twitter:title"]', set("t", title))
      .on('meta[property="og:description"]', set("d", desc))
      .on('meta[name="twitter:description"]', set("d", desc))
      .on('meta[property="og:url"]', set("u", u.origin + "/" + u.search))
      .on('meta[property="og:image"]', set("i", image || u.origin + "/og.png"))
      .on('meta[name="twitter:image"]', set("i", image || u.origin + "/og.png"))
      .on('meta[property="og:image:alt"]', set("a", image ? "דוח רכב בלוחית" : "לוחית, בדיקת רכב לפי מספר"))
      .transform(res);
    // which version answered (binding CF_VERSION_METADATA in wrangler.toml): the Workers deploy check waits for the new one
    const id = env?.CF_VERSION_METADATA?.id;
    if (!id) return out;
    const named = new Response(out.body, out);
    named.headers.set("x-luchit-version", id);
    return named;
  },
};

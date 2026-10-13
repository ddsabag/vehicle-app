// luchit-api: POST /api/subscribe  { email, website (honeypot) }  ->  Brevo double opt-in.
// Route: luchit.app/api/*   Secrets: BREVO_KEY   Vars: BREVO_LIST_ID, BREVO_DOI_TEMPLATE_ID
// Nothing is stored here: Brevo holds the contact, the consent time and the unsubscribe state.
const ORIGIN = "https://luchit.app";
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname !== "/api/subscribe") return json({ error: "not found" }, 404);
    if (req.method !== "POST") return json({ error: "method" }, 405);
    if (req.headers.get("origin") !== ORIGIN) return json({ error: "forbidden" }, 403);
    if (!(req.headers.get("content-type") || "").includes("application/json")) return json({ error: "type" }, 415);

    let b; try { b = await req.json(); } catch { return json({ error: "bad request" }, 400); }
    if (b.website) return json({ ok: true });                         // honeypot: bots fill it, answer success and do nothing
    if (b.consent !== true) return json({ error: "consent" }, 400);   // the unticked checkbox must have been ticked
    const email = String(b.email || "").trim().toLowerCase();
    if (email.length > 254 || !/^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/.test(email)) return json({ error: "email" }, 400);

    const r = await fetch("https://api.brevo.com/v3/contacts/doubleOptinConfirmation", {
      method: "POST",
      headers: { "api-key": env.BREVO_KEY, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        email,
        includeListIds: [Number(env.BREVO_LIST_ID)],
        templateId: Number(env.BREVO_DOI_TEMPLATE_ID),
        redirectionUrl: ORIGIN + "/magazine/?subscribed=1",
        attributes: { SOURCE: "magazine", CONSENT_AT: new Date().toISOString() },
      }),
    });
    if (r.ok) return json({ ok: true });
    // Brevo answers 400 "already exists / already confirmed" in some cases: do not reveal whether an address is subscribed
    const t = await r.text();
    console.log("brevo", r.status, t.slice(0, 200));
    return /already|exist/i.test(t) ? json({ ok: true }) : json({ error: "upstream" }, 502);
  },
};

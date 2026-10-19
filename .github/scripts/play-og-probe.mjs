// What a messaging app sees when the Google Play link is shared: status, title and the og: tags, per crawler user agent. Public page, no secrets.
const URL0 = "https://play.google.com/store/apps/details?id=com.ddsabag.pratirechev";
const UAS = { whatsapp: "WhatsApp/2.23.20.0 A", facebook: "facebookexternalhit/1.1", telegram: "TelegramBot (like TwitterBot)" };
for (const q of ["", "&hl=he&gl=IL"]) for (const [k, ua] of Object.entries(UAS)) {
  try {
    const r = await fetch(URL0 + q, { headers: { "user-agent": ua, "accept-language": "he-IL,he;q=0.9" }, signal: AbortSignal.timeout(20000) });
    const t = await r.text();
    const tags = [...t.matchAll(/<meta (?:property|name)="(og:[a-z:]+|description|twitter:[a-z]+)" content="([^"]*)"/g)].map(m => `${m[1]}=${m[2].slice(0, 120)}`);
    console.log(`${(q || "plain").padEnd(14)} ${k.padEnd(9)} ${r.status} title="${(/<title[^>]*>([^<]*)/.exec(t)?.[1] || "").slice(0, 100)}"`);
    for (const x of tags) console.log("    " + x);
  } catch (e) { console.log(`${q} ${k}: ${e.name} ${e.cause?.code || ""}`); }
}

// Checks the email signature files on the live site, also as Gmail's image proxy fetches them.
const UA = { browser: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36", gmail: "Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)" };
for (const u of ["https://luchit.app/email/signature.html", "https://luchit.app/email/signature-logo.png", "https://luchit.app/go/mail?c=signature"])
  for (const [k, ua] of Object.entries(UA)) {
    const r = await fetch(u + (u.includes("?") ? "&" : "?") + "nc=" + Date.now(), { headers: { "user-agent": ua }, redirect: "manual" });
    const b = new Uint8Array(await r.arrayBuffer());
    console.log(k.padEnd(8), r.status, (r.headers.get("content-type") || "").padEnd(24), String(b.length).padStart(6), r.headers.get("location") || "", u);
  }

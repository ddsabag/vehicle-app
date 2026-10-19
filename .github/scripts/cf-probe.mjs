// One-off (probe-go branch, not for main): does the edge inject Cloudflare's own Web Analytics beacon into the pages, and with which token.
const UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36";
console.log("at", new Date().toISOString());
for (const p of ["/", "/?utm_source=youtube&utm_medium=social&utm_campaign=bio", "/magazine/2026-09/", "/model/", "/model/mg4-443/", "/check/recall/", "/guide/", "/privacy.html", "/lib/cfb.js", "/go/yt", "/live"]) {
  try {
    const r = await fetch("https://luchit.app" + p, {headers: {"user-agent": UA, accept: "text/html,*/*"}, redirect: "manual"});
    const t = await r.text();
    const tokens = [...t.matchAll(/data-cf-beacon='?"?(\{[^>]*?\})/g)].map(m => m[1].replace(/&quot;/g, '"'));
    const tags = [...t.matchAll(/<script[^>]*cloudflareinsights[^>]*>/g)].map(m => m[0].slice(0, 220));
    console.log(`\n${p} -> ${r.status} ${r.headers.get("content-type")} | cache-control ${r.headers.get("cache-control")} | cf-cache ${r.headers.get("cf-cache-status")} | enc ${r.headers.get("content-encoding")} | len ${t.length} | location ${r.headers.get("location") || "-"}`);
    console.log("  beacon script tags in the HTML:", tags.length, JSON.stringify(tags));
    console.log("  data-cf-beacon values:", JSON.stringify(tokens), "| cfb.js referenced:", t.includes("/lib/cfb.js"));
    if (p === "/lib/cfb.js") console.log("  body starts:", t.slice(0, 160).replace(/\n/g, " "));
  } catch (e) { console.log(p, "failed", String(e)); }
}

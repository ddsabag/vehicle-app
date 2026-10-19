// One-off live check of the luchit.app/go/<code> short links (OG Worker): status and Location for each code, then where a browser lands.
const codes = ["tiktok", "ig", "fb", "li", "yt", "wa", "mail", "press", "qr", "dealer", "FB", "nope"];
for (const c of codes) {
  const r = await fetch(`https://luchit.app/go/${c}?c=launch&st=${Date.now()}`, {redirect: "manual", headers: {"user-agent": "Mozilla/5.0 go-probe"}});
  console.log(`/go/${c}`.padEnd(12), r.status, r.headers.get("location"), r.headers.get("x-luchit-version") || "");
}
const f = await fetch(`https://luchit.app/go/fb?st=${Date.now()}`, {headers: {"user-agent": "facebookexternalhit/1.1"}});
const t = await f.text();
console.log("follow (facebook crawler):", f.status, f.url, (t.match(/<meta property="og:title" content="([^"]*)"/) || [])[1]);
const g = await fetch(`https://luchit.app/?st=${Date.now()}`, {headers: {"user-agent": "Mozilla/5.0 go-probe"}});
console.log("home:", g.status, (await g.text()).includes('id="plate"'));

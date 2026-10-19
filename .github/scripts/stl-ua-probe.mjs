// One-off: can the phone's daily check (Java HttpURLConnection, a Dalvik user agent) read luchit.app/settlements.json through Cloudflare?
const UAS = ["Dalvik/2.1.0 (Linux; U; Android 14; Pixel 7 Build/UQ1A.240205.004)", "Dalvik/2.1.0 (Linux; U; Android 10; SM-A505F Build/QP1A.190711.020)", ""];
for (const ua of UAS) {
  try {
    const r = await fetch("https://luchit.app/settlements.json?st=" + Date.now(), {headers: ua ? {"user-agent": ua, accept: "application/json"} : {accept: "application/json"}});
    const t = await r.text();
    let n = "-"; try { n = JSON.parse(t).items.length; } catch {}
    console.log(`${ua || "(node default)"} -> ${r.status} ${r.headers.get("content-type")} cf-mitigated=${r.headers.get("cf-mitigated")} bytes=${t.length} items=${n}`);
  } catch (e) { console.log(`${ua} -> error ${e.message}`); }
}

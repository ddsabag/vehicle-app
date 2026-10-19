// One-off (probe-go branch, not for main): which code is live on the luchit-live and luchit-api Workers (read-only Cloudflare API calls).
const raw = String(process.env.CLOUDFLARE_API_TOKEN || ""), m = raw.match(/Bearer\s+([A-Za-z0-9_\-]{20,})/i);
const tok = (m ? m[1] : raw).trim().replace(/^["']|["']$/g, ""), acc = String(process.env.CF_ACCOUNT_ID || "").trim();
const API = `https://api.cloudflare.com/client/v4/accounts/${acc}/workers/scripts`;
const get = async (p, raw = false) => { const r = await fetch(API + p, { headers: { authorization: "Bearer " + tok } }); if (!r.ok) return { err: r.status + " " + (await r.text()).slice(0, 200) }; return raw ? r.text() : r.json(); };
console.log("at", new Date().toISOString());
for (const name of ["luchit-live"]) {
  const d = await get(`/${name}/deployments`);
  if (d.err) { console.log(name, "deployments", d.err); continue; }
  const list = (d.result && d.result.deployments) || [];
  for (const x of list.slice(0, 3)) console.log(name, "deployment", x.created_on, "| versions", JSON.stringify(x.versions), "| annotations", JSON.stringify(x.annotations || {}));
  const vid = list[0] && list[0].versions && list[0].versions[0] && list[0].versions[0].version_id;
  if (!vid) continue;
  const v = await get(`/${name}/versions/${vid}`);
  console.log(name, "active version", vid, "| annotations", JSON.stringify((v.result && v.result.annotations) || v.err || {}), "| metadata", JSON.stringify((v.result && v.result.metadata) || {}).slice(0, 300));
  const code = await get(`/${name}/content/v2?version=${vid}`, true);
  const txt = typeof code === "string" ? code : JSON.stringify(code);
  for (const k of ['const BUILD = "live-24"', 'userAgentBrowser_neq', 'siteTag_in', 'webUsers', 'startsWith("ga4")']) console.log(name, "live code has", JSON.stringify(k), ":", txt.includes(k));
  console.log(name, "live code length", txt.length);
}

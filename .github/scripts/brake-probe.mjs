// One-off (probe-go branch, not for main), 20.10: is maarechet_ezer_labalam_ind autonomous emergency braking or brake assist? Share of WLTP
// rows with each braking/forward system by model year (brake assist was common long before autonomous braking).
const API = "https://data.gov.il/api/3/action/datastore_search", WLTP = "142afde2-6228-49f9-8a29-9b6c3a0cbe40", PAGE = 30000;
const F = ["shnat_yitzur", "maarechet_ezer_labalam_ind", "nitur_merhak_milfanim_ind", "zihuy_matzav_hitkarvut_mesukenet_ind", "zihuy_holchey_regel_ind", "blimat_hirum_lifnei_holhei_regel_ofanaim", "abs_ind", "bakarat_yatzivut_ind"];
const rows = []; for (let off = 0; ; off += PAGE) { const r = (await (await fetch(API + "?" + new URLSearchParams({ resource_id: WLTP, limit: String(PAGE), offset: String(off), fields: F.join(",") }))).json()).result; rows.push(...r.records); if (r.records.length < PAGE) break; }
const by = {}; for (const r of rows) { const y = Number(r.shnat_yitzur); if (y < 1998) continue; const o = by[y] ||= { n: 0 }; o.n++; for (const f of F.slice(1)) if (String(r[f] ?? "").trim() === "1") o[f] = (o[f] || 0) + 1; }
console.log("year rows | " + F.slice(1).map(f => f.replace(/_ind$/, "")).join(" | "));
for (const y of Object.keys(by).sort()) { const o = by[y]; console.log(y, o.n, "|", F.slice(1).map(f => Math.round((o[f] || 0) / o.n * 100) + "%").join(" | ")); }

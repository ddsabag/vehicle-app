// Dumps the register record, latest technical record and model-catalogue row for each plate (to test service-interval matching).
const API = "https://data.gov.il/api/3/action/datastore_search";
const ACTIVE = "053cea08-09bc-40ec-8f7a-156f0677aff3", TECH = "56063a99-8a3e-4ff4-912e-5966c0279bad", WLTP = "142afde2-6228-49f9-8a29-9b6c3a0cbe40";
const get = async p => { for (let i = 0; i < 4; i++) { try { const j = await (await fetch(API + "?" + new URLSearchParams(p))).json(); if (j.success) return j.result; } catch {} await new Promise(r => setTimeout(r, 2000)); } return {records: []}; };
const out = [];
for (const pl of (process.env.PLATES || "").split(",").map(x => x.trim()).filter(Boolean)) {
  const v = (await get({resource_id: ACTIVE, limit: "1", filters: JSON.stringify({mispar_rechev: Number(pl)})})).records[0] || null;
  const t = (await get({resource_id: TECH, limit: "1", filters: JSON.stringify({mispar_rechev: Number(pl)})})).records[0] || null;
  let w = null;
  if (v) w = (await get({resource_id: WLTP, limit: "1", filters: JSON.stringify({tozeret_cd: v.tozeret_cd, degem_cd: v.degem_cd, shnat_yitzur: v.shnat_yitzur})})).records[0] || null;
  out.push({plate: pl, v, t, w});
}
console.log("JSON_START" + JSON.stringify(out) + "JSON_END");

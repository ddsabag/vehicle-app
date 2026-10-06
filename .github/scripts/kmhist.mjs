// Checks whether the datasets hold more than one odometer reading per plate (for a km-over-time chart).
const API = "https://data.gov.il/api/3/action/datastore_search";
const IDS = {tech: "56063a99-8a3e-4ff4-912e-5966c0279bad", cont: "0866573c-40cd-4ca8-91d2-9dd2d7a492e5", active: "053cea08-09bc-40ec-8f7a-156f0677aff3"};
const get = async p => { for (let i = 0; i < 4; i++) { try { const j = await (await fetch(API + "?" + new URLSearchParams(p))).json(); if (j.success) return j.result; } catch {} await new Promise(r => setTimeout(r, 2000)); } return {records: [], fields: []}; };
for (const pl of (process.env.PLATES || "").split(",").map(x => x.trim()).filter(Boolean)) {
  for (const [n, id] of Object.entries(IDS)) {
    const r = await get({resource_id: id, limit: "50", filters: JSON.stringify({mispar_rechev: Number(pl)})});
    const km = r.records.map(x => ({km: x.kilometer_test_aharon, d: x.mivchan_acharon_dt || x.tokef_dt || x.baalut_dt || x.TAARICH, rest: Object.keys(x).filter(k => /km|kilom|dt|date/i.test(k))}));
    console.log(pl, n, "records:", r.records.length, JSON.stringify(km.slice(0, 5)));
  }
}

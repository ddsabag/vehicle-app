const API="https://data.gov.il/api/3/action/";
for(const p of ["46644401","75350003","2367178"]){const r=await (await fetch(API+"datastore_search?resource_id=56063a99-8a3e-4ff4-912e-5966c0279bad&filters="+encodeURIComponent(JSON.stringify({mispar_rechev:p.padStart(8,"0")})))).json();console.log(p,JSON.stringify(r.result.records[0]||null));}
const r=await (await fetch(API+"datastore_search?resource_id=56063a99-8a3e-4ff4-912e-5966c0279bad&limit=3")).json();console.log("fields",r.result.fields.map(f=>f.id).join(","));console.log(JSON.stringify(r.result.records[0]));

const API="https://data.gov.il/api/3/action/";
const G=async(u)=>{const r=await fetch(API+u,{signal:AbortSignal.timeout(60000)});return r.json();};
const ID="053cea08-09bc-40ec-8f7a-156f0677aff3";
const a=await G("datastore_search?resource_id="+ID+"&limit=2");
console.log("fields",(a.result.fields||[]).map(f=>f.id).join(","));
console.log("rec0",JSON.stringify(a.result.records[0]));
for(const p of (process.env.PLATES||"").split(",")){const r=await G("datastore_search?resource_id="+ID+"&filters="+encodeURIComponent(JSON.stringify({mispar_rechev:Number(p)})));console.log("plate",p,JSON.stringify(r.result.records[0]||null));}
for(const q of ["מקוריות","בעלות","בעלות רכב"]){const r=await G("package_search?rows=8&q="+encodeURIComponent(q));console.log("search",q,(r.result.results||[]).map(x=>x.title+" "+x.resources.map(y=>y.id).slice(0,2).join("|")).join(" ;; "));}

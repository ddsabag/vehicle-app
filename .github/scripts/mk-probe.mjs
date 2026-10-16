const API="https://data.gov.il/api/3/action/";
const G=async(u)=>{try{const r=await fetch(API+u,{signal:AbortSignal.timeout(60000)});return await r.json();}catch(e){return {error:String(e)}}};
const html=(await import("node:fs")).readFileSync("index.html","utf8");
const ids=[...new Set([...html.matchAll(/id:"([0-9a-f-]{36})"/g)].map(m=>m[1]))];
for(const id of ids){const a=await G("datastore_search?resource_id="+id+"&limit=1");const f=(a.result&&a.result.fields||[]).map(x=>x.id);console.log(id.slice(0,8),a.result?a.result.total:"ERR",f.filter(x=>/mkor|makor|baal|moked|rishum|yevu|aliya/i.test(x)).join(","));}
for(const q of ["מקוריות","מקוריות רכב","רישום ראשון רכב","היסטוריית כלי רכב","כלי רכב פרטיים ומסחריים"]){const r=await G("package_search?rows=8&q="+encodeURIComponent(q));console.log("search",q,JSON.stringify(((r.result||{}).results||[]).map(x=>x.title+" "+x.id.slice(0,8))));}
const p=await G("package_show?id=273c5e33-25ab-4980-8522-a2f7ba0bb62d");console.log("hist pkg",(p.result.resources||[]).map(x=>x.name+" "+x.id.slice(0,8)+" "+x.last_modified).join(" ;; "));
const a=await G("datastore_search?resource_id=053cea08-09bc-40ec-8f7a-156f0677aff3&limit=1");console.log("active meta",JSON.stringify((await G("resource_show?id=053cea08-09bc-40ec-8f7a-156f0677aff3")).result?.last_modified));

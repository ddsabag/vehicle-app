const r = await (await fetch("https://data.gov.il/api/3/action/datastore_search?resource_id=053cea08-09bc-40ec-8f7a-156f0677aff3&limit=5&filters=" + encodeURIComponent(JSON.stringify({shnat_yitzur: 2024})))).json();
console.log(r.result.records.map(x => JSON.stringify({y: x.shnat_yitzur, m: x.moed_aliya_lakvish, b: x.baalut, mk: x.mkoriut_nm})).join("\n"));
console.log(r.result.fields.map(f => f.id).join(","));

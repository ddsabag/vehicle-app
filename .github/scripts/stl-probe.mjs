// One-off probe for the weekly settlements review: prints the text of court notices and press stories.
const strip = h => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, "").replace(/<br\s*\/?>|<\/p>|<\/li>|<\/h\d>/g, "\n").replace(/<[^>]+>/g, "").replace(/&#8211;/g, "-").replace(/&#8217;|&#8216;/g, "'").replace(/&#8220;|&#8221;|&quot;/g, '"').replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#\d+;/g, " ").replace(/\n\s*\n+/g, "\n").trim();
const get = async u => { const r = await fetch(u, {headers: {"user-agent": "Mozilla/5.0 luchit-settlements"}}); return r.ok ? r.text() : `HTTP ${r.status}`; };
const WP = "https://www.yitzugit.co.il/wp-json/wp/v2/posts";
for (const q of ["טסלה", "צ'מפיון", "צ׳מפיון", "מכשירי תנועה", "יפנאוטו", "גואנגול", "פיקאר", "סיקלי", "מוטורס", "רכב"]) {
  try {
    const j = JSON.parse(await get(`${WP}?search=${encodeURIComponent(q)}&per_page=20&_fields=date,link,title`));
    console.log(`\n### search ${q}: ${j.length}`);
    for (const p of j) console.log(p.date.slice(0, 10), strip(p.title.rendered), p.link);
  } catch (e) { console.log(`search ${q} failed`, e.message); }
}
const slugs = ["29129-05-21", "1504-04-24"];
const all = JSON.parse(await get(`${WP}?per_page=100&_fields=date,link,title,content`));
for (const p of all) {
  const t = strip(p.title.rendered);
  if (slugs.some(s => t.includes(s)) || /מכשירי תנועה|יפנאוטו|טסלה|צ.מפיון/.test(t))
    console.log(`\n==== ${p.date} ${t}\n${p.link}\n${strip(p.content.rendered).slice(0, 9000)}`);
}
for (const f of ["https://www.thecar.co.il/feed/", "https://www.thecar.co.il/category/%d7%aa%d7%a7%d7%9c%d7%95%d7%aa-%d7%a1%d7%93%d7%a8%d7%aa%d7%99%d7%95%d7%aa/feed/"]) {
  const x = await get(f);
  for (const it of x.split("<item>").slice(1)) {
    const title = (it.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "";
    if (!/טסלה|ייצוגית|פשרה/.test(title)) continue;
    const body = (it.match(/<content:encoded>([\s\S]*?)<\/content:encoded>/) || [])[1] || "";
    console.log(`\n==== TheCar ${strip(title.replace(/<!\[CDATA\[|\]\]>/g, ""))}\n${strip(body.replace(/<!\[CDATA\[|\]\]>/g, "")).slice(0, 5000)}`);
  }
}

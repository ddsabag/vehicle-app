// One-off probe for the weekly settlements review (1.11): court notices, the importer page and press for this week's open items.
const strip = h => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<nav[\s\S]*?<\/nav>|<footer[\s\S]*?<\/footer>/g, "").replace(/<br\s*\/?>|<\/p>|<\/li>|<\/h\d>|<\/div>/g, "\n").replace(/<[^>]+>/g, "").replace(/&#8211;/g, "-").replace(/&#8217;|&#8216;/g, "'").replace(/&#8220;|&#8221;|&quot;/g, '"').replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#\d+;/g, " ").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
const H = {"user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36", "accept-language": "he-IL,he;q=0.9"};
const get = async u => { try { const r = await fetch(u, {headers: H, signal: AbortSignal.timeout(30000)}); return r.ok ? r.text() : `HTTP ${r.status}`; } catch (e) { return `ERR ${e.message}`; } };
const WP = "https://www.yitzugit.co.il/wp-json/wp/v2/posts";
const want = /38503-08-23|1504-04-24|33473-10-24|53907-08-21|44731-03-23|סמלת|מכשירי תנועה|צ.מפיון|יפנאוטו|טסלה|קרסו|כלמוביל|דלק מוטורס|יוניון|לובינסקי|מאיר|שברולט|ג.נרל מוטורס/;
for (const q of ["38503-08-23", "סמלת", "1504-04-24", "מכשירי תנועה", "צ'מפיון"]) {
  let j = []; try { j = JSON.parse(await get(`${WP}?search=${encodeURIComponent(q)}&per_page=20&_fields=date,link,title,content`)); } catch (e) { console.log(`search ${q} failed`, e.message); }
  console.log(`\n### search ${q}: ${j.length}`);
  for (const p of j) {
    const t = strip(p.title.rendered);
    console.log(p.date.slice(0, 10), t, p.link);
    if (p.date >= "2026-10-20" && want.test(t)) console.log(`---- CONTENT\n${strip(p.content.rendered).slice(0, 12000)}\n---- END`);
  }
}
for (const u of ["https://samelet.com/", "https://samelet.com/class-actions/", "https://samelet.com/%d7%94%d7%a1%d7%93%d7%a8-%d7%a4%d7%a9%d7%a8%d7%94/"]) {
  const h = await get(u);
  const links = [...h.matchAll(/href="([^"]+)"/gi)].map(m => m[1]).filter(s => /pdf|פשרה|%d7%a4%d7%a9%d7%a8%d7%94|settle|class|legal/i.test(s));
  console.log(`\n==== PAGE ${u}\n${h.startsWith("HTTP") || h.startsWith("ERR") ? h : "ok " + h.length}\nLINKS: ${[...new Set(links)].join("\n")}`);
}
const q = s => encodeURIComponent(s);
for (const s of ["פיאט 500 חשמלית הסדר פשרה", "סמלת הסדר פשרה", "פיאט 500 טווח ייצוגית", "וולבה צ'מפיון", "הסדר פשרה רכב"]) {
  const x = await get(`https://news.google.com/rss/search?q=${q(s)}&hl=he&gl=IL&ceid=IL:he`);
  const it = [...x.matchAll(/<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<pubDate>([\s\S]*?)<\/pubDate>/g)].slice(0, 12);
  console.log(`\n### news ${s}: ${it.length}`); for (const m of it) console.log(m[2].slice(5, 16), strip(m[1]));
}

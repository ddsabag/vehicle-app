// One-off probe for the weekly settlements review: prints importer settlement pages and searches.
const strip = h => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<nav[\s\S]*?<\/nav>|<footer[\s\S]*?<\/footer>/g, "").replace(/<br\s*\/?>|<\/p>|<\/li>|<\/h\d>|<\/div>/g, "\n").replace(/<[^>]+>/g, "").replace(/&#8211;/g, "-").replace(/&#8217;|&#8216;/g, "'").replace(/&#8220;|&#8221;|&quot;/g, '"').replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#\d+;/g, " ").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
const H = {"user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36", "accept-language": "he-IL,he;q=0.9"};
const get = async u => { try { const r = await fetch(u, {headers: H, signal: AbortSignal.timeout(30000)}); return r.ok ? r.text() : `HTTP ${r.status}`; } catch (e) { return `ERR ${e.message}`; } };
const pages = ["https://championmotors.co.il/arrangements/public-information/", "https://kia-israel.co.il/הודעה-בדבר-הסכם-פשרה", "https://www.kia-israel.co.il/"];
for (const u of pages) {
  const h = await get(u);
  const links = [...h.matchAll(/href="([^"]+\.pdf[^"]*)"/gi)].map(m => m[1]);
  console.log(`\n==== PAGE ${u}\n${strip(h).slice(0, 12000)}\nPDF: ${[...new Set(links)].join("\n")}`);
}
const q = s => encodeURIComponent(s);
for (const s of ["וולבה צ'מפיון", "1504-04-24", "33473-10-24", "53907-08-21", "גואנגול", "פיקאר מכשירי תנועה", "הסדר פשרה צ'מפיון מוטורס", "הסדר פשרה קיה ישראל"]) {
  const x = await get(`https://news.google.com/rss/search?q=${q(s)}&hl=he&gl=IL&ceid=IL:he`);
  const it = [...x.matchAll(/<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<link>([\s\S]*?)<\/link>[\s\S]*?<pubDate>([\s\S]*?)<\/pubDate>/g)].slice(0, 10);
  console.log(`\n### news ${s}: ${it.length}`); for (const m of it) console.log(m[3].slice(5, 16), strip(m[1]));
}

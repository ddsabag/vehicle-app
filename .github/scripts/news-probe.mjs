// which free news sources answer from a GitHub runner, and in what shape (for the weekly settlements watch)
const q = s => encodeURIComponent(s);
const U = [
  "https://www.thecar.co.il/feed/",
  "https://www.thecar.co.il/category/%d7%aa%d7%a7%d7%9c%d7%95%d7%aa-%d7%a1%d7%93%d7%a8%d7%aa%d7%99%d7%95%d7%aa/feed/",
  `https://news.google.com/rss/search?q=${q('"הסדר פשרה" רכב')}&hl=he&gl=IL&ceid=IL:he`,
  `https://news.google.com/rss/search?q=${q('ייצוגית יבואן רכב')}&hl=he&gl=IL&ceid=IL:he`,
  "https://www.yitzugit.co.il/feed/",
  "https://www.yitzugit.co.il/wp-json/wp/v2/types",
  `https://www.yitzugit.co.il/wp-json/wp/v2/posts?search=${q("רכב")}&per_page=5&_fields=date,link,title`,
  `https://www.yitzugit.co.il/wp-json/wp/v2/custom-newspaper?search=${q("רכב")}&per_page=5&_fields=date,link,title`,
  "https://www.ynet.co.il/Integration/StoryRss1946.xml",
  "https://rss.walla.co.il/feed/31",
];
for (const u of U) {
  try {
    const r = await fetch(u, {headers: {"user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36", "accept-language": "he-IL,he;q=0.9"}, signal: AbortSignal.timeout(20000), redirect: "follow"});
    const t = await r.text();
    const items = (t.match(/<item[\s>]/g) || []).length, titles = [...t.matchAll(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/g)].slice(1, 4).map(m => m[1].trim().slice(0, 90));
    console.log(`== ${r.status} ${r.headers.get("content-type")} ${t.length}B items=${items} ${u.slice(0, 110)}`);
    if (titles.length) console.log("   " + titles.join(" | "));
    else console.log("   " + t.slice(0, 300).replace(/\s+/g, " "));
    const links = [...t.matchAll(/<link>([^<]+)<\/link>/g)].slice(1, 3).map(m => m[1]); if (links.length) console.log("   links: " + links.join(" "));
    const src = [...t.matchAll(/<source url="([^"]+)">([^<]+)<\/source>/g)].slice(0, 3).map(m => m[2] + " " + m[1]); if (src.length) console.log("   sources: " + src.join(" | "));
  } catch (e) { console.log(`== ERR ${e.message} ${u.slice(0, 110)}`); }
}

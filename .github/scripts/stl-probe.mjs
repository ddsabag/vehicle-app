// One-off probe for the weekly settlements review (1.11): court notices, the importer page and press for this week's open items.
const strip = h => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<nav[\s\S]*?<\/nav>|<footer[\s\S]*?<\/footer>/g, "").replace(/<br\s*\/?>|<\/p>|<\/li>|<\/h\d>|<\/div>/g, "\n").replace(/<[^>]+>/g, "").replace(/&#8211;/g, "-").replace(/&#8217;|&#8216;/g, "'").replace(/&#8220;|&#8221;|&quot;/g, '"').replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#\d+;/g, " ").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
const H = {"user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36", "accept-language": "he-IL,he;q=0.9"};
const get = async u => { try { const r = await fetch(u, {headers: H, signal: AbortSignal.timeout(30000)}); return r.ok ? r.text() : `HTTP ${r.status}`; } catch (e) { return `ERR ${e.message}`; } };
const u = "https://samelet.com/%d7%94%d7%95%d7%93%d7%a2%d7%94-%d7%91%d7%93%d7%91%d7%a8-%d7%94%d7%92%d7%a9%d7%aa-%d7%91%d7%a7%d7%a9%d7%94-%d7%9c%d7%90%d7%99%d7%a9%d7%95%d7%a8-%d7%94%d7%a1%d7%93%d7%a8-%d7%a4%d7%a9%d7%a8%d7%94-23-08-3/";
const h = await get(u); const m = h.match(/<main[\s\S]*?<\/main>/) || h.match(/<article[\s\S]*?<\/article>/);
console.log(`==== PAGE ${decodeURI(u)}\n${strip(m ? m[0] : h).slice(0, 15000)}`);
console.log("PDF:", [...new Set([...h.matchAll(/href="([^"]+\.pdf[^"]*)"/gi)].map(x => x[1]))].join("\n"));
const home = await get("https://samelet.com/");
console.log("HOME mentions:", [...new Set([...home.matchAll(/[^<>"]{0,80}(?:אושר|פסק דין|הסדר פשרה|500e|500 חשמלית)[^<>"]{0,80}/g)].map(x => x[0].trim()))].slice(0, 30).join("\n"));

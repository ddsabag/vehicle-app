// AEO/GEO probe: what AI and search crawlers get from luchit.app (robots.txt as served, status per user agent, challenge pages)
const UA = {
  browser: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
  Googlebot: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  Bingbot: "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
  GPTBot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot",
  "OAI-SearchBot": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot",
  "ChatGPT-User": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot",
  PerplexityBot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)",
  ClaudeBot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
};
const r = await fetch("https://luchit.app/robots.txt", { headers: { "user-agent": UA.browser } });
console.log("robots.txt", r.status, "\n" + (await r.text()).slice(0, 3000));
for (const path of ["/", "/check/value/", "/model/", "/llms.txt"]) {
  for (const [n, ua] of Object.entries(UA)) {
    try {
      const x = await fetch("https://luchit.app" + path, { headers: { "user-agent": ua, accept: "text/html,*/*" }, redirect: "manual" });
      const t = await x.text();
      const chal = /cf-chl|challenge-platform|Just a moment|Attention Required/i.test(t);
      console.log(path, n, x.status, x.headers.get("server") || "", "bytes", t.length, chal ? "CHALLENGE" : "", x.headers.get("cf-mitigated") || "");
    } catch (e) { console.log(path, n, "error", e.message); }
  }
}

// Cloudflare Web Analytics page count for the static pages (models, brands, topics, magazine, guide).
// Same token and opt-out as the home page: nothing loads inside the Android app or after "analyticsOff" was set in the settings.
(function () {
  if (window.AndroidApp) return;
  // a campaign link that lands on one of these pages (utm_source=newsletter on a magazine article) is kept for the visit, as the home page keeps
  // its own (FT in index.html), so the car checks that follow on the home page count under that source. First link wins; no identifier
  try {
    var q = new URLSearchParams(location.search), clean = function (k, n) { return (q.get(k) || "").toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, n); };
    var alias = {fb: "facebook", ig: "instagram", yt: "youtube", wa: "whatsapp", li: "linkedin", tt: "tiktok", mail: "newsletter", email: "newsletter"};
    var k = (q.get("utm_source") || "").toLowerCase().replace(/[^a-z]/g, "").slice(0, 12), src = alias[k] || k;
    if (src && src !== "share" && src !== "luchitapp" && !sessionStorage.getItem("ft")) sessionStorage.setItem("ft", JSON.stringify({s: src, m: clean("utm_medium", 12) || "web", c: clean("utm_campaign", 24)}));
  } catch (e) {}
  try { if (location.protocol !== "https:" || localStorage.getItem("analyticsOff") === "1") return; } catch (e) { return; }
  var s = document.createElement("script");
  s.defer = true;
  s.src = "https://static.cloudflareinsights.com/beacon.min.js";
  s.setAttribute("data-cf-beacon", '{"token":"9bb0e756882c478a808d95596e0deade"}');
  document.head.appendChild(s);
})();

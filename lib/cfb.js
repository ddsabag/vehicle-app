// Cloudflare Web Analytics page count for the static pages (models, brands, topics, magazine, guide).
// Same token and opt-out as the home page: nothing loads inside the Android app or after "analyticsOff" was set in the settings.
(function () {
  try { if (window.AndroidApp || location.protocol !== "https:" || localStorage.getItem("analyticsOff") === "1") return; } catch (e) { return; }
  var s = document.createElement("script");
  s.defer = true;
  s.src = "https://static.cloudflareinsights.com/beacon.min.js";
  s.setAttribute("data-cf-beacon", '{"token":"9bb0e756882c478a808d95596e0deade"}');
  document.head.appendChild(s);
})();

// one-off, test branch only: which countries each track is available in (read inside an edit that is then deleted)
import { jwt } from "./play-alpha.mjs";
const sa = JSON.parse(process.env.SHIP_SA_JSON);
const t = await (await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt(sa, "https://www.googleapis.com/auth/androidpublisher", Date.now()) }) })).json();
const H = { authorization: "Bearer " + t.access_token };
const P = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.ddsabag.pratirechev";
const e = await (await fetch(P + "/edits", { method: "POST", headers: H })).json();
try {
  for (const tr of ["production", "beta", "alpha"]) {
    const r = await fetch(`${P}/edits/${e.id}/countryAvailability/${tr}`, { headers: H });
    console.log(tr, r.status, (await r.text()).replace(/\s+/g, " ").slice(0, 400));
  }
} finally { const d = await fetch(`${P}/edits/${e.id}`, { method: "DELETE", headers: H }); console.log("edit deleted", d.status); }

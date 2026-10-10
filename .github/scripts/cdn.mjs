// Verify CDN assets the app loads: the OCR language file exists and SRI hashes still match
import fs from "node:fs"; import crypto from "node:crypto";
const t = fs.readFileSync("index.html", "utf8");
const sri = JSON.parse(t.match(/const LIB_SRI = (\{.*?\});/)[1]);
const libs = t.match(/const LIBS = \{([\s\S]*?)\};/)[1];
for (const m of libs.matchAll(/(\w+):\s*"(https:[^"]+)"/g)) {
  const r = await fetch(m[2]); const b = Buffer.from(await r.arrayBuffer());
  const h = "sha384-" + crypto.createHash("sha384").update(b).digest("base64");
  console.log(m[1], r.status, b.length, sri[m[1]] ? (sri[m[1]] === h ? "SRI ok" : "SRI MISMATCH " + h) : "no sri");
}
const lp = t.match(/langPath: "([^"]+)"/)[1];
for (const f of ["eng.traineddata.gz", "eng.traineddata"]) { const r = await fetch(lp + "/" + f, {method: "HEAD"}); console.log("lang", f, r.status); }
const r2 = await fetch("https://luchit.app/lib/jspdf.umd.min.js", {method: "HEAD"}); console.log("own jspdf", r2.status);

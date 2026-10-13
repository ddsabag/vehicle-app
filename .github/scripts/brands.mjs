// One display name per brand, shared with the app: the list lives in index.html (BRAND_LABELS) and is read from there.
import fs from "node:fs";
const src = fs.readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const block = src.match(/const BRAND_LABELS = (\[[\s\S]*?\n\]);/);
if (!block) throw new Error("BRAND_LABELS not found in index.html");
export const BRAND_LABELS = new Function("return " + block[1])();
export const brandKey = s => String(s || "").replace(/[\s.'"׳״`\-_]/g, "");
export const brandLabel = name => {
  const k = brandKey(name); if (!k) return name;
  for (const [key, exact, label] of BRAND_LABELS) if (k === key || (!exact && k.startsWith(key))) return label;
  return name;
};
// the spelling people also search for, kept in the page text for search engines
export const BRAND_ALT = {KGM: "קיי גי מוביליטי", BMW: "ב.מ.וו", BYD: "בי.ווי.די", MG: "אם.ג׳י", DS: "די.אס", SWM: "אס.דאבל יו.אם", GMC: "ג׳י.אם.סי", JAC: "ג׳אק", GAC: "ג׳י.איי.סי", DFSK: "די.אף.אס.קיי"};

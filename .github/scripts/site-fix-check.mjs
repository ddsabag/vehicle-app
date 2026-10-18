// Re-runs site-data-audit.mjs after the audit fixes on next, with three changes to the audit itself (each asserted, so a drift in the audit fails loudly):
//  1. towing: the app now reads 0/0 as a ban only from 2008 (older rows write 0/0 for nearly every model) and borrows another year only from the same model name,
//     so the expectation follows that rule; a TOWCHK note prints the shown value next to the new and the first expectation for every car.
//  2. maker-name pass: the app now matches settlements on the shown maker (makerOnly), so the audit's mirror of that match does too.
//  3. model stats card: a MSNOTE note prints the count line, to show which group the number covers.
// Same inputs as site-data-audit.mjs (PLATES, QUERIES). No plate is printed beyond the audit's own masked form.
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
let src = fs.readFileSync(path.join(dir, "site-data-audit.mjs"), "utf8");
const swap = (from, to) => { const n = src.split(from).length - 1; if (n !== 1) { console.log(`site-fix-check: expected one "${from.slice(0, 60)}", found ${n}`); process.exit(1); } src = src.replace(from, () => to); };

swap(`      else exp = ["none"]; }\n`, `      else exp = ["none"]; }
    const expOld = exp; { const own = posV(R.kosher_grira_im_blamim) || posV(R.kosher_grira_bli_blamim) ? \`\${posV(R.kosher_grira_im_blamim) ? N(R.kosher_grira_im_blamim) : "—"}/\${posV(R.kosher_grira_bli_blamim) ? N(R.kosher_grira_bli_blamim) : "—"}\` : "";
      const nmU = x => String(x || "").trim().toUpperCase(), sameNm = r => !E(R.kinuy_mishari) && nmU(r.kinuy_mishari) === nmU(R.kinuy_mishari) || !E(R.degem_nm) && nmU(r.degem_nm) === nmU(R.degem_nm);
      expYear = null;
      if (same.some(has)) exp = pairs(same);
      else if (same.length && same.every(zero)) exp = [y >= 2008 && !own ? "ban" : own || "none"];
      else { const other = rs.filter(r => has(r) && sameNm(r)); if (other.length) { const d = Math.min(...other.map(r => Math.abs(N(r.shnat_yitzur) - y))); const near = other.filter(r => Math.abs(N(r.shnat_yitzur) - y) === d); exp = pairs(near); expYear = [...new Set(near.map(r => N(r.shnat_yitzur)))]; }
        else exp = [own || "none"]; } }
`);
swap(`    const yr = (card.notes.join(" ").match(/משנת (\\d{4})/) || [])[1];\n`, `    const yr = (card.notes.join(" ").match(/משנת (\\d{4})/) || [])[1];
    NOTES.push(\`TOWCHK \${c.id} \${R.sug_degem || ""} \${sp(R.kinuy_mishari)} \${y}: shown "\${shown}\${yr ? " (model year " + yr + ")" : ""}" | expected now "\${exp.join(" or ")}" | first audit rule "\${expOld.join(" or ")}"\`);
`);
swap(`const stl = x => SETTLEMENTS.filter(s => s.mk.test(normS([x.v.tozeret_nm, x.make].join(" ")))).map(s => s.id);`,
  `const stl = x => SETTLEMENTS.filter(s => s.mk.test(normS(typeof makerOnly === "function" ? makerOnly(x) : [x.v.tozeret_nm, x.make].join(" ")))).map(s => s.id);`);
swap(`    if (m && X.cohort != null) {`, `    if (ms) { const t = (ms.text.match(/\\([\\d,]+ רכבים פעילים[^)]*\\)/) || [])[0]; NOTES.push(\`MSNOTE \${c.id} \${sp(R.kinuy_mishari)} \${y}: \${t || "(no count line)"}\`); }
    if (m && X.cohort != null) {`);

const out = path.join(dir, "site-fix-check.gen.mjs");   // next to the audit, so "playwright" resolves from the repo's node_modules
fs.writeFileSync(out, src);
console.log("site-fix-check: audit patched (towing rule, maker-only settlements, model stats note)");
await import(pathToFileURL(out).href);

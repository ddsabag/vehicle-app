// Probe: the catalogue build with the per-car recall list (recall-percar.mjs), run as catalog.yml runs it, then the recall check (recall-health.mjs, a
// first run here: no state to compare); the per-model files are dropped, so the published report holds meta.json, the maker indexes (c/<cd>.json) and the
// recall files (r/). No plate is written anywhere.
import {execFileSync} from "node:child_process";
import fs from "node:fs";
execFileSync(process.execPath, ["--max-old-space-size=6144", ".github/scripts/catalog-build.mjs"], {stdio: "inherit", env: {...process.env, OUT: "out/cat"}});
execFileSync(process.execPath, [".github/scripts/recall-health.mjs"], {stdio: "inherit", env: {...process.env, OUT: "out/cat", PREV: "none.json"}});
for (const f of fs.readdirSync("out/cat/c")) if (!f.endsWith(".json")) fs.rmSync(`out/cat/c/${f}`, {recursive: true, force: true});
console.log("kept: " + fs.readdirSync("out/cat").join(", "));

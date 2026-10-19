// Probe: the catalogue build with the per-car recall list (recall-percar.mjs), run as catalog.yml runs it; the per-model files (c/) are dropped
// so the published report holds only meta.json and the recall files (r/). No plate is written anywhere.
import {execFileSync} from "node:child_process";
import fs from "node:fs";
execFileSync(process.execPath, ["--max-old-space-size=6144", ".github/scripts/catalog-build.mjs"], {stdio: "inherit", env: {...process.env, OUT: "out/cat"}});
fs.rmSync("out/cat/c", {recursive: true, force: true});
console.log("kept: " + fs.readdirSync("out/cat").join(", "));

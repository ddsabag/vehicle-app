// inspect.yml runs this before any script: the plates input takes the example plates only (datasets.mjs probePlates).
// It reads the input from the run's event file, never from a step's env, because GitHub prints a step's env at the top of the public log.
import fs from "node:fs";
import {probePlates} from "./datasets.mjs";
const raw = String(JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")).inputs?.plates || "");
try {
  const plates = probePlates(raw, "");
  console.log(plates.length ? `plates input: ${plates.length} example plate(s)` : "plates input: none");
} catch (e) {
  console.log("::error::" + e.message);   // the message names the example plates, never the input
  process.exit(1);
}

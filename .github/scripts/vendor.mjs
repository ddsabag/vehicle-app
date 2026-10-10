import fs from "node:fs";
import { createHash } from "node:crypto";
const b = Buffer.from(await (await fetch("https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js")).arrayBuffer());
fs.mkdirSync("out", { recursive: true });
fs.writeFileSync("out/jspdf.umd.min.js", b);
console.log("bytes", b.length, "sha384-" + createHash("sha384").update(b).digest("base64"));

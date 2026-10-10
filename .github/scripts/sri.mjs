import { createHash } from "node:crypto";
const U = ["html-to-image@1.11.13/dist/html-to-image.js", "jspdf@2.5.2/dist/jspdf.umd.min.js", "tesseract.js@5.1.1/dist/tesseract.min.js"];
for (const u of U) {
  const b = Buffer.from(await (await fetch("https://cdn.jsdelivr.net/npm/" + u)).arrayBuffer());
  console.log(u, "sha384-" + createHash("sha384").update(b).digest("base64"), b.length);
}

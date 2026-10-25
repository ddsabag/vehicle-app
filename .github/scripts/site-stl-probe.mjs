// One-off probe for the weekly settlements review: the Champion settlements page renders in the browser only.
import {chromium} from "playwright";
const b = await chromium.launch(), p = await b.newPage({locale: "he-IL"});
for (const u of ["https://championmotors.co.il/arrangements/public-information/", "https://championmotors.co.il/arrangements/"]) {
  try {
    await p.goto(u, {waitUntil: "networkidle", timeout: 60000});
    await p.waitForTimeout(4000);
    const t = await p.evaluate(() => document.body.innerText);
    const links = await p.evaluate(() => [...document.querySelectorAll("a")].map(a => `${a.innerText.trim().slice(0, 80)} | ${a.href}`).filter(s => /pdf|arrangement|הסדר|פשרה/i.test(s)));
    console.log(`\n==== ${u}\n${t.slice(0, 15000)}\nLINKS:\n${[...new Set(links)].join("\n")}`);
  } catch (e) { console.log(`${u} failed`, e.message); }
}
await b.close();

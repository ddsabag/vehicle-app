// The phone's daily check matches settlements in Java (android/.../SettlementMatch.java) on the page's summary of a car (stlCar in
// index.html), while the car's page matches them in JavaScript (stlCompile + settlementsFor). This builds cars from the model catalogue
// (every model, every year around its range, with varied colour, fuel, trim, engine size and factory, plus cars with missing fields, personal
// imports and cars off the road), runs both matches on each and fails on any difference, so a new pattern in settlements.json that Java
// reads differently is caught before it ships.
//   node .github/scripts/stl-parity.mjs [settlements.json]
// Needs javac/java and the org.json jar (JSON_JAR; else it is downloaded from Maven Central into the temp folder).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {normS} from "./settlements.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const grab = (re, what) => { const m = html.match(re); if (!m) throw new Error(`index.html has no ${what}`); return m[1]; };
const num = new Function(`return (${grab(/^const num = (v => .*);$/m, "num")});`)();
const stlCompile = new Function("num", grab(/\/\* stl-compile \*\/([\s\S]*?)\/\* \/stl-compile \*\//, "stl-compile block") + "\nreturn stlCompile;")(num);
const makerOnly = D => D.make;   // the page joins the register's maker names; here the catalogue's maker stands for them on both sides
const stlCar = new Function("normS", "num", "makerOnly", grab(/(function stlCar\(D\)\{[\s\S]*?\n\})\n/, "stlCar") + "\nreturn stlCar;")(normS, num, makerOnly);

const file = process.argv[2] || path.join(ROOT, "settlements.json");
const items = JSON.parse(fs.readFileSync(file, "utf8")).items;
const list = items.map(stlCompile).filter(Boolean);
// settlementsFor in index.html itself, on a car without the page around it (the compiled file stands for the page's SETTLEMENTS)
const settlementsFor = new Function("SETTLEMENTS", "normS", "num", "makerOnly", grab(/(function settlementsFor\(D\)\{[\s\S]*?\n\})\n/, "settlementsFor") + "\nreturn settlementsFor;")(list, normS, num, makerOnly);
const pageMatch = D => settlementsFor(D).map(s => s.id);

// cars: each catalogue model in each year from a year before its range to a year after, two variants per year (a fixed pseudo-random pick)
let seed = 7;
const rnd = a => a[(seed = (seed * 1103515245 + 12345) >>> 0) % a.length];
const COLORS = ["לבן", "לבן שנהב", "שחור", "כסף מטלי", "אפור", undefined];
const FUELS = ["בנזין", "דיזל", "חשמל", "היברידי", "חשמל/בנזין", undefined];
const TRIMS = ["", "PREMIUM", "HYBRID", "TYPE R", "Hybrid Plus", undefined];
const CCS = [undefined, "", 0, 998, "1,598", 1995, 2400, 2999, 3500];
const cars = [];
for (const [maker, model, from, to] of JSON.parse(fs.readFileSync(path.join(ROOT, "models.json"), "utf8")).rows) {
  for (let y = Math.max(1990, from - 1); y <= Math.min(2027, to + 1); y++) for (let k = 0; k < 2; k++) {
    cars.push({make: maker, v: {kinuy_mishari: model, degem_nm: rnd(["", model.split(" ")[0], undefined]), shnat_yitzur: rnd([y, String(y)]), tzeva_rechev: rnd(COLORS), sug_delek_nm: rnd(FUELS), ramat_gimur: rnd(TRIMS), nefach_manoa: rnd(CCS), tozeret_nm: rnd([maker, maker + " סלובקיה", undefined])}});
  }
}
// each entry's own names (pickups and other models the private-car catalogue lacks), every year 2005-2027 with every fuel
const lits = p => String(p || "").replace(/\(\?<?[=!][^)]*\)/g, "").replace(/[\^$()?\\.]/g, "").split("|").filter(Boolean);
for (const e of items) for (const mk of lits(e.mk).slice(0, 2)) for (const md of [...new Set([...lits(e.md), ...(e.m || []).flatMap(a => lits(a.md))])].slice(0, 8).concat([""])) {
  for (let y = 2005; y <= 2027; y++) for (const f of FUELS) cars.push({make: mk, v: {kinuy_mishari: md, shnat_yitzur: y, tzeva_rechev: rnd(COLORS), sug_delek_nm: f, ramat_gimur: rnd(TRIMS), nefach_manoa: rnd(CCS), tozeret_nm: rnd([mk + " סלובקיה", mk + " ד. קוריאה", "", undefined])}});
  // the same car as a personal import and off the road: neither side may match it (the phone has no summary of it)
  cars.push({make: mk, importKind: "יבוא אישי · משומש", v: {kinuy_mishari: md, shnat_yitzur: (e.y || [2018])[0]}}, {make: mk, isCancelled: true, v: {kinuy_mishari: md, shnat_yitzur: (e.y || [2018])[0]}});
}
// missing fields: no year, no names, nothing but the maker
for (const [maker, model] of JSON.parse(fs.readFileSync(path.join(ROOT, "models.json"), "utf8")).rows.filter((r, i) => i % 50 === 0)) {
  cars.push({make: maker, v: {kinuy_mishari: model}}, {make: maker, v: {shnat_yitzur: 2020}}, {make: maker, v: {}});
}
const cases = cars.map(D => ({car: JSON.parse(JSON.stringify(stlCar(D))), expect: pageMatch(D)}));   // through JSON, as localStorage and the bridge carry it

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stl-parity-"));
fs.writeFileSync(path.join(tmp, "cases.json"), JSON.stringify(cases));
let jar = process.env.JSON_JAR;
if (!jar) {
  jar = path.join(tmp, "json.jar");
  execFileSync("curl", ["-sSfL", "--retry", "3", "-o", jar, "https://repo.maven.apache.org/maven2/org/json/json/20240303/json-20240303.jar"]);
}
const src = path.join(ROOT, "android/app/src/main/java/com/ddsabag/pratirechev/SettlementMatch.java");
const pkg = path.join(tmp, "src/com/ddsabag/pratirechev");
fs.mkdirSync(pkg, {recursive: true});
fs.copyFileSync(src, path.join(pkg, "SettlementMatch.java"));
fs.writeFileSync(path.join(pkg, "StlParity.java"), `package com.ddsabag.pratirechev;
import org.json.*;
import java.nio.file.*;
import java.util.*;
public class StlParity {
  public static void main(String[] a) throws Exception {
    List<SettlementMatch.Entry> list = SettlementMatch.compile(new JSONObject(Files.readString(Path.of(a[0]))).getJSONArray("items"));
    JSONArray cases = new JSONArray(Files.readString(Path.of(a[1])));
    String today = new java.text.SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
    int year = Calendar.getInstance().get(Calendar.YEAR), bad = 0;
    System.out.println("java: " + list.size() + " entries compiled");
    if (list.size() != Integer.parseInt(a[2])) { System.out.println("DIFF the page compiled " + a[2] + " entries"); bad++; }
    for (int i = 0; i < cases.length(); i++) {
      JSONObject c = cases.getJSONObject(i);
      List<String> got = new ArrayList<>();
      for (SettlementMatch.Entry e : SettlementMatch.match(list, c.isNull("car") ? null : c.getJSONObject("car"), today, year)) got.add(e.id);
      List<String> want = new ArrayList<>();
      JSONArray w = c.getJSONArray("expect");
      for (int k = 0; k < w.length(); k++) want.add(w.getString(k));
      // no summary (a personal import, a car off the road): the worker skips the car, so the page must not match it either
      if (!got.equals(want) && bad++ < 15) System.out.println("DIFF " + c.opt("car") + " page=" + want + " java=" + got);
    }
    System.out.println("java: " + cases.length() + " cars, " + bad + " differences");
    System.exit(bad == 0 ? 0 : 1);
  }
}
`);
const out = path.join(tmp, "classes");
execFileSync("javac", ["-encoding", "UTF-8", "-d", out, "-cp", jar, path.join(pkg, "SettlementMatch.java"), path.join(pkg, "StlParity.java")], {stdio: "inherit"});
const matched = new Set(cases.flatMap(c => c.expect)), unused = list.filter(s => !matched.has(s.id)).map(s => s.id);
console.log(`page: ${list.length} of ${items.length} entries compiled, ${cases.length} cars, ${cases.filter(c => c.expect.length).length} with a match` + (unused.length ? `; no test car matched ${unused.join(", ")}` : ""));
if (list.length !== items.length) { console.log("::error::stl-parity: the page compiled fewer entries than the file has"); process.exitCode = 1; }
try {
  execFileSync("java", ["-Dfile.encoding=UTF-8", "-Dstdout.encoding=UTF-8", "-Dsun.stdout.encoding=UTF-8", "-cp", `${out}${path.delimiter}${jar}`, "com.ddsabag.pratirechev.StlParity", file, path.join(tmp, "cases.json"), String(list.length)], {stdio: "inherit"});
} catch {
  console.log("::error::stl-parity: the phone's settlement match (SettlementMatch.java) differs from the page's");
  process.exitCode = 1;
}
fs.rmSync(tmp, {recursive: true, force: true});

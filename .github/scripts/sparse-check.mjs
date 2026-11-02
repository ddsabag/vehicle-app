#!/usr/bin/env node
// sparse-check.mjs: every workflow that uses a sparse checkout must list every local file its scripts load.
// It reads each "sparse-checkout: |" block, follows the local loads of each listed script (static and literal
// dynamic import, require, new URL("..", import.meta.url)) and lists any loaded file the block leaves out.
// Why: on 2.11.2026 claude.mjs began to import ai-usage.mjs; two sparse workflows lacked it and Release guard's
// second look failed silently. Run: node .github/scripts/sparse-check.mjs [selftest]. Exit 1 when a file is missing.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");

export function blocks(yml) {
  const out = [], lines = yml.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)sparse-checkout:\s*\|\s*$/);
    if (!m) continue;
    const list = [];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (!l.trim()) continue;
      const ind = l.match(/^\s*/)[0].length;
      if (ind <= m[1].length) break;
      list.push(l.trim());
    }
    out.push(list);
  }
  return out;
}

// Comment lines are skipped; a load on a line with "try" is optional by design (the script runs on without it)
export function loads(src, { optional = false } = {}) {
  const found = new Set();
  const code = src.split("\n").filter(l => !/^\s*(\/\/|\/?\*)/.test(l)).filter(l => /\btry\b/.test(l) === optional).join("\n");
  const res = [
    /\bimport\s+[^"'`;]*?from\s*["'](\.{1,2}\/[^"']+)["']/g,
    /\bimport\s*["'](\.{1,2}\/[^"']+)["']/g,
    /\bimport\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g,
    /\brequire\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g,
    /new URL\(\s*["'](\.{1,2}\/[^"']+)["']\s*,\s*import\.meta\.url\s*\)/g,
  ];
  for (const re of res) for (const m of code.matchAll(re)) found.add(m[1]);
  return [...found];
}

function covered(file, list) {
  return list.some(e => e === file || file.startsWith(e.replace(/\/?$/, "/")));
}

export function check(root = ROOT) {
  const dir = path.join(root, ".github/workflows"), problems = [];
  for (const wf of fs.readdirSync(dir).filter(f => /\.ya?ml$/.test(f)).sort()) {
    for (const list of blocks(fs.readFileSync(path.join(dir, wf), "utf8"))) {
      const seen = new Set(), queue = list.filter(f => /\.(m?js|cjs)$/.test(f));
      while (queue.length) {
        const f = queue.shift();
        if (seen.has(f)) continue;
        seen.add(f);
        let src;
        try { src = fs.readFileSync(path.join(root, f), "utf8"); } catch { continue; }
        for (const rel of loads(src)) {
          const dep = path.posix.normalize(path.posix.join(path.posix.dirname(f), rel));
          if (!fs.existsSync(path.join(root, dep)) || dep === f) continue;
          if (!covered(dep, list)) problems.push(`${wf}: ${f} loads ${dep}, not in its sparse-checkout`);
          if (/\.(m?js|cjs)$/.test(dep)) queue.push(dep);
        }
      }
    }
  }
  return [...new Set(problems)];
}

function selftest() {
  let n = 0;
  const ok = (c, m) => { if (!c) { console.error("FAIL " + m); process.exit(1); } n++; };
  const y = "    with:\n      sparse-checkout: |\n        a/x.mjs\n        b/\n      sparse-checkout-cone-mode: false\n  next:\n";
  ok(JSON.stringify(blocks(y)) === '[["a/x.mjs","b/"]]', "reads a sparse block and stops at the dedent");
  const s = 'import { a } from "./ai-usage.mjs";\nimport x from "node:fs";\nconst k = await import("./tg-text.mjs");\nfs.readFileSync(new URL("../seo-data.pub.pem", import.meta.url));\nrequire("./c.cjs");';
  ok(JSON.stringify(loads(s).sort()) === JSON.stringify(["../seo-data.pub.pem", "./ai-usage.mjs", "./c.cjs", "./tg-text.mjs"]), "finds local loads, skips node: modules");
  ok(loads('// try { r = await import("./alert.mjs"); } catch {}\n * import x from "./y.mjs"').length === 0, "comment lines are skipped");
  ok(loads('try { r = await import("./alert.mjs"); } catch {}').length === 0 && loads('try { r = await import("./alert.mjs"); } catch {}', { optional: true })[0] === "./alert.mjs", "a load inside try is optional");
  ok(covered("b/c.js", ["b/"]) && covered("b/c.js", ["b"]) && !covered("bc.js", ["b"]), "a listed folder covers its files");
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "sparse-"));
  fs.mkdirSync(path.join(tmp, ".github/workflows"), { recursive: true });
  fs.mkdirSync(path.join(tmp, ".github/scripts"), { recursive: true });
  fs.writeFileSync(path.join(tmp, ".github/scripts/claude.mjs"), 'import { r } from "./ai-usage.mjs";');
  fs.writeFileSync(path.join(tmp, ".github/scripts/ai-usage.mjs"), 'fs.readFileSync(new URL("../k.pem", import.meta.url));');
  fs.writeFileSync(path.join(tmp, ".github/k.pem"), "k");
  fs.writeFileSync(path.join(tmp, ".github/workflows/w.yml"), "      sparse-checkout: |\n        .github/scripts/claude.mjs\n");
  const p = check(tmp);
  ok(p.length === 2 && p[0].includes("ai-usage.mjs") && p[1].includes("k.pem"), "the 2.11 break is caught, transitively");
  fs.writeFileSync(path.join(tmp, ".github/workflows/w.yml"), "      sparse-checkout: |\n        .github/scripts/claude.mjs\n        .github/scripts/ai-usage.mjs\n        .github/k.pem\n");
  ok(check(tmp).length === 0, "a complete list passes");
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`sparse-check selftest ok (${n} checks)`);
}

if (process.argv[1] && process.argv[1].endsWith("sparse-check.mjs")) {
  if (process.argv[2] === "selftest") selftest();
  else {
    const p = check();
    for (const l of p) console.log("MISSING " + l);
    console.log(p.length ? `${p.length} missing` : "every sparse checkout lists what its scripts load");
    process.exit(p.length ? 1 : 0);
  }
}

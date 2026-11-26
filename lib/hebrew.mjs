// Hebrew-aware text normalisation and matching for the לוחית content lint. No dependencies.
// Every transformation keeps a map back to the original string offsets, so a match can be reported with its line and snippet.

// Cantillation + niqqud (keeps maqaf U+05BE, paseq U+05C0, sof pasuq U+05C3, nun hafukha U+05C6, which are punctuation)
const NIQQUD = /[֑-ׇֽֿׁׂׅׄ]/u;
const COMBINING = /[̀-ͯ᪰-᫿᷀-᷿⃐-⃿︠-︯]/u;
// Invisible characters: every default-ignorable code point and every format character (zero-width, bidi controls, soft hyphen,
// variation selectors, Unicode tag characters U+E0000-E007F, Hangul fillers...) plus the musical formatting controls.
export const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\p{Cf}\u{1D173}-\u{1D17A}]/u;
const FINAL = { "ך": "כ", "ם": "מ", "ן": "נ", "ף": "פ", "ץ": "צ" };
const PUNCT_MAP = { "׳": "'", "״": '"', "־": "-", "‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-", "―": "-", "−": "-", "﹘": "-", "﹣": "-", "－": "-",
  "‘": "'", "’": "'", "‚": "'", "‛": "'", "“": '"', "”": '"', "„": '"', " ": " ", " ": " ", " ": " ", " ": " ", " ": " ", "⠀": " ", "　": " ",
  "٪": "%", "٫": ".", "٬": ",", "،": "," };
// Latin look-alikes from Cyrillic and Greek (after lower-casing): "ѕсаm" reads as "scam"
const CONFUSABLE = { "а": "a", "в": "b", "е": "e", "ё": "e", "к": "k", "м": "m", "н": "h", "о": "o", "р": "p", "с": "c", "т": "t", "у": "y", "х": "x", "ѕ": "s", "і": "i", "ї": "i", "ј": "j",
  "ԁ": "d", "ԛ": "q", "ԝ": "w", "һ": "h", "ӏ": "l", "ɡ": "g", "ɑ": "a", "ο": "o", "α": "a", "ι": "i", "κ": "k", "ν": "v", "ρ": "p", "τ": "t", "υ": "u", "χ": "x", "ϲ": "c", "ϳ": "j", "ε": "e", "ꓲ": "i", "ı": "i" };
export const HEB = "א-ת";
const isHeb = c => c >= "א" && c <= "ת";
const isLetter = c => /\p{L}/u.test(c);
const isDigit = c => /\p{N}/u.test(c);
const isSpace = c => /\s/u.test(c);

// Any decimal digit (Arabic-Indic ٢٣, Persian ۲۳, Devanagari २३, fullwidth...) -> ASCII. Same length for BMP digits.
const ND = /\p{Nd}/u;
export function digitValue(ch) {
  const cp = ch.codePointAt(0);
  if (cp >= 48 && cp <= 57) return cp - 48;
  let s = cp; while (s > 0 && ND.test(String.fromCodePoint(s - 1))) s--;
  return (cp - s) % 10;
}
export function foldDigits(s) { return String(s).replace(/\p{Nd}/gu, c => { const d = String(digitValue(c)); return c.length === 2 ? d + "​" : d; }); }

// unit list: [{c: char, p: offset in the original string}]
function units(text) {
  const u = [];
  for (let i = 0; i < text.length;) { const ch = String.fromCodePoint(text.codePointAt(i)); u.push({ c: ch, p: i }); i += ch.length; }
  return u;
}
const join = u => u.map(x => x.c).join("");

// A: base normalisation (NFKD, niqqud/combining/invisible removed, final letters -> regular, lower case, quote/dash variants unified,
// Cyrillic/Greek look-alikes -> Latin, every decimal digit -> ASCII)
function baseOf(us) {
  const out = [];
  for (const { c, p } of us) {
    for (const x of c.normalize("NFKD")) {
      if (NIQQUD.test(x) || COMBINING.test(x) || INVISIBLE.test(x)) continue;
      let y = PUNCT_MAP[x] ?? x;
      y = FINAL[y] ?? y;
      for (let z of y.toLowerCase()) { z = CONFUSABLE[z] ?? z; if (ND.test(z)) z = String(digitValue(z)); out.push({ c: z, p }); }
    }
  }
  return out;
}
// B: punctuation between two Hebrew letters removed ("מ.צ.י.א.ה" -> "מציאה", "מצי*אה" -> "מציאה"); whitespace kept
function dropInnerPunct(u) {
  const out = [];
  for (let i = 0; i < u.length; i++) {
    const c = u[i].c;
    if (!isLetter(c) && !isDigit(c) && !isSpace(c) && out.length && isHeb(out[out.length - 1].c)) {
      let j = i; while (j < u.length && !isLetter(u[j].c) && !isDigit(u[j].c) && !isSpace(u[j].c)) j++;
      if (j < u.length && isHeb(u[j].c)) { i = j - 1; continue; }
    }
    out.push(u[i]);
  }
  return out;
}
// C: runs of 3+ single Hebrew letters separated by spaces/punctuation are joined ("מ צ י א ה" -> "מציאה")
function joinSpacedLetters(u) {
  const s = join(u);
  const re = new RegExp(`(?<![\\p{L}\\p{N}])[${HEB}](?![\\p{L}\\p{N}])(?:[^\\p{L}\\p{N}\\n]{1,3}[${HEB}](?![\\p{L}\\p{N}])){2,}`, "gu");
  const out = []; let last = 0;
  const idx = []; { let k = 0; for (let i = 0; i < u.length; i++) { idx[k] = i; k += u[i].c.length; } idx[k] = u.length; }
  for (const m of s.matchAll(re)) {
    const a = idx[m.index], b = idx[m.index + m[0].length];
    for (let i = last; i < a; i++) out.push(u[i]);
    for (let i = a; i < b; i++) if (isHeb(u[i].c)) out.push(u[i]);
    last = b;
  }
  for (let i = last; i < u.length; i++) out.push(u[i]);
  return out;
}
// D: Hebrew look-alike letters: a word-final ס written in place of the final ם ("מומלציס" -> "מומלצימ")
function lookalike(u) {
  let changed = false;
  const out = u.map((x, i) => {
    if (x.c === "ס" && i > 0 && isHeb(u[i - 1].c) && (i + 1 >= u.length || !isLetter(u[i + 1].c))) { changed = true; return { c: "מ", p: x.p }; }
    return x;
  });
  return changed ? out : null;
}
// E: URL percent-encoding decoded ("short-1-ok%65tz", "%D7%9E%D7%A6..."), every decoded char mapped to its first %XX
const isPct = (us, i) => us[i].c === "%" && i + 2 < us.length && /^[0-9a-f]{2}$/i.test(us[i + 1].c + us[i + 2].c);
function pctDecode(us) {
  if (!us.some((x, i) => isPct(us, i))) return null;
  const out = [];
  for (let i = 0; i < us.length;) {
    if (isPct(us, i)) {
      const bytes = [], p = us[i].p; let j = i;
      while (j < us.length && isPct(us, j)) { bytes.push(parseInt(us[j + 1].c + us[j + 2].c, 16)); j += 3; }
      for (const ch of Buffer.from(bytes).toString("utf8")) out.push({ c: ch, p });
      i = j; continue;
    }
    out.push(us[i]); i++;
  }
  return out;
}
// F: bidi overrides (U+202D LRO / U+202E RLO ... U+202C PDF or end of line): the run is displayed in reverse, so "‭האיצמ‬" reads "מציאה"
function reverseOverrideUnits(us) {
  let changed = false; const out = [...us];
  for (let i = 0; i < out.length; i++) {
    if (out[i].c !== "‭" && out[i].c !== "‮") continue;
    let j = i + 1; while (j < out.length && out[j].c !== "‬" && out[j].c !== "\n") j++;
    const seg = out.slice(i + 1, j).reverse(); out.splice(i + 1, seg.length, ...seg); changed = true; i = j;
  }
  return changed ? out : null;
}

// Returns the variants to match against: [{name, text, map}] where map[k] = original offset of text char k (UTF-16 index)
export function variants(text) {
  const U = units(text);
  const A = baseOf(U), B = dropInnerPunct(A), C = joinSpacedLetters(B);
  const mk = (name, u) => { const map = []; let t = ""; for (const x of u) { for (let k = 0; k < x.c.length; k++) map.push(x.p); t += x.c; } map.push(text.length); return { name, text: t, map }; };
  const out = [mk("plain", A), mk("no-inner-punct", B), mk("joined-letters", C)];
  const D = lookalike(C); if (D) out.push(mk("look-alike", D));
  const E = pctDecode(U); if (E) out.push(mk("url-decoded", dropInnerPunct(baseOf(E))));
  const F = reverseOverrideUnits(U); if (F) out.push(mk("bidi-override", joinSpacedLetters(dropInnerPunct(baseOf(F)))));
  return out;
}
export function normalize(text) { return join(baseOf(units(text))); }

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const FINALS_RE = /[ךםןףץ]/g;
export const fixFinals = s => s && String(s).replace(FINALS_RE, c => FINAL[c]);
export const PREFIX = "(?:[ושהבלמכ]{0,4})";
// Build a regex for a forbidden word or phrase.
//  - string: Hebrew gets optional prefixes ו/ה/ש/ב/ל/מ/כ (up to 4, e.g. "וכשה") before the first word; whole-word match; words of a
//    phrase may be separated by any run of non-letters. Latin: case-insensitive whole word.
//  - {re: "..."}: a regular expression on the normalised text (lower case, final letters written as regular letters; {P} = the prefix
//    group). It is wrapped in letter/digit boundaries unless "bounded": false.
export function termRegex(term, prefixes = "ושהבלמכ") {
  if (term && typeof term === "object") {
    const src = fixFinals(term.re).replace(/\{P\}/g, PREFIX);
    return new RegExp(term.bounded === false ? src : `(?<![\\p{L}\\p{N}])(?:${src})(?![\\p{L}\\p{N}])`, "giu");
  }
  const words = normalize(term).trim().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!words.length) return null;
  const heb = new RegExp(`^[${HEB}]`, "u").test(words[0]);
  const pre = heb && prefixes ? `(?:[${prefixes}]{0,4})` : "";
  const body = words.map(esc).join("[^\\p{L}\\p{N}]+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${pre}(${body})(?![\\p{L}\\p{N}])`, "gu");
}
const RE_CACHE = new Map();
function compiled(term, opts) {
  const key = JSON.stringify([term, opts.prefixes, opts.unless_next, opts.unless_prev, opts.unless_match]);
  if (RE_CACHE.has(key)) return RE_CACHE.get(key);
  const c = {
    re: termRegex(term, opts.prefixes),
    un: opts.unless_next ? new RegExp("^(?:" + fixFinals(opts.unless_next) + ")", "iu") : null,
    up: opts.unless_prev ? new RegExp("(?:" + fixFinals(opts.unless_prev) + ")$", "iu") : null,
    um: opts.unless_match ? new RegExp("^(?:" + fixFinals(opts.unless_match) + ")$", "iu") : null,
  };
  RE_CACHE.set(key, c); return c;
}
export const termLabel = t => typeof t === "string" ? t : (t.label ?? t.term ?? t.re);

// Find a term in text (all variants). term: a string, {term, ...opts} or {re, ...opts}. opts: unless_next / unless_prev / unless_match
// regex sources, evaluated on the normalised variant text (unless_next sees the text after the match with leading non-letters removed;
// unless_prev sees up to 60 characters before it; unless_match sees the match itself).
export function findTerm(text, term, opts = {}, vars = variants(text)) {
  if (term && typeof term === "object") { opts = { ...term, ...opts }; term = term.term !== undefined ? term.term : { re: term.re, bounded: term.bounded }; }
  const { re, un, up, um } = compiled(term, opts);
  if (!re) return [];
  const hits = [], seen = new Set();
  for (const v of vars) {
    re.lastIndex = 0;
    for (const m of v.text.matchAll(re)) {
      if (!m[0].length) continue;
      const after = v.text.slice(m.index + m[0].length).replace(/^[^\p{L}\p{N}]+/u, "");
      const before = v.text.slice(Math.max(0, m.index - 60), m.index);
      if (un && un.test(after)) continue;
      if (up && up.test(before)) continue;
      if (um && um.test(m[0])) continue;
      const start = v.map[m.index], end = v.map[m.index + m[0].length - 1] + 1;
      if (seen.has(start)) continue;
      seen.add(start);
      hits.push({ start, end, variant: v.name, matched: m[0] });
    }
  }
  return hits;
}

export function lineOf(text, offset) { let n = 1; for (let i = 0; i < offset && i < text.length; i++) if (text[i] === "\n") n++; return n; }
export function snippet(text, start, end, pad = 30) {
  const a = Math.max(0, start - pad), b = Math.min(text.length, end + pad);
  const clean = x => x.replace(new RegExp(INVISIBLE.source, "gu"), "").replace(/\s+/g, " ");
  return (a > 0 ? "…" : "") + clean(text.slice(a, b)).trim() + (b < text.length ? "…" : "");
}

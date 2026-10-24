#!/usr/bin/env python3
"""Offline test of run.py's Sunday block (alert router): waiting.mjs faked through subprocess.run (ok, exit 3, crash with or without output, timeout, node missing,
empty, no file, oversized) x shadow/routed; GA, sources and notify mocked, nothing is sent and no network is used.
Checks: the brief is always sent whole, the message stays under Telegram's limit, the public log gets no block text, and sent=1
(the summary mark) is written only when nothing held for Sunday could be skipped.
  python3 -I -B analytics/test_run_block.py"""
import contextlib, io, os, subprocess, sys, tempfile, types
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import sample  # noqa: E402
ga = types.ModuleType("ga"); ga.collect = lambda per, cfg: sample.make(per, "busy"); sys.modules["ga"] = ga
src = types.ModuleType("sources"); src.collect_all = lambda per, cfg: (sample.extras("busy"), []); sys.modules["sources"] = src
import notify, run  # noqa: E402
n = bad = 0
def ok(c, m):
    global n, bad; n += 1
    if not c: bad += 1; print("FAIL", m)
SENT = []
notify.send_all = lambda subject, text, html, silent=True: (SENT.append(text) or (["telegram"], []))
REAL, TMP = subprocess.run, tempfile.TemporaryDirectory()
FALLBACK = "⚠️ רשימת 'מחכה לך' לא נבנתה השבוע (הדוח עצמו תקין)."
BODY = {"ok": "🧾 לוחית · סיכום שבועי\n\n⏳ מחכה לך: אין כלום השבוע ✓\n\n🔔 x", "exit3": "🧾 block without state", "crash": None, "crashw": "🧾 half-written block", "empty": "  \n", "nofile": None,
        "huge": "\n".join("• שורה ארוכה מאוד " + "א" * 60 + f" {i}" for i in range(200))}
def fake(mode):
    def f(argv, **kw):
        assert argv[0] == "node" and argv[1].endswith(os.path.join(".github", "scripts", "waiting.mjs")) and kw.get("timeout") == 120, argv
        if mode == "missing": raise FileNotFoundError("node")
        if mode == "timeout": raise subprocess.TimeoutExpired(argv, 120)
        if BODY[mode] is not None: open(argv[2], "w", encoding="utf-8").write(BODY[mode])
        return subprocess.CompletedProcess(argv, {"exit3": 3, "crash": 1, "crashw": 1}.get(mode, 0), b"", b"Error: boom 12345")
    return f
def main(mode, route="", argv=("--send",), stale=False):
    out = tempfile.mkdtemp(dir=TMP.name); go = os.path.join(out, "gh_output"); open(go, "w").close()
    if stale: open(os.path.join(out, "waiting.txt"), "w").write("STALE BLOCK")
    os.environ.update(GITHUB_OUTPUT=go, ALERT_ROUTE=route, GITHUB_RUN_ID="1", GITHUB_SERVER_URL="https://github.com", GITHUB_REPOSITORY="o/r"); os.environ.pop("SCHEDULE", None)
    run.subprocess.run = fake(mode); SENT.clear(); sys.argv = ["run.py", *argv, "--out", out]
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf): rc = run.main()
    finally: run.subprocess.run = REAL
    s = SENT[0] if SENT else None
    if s is not None:   # the Telegram standard's tag line comes first, above the block; the checks below read what follows it
        ok(s.split("\n", 1)[0] in (run.tag_line("green"), run.tag_line("red")), f"{mode}: tag line first {s[:30]!r}"); s = s.split("\n", 1)[1]
    return rc, s, open(go).read(), buf.getvalue()

# the brief as it is sent without the block
wb = run.with_block; run.with_block = lambda head, text, limit=4000: (text, True)
brief = main("ok")[1]; run.with_block = wb
ok(bool(brief) and brief.startswith(("🟢", "🟡", "🔴")), "brief built")
rc, text, _, _ = main("ok")
ok(rc == 0 and text == BODY["ok"] + "\n\n" + brief, "ok: block on top, blank line, brief below")
# mode, ALERT_ROUTE, expected start, sent=1 expected
for mode, route, head, mark in [("ok", "", "🧾", True), ("ok", "all", "🧾", True), ("ok", "critical,day", "🧾", True), ("exit3", "all", BODY["exit3"], False), ("exit3", "", BODY["exit3"], True),
        ("crash", "", FALLBACK, True), ("crash", "critical,silent", FALLBACK, False), ("crashw", "", FALLBACK, True), ("timeout", "", FALLBACK, True), ("timeout", "summary", FALLBACK, False),
        ("missing", "", FALLBACK, True), ("missing", "all", FALLBACK, False), ("empty", "", FALLBACK, True), ("empty", "all", FALLBACK, False),
        ("nofile", "", FALLBACK, True), ("nofile", "all", FALLBACK, False), ("huge", "", "• שורה", True), ("huge", "all", "• שורה", False)]:
    rc, text, gho, log = main(mode, route); c = f"{mode}/{route or 'shadow'}"
    ok(rc == 0 and text is not None and text.endswith("\n\n" + brief), c + ": brief sent whole")
    ok(text.startswith(head), f"{c}: head {text[:40]!r}")
    ok((gho == "sent=1\n") == mark, f"{c}: mark {gho!r}")
    ok(run.u16(text) <= 4000, f"{c}: under the Telegram limit ({run.u16(text)})")
    blk = [l for l in log.splitlines() if not l.startswith(("report built:", "sent via:"))]
    ok(all(l.startswith("waiting block skipped: ") and l.split(": ")[1].isidentifier() for l in blk) and "boom" not in log and "שורה" not in log, f"{c}: the public log holds no block text {log!r}")
rc, text, gho, _ = main("huge")
ok(text.split("\n\n")[0].endswith("\n…") and text.endswith("\n\n" + brief) and gho == "sent=1\n", "huge in shadow: head cut at a line end with …, brief whole, still marked")
rc, text, _, _ = main("nofile", stale=True)
ok("STALE" not in text and text.startswith(FALLBACK), "a stale waiting.txt is never reused")
def boom(*a, **k): raise RuntimeError("x")
run.with_block = boom
rc, text, gho, _ = main("ok"); ok(rc == 0 and text == brief and gho == "sent=1\n", "with_block raising in shadow: the brief alone, marked")
rc, text, gho, _ = main("ok", "all"); ok(rc == 0 and text == brief and gho == "", "with_block raising, routed: the brief alone, not marked")
run.with_block = wb
notify.send_all = lambda subject, text, html, silent=True: ([], ["telegram: HTTP 500"])
rc, _, gho, _ = main("ok"); ok(rc == 1 and gho == "", "nothing delivered: red run, not marked")
notify.send_all = lambda subject, text, html, silent=True: (SENT.append(text) or (["telegram"], []))
# with_block: the block is cut or dropped, never the brief (UTF-16 count)
t, whole = run.with_block("🧾 head\n• a\n• b", "x" * 3995); ok(t == "x" * 3995 and not whole, "no room: block dropped")
t, whole = run.with_block("🧾 head\n• a\n• " + "b" * 50, "x" * 3940); ok(t.startswith("🧾 head\n• a\n…\n\n") and t.endswith("x" * 3940) and not whole and run.u16(t) <= 4000, "cut at a line end " + repr(t[:30]))
t, whole = run.with_block("🧾 " + "😀" * 1000, "x" * 2000); ok(run.u16(t) <= 4000 and t == "x" * 2000 and not whole, "UTF-16 length (emoji are 2 units)")
t, whole = run.with_block("🧾 a", "x" * 100); ok(t == "🧾 a\n\n" + "x" * 100 and whole, "fits: whole")
# without --send (or with --sample) waiting.mjs is never called and nothing is sent
for argv in [("--sample",), ("--sample", "--send"), ()]:
    called = []; run.subprocess.run = lambda *a, **k: called.append(a)
    sys.argv = ["run.py", *argv, "--out", tempfile.mkdtemp(dir=TMP.name)]; SENT.clear()
    try:
        with contextlib.redirect_stdout(io.StringIO()): rc = run.main()
    finally: run.subprocess.run = REAL
    ok(rc == 0 and not called and not SENT, f"{argv}: no block, nothing sent")
TMP.cleanup()
print(f"run.py block test: {bad} of {n} checks FAILED" if bad else f"run.py block test ok ({n} checks)")
sys.exit(1 if bad else 0)

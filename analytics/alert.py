"""Alert router, Python side: hands one alert to the Node engine (.github/scripts/alert.mjs --stdin) and falls back to the caller's
own unchanged send on anything but an ALERT_DONE marker (node missing, ALERT_LEGACY, a crash, a timeout). Text travels through stdin,
never argv, and is never printed. Standard library only.
  try:
      import alert as router
  except Exception:
      router = None
  ok = router.alert("day", "webwatch:rollback", msg, url, today="loud", legacy=lambda: telegram(msg)) if router else telegram(msg)
  python3 -I analytics/alert.py --selftest"""
import json, os, shutil, subprocess, sys

ENGINE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".github", "scripts", "alert.mjs")


def _done(out):
    """True/False from a last stdout line "ALERT_DONE <action> <0|1>"; None for anything else."""
    if isinstance(out, bytes): out = out.decode("utf-8", "replace")
    lines = (out or "").strip().splitlines()
    parts = lines[-1].split() if lines else []
    return parts[2] == "1" if len(parts) >= 3 and parts[0] == "ALERT_DONE" else None


def alert(level, key, text, link="", *, today, legacy, fresh=False):
    """Returns whether the message was taken. Never raises on its own; exceptions from legacy() propagate unchanged."""
    r = None
    try:
        node = shutil.which("node")
        if node:
            p = subprocess.run([node, ENGINE, "--stdin"], capture_output=True, text=True, encoding="utf-8", timeout=60,
                               input=json.dumps({"level": level, "key": key, "text": text, "link": link, "today": today, "plain": True, "fresh": bool(fresh)}))
            for line in (p.stdout or "").splitlines():   # the engine prints only its log line and the marker: no text, links or numbers
                if line.startswith(("alert ", "ALERT_")): print(line)
            r = _done(p.stdout)
    except subprocess.TimeoutExpired as e:
        r = _done(e.stdout)   # the engine prints ALERT_DONE as soon as the message is out, so a kill during its state write is still done
    except Exception:
        r = None
    return bool(legacy()) if r is None else r


def selftest():
    """Offline: subprocess.run and shutil.which mocked, plus one real engine run without a Telegram token (no network)."""
    n = bad = 0
    def ok(c, m):
        nonlocal n, bad
        n += 1
        if not c: bad += 1; print("FAIL", m)
    real_run, real_which, env0 = subprocess.run, shutil.which, dict(os.environ)
    seen = []
    def fake(out="", code=0, exc=None):
        def run(args, **kw):
            seen.append((args, kw))
            if exc: raise exc
            return subprocess.CompletedProcess(args, code, out, "")
        return run
    def case(run=None, which="/usr/bin/node", ret=True, raises=None, **kw):
        calls = []
        def legacy():
            calls.append(1)
            if raises: raise raises
            return ret
        subprocess.run = run or fake()
        shutil.which = (lambda name: which) if which != "real" else real_which
        try:
            return alert(kw.get("level", "day"), kw.get("key", "webwatch:rollback"), kw.get("text", "rollback text"), "https://github.com/o/r/actions/runs/1",
                         today="loud", legacy=legacy), len(calls)
        finally:
            subprocess.run, shutil.which = real_run, real_which
    try:
        ok(case(fake("alert webwatch:rollback day -> loud\nALERT_DONE loud 1\n")) == (True, 0), "ALERT_DONE 1 -> True, no legacy")
        ok(case(fake("ALERT_DONE loud 0\n")) == (False, 0), "ALERT_DONE 0 -> False, no legacy")
        ok(case(fake("alert webwatch:rollback day -> legacy\nALERT_LEGACY\n")) == (True, 1), "ALERT_LEGACY -> legacy once")
        ok(case(fake("ALERT_LEGACY\n"), ret=None) == (False, 1), "ALERT_LEGACY -> bool(legacy())")
        ok(case(fake("ALERT_DONE loud 1\nsomething else\n")) == (True, 1), "marker not on the last line -> legacy")
        ok(case(fake("", code=1)) == (True, 1), "node crash -> legacy")
        ok(case(fake("", exc=OSError("exec format error"))) == (True, 1), "spawn error -> legacy")
        ok(case(fake(exc=subprocess.TimeoutExpired(["node"], 60))) == (True, 1), "subprocess timeout -> legacy")
        ok(case(fake(exc=subprocess.TimeoutExpired(["node"], 60, output=b"ALERT_DONE loud 1\n"))) == (True, 0), "timeout after ALERT_DONE -> done, no duplicate")
        ok(case(which=None) == (True, 1), "node missing (which) -> legacy")
        os.environ["PATH"] = ""
        ok(case(which="real") == (True, 1), 'node missing (PATH="") -> legacy')
        os.environ.clear(); os.environ.update(env0)
        seen.clear()
        secret = "פרטים 050-1234567 dudu@example.com"
        case(fake("ALERT_DONE loud 1\n"), text=secret)
        args, kw = seen[0]
        ok(not any(secret in str(a) or "050-1234567" in str(a) for a in args) and args[-1] == "--stdin", "text never in argv")
        ok(json.loads(kw["input"])["text"] == secret and json.loads(kw["input"])["plain"] is True and kw.get("timeout") == 60, "text through stdin, plain, 60 s")
        for name, run in (("ALERT_LEGACY", fake("ALERT_LEGACY\n")), ("node missing", None)):
            try:
                case(run, which="/usr/bin/node" if run else None, raises=ValueError("legacy boom"))
                ok(False, "legacy exception propagates: " + name)
            except ValueError as e:
                ok(str(e) == "legacy boom", "legacy exception propagates: " + name)
        if real_which("node") and os.path.exists(ENGINE):   # the real engine, offline: no Telegram token -> ALERT_LEGACY
            for k in ("TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "GITHUB_TOKEN"): os.environ.pop(k, None)
            ok(case(which="real", run=real_run) == (True, 1), "real engine without a token -> legacy once")
            ok(case(which="real", run=real_run, key="plate:12-345-67") == (True, 1), "real engine, invalid key -> legacy once")
    finally:
        subprocess.run, shutil.which = real_run, real_which
        os.environ.clear(); os.environ.update(env0)
    print(f"alert.py selftest: {bad} of {n} checks FAILED" if bad else f"alert.py selftest ok ({n} checks)")
    sys.exit(1 if bad else 0)


if __name__ == "__main__" and "--selftest" in sys.argv:
    selftest()

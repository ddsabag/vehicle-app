"""Delivery. Every channel is optional: it is used only when its secret exists. Python standard library only."""
import json, mimetypes, os, smtplib, urllib.parse, urllib.request, uuid
from email.message import EmailMessage


def _post(url, data, headers):
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def telegram(text, html_path):
    tok, chat = os.environ.get("TELEGRAM_BOT_TOKEN"), os.environ.get("TELEGRAM_CHAT_ID")
    if not (tok and chat): return None
    base = f"https://api.telegram.org/bot{tok}/"
    _post(base + "sendMessage", urllib.parse.urlencode({"chat_id": chat, "text": text, "disable_web_page_preview": "true"}).encode(),
          {"Content-Type": "application/x-www-form-urlencoded"})
    if html_path:
        b = uuid.uuid4().hex; body = bytearray()
        def field(n, v): body.extend(f'--{b}\r\nContent-Disposition: form-data; name="{n}"\r\n\r\n{v}\r\n'.encode())
        field("chat_id", chat)
        name = os.path.basename(html_path)
        body.extend(f'--{b}\r\nContent-Disposition: form-data; name="document"; filename="{name}"\r\nContent-Type: text/html\r\n\r\n'.encode())
        body.extend(open(html_path, "rb").read()); body.extend(f"\r\n--{b}--\r\n".encode())
        _post(base + "sendDocument", bytes(body), {"Content-Type": f"multipart/form-data; boundary={b}"})
    return "telegram"


def slack(text):
    url = os.environ.get("SLACK_WEBHOOK_URL")
    if not url: return None
    _post(url, json.dumps({"text": text}).encode(), {"Content-Type": "application/json"})
    return "slack"


def email(subject, text, html_path):
    host, to = os.environ.get("SMTP_HOST"), os.environ.get("EMAIL_TO")
    if not (host and to): return None
    msg = EmailMessage()
    msg["Subject"] = subject; msg["From"] = os.environ.get("SMTP_FROM") or os.environ.get("SMTP_USER") or to; msg["To"] = to
    msg.set_content(text)
    if html_path:
        msg.add_attachment(open(html_path, "rb").read(), maintype="text", subtype="html", filename=os.path.basename(html_path))
    with smtplib.SMTP(host, int(os.environ.get("SMTP_PORT", "587")), timeout=30) as s:
        s.starttls()
        if os.environ.get("SMTP_USER"): s.login(os.environ["SMTP_USER"], os.environ.get("SMTP_PASSWORD", ""))
        s.send_message(msg)
    return "email"


def send_all(subject, text, html_path):
    sent, errs = [], []
    for name, fn in (("telegram", lambda: telegram(text, html_path)), ("slack", lambda: slack(text)), ("email", lambda: email(subject, text, html_path))):
        try:
            r = fn()
            if r: sent.append(r)
        except Exception as e:
            errs.append(f"{name}: {type(e).__name__}: {e}")
    return sent, errs

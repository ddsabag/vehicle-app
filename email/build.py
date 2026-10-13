"""Builds email/confirm.html and email/newsletter.html from one shell. Run: python3 email/build.py"""
import pathlib
D = pathlib.Path(__file__).parent
LOGO = "https://luchit.app/icon-512.png"
FF = "Assistant,'Segoe UI',Arial,Helvetica,sans-serif"
CSS = """
body{margin:0;padding:0;background:#f1f3f7;-webkit-text-size-adjust:100%}
table{border-collapse:collapse}
a{color:#2a56c6}
@media (max-width:620px){.px{padding-left:22px!important;padding-right:22px!important}.h1{font-size:23px!important}.btn a{display:block!important;text-align:center!important}}
@media (prefers-color-scheme:dark){
  body,.bg{background:#0d1118!important}
  .card{background:#161c27!important}
  .tx{color:#e9edf3!important}
  .mu{color:#9aa4b6!important}
  .ln{border-color:#2a3342!important;background:#2a3342!important}
  .tile{background:#1d2532!important}
}
"""
def td(inner, style="", cls="", extra=""):
    return f'<td dir="rtl" align="right" class="ff {cls}" style="text-align:right;font-family:{FF};{style}" {extra}>{inner}</td>'

def shell(pre, body, foot):
    return f'''<!doctype html>
<html lang="he" dir="rtl"><head><meta charset="utf-8">[[ROBOTS]]<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">
<title>לוחית</title>
<style>{CSS}</style></head>
<body class="bg" dir="rtl" style="margin:0;padding:0;background:#f1f3f7">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">{pre}</div>
<table role="presentation" width="100%" dir="rtl" class="bg" style="background:#f1f3f7"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="600" dir="rtl" style="width:100%;max-width:600px">
  <tr><td class="card" dir="rtl" align="right" style="background:#ffffff;border-radius:16px;border-top:5px solid #ffc400;overflow:hidden">
    <table role="presentation" width="100%" dir="rtl">
      <tr>{td(f'<table role="presentation" dir="rtl"><tr><td dir="rtl" align="right" style="padding-left:12px"><a href="https://luchit.app/"><img src="{LOGO}" width="48" height="48" alt="לוחית" style="display:block;border:0;border-radius:11px"></a></td><td dir="rtl" align="right" style="font-family:{FF}"><a href="https://luchit.app/" class="tx" style="text-decoration:none;color:#151a24;font-size:22px;font-weight:800;line-height:1.1">לוחית</a><div class="mu" style="color:#5d6676;font-size:13px;margin-top:3px">בדיקת רכב לפי מספר רישוי</div></td></tr></table>', "padding:24px 36px 4px", "px")}</tr>
      <tr>{td(body, "padding:18px 36px 34px", "px")}</tr>
    </table>
  </td></tr>
  <tr>{td(foot, "padding:20px 36px 8px;color:#5d6676;font-size:12px;line-height:1.75", "px mu")}</tr>
</table>
</td></tr></table>
</body></html>
'''

def button(href, label):
    return f'<table role="presentation" dir="rtl" align="right" class="btn" style="margin:26px 0 6px"><tr><td dir="rtl" align="center" style="background:#2a56c6;border-radius:10px"><a href="{href}" style="display:inline-block;padding:15px 34px;color:#ffffff;font-family:{FF};font-weight:700;font-size:16px;text-decoration:none">{label}</a></td></tr></table>'

def tile(icon, head, text):
    return f'<tr><td dir="rtl" align="right" class="tile" style="background:#f5f7fa;border-radius:10px;padding:12px 14px;text-align:right;font-family:{FF}"><table role="presentation" dir="rtl"><tr><td dir="rtl" align="right" valign="top" style="font-size:20px;line-height:1.3;padding-left:12px">{icon}</td><td dir="rtl" align="right" class="tx" style="font-family:{FF};color:#151a24;font-size:15px;line-height:1.6;text-align:right"><b>{head}</b><br><span class="mu" style="color:#5d6676;font-size:14px">{text}</span></td></tr></table></td></tr><tr><td style="height:8px;line-height:8px;font-size:0">&nbsp;</td></tr>'

P = lambda t, st="": f'<p class="tx" dir="rtl" style="margin:0 0 12px;font-family:{FF};font-size:16px;line-height:1.75;color:#151a24;text-align:right;{st}">{t}</p>'
MU = lambda t: f'<p class="mu" dir="rtl" style="margin:0;font-family:{FF};font-size:13px;line-height:1.7;color:#5d6676;text-align:right">{t}</p>'
H1 = lambda t: f'<h1 class="tx h1" dir="rtl" style="margin:0 0 14px;font-family:{FF};font-size:27px;line-height:1.3;color:#151a24;text-align:right">{t}</h1>'
LK = 'style="color:#5d6676"'
DOM = '<bdi dir="ltr">luchit.app</bdi>'
MAIL = '<bdi dir="ltr"><a href="mailto:updates@luchit.app" ' + LK + '>updates@luchit.app</a></bdi>'
PRIV = f'<a href="https://luchit.app/privacy.html" {LK}>מדיניות פרטיות</a>'

confirm_body = H1("עוד צעד אחד ואתם רשומים") + P("ביקשתם לקבל את המגזין החודשי של לוחית. כדי לוודא שהכתובת שלכם, לחצו על הכפתור:") + button("{{CONFIRM_URL}}", "אישור הרשמה") + \
  '<table role="presentation" dir="rtl" width="100%" style="margin-top:22px">' + \
  tile("📊", "סיכום חודשי של שוק הרכב", "מגמות, דגמים ונתונים ממשרד התחבורה, בעברית פשוטה.") + \
  tile("🔔", "פעם בחודש, לא יותר", "בלי ספאם. אפשר להסיר את עצמכם בלחיצה אחת בכל מייל.") + '</table>' + \
  MU("לא נרשמתם? אפשר להתעלם מהמייל, ולא נשלח לכם דבר.")
confirm_foot = f'<div style="margin-bottom:6px">הודעת אישור הרשמה שנשלחה בעקבות בקשה באתר {DOM}. המגזין עצמו הוא פרסומת, והוא יישלח רק אחרי האישור.</div><div>{MAIL} · {PRIV}</div>'

news_body = f'<div class="mu" dir="rtl" style="font-family:{FF};color:#5d6676;font-size:13px;margin-bottom:8px;text-align:right">המגזין של לוחית · [[MONTH]]</div>' + H1("[[TITLE]]") + P("[[LEAD]]") + button("[[URL]]", "לקריאת הכתבה במגזין") + \
  f'<table role="presentation" dir="rtl" width="100%" style="margin-top:22px"><tr><td class="ln" style="height:1px;line-height:1px;font-size:0;background:#e3e7ee">&nbsp;</td></tr></table>' + \
  f'<p class="mu" dir="rtl" style="margin:18px 0 0;font-family:{FF};font-size:14px;line-height:1.75;color:#5d6676;text-align:right">רוצים לבדוק רכב ספציפי? הקלידו מספר רישוי ב-<a href="https://luchit.app/">{DOM}</a> וקבלו ריקולים, טסט, בעלויות ושווי משוער, בחינם. אפשר גם <a href="[[PLAY_URL]]">באפליקציה בגוגל פליי</a>.</p>'
news_foot = f'<div style="margin-bottom:6px"><b>פרסומת.</b> קיבלתם מייל זה כי נרשמתם למגזין לוחית ואישרתם קבלת פרסומות ועדכונים, בהתאם לחוק התקשורת (בזק ושידורים).</div><div style="margin-bottom:6px">הסרה מהרשימה בלחיצה אחת: <a href="{{{{ unsubscribe }}}}" {LK}>להסרה מהדיוור</a></div><div style="margin-bottom:6px">לוחית, מופעלת על ידי דודו סבאג, מסד.</div><div>{MAIL} · {PRIV}</div>'

(D/"confirm.html").write_text(shell("עוד צעד אחד: אישור ההרשמה למגזין לוחית", confirm_body, confirm_foot).replace("[[ROBOTS]]", '<meta name="robots" content="noindex">'))
(D/"newsletter.html").write_text(shell("[[PREHEADER]]", news_body, news_foot).replace("[[ROBOTS]]", '<meta name="robots" content="noindex">'))

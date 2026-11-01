# Kit visual QA: 2026-11-01

15 images looked at by claude-sonnet-5-5.
6 findings, 17 low-confidence notes. Report only: decide each one by looking at the image.

## Findings
- **medium · overlap** · reel-buyer-questions.frame-2of5.jpg · top edge of the phone mockup, just above the screen: The mock-scene caption "* המחשה · רכב לדוגמה" is half hidden behind the top edge of the phone frame, so its lower half is cut off and it is hard to read. («* המחשה · רכב לדוגמה»)
- **low · layout** · story-02.png · subtitle under the headline, second line: The subtitle "לפי מאגרי משרד התחבורה, בלי שמות של בעלים." wraps so that the single word "בעלים." sits alone on its own row, a widow that looks accidental. («בעלים.»)
- **low · layout** · story-03.png · subtitle paragraph under the headline, second line: The subtitle "ריקול פתוח? התיקון בדרך כלל ללא עלות אצל היבואן." wraps so that the single word "היבואן." sits alone on its own row (a widow). («היבואן.»)
- **low · rtl** · story-03.png · line under the licence plate: The Hebrew prefix "ב-" and the URL "luchit.app" are in the wrong visual order. The line reads "luchit.app-בודקים ב", with the URL at the left and the hyphen detached from it. («בודקים ב-luchit.app»)
- **low · layout** · reel-buyer-questions.frame-1of5.jpg · Headline, first two lines: "כל שאלה בלי" then "תשובה" alone on the second row: The word "תשובה" sits alone on its own row, leaving a short orphan line under "כל שאלה בלי". The line break splits the phrase awkwardly. («תשובה»)
- **low · cut_text** · reel-buyer-questions.frame-3of5.jpg · top, partly hidden behind the green header bar, above the report card on the right: The earlier chat bubble "עד מתי הטסט?" is cut off by the green header bar, so the top half of the letters is hidden. («עד מתי הטסט?»)

## Low-confidence notes
- typo · carousel-04.png · yellow pill above the title: The pill reads 'צעד 2', which is fine on its own. However, the slide shows no other defect in the pill, so this is only a low-confidence check of the wording ('צעד' rather than 'טיפ').
- layout · carousel-01.png · Title block, third line: The headline wraps so that the single word "תשובות." sits alone on its own row after "מגיעים עם", leaving a short orphan line.
- layout · carousel-01.png · Source footnote, second line: The footnote wraps awkwardly: the word "פעילים." is left alone at the start of the second line, and the sentence reads broken across lines.
- rtl · carousel-02.png · bottom left, the swipe prompt next to 'החליקו': The arrow points left, which is the correct 'next' direction in RTL, so this is not an error. The only possible concern is the word-and-arrow order, and it looks consistent.
- rtl · carousel-03.png · Title second line, yellow text next to the period: The period sits at the left end of the Hebrew title line, which is the correct end for RTL, so this is fine. The title as a whole has no defect.
- typo · carousel-05.png · Yellow box, second line under 'luchit.app-ב': Possibly the box line 'חינם · בלי הרשמה · אנדרואיד ודפדפן' reads fine; no clear defect, but the sentence is a list of unrelated items. Low-confidence note only.
- layout · story-01.png · bottom area: Google Play badge and "זמינה להורדה" caption, around y=1480-1590: The badge and its caption sit inside the bottom 340px (y>1580) reserved for the network's UI. The badge is allowed in that zone, but its bottom edge at about y=1590 is right at the limit, so this is …
- typo · dealer-post.png · top right, header line beside the logo: The header reads "למגרשים ולטריי-אין", and the English "trade-in" is transliterated in an odd way as "טריי-אין". It is probably intended, so this is a minor wording point.
- layout · dealer-post.png · bottom left, "זמינה להורדה" caption above the Google Play badge: The caption is not aligned with the badge's left edge. It is indented relative to the badge, and the pair sits apart from the right-aligned "שיתוף הדוה" link row.
- rtl · dealer-post.png · bottom right, link row: The arrow "←" points left, toward the Hebrew text, and the sequence reads right to left as the Hebrew first and the URL second. This is probably fine, so I am flagging it only at low confidence.
- badge · reel-cover.jpg · whole cover frame; no Google Play badge anywhere, including the bottom area: The 'GET IT ON Google Play' badge is not visible on this cover image. Note that the rule covers a reel's last frame, so this is only a possible defect on a cover.
- layout · reel-cover.jpg · top-left of chat area, the '* המחשה' tag next to the first message bubble: The mock-scene tag sits at the very top-left, crammed right against the header edge and the message bubble row, and the asterisk is placed to the left of the Hebrew word. The tag is inside the top 25…
- layout · reel-cover.jpg · large empty area between the message bubble and the title pill 'מוכרים רכב?', and the empty bottom area: The cover has a very large empty beige gap in the middle of the frame, with only one short message bubble and a title pill floating far below it. The composition looks unfinished.
- rtl · reel-buyer-questions.frame-1of5.jpg · Yellow headline line, at the left end: The period sits at the left end of the Hebrew sentence, which is the correct end for RTL. No defect here.
- other · reel-buyer-questions.frame-1of5.jpg · The "* המחשה" tag at the top left of the chat: The mock-scene tag is very faint and low-contrast against the dimmed background. It is intentional, but hard to read.
- layout · reel-buyer-questions.frame-2of5.jpg · bottom of the frame: no Google Play badge, and the phone runs down to about y=1820: The frame has no visible Google Play badge. The phone also reaches into the bottom 340px reserved for the network UI. This is probably acceptable for a middle frame, so it is a low-confidence note.
- layout · reel-buyer-questions.frame-3of5.jpg · green header at the top, contact name "קונה מהמודעה" and "מקליד/ה...": The header text sits inside the top 250 px, which the network interface covers. It is part of the mocked chat scene, so the risk is small.

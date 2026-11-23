### Exploratory walk 2026-11-23: 6 notes, 0 high

[run](https://github.com/ddsabag/vehicle-app/actions/runs/45111321257). Report only: Claude Sonnet used the page on next like a person, with the example plates and nothing leaving the machine. Notes are its own judgement, not checked yet.

#### buyer: 26 steps, 1 notes

> I checked 1234567 on the overview, purchase and spec tabs, compared it with 4444444, and tried the plates "12ab" and "111 11 11". Only one real problem turned up: the green "0 מתוך 8" safety badge on the spec tab reads as good news when 0 really means unknown. I noted it. The invalid-plate message and the "not found" message for 1111111 behaved correctly.

| severity | kind | where | what | screen |
|---|---|---|---|---|
| medium | data | מפרט tab, בטיחות row | "0 מתוך 8" safety badge is green, which looks like good news. The text below says 0 may mean no rating or an old one. It reads as a good result when it is really unknown. | [shot](buyer-1.png) |

#### owner: 41 steps, 2 notes

> I walked the nickname, car file, add-service, alerts, settings and remove/re-add flows in dark mode on a small screen. Layout and contrast were mostly fine. I noted two problems: the settings alerts row only opens the alerts feed, and the nickname is lost after removing and re-adding a car.

| severity | kind | where | what | screen |
|---|---|---|---|---|
| medium | confusing | Settings > התראות row "על אילו רכבים ועל מה להתריע" | The row reads like alert preferences, but tapping it just closes settings and shows the alerts feed. There are no options for which cars or which alerts. | [shot](owner-1.png) |
| low | confusing | Car page 44-444-44 after remove and re-add | After removing the car and saving it again, the nickname I set is gone with no warning. Also, "חיפוש" is highlighted in the bottom bar although I came from הרכבים שלי. | [shot](owner-2.png) |

#### visitor: 32 steps, 3 notes

> I checked the home page, the 4444444 result, settings, the FAQ, the bulk-check tool and the privacy page. I noted three things: the "תצוגה פשוטה" switch looks neither on nor off, the privacy and terms links in settings showed no change when tapped, and the footer's "מדריך לקונה" link is styled differently from the rest. I didn't open the model compare tool, and I found no About page or app link i…

| severity | kind | where | what | screen |
|---|---|---|---|---|
| medium | confusing | Settings dialog, "תצוגה פשוטה" switch | Switch has a grey track with the knob on the left (the "on" side), which is neither the OFF nor ON look described; state is unclear. | [shot](visitor-1.png) |
| medium | broken | Settings dialog, links מדיניות פרטיות / תנאי שימוש | Tapping privacy policy and terms links gives no visible change; the dialog stays and no page opens (maybe new tab, no feedback). | [shot](visitor-2.png) |
| low | layout | Footer, "מדריך לקונה" link | Only this footer link is blue and underlined, unlike the other grey links; inconsistent. Footer also has no About page or app download link. | [shot](visitor-3.png) |

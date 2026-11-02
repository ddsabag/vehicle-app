### Exploratory walk 2026-11-02: 5 notes, 0 high

[run](https://github.com/ddsabag/vehicle-app/actions/runs/41432283681). Report only: Claude Sonnet used the page on next like a person, with the example plates and nothing leaving the machine. Notes are its own judgement, not checked yet.

#### buyer: 28 steps, 1 notes

> I checked 1234567 (the overview, purchase and spec tabs), the too-short, letters and not-found plates, 7654321, and the comparison screen. I found one minor problem: on the comparison screen, the "שמירה" and "נשמר ✓" buttons don't say which car each one belongs to. The rest worked, including the validation messages, the not-found message and the plate digit order.

| severity | kind | where | what | screen |
|---|---|---|---|---|
| low | confusing | השוואת רכבים, בלוק "ברכבים שלי" | שני כפתורים, "שמירה" ו"נשמר ✓", מופיעים בלי שם הרכב ליד כל אחד. אי אפשר לדעת איזה כפתור שייך לאיזה רכב. גם כוכב "שמירת השוואה" למעלה דומה להם. | [shot](2026-11-02/buyer-1.png) |

#### owner: 43 steps, 1 notes

> I walked through nicknaming, opening a car's file, adding a service, alerts, settings, and removing and re-adding a car, all in dark mode. I found one problem: a long nickname is cut off mid-word in the file header with no ellipsis, and the same cut text shows as "המשפ" on the home screen's recent checks.

| severity | kind | where | what | screen |
|---|---|---|---|---|
| medium | cut_text | File header, nickname line | A long nickname is cut mid-word at the bottom ("המשפ") with no ellipsis, and the full name can't be read anywhere. | [shot](2026-11-02/owner-1.png) |

#### visitor: 29 steps, 3 notes

> I checked 7654321, the compare dialog, settings, the FAQ and the privacy page. I did not reach the tools pages (model search, market, bulk check), and I found no terms or about page. I noted three problems: the bare privacy page with no way back, a switch that is on but shows a grey track, and over-reassuring "no red flags" wording on the purchase tab.

| severity | kind | where | what | screen |
|---|---|---|---|---|
| medium | layout | Privacy policy page | The page is plain, unstyled text with no header, no link back to the site and no footer. Nothing on it can be pressed, so a visitor has to use the browser Back button. The lines are also very long on a desktop screen. | [shot](2026-11-02/visitor-1.png) |
| medium | contrast | Settings, "תצוגה פשוטה" switch | The switch is checked ("on") and its knob is at the end (left), but the track is grey, not blue. It looks half-off, so a person can't tell whether simple display is on. | [shot](2026-11-02/visitor-2.png) |
| low | confusing | Report, "קנייה" tab, "ליווי קנייה" | The tab says "לא עלו דגלים אדומים בנתונים" (no red flags) with no price entered and no value estimate. It reads as a reassurance about the car, though the check covers only four registry items and the app says it can't see accidents or liens. | [shot](2026-11-02/visitor-3.png) |

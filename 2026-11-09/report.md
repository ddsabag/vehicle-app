### Exploratory walk 2026-11-09: 3 notes, 0 high

[run](https://github.com/ddsabag/vehicle-app/actions/runs/42561335027). Report only: Claude Sonnet used the page on next like a person, with the example plates and nothing leaving the machine. Notes are its own judgement, not checked yet.

#### buyer: 27 steps, 1 notes

> I checked both example plates (overview, purchase and spec tabs), plates with dashes, spaces, letters, too few digits and a missing plate (1111111), and the My Cars screen. The only problem I noted is the safety row for 7654321, which shows a green "0 מתוך 8" even though the page itself says 0 may just mean the data is not reported. Input handling and the not-found messages looked fine, and I did…

| severity | kind | where | what | screen |
|---|---|---|---|---|
| medium | data | מפרט tab, בטיחות row (7654321) | A 2023 Mercedes shows "0 מתוך 8" safety level in a green badge. The explanation below admits 0 may only mean the equipment is not reported. The green badge and the bare "0 מתוך 8" look like a verdict and say more than the data knows. | [shot](buyer-1.png) |

#### owner: 39 steps, 1 notes

> I walked the app in dark mode on a small phone. I covered the saved-cars table, a car's file, a long nickname, adding a service, the alerts list, and the settings sheet. The only problem I noted was low severity: a long nickname is silently cut to about 30 characters with no warning. I did not test removing a car and adding it back, because my taps landed on the wrong buttons. I also did not test…

| severity | kind | where | what | screen |
|---|---|---|---|---|
| low | confusing | שינוי כינוי input | A long nickname is silently cut to about 30 characters ("...של סבא", without "מהמושב"). The input gives no counter or warning, and the saved message says only "saved". | [shot](owner-1.png) |

#### visitor: 19 steps, 1 notes

> I checked the home page, the 7654321 result, the privacy page, the compare dialog, the settings dialog and the footer. I noted one low-severity problem: the "תצוגה פשוטה" switch has its knob in the ON position but a grey track. The footer lists the privacy page but I found no terms, about or FAQ link, and I didn't open the tools or "מה אפשר לבדוק" pages.

| severity | kind | where | what | screen |
|---|---|---|---|---|
| low | confusing | Settings dialog, "תצוגה פשוטה" switch | The knob is at the left (ON position) but the track is slate grey, not blue. It is unclear whether the switch is on or off. | [shot](visitor-1.png) |

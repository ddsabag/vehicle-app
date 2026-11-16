### Exploratory walk 2026-11-16: 4 notes, 0 high

[run](https://github.com/ddsabag/vehicle-app/actions/runs/43803574131). Report only: Claude Sonnet used the page on next like a person, with the example plates and nothing leaving the machine. Notes are its own judgement, not checked yet.

#### buyer: 25 steps, 1 notes

> I checked 1234567 on all four tabs, searched with dashes and spaces, 3 digits and 1111111, and built a comparison with 7654321. Plate handling, the error messages and the comparison worked correctly. I noted one problem: the safety badge "0 מתוך 8" is green, which reads as good, while the text below it says the 0 may just mean there is no data.

| severity | kind | where | what | screen |
|---|---|---|---|---|
| medium | confusing | מפרט tab, בטיחות | The badge "0 מתוך 8" is green, which reads as good. The text below says the 0 may only mean there is no data. A reader in a hurry would take it as a good or a bad score when it is neither. | [shot](2026-11-16/buyer-1.png) |

#### owner: 40 steps, 1 notes

> I walked through nicknaming a car, opening its file, adding a service, the alerts, settings, and removing a car and adding it back, all in dark mode. I noted one problem: the settings row "על אילו רכבים ועל מה להתריע" opens the general alerts feed instead of any alert choices. I also saw that removing a car gives no confirmation, and that a negative km value was accepted silently, but I did not n…

| severity | kind | where | what | screen |
|---|---|---|---|---|
| medium | confusing | Settings, row "על אילו רכבים ועל מה להתריע" | Tapping this settings row closes settings and shows the general alerts feed, not any choice of which cars or what to alert on. I found no way to set alert preferences. | [shot](2026-11-16/owner-1.png) |

#### visitor: 24 steps, 2 notes

> I checked plate 7654321, the terms page, the compare dialog, the settings dialog and the "what can be checked" page, using 18 tool calls. I noted two low-severity problems: closing the compare dialog sends you back to the car report instead of the compare page, and the "תצוגה פשוטה" switch looks grey even though it is on. I did not get to the privacy, about or FAQ pages, the tools pages, or the a…

| severity | kind | where | what | screen |
|---|---|---|---|---|
| low | confusing | השוואה → dialog "הוספת רכב 2 להשוואה" | Tapping השוואה on the report opened the compare page with the add-car dialog on top. Closing the dialog with X took me back to the car report, not the compare page. I expected to stay on the compare page. | [shot](2026-11-16/visitor-1.png) |
| low | contrast | הגדרות → תצוגה פשוטה switch | The switch is on (checkbox "on", knob at the end/left). Its track is grey-slate instead of blue, so it looks off or disabled. | [shot](2026-11-16/visitor-2.png) |

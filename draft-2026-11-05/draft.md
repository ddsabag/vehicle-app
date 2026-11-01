# טיוטת ערכה 4 ליום חמישי 2026-11-05

Draft by claude-opus-5-5 the night before. Review every line; the Thursday run renders, films, lints the whole kit and decides.

## Pain
ריקול או טסט שפג אחרי הקנייה, בלי שמישהו עוקב

Kit 3 covered the seller before the meeting. This week the story moves to after the handshake. Israeli owners, lots and fleet managers share one quiet fear: they only find out about a problem when it is already a problem. That means a test that lapsed unnoticed, or a recall published for the model months after the car was bought. Nobody checks the Ministry of Transport register for no reason, so the surprise comes at the worst moment: at a police check, when a buyer is already waiting, or when a driver is stuck. The data makes this concrete and new to most people. Recall rates are model-level facts (MG3: 118 and Citroen BERLINGO: 60 per 1,000 active cars with an open recall), but every owner wants to know about one car. There is no new recall campaign this week (no catalogue id after 16821), so this is not recall news. It is the first full kit built on the approved 1.38 main message, 'התיק של הרכב, מהבדיקה ועד המכירה'. The car file ('פתחו לו תיק', live with 1.38.3 at 100% since 27.10) turns the vague worry into one action. For lots and fleets, the bulk check (PRO עסקי) answers the same fear across the whole lot. It works because it relieves anxiety without blaming anyone: the manufacturer publishes the recall, the importer fixes it, and the only enemy is not knowing.

## Picks
- reel: B2B utility: מי עוקב אחרי הטסט? [product-1.37 + recalls-model-stats]
- carousel: Trust & Safety: קניתם רכב? ריקול יכול להגיע גם אחר כך [recalls-model-stats]
- stories: Community: עד מתי הטסט של הרכב שלכם? [product-1.38]
- dealer: B2B utility (recall/test follow-up for the whole lot): מה פג במגרש? טבלה אחת למעקב [product-1.37]

## Lint (copy only)
Clean after 1 fix round(s).

## Notes
- Lint fixes in this version: (1) pro-feature: 'ללא עלות' is removed from every item that mentions the bulk check (reel VO and screen, reel caption, dealer note, dealer caption). The repair line there is now 'מתאמים תיקון אצל היבואן' / 'היבואן מתקן'. 'בדרך כלל ללא עלות' stays only in the carousel, which has no PRO feature. (2) The VO number is written in digits ('60 מכל 1,000', fact recalls-model-stats #5). (3) The timings, pixel sizes, the 2.2 tail and the version number are moved out of reel.json into these notes.
- Reel timing by line (about 30 s in total): line 1 0-3s, line 2 3-7s, line 3 7-11s, line 4 11-15s, line 5 15-18s, line 6 18-23s, line 7 23-26s, line 8 26-30s.
- Reel end card (RUNBOOK 6.5): the badge is about 110px tall with 28px clear around it, under the luchit.app pill. It stays on screen at least 3 s after the badge appears (TOT = last VO end + 2.2, same tail in audio.py).
- App screens (lines 6-7) must be recorded fresh from 1.38.3 (APP_VERSION 1.38.3, at 100% of production since 27.10) with app-record*.mjs, on synthetic data. Demo plates only: 12-345-67, 76-543-21, 123-45-67. Motion graphics are acceptable instead.
- VO: ElevenLabs reads digits ('60', '1,000'). Listen and check that it says them as 'שישים מכל אלף'. With no ElevenLabs key the reel is captions-only: drop 'הקריינות נוצרה ב-AI.' from the reel caption and the AI label from the TikTok prompt.
- Pain differs from kit 3 (the seller before the meeting): this kit is about after the purchase (a recall or test with nobody following), built on the 1.38 main message 'התיק של הרכב, מהבדיקה ועד המכירה'.
- Features used: the car file / 'פתחו לו תיק' (1.38.3) and the fleet table with last service date and km (1.37). The bulk check is labelled 'PRO עסקי' everywhere, with no 'חינם' or cost wording near it. Please confirm that the fleet table belongs to the PRO bulk check.
- Recall wording follows the caution: 'N מכל 1,000 רכבים פעילים עם ריקול פתוח', never 'N ריקולים'. Models are framed as 'נתון על הדגם, לא פסק דין על הרכב'. No 'זכאים', no villain.
- The dealer table uses word cells only, so no nonclaims are needed. The service-date/km column is not in the static table.
- Not used on purpose: fuel (VERIFY caution, Delek-derived price); the Fiat 500e settlement (changed_fields cond/st, so not clearly new for owners); recall news (none after id 16821); magazine offroad-2026-10 (already kit 2); market 09/2026 (kit 2 dealer).
- 'בלי פרסומות' on the carousel CTA restates the strategy line (free, no ads). Please confirm it is still true in 1.38.3.
- Schedule (D=2026-11-05): Sun 08.11 08:30 dealer, Mon 09.11 20:30 carousel, Tue 10.11 08:15 stories, Thu 12.11 20:30 reel. Autopilot zone B is OBSERVE for this kit: log rows only.
- go/ topics: lot_followup (reel), car_file_recall (carousel), lot_recall_test (dealer), test_date (stories).

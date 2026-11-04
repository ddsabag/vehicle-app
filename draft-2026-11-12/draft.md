# טיוטת ערכה 4 ליום חמישי 2026-11-12

Draft by claude-opus-5-5 the night before. Review every line; the Thursday run renders, films, lints the whole kit and decides.

## Pain
ריקול חדש נפתח, והרכב כבר אצלכם

This week brings new data. Since the last kit's recall baseline, new recalls were added to the Ministry of Transport list, so the topic is fresh. They include LEXUS NX, CHEVROLET TRAX, JEEP WRANGLER and JAGUAR I PACE. The pain is the surprise after the car is already at home, on the lot or in the fleet. Most Israelis assume that once a car passed the deal, the safety question is closed. A new recall reopens it, and nobody calls to say so. The uncertainty is personal ('is MY car on the list?'), not abstract, so one simple action relieves it: type the licence plate. For lots and fleets the pain grows with every car, because nobody wants a customer to learn about an open recall after delivery. This differs from last kit's seller-preparation pain. It also leads into the new main message: the car file keeps watching after the purchase, with in-app alerts on recall, test and ownership change. The enemy is the surprise, never the importer: the manufacturer recalls and the importer fixes, usually at no cost.

## Picks
- reel: B2B utility: ריקול חדש, כל המגרש [news-recalls-16821-16830]
- carousel: Trust & Safety: נפתח ריקול חדש. הרכב שלכם ברשימה? [news-recalls-16821-16830]
- stories: Community: ריקול חדש: איך הייתם יודעים? [news-recalls-16821-16830]
- dealer: B2B utility (recall/test follow-up for the whole lot): כל המגרש. ריקול וטסט בטבלה אחת. [news-recalls-16821-16830]

## Lint (copy only)
Clean after 1 fix round(s).

## Notes
- Lint fixes. The dealer caption no longer says 'ללא עלות' anywhere near the bulk check (PRO עסקי); the line that mentions the bulk check now also carries '(PRO עסקי)'. In the reel caption, the 'usually no cost at the importer' sentence moved into the single-check paragraph, on its own line, away from the PRO paragraph. The reel visuals no longer carry version numbers, pixel sizes or seconds: they point to the RUNBOOK end-card spec and to 'the version now fully live in production'. The builder must still apply the RUNBOOK values in gen.py: badge size and clear space, end-card hold, and APP_VERSION.
- The only number in all copy is 118 (idea recalls-model-stats, fact index 3, MG3). It is written in the binding form 'MG3: 118 מכל 1,000 רכבים פעילים עם ריקול פתוח', never 'ריקולים'. It sits next to the neutral line 'ריקול הוא תיקון של היצרן', following the caution that a recall count is not a reliability verdict.
- Re-run ideas.mjs on build day. ideas.json is close to the fetched_at age limit, and the model/stats data_as_of is past the warning age. Newer recalls may exist: refresh the model names if so, and set recall_max_id from the new run.
- news-recalls has no facts, so the recall copy has no counts and no build years. VOLVO EX30 and RAM models were left out because their names contain digits the lint would read as unsourced numbers. The copy says 'לאחרונה', not 'השבוע', because the posts go out the following week. It says 'לא כל רכב מהדגם', never 'כל רכבי'.
- recall-state is 'stalled' (the ministry list may lag), so the second dealer demo row says 'לא נמצא', not 'אין ריקול'. Confirm this wording, or change that cell to 'ריקול פתוח' as on the first row.
- Check before approval that the PRO עסקי bulk table is live in Play production and shows test validity and an open recall per car. Also check that in-app alerts on a new recall, test and ownership change are live (the car-file message). App screens must be fresh recordings of the version at full production, on synthetic data with demo plates only. No needs_live is needed if that version is already at full rollout.
- Idea product-1.38 lists features that are not in the RUNBOOK's promotable screen list (for example the 'שיתוף' word and the next service by exact model). None of them are used; confirm with the release thread.
- If an ElevenLabs key is present and voiceover is generated, add 'הקריינות נוצרה ב-AI.' to the reel's Facebook and Instagram captions, and turn on AI-generated content in the TikTok prompt. With no key, the reel runs on captions only.
- Autopilot zone B: check the 'Current:' line in the rules file. Rule B4 ('check your car' after new recalls) matches this week's pick anyway. Log it in the autopilot log; in OBSERVE mode, change nothing beyond the kit.
- Skipped this week: fuel (VERIFY caution; the price is derived from Delek's list) and the Fiat settlement (its changed fields may be a data fix, not news).

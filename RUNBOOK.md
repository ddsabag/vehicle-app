# מפעל ערכות התוכן השבועיות – לוחית (RUNBOOK)

The exact Thursday-morning procedure for a fresh Claude session that builds the weekly content kit for **לוחית** (luchit.app).
Read this whole file before starting. Everything here runs in the cloud container; nothing is installed on Dudu's PC.

## כללי ברזל (read twice)
- **Golden rule:** dealers, trade-in companies, importers and fleet managers are **customers**, never villains. Never write that לוחית exposes fraud or identifies dealers. The enemy is uncertainty, missing info and surprises (manufacturer recalls, expired tests). The kits speak to the buyer only (section "קהל ומסרים"); the line is `rotation.json` `audience_rule.line`.
- **Publishing goes only through the autopost bot** (Dudu 2026-10-22: "תכין את התכנים ותעלה אותם לבד; מה שלא ניתן אוטומטית: פרומפט שבועי"). Facebook and Instagram: the kit's `autopost.json` is queued with `enqueue.mjs` (step 9c), which pushes only to the branch `social-queue`, and the workflow "Social publish" posts it at the set times. Claude never posts from the container and never pushes anywhere else. Stories go through the bot too (Dudu 2026-10-22: "כולל סטורי כולל הכל"), so they are designed without stickers. TikTok is not automatic (its API posts privately only without TikTok's audit): the kit has **one** browser-extension prompt, for TikTok only, that schedules to the end (clicks Schedule, never Post), and Dudu's Cowork scheduled task on his PC runs the newest kit's TikTok prompt every Friday 11:30 Israel (since 2.11.2026), so a kit carries no TikTok reminder (Dudu 3.11: the reminder is no longer relevant) and its TikTok time must fall after that Friday (the usual reel Thursday of the next week). A reel that needs a version not yet in Google Play production: the kit says so and the reply tells Dudu to run the prompt by hand once the version is live. Every upload sends Dudu one Telegram line ("עלה סטורי", "עלתה קרוסלה"...) with its links.
- No stickers (the API has none): a story that asks something says "ענו לנו בהודעה לסטורי", a story that points to the site says "בודקים ב-luchit.app" on the image. No TikTok analytics. `short-1-oketz` is never used or mentioned.
- Every number in the copy comes from `facts.json`, which points into the repo data. No invented numbers, no rounding beyond what the fact says, estimates keep "(הערכה)".
- PRO features are labelled: bulk check = "PRO עסקי", never "חינם".
- Only the demo plate `76-543-21` (`7654321`). `12-345-67` / `1234567` belong to a real car (product, 5.11.2026): never use them, even though the lint config still allows them. Never a real plate, not even in a screen recording.
- Forbidden words, dealer-negative phrases, "זכאי" in recall claims and winner/recommendation wording are in `lint-config.json`. **`lint.mjs` must pass. Never deliver a kit that fails, and never edit `lint-config.json` to make a kit pass** (the lists change only when Dudu or the red-team asks; when they do, add a case to `fixtures/selftest-cases.json` and run `--selftest`).

## GROWTH_MARKETING_AUTOPILOT (Dudu, 2026-10-22: guidelines for every weekly kit)
Dudu's standing content rules, applied inside the iron rules above (golden rule, facts-only numbers, no feature before it is live in Google Play production, lint):
- **You are the strategist (zero spoon-feeding).** Before picking content in step 3, choose the week's single strongest pain point of the private used-car buyer yourself, from `audience_rule.buyer_pains` (section "קהל ומסרים"), the market data and `ideas.json` (the newest magazine article, recall rates, what people search). Write it at the top of the kit markdown as one focused paragraph: the pain point and why it works psychologically on the Israeli audience. Every item of the week (reel, carousel, stories, Sunday buyer post) is built around it; the rotation pillars decide the angle of each item, not a different topic. Do not pick the pain point of the last kit (`history[-1].pain` in `rotation.json`) again unless this week's data about it is new.
- **No generic content and no clichés.** Every post solves a real problem or reveals a surprising fact the viewer did not know, backed by a fact in `facts.json`.
- **Hook-Story-Offer** in every item: the hook (first 3 seconds / cover / first story screen) presses hard on the chosen pain point; the middle gives a fact or a scenario showing the risk of buying blind; the end always sends the viewer to one exact action: enter a licence plate in לוחית (luchit.app / the app).
- Reel up to 30 seconds with an exact visual description of each moment; carousel 4-5 slides of data-based value with caption and hashtags; stories 3 screens (the first sparks interest as a question, the last sends to the app). Stories go through the bot without stickers, so the "poll" is a question answered by DM.
- Limits that stay: the risk is uncertainty, missing information and surprises (recalls, expired tests), never a dealer, importer or seller; "reveal" means a surprising fact, never "exposing" anyone (the lint blocks חשיפה); no unverified claims such as "the leading app".
- **Main message from the first kit after 1.38 is live in Google Play production** (Dudu 24.10, strategy thread): "התיק של הרכב, מהבדיקה ועד המכירה" replaces "התראות אחרי הקנייה". Reason: Ototo (iOS, free with ads) already sends test/insurance/fee reminders, so alerts alone are not unique. What stays ours: recall + ownership-change + test alerts on the same car, free, no ads, plus buying help before the purchase. Never use it before 1.38 is live in production. Met on 26.10 (1.38.2 at 100% of production, product thread), so kit 3 (29.10) is the first kit with this message; its pillars still follow rotation.json. Never name or attack a competitor in copy.
  Car-file door (Dudu approved for 1.38, 25.10): a home line "יש לכם כבר רכב? פתחו לו תיק" for returning users, "זה הרכב שלי" in the car page ⋯ menu, the file row above ownership history, and "שווי היום (הערכה)" in the file. Once 1.38 is at 100% in production (reached 26.10 with 1.38.2), posts with this message point at that door; before that, lead with buyer features. Check the current build before each kit.

- **Feature spotlight, one per kit** (Dudu 2.11.2026: "נאמר כל פעם להתרכז בפיצ'ר מסויים"). The week's stories or reel hook on one concrete question that a single live feature answers ("עד מתי הטסט?", "יש ריקול פתוח?", "כמה ידיים?", "מותר לגרור?", "יש הסדר פשרה לדגם?"), then show that feature with the demo plate. Record it in rotation.json history as `feature` and do not repeat it within 4 kits. Allowed only for features live in Play production, and always from the buyer, seller or owner side of *their own* or a candidate car. Never use a feature to check a stranger's car or person: the disability parking tag (תג נכה) is personal data that the app shows on screen only and never shares, so it is never a hook like "a car parked in a disabled spot, does it have a tag?". Its one allowed angle is the buyer's: "ייתכן שלא ניתן להעביר בעלות לפני שהבעלים מסיר את התג", in a step list about what to settle before paying.

## קהל ומסרים (audience, from kit 5; Dudu 5.11.2026 20:02 UTC + 7.11.2026 12:58 UTC)
Full research and messaging page: https://claude.ai/artifact/EUatsimgLr349SippYU3HV (7.11.2026). The rules that bind every kit:
- **Who:** the private used-car buyer, between the ad (Yad2, Facebook groups) and the meeting with the seller. People who buy a car once every few years, weigh 2-3 models, ask a mechanic or "someone who understands", close within about a month.
- **Never again in a kit** (Dudu 7.11: kit 4 still had dealer items, "בניגוד לסיכום שלנו... קח בחשבון מפעם הבאה"): no item for dealers, lots (מגרש), fleets, trade-in, sellers or owners. Not as the reel, not as the carousel, not as the Sunday post. Dealers come back only if Dudu decides so after 21.11, on a separate track. A decision about the buyer never implies "the dealer post stays".
- **Lead pain:** one per kit, from `rotation.json` `audience_rule.buyer_pains` in order (seller_q, story_data, km_test, price_range, home_checks, ev_battery, compare_two, before_pay), no repeat until all are used unless the data is new. Each has the live feature that answers it and the way to say it. Write the week's paragraph from that pain.
- **Discoveries, not leads:** buyers rarely ask about an open recall, the test date, a settlement or an off-road car. That is where לוחית sees what they do not think to check, so these go inside an item as "ועוד דבר שכדאי לבדוק", never as the pain that opens the kit (Dudu's requested topics, like the kit 5 settlement reel, are framed this way).
- **Promise:** coming to the meeting prepared, with the same picture from the Ministry of Transport databases and the right questions, without surprises. Line: `audience_rule.line` (a decision on "בודקים לפני שנפגשים" is pending: use what the file says).
- **Honest limits build trust:** לוחית does not see accidents, insurance claims, liens or theft. Say so when the pain is there, and point to the official checks from home that the buy tab links in step 1.
- **Do not say:** "היסטוריה מלאה", "בדיקת תאונות", "ק\"מ אמיתי", "זיוף", "איתור בעלים", "רשמי/רשמית" about לוחית itself, "פראייר", "רמאים", "שלא יעבדו עליכם"; "חינם" is proof, never the hook (every competitor says it). Say: "מתוך המאגרים הפתוחים של משרד התחבורה", "לפני שנפגשים", "מה לשאול את המוכר", "הק\"מ שנרשם בטסט האחרון", "בתוך הטווח המשוער (הערכה)", "ייתכן".
- **Built for the groups:** Facebook groups bring almost all checks and installs, our own pages almost none. Every item must also read well as a group post: one pain, one plate action, no inside jokes. A new group-post text still goes to Dudu for approval before it enters the group prompt.
- **Measure by pain:** every item's go/ topic `c=` is its pain id (seller_q, story_data...), so camp-topics ranks pains by checks and installs.
- **The car file** ("זה הרכב שלי", alerts in the Android app) is only the closing line of a buyer item.

## Autopilot zone B (Dudu 25.10 21:28 UTC, rules: /mnt/project-files/vehicle-app/strategy/autopilot-rules.md, read before any automatic action)
- Mode: OBSERVE for the kits of 29.10 and 5.11; ON from the kit of 12.11 only after strategy confirms on 11.11. The current mode is the "Current:" line in the rules file. "עצור אוטומציה" from Dudu anywhere = observe.
- Input: camp-data (ideas.mjs --camp, idea `camp-topics`; 28-day columns for the 4-week thresholds). No snapshot = log "אין נתונים".
- Rules: (B1) topic order: a topic ranks only with >= 30 visits in 4 weeks; (B2) slot move only if >= 30% better with >= 100 visits per slot; (B3) swap a queued post for another item of the same kit when its topic is at the bottom; (B4) a "בדקו את הרכב שלכם" item after a big new recall (news-recalls).
- OBSERVE: while building each kit, write what the autopilot WOULD do as rows at the top of /mnt/project-files/vehicle-app/strategy/autopilot-log.md (schema there; under the minimum sample write "אין מספיק נתונים") and change nothing beyond the normal kit. Fill the last column "he" with one short plain-Hebrew line for the /live drawer (neutral, no numbers). Then optionally: `node /mnt/project-files/vehicle-app/measurement/autopilot-mirror.mjs $REPO --push`.
- ON limits: at most 1 automatic change per surface per week and 2 per week across all zones; none from 2 days before to 2 days after an app release; auto-revert when the guardrail drops more than 15%; one silent ✅ per change. Never: deletions, a feature not at 100% in production, villain wording, numbers from camp-data in copy.

## Paths
```
FACTORY=/mnt/project-files/vehicle-app/content-factory
WORK=<your scratchpad>/factory-$(date +%F)          # throwaway: repo clone, ideas.json, Search Console data
REPO=$WORK/vehicle-app
D=$(TZ=Asia/Jerusalem date +%F)                     # the Thursday the kit is built
KIT=/mnt/project-files/vehicle-app/marketing-kit-$D
```
Do not touch other git checkouts in the scratchpad (other sessions may be working there). Use your own `$WORK`.

## Files in the factory
| file | what |
|---|---|
| `ideas.mjs` | prints `ideas.json`: content ideas with exact numbers and their sources, from the repo (and optional Search Console JSON) |
| `lint.mjs` + `lint-config.json` | compliance lint of a kit folder; `--selftest` runs the fixtures |
| `lib/hebrew.mjs`, `lib/facts.mjs` | Hebrew normalisation/matching; fact locators shared by ideas and lint |
| `render/build.mjs` + `render/assets/` | kit.json → `src/kit.html` → PNGs (carousel 1080×1350, story 1080×1920, dealer post 1080×1350) in kit 1's look |
| `render/sample/` | a rendered sample (all templates) with a verified `facts.json`: copy its `kit.json` as a starting point |
| `templates/kit-template.md` | skeleton of `ערכת-תוכן-שבועית-N.md` (kit 2's format, autopost section with stories and the TikTok reminder, one TikTok prompt) |
| `enqueue.mjs` | checks a kit's `autopost.json` (lint, the bot's own validation, times, caption lines, image/video shapes) and queues it on `social-queue` for the bot; `--dry`, `--selftest` |
| `rotation.json` | content-pillar rotation and history of delivered kits |
| `fixtures/` | lint selftest fixtures (good kit, bad kit, mini repo, text cases) |

---

## The procedure (Thursday morning)

Post a status checklist in the thread first (update_status), then work through these steps.

### 1. Repo: clone or pull (read only)
```bash
mkdir -p $WORK
git clone -q --depth 200 https://github.com/ddsabag/vehicle-app $REPO 2>/dev/null || git -C $REPO pull -q --ff-only
git -C $REPO log -1 --format='%h %cI %s'
node $FACTORY/lint.mjs --selftest          # must print "selftest: N/N passed"
```
`--depth 200` gives enough history for "what changed" ideas (fuel price vs last month, models whose recall rate changed). A `--depth 1` clone works but those ideas then say "no history". Never commit or push in this clone.
Run `ideas.mjs` and `lint.mjs` on **the same clone**: a fact with `source_rev` (a past value) is re-read with `git show`, and on a clone that lacks that revision the lint fails closed ("not available in the checkout (shallow clone?)": run `git -C $REPO fetch -q --deepen 200`). The lint also fails when the checkout HEAD is more than 3 days old (pull first) or older than the `repo_commit` written in `facts.json`.

Optional, Search Console (private: topics only, never numbers in copy):
```bash
git -C $REPO fetch -q --depth 1 origin seo-data && git -C $REPO show FETCH_HEAD:seo-data.enc.json > $WORK/seo-data.enc.json
node /mnt/project-files/vehicle-app/seo-key/decrypt.mjs $WORK/seo-data.enc.json > $WORK/seo-data.json
```
Keep `seo-data.json` in `$WORK` only; never copy it into the kit.

Recall news (public data, branch catalog-data) and, once the measurement thread publishes it, the weekly campaign snapshot (private: app opens per topic and network, `link_open` camp/via; topics only, never numbers in copy):
```bash
git clone -q --depth 1 -b catalog-data https://github.com/ddsabag/vehicle-app $WORK/catalog
# campaign snapshot (measurement, updated Wednesdays 04:40 UTC; branch camp-data, until it is on main the sample is on camp-probe-out)
git -C $REPO fetch -q --depth 1 origin camp-data && git -C $REPO show FETCH_HEAD:camp-data.enc.json > $WORK/camp-data.enc.json \
  && node /mnt/project-files/vehicle-app/seo-key/decrypt.mjs $WORK/camp-data.enc.json > $WORK/camp.json   # keep in $WORK, private
```

### 2. Ideas
```bash
node $FACTORY/ideas.mjs $REPO --catalog $WORK/catalog [--gsc $WORK/seo-data.json] [--camp $WORK/camp.json] --out $WORK/ideas.json > /dev/null
node -e 'const j=require(process.argv[1]);for(const i of j.ideas)console.log(i.id,"|",i.pillar_hint,"|",i.title,"| facts:",i.facts.length,i.history_note||"");console.log("dropped:",j.dropped_facts.length,"warnings:",j.warnings)' $WORK/ideas.json
```
Each idea has `facts` (already verified against the source), `angle`, `cautions` and sometimes `change` / `recall_rate_changes`. Read every `caution` and every top-level `warning` (e.g. a fuel price that changed within the month; diesel, which is Delek's full-service list price and not a regulated price; a `fuel.json` whose source is not gov.il, in which case the 95 price is derived from a company list and says VERIFY): if a caution says "verify", do not use that number. Facts that failed verification are in `dropped_facts` and must not be used.

Idea kinds: latest magazine articles (`magazine/posts.json`), recall rates per model (`model/stats.json`, models with ≥3,000 active cars as in the magazine; individual recall campaigns are not in the repo, the app reads them live from data.gov.il), fuel price (`fuel.json` + git history), new-car deliveries and top models (`market.json`), fleet size (`model/stats.json`), Search Console top queries (private), news of the week (`news-settlements-<date>`: open settlements new or changed in `settlements.json` vs its version 7+ days ago, benefit amounts as facts; a "changed" item may be a data fix, read `changed_fields` before calling it news. `news-recalls-<from>-<to>`: recall campaigns added to the catalogue after the last kit's `recall_max_id`, no facts, so no numbers in copy; angle "check your car", the importer fixes, never a villain), what worked last week (`camp-topics`, private, from `--camp`: rank topics by app opens, repeat what opened the app, never a number in copy), and what changed in the app (`product-<version>`: the Play release notes of every version released in the last 14 days, `android/release-notes.txt` history; feature lines, no facts). When a version with a user-visible feature was released since the last kit, give it one slot (a story or the reel) and say in the kit which version it needs; never present a feature before that version is live in Play.

### 3. Pick the week's content (rotation)
Read `$FACTORY/rotation.json`:
- kit number `N = last_kit + 1`
- reel pillar = `order[cursor]`, carousel pillar = `order[(cursor+1) % len(order)]` (3 pillars since kit 5)
- stories (optional) = Community, unless the reel already is Community (then Trust & Safety)
- Sunday post = a BUYER post (since kit 5), angle = `dealer_angles[dealer_angle_cursor]` (the key names stay for the Kit draft bot; the angles are buyer angles). In kit.json it is still the `dealer` object and the file `dealer-post.png` (renderer and lint names), with `"audience": "לפני שקונים רכב יד 2"` and no `pro`. If the Kit draft bot's slots call it "B2B utility", ignore that label.
- **Dudu's requested topics go first**: if `rotation.json` has a `requested` item whose `target_kit` is N (or an older one still open), build it in the slot it names, follow its `cautions`, use its `feature` as the week's feature spotlight, then mark it done (`"done_kit": N`) instead of deleting it. Re-check `verified` against the current Play production version before using it.

Pick **1 reel + 1 carousel + 1 Sunday buyer post** (+ 3 stories when there is a natural question for the buyer) from `ideas.json` whose `pillar_hint` fits; prefer the newest data (latest magazine article, a change since last month). Pillars:
- **Trust & Safety**: what the plate shows before the meeting, open recall and test as discoveries, "בודקים לפני שנפגשים", what to settle before paying.
- **Efficiency/compare**: two candidate cars side by side by plate (no winner, no "better"), the asking price against the estimated range (הערכה), a wasted trip saved.
- **Community**: buyers' questions answered by a reply to the story ("מה הדבר הראשון שאתם שואלים מוכר?"), answering what buyers search.

Avoid repeating last week's titles (see `history`).

Coordination with the marketing plan (2026-10-19, "one finding a month, one story a week"): this kit runs Thursday 10:22 Israel, after the magazine's Thursday data article (magazine.yml, 05:30 UTC). When `magazine/posts.json` has an article dated today, it is the week's story: build the reel or the carousel on its facts (whichever pillar fits). In the first kit after the 6th of the month, the monthly article (the month's finding) gets the other of the two. Every link in captions and prompts is a short source link (live since 2026-10-19): `luchit.app/go/<code>?c=<topic>` with code tiktok, ig, fb, li (LinkedIn), yt, wa; `<topic>` = the topic slug in letters and _ only (no digits: the kit lint checks every number; anything else is dropped). The link answers a 302 to the home page with utm_source/medium/campaign, so the /live "מקורות" drawer counts it. Bio links use the bare code (`luchit.app/go/tiktok`).

Schedule (the following Sunday–Thursday, as in kit 1, Israel time):
```bash
for k in 3 4 5 7; do TZ=Asia/Jerusalem date -d "$D +$k day" '+%a %d.%m.%Y'; done   # Sun, Mon, Tue, Thu
```
Sun 08:30 buyer post · Mon 20:30 carousel · Tue 08:15 stories · Thu 20:30 reel.

### 4. Copy + facts.json
Write the copy in Hebrew (short sentences, no em dashes, data-first, calm, never fear; golden rule). Then `$KIT/facts.json`:
```json
{"kit": N, "repo_commit": "<sha>", "facts": [ ...copied verbatim from ideas.json... ],
 "nonclaims": [{"text": "פג בעוד 12 יום", "reason": "demo row on the post table (demo plate, marked 'נתונים לדוגמה')"}]}
```
- Copy facts **verbatim** from `ideas.json` (they carry `source_path`, `json_pointer`/`regex`/`derive`, `fetched_at`, `data_as_of`, `repo_commit`). Every number that appears in any caption, slide, reel text, `kit.json`, `src/` file or generator string must equal the `value` of a fact. Write numbers exactly as the fact (118, 24,162, 7.77); percent facts are written with `%`; a fact whose `value` is rounded from the source needs "כ-" before the number in the copy ("כ-17%").
- The copy around a number must say what the fact says: same unit (%/ש"ח), same model (a model named near the number, or in another cell of the same table row, must appear in the fact's text), same topic, same direction (ירידה/עלייה), and the wording the binding in `lint-config.json` (`rules.facts.bindings`) requires. Recall rates: "MG3: 118 מכל 1,000 רכבים פעילים עם ריקול פתוח" (never "118 ריקולים"). Deliveries: "נמסרו / מסירות ... רכבים פרטיים חדשים". Diesel: only as "מחירון ... בשירות מלא", never "מחיר הסולר". A big number alone on a slide is read with the label in the block right before/after it, so the label must carry this wording.
- A fact from a past git revision (`source_rev`) may only appear in a sentence that says when ("בתחילת אוקטובר", "לעומת", "אשתקד"), never with "עכשיו"/"היום".
- `fetched_at` must be at most 10 days old (and not in the future): re-run `ideas.mjs` instead of reusing an old `facts.json`.
- A fact you build yourself must follow the same format (see "Fact format" below) and will be re-verified by the lint.
- `nonclaims` only for numbers that are not data claims (demo rows, "4 צעדים" style structure, "אחרי 4 שבועות"). Each needs a real `reason` (8+ characters) and quotes the exact text around the number; a nonclaim that looks like a data claim (%, ש"ח, רכבים, ריקול, ירידה/עלייה...) is rejected. A nonclaim only exempts the number: every word and plate rule still runs on it. Keep it short and honest.
- Facts with `"private": true` (Search Console) can never justify a number in copy.
- Estimates (anything "שווי", value, forecast): set `"estimate": true` on the fact and write "(הערכה)" right after the number.
- Phrasing that keeps you inside the rules: "לפי מאגרי משרד התחבורה", "ריקולים רשומים", "בדרך כלל ללא עלות אצל היבואן", "ייתכן ש...", "השוואה בלי דירוג", "רכב לדוגמה". Do not write: מציאה, מומלץ/ממליצים/המלצה, הכי טוב, מנצח/ניצחון, עדיף, זכאים (near a recall), חשיפה/חושפת (allowed only under the exact "## מדידה" heading, as the impressions metric), anything about dealers hiding/lying/cheating. Allowed: "אין מנצח" (the no-winner framing), "לא מומלץ"/"לא משתלם" style negations in neutral copy, refund "זכאים" that is not about a recall.

### 5. Static posts
Start from `$FACTORY/render/sample/kit.json` (it shows every template). Templates:
- carousel: `cover`, `stat` (big number + label), `step` (badge, decorative step number, optional demo `plate`), `compare` (two columns, no winner), `cta`
- stories: `question` (asks for a reply to the story), `stat`, `answer` (optional demo plate, link hint)
- dealer (the Sunday BUYER post since kit 5): `audience` (the small label top right, e.g. "לפני שקונים רכב יד 2"; without it the renderer prints "למגרשים ולציים", which must never appear), `kicker`, `title`, `body`, optional table `head` + `rows` (a plate cell only `{"plate": "76-543-21"}`), `note`, `cta`; no `pro`
Markup: `*yellow*`, `**bold**`, `\n`. `source` adds the small "מקור:" line (the carousel's `source` goes on slide 1).
```bash
mkdir -p $KIT && cp $WORK/kit.json $KIT/kit.json
node $FACTORY/render/build.mjs $KIT/kit.json $KIT
```
It writes `$KIT/src/kit.html` (+ fonts, logo, `google-play-badge.svg`) and `carousel-01.png…`, `story-01.png…`, `dealer-post.png`. **Every post carries the Google Play badge with "זמינה להורדה"** (Dudu 2026-10-22): the renderer puts it at the bottom centre of each slide (also on `foot: false` slides), above the counter on stories and bottom left on the dealer post, and warns when copy crowds it (it needs a quarter of its height clear). The badge is the official English "GET IT ON Google Play" artwork, unchanged (the Hebrew one in the npm package draws its colon on the wrong side); rules in `render/assets/google-play-badge.NOTICE.txt`. The lint fails a post without it. The lint reads `kit.json`, `src/kit.html` and the PNG names: a `step` that is not a 1-2 digit counter, a `bg` with a `data:` URI and anything marked `data-nonum` that is not a plain counter ("3", "2/5") are checked as copy. It refuses non-demo plates and warns when text overflows a post: shorten the copy and re-run. **Look at every PNG** (Read tool) before going on.

### 6. Reel (HyperFrames)
Pipeline from the team notes (vehicle-app-video-hyperframes):
1. Start from the closest existing source in `/mnt/project-files/vehicle-app/marketing-video/src-shorts/` (e.g. `deal/` for a two-person scene, `ugc/` for word-by-word captions, `b2b/` for a table) and copy it to `$KIT/src/reel/` (copy `vendor/` too; the lint skips `vendor/`). Never use `short-1-oketz`.
2. Edit the generator (`gen.py` → `index.html`): on-screen text must use only numbers from `facts.json` and only demo plates. The lint reads string literals in `.py/.js/.mjs/.ts` files: a literal holding HTML is read like an HTML page (visible text checked for numbers and words, CSS sizes and colours ignored, CSS `content:`, `attr()`, script strings and `data:` URIs checked for words), any other Hebrew literal is checked as copy. App screen recordings: `tools/app-record.mjs` with mocked data and demo plate 76-543-21 (12-345-67 is a real car since 5.11.2026: change the recorder before using it) (run from /opt/node-tools with the repo clone).
3. Voiceover **only if** an ElevenLabs key is present: `[ -n "$ELEVENLABS_API_KEY" ] && echo yes` (never print the key). Then `python3 vo.py` (model eleven_v3, `language_code: he`, UA `curl/8`, `mp3_44100_128`; voices used so far: sarah, george, Liam, Brian). **No key → captions-only reel**: kinetic on-screen text carries the message; no VO lines; music from `sfx.py`/`music.py` (original synthesized, no licence issue).
4. Render:
```bash
cd $KIT/src/reel
CH=$(ls -d /opt/pw-browsers/chromium-*/chrome-linux/chrome | head -1)
HYPERFRAMES_BROWSER_PATH=$CH PUPPETEER_EXECUTABLE_PATH=$CH npx -y hyperframes render . -o $KIT/reel-<slug>.mp4
ffmpeg -v error -y -ss 1 -i $KIT/reel-<slug>.mp4 -frames:v 1 $KIT/reel-cover.jpg
ffprobe -v error -show_entries format=duration -of csv=p=0 $KIT/reel-<slug>.mp4
```
Gotchas: never `dir="rtl"` on `<html>` (blank render), put it on `#root`; vendor gsap and Heebo (headless Chrome cannot reach CDNs); `tl.call` does not fire on seek-based render (swap states with `tl.set`); a later `tl.fromTo` on an element that already animates holds its from-values from t=0 (use `tl.to`); a pre-padded video needs `data-media-start` equal to its clip start.
5. **End card with the Google Play badge** (Dudu 2026-10-22, the lint fails a reel without it): copy `$FACTORY/render/assets/google-play-badge.svg` unchanged to `$KIT/src/reel/assets/`, and put "זמינה להורדה" over `<img src="assets/google-play-badge.svg">` (about 110px tall, 28px clear around it) on the end card, under the luchit.app pill. Keep the end card on screen at least 3 seconds after the badge appears (kit 2: `TOT = last VO end + 2.2`, same tail in `audio.py`). Kit 2's `src/reel/gen.py` (`.gp`, `#s6g`) is the reference. HyperFrames leaves `src/reel/.hyperframes/` (render state): the lint skips it, and it is never copied to the PC.
6. App screens: show only the UI that is live in Play production. **1.38.3 reached 100% of Play production on 27.10** (release thread: versionCode 155, verified 04:05 UTC; 1.38.2 had reached 100% on 26.10), so from kit 3 (Thu 29.10) app screens show the 1.38.3 UI only, never an older one. Promotable: the bottom bar (חיפוש / הרכבים שלי / התראות), the car file, compare, the expiry date read from a document, the 1.38.2 items (settings in sections with the FAQ on its own page, undo after deleting saved cars or history, Back from "הרכבים שלי" returns to the open car) and the 1.38.3 items: "+" in "הרכבים שלי" saves the next car checked (with ביטול), "פתחו לו תיק" on home opens the car file right after the check, the car's nickname on the car page, dark mode from the first frame, the bottom bar steps aside for the keyboard, the "קנייה" tab in buying order, a car not yet in the register shows its maker and first-registration date, "השוואה" beside the car name, and a shorter model name under the recent plates (list: capsules/product.md "1.38.3 screens for marketing kit 3"; release notes: android/release-notes.txt on main). Record screens fresh from main (`APP_VERSION` "1.38.3" in index.html; after a later merge, only once that version is at 100%, otherwise from the release branch `app-<version>` of the version at 100%) with `marketing-video/tools/app-record*.mjs` (first fix the 1.38 notes at the top of each script), on synthetic data and demo plates only; never reuse screens recorded before 1.38.3. The website on wide screens changed in the same release (settings in the top bar, two columns on home, worded share/save, one footer): any desktop screenshot of luchit.app is taken fresh; phone and store screenshots of 1.38.3 are valid. A kit may also skip app screens (data, motion graphics and the plate CTA). For later releases the gate stays: new UI only after the Telegram line "הגרסה הגיעה ל-100% מהמשתמשים ב-Production" (prod:full); "Google אישרה... הפצה הדרגתית" (prod:live, 20%) does not count. After a release that changes the UI, re-record the app screens (`marketing-video/tools/app-record*.mjs` on the new build) before the next kit uses them (Dudu 2026-10-22: new UI means new store screenshots and new kit screens).
7. Watch a few frames (`ffmpeg -ss <t> -frames:v 1 frame.png`, then Read) before going on. Include a frame of the end card with the badge. If HyperFrames cannot run (network/npm failure), deliver the static posts and say in the summary that the reel is missing; never substitute an old video.

### 7. The kit markdown
Copy `templates/kit-template.md` to `$KIT/ערכת-תוכן-שבועית-N.md` and fill every `{{…}}` (none may remain: `grep -n '{{' $KIT/*.md` must print nothing). Keep kit 2's order (`marketing-kit-2026-10-22` is the reference): header with golden rule and "how it goes out", schedule table with golden hours, a "how it goes out" column and the "these are assumptions" line, go links, 1 reel (timed table, caption, hashtags, HyperFrames command), 2 carousel, 3 stories, 4 Sunday buyer post (Instagram/Facebook caption; LinkedIn was dropped on 2026-10-22, no LinkedIn caption or step), the autopost section, **one** extension prompt (TikTok only), pre-approval checklist, measurement. Stories have no phone steps and no stickers: they go through the bot.
Every caption carries the line "לוחית זמינה להורדה ב-Google Play" (enqueue.mjs refuses a caption without it). Instagram captions say "בלינק בביו" (links in a caption are not clickable there; since 26.10 the TikTok, Facebook, Instagram and YouTube bios also carry the Google Play link, Dudu marked it done on /live); the Facebook version puts `luchit.app/go/fb?c=<topic>` in the post instead (enqueue.mjs refuses "בביו" on Facebook). Captions never say the voice or visuals were made with AI (Dudu 5.11.2026: "אל תכתוב שהקריינות נוצרה ב AI"); only the TikTok prompt turns on TikTok's own "AI-generated content" setting when the voice is AI.
The single extension prompt is for TikTok only and schedules to the end: its first line says so ("לתזמן בטיקטוק עד הסוף ..."), Windows path `C:\Users\Dudu Sabag\Desktop\לוחית\1 ערכות תוכן\marketing-kit-<D>\`, TikTok Studio upload URL, the caption verbatim, settings (AI-generated content when the voice is AI, Everyone, comments on), Schedule with date and time, "לחץ על הכפתור Schedule. אסור ללחוץ על Post", a check that the post is listed as scheduled with a screenshot, and "אם משהו לא תואם ... עצור ושאל אותי". Catch-up rule (Dudu 2.11: the Cowork task may run late, when the PC wakes): the prompt says "אם מועד התזמון כבר עבר או שנותרו פחות מ-30 דקות אליו, תזמן ליום המחרת באותה שעה ורשום זאת בדוח". When the reel shows app screens of a new version, the prompt's intro says to run it only after the Telegram message that the version is live (the bot waits for it on Facebook/Instagram by itself, step 9c). Stories have no phone steps: they go through the bot (never write "לחצו על שתף/פרסם" anywhere: the lint refuses a publish click outside the prompt).

### 8. Lint (gate)
```bash
node $FACTORY/lint.mjs $KIT --repo $REPO ; echo "exit $?"
```
Must print `PASS` and exit 0. On FAIL: fix the copy/facts (not the config), re-render if slide text changed, run again. Typical fixes: a number without a fact → add the fact from ideas.json or remove the number; a demo row number → `nonclaims` with a reason; a post mentioning bulk check → that is a business feature and does not belong in a buyer kit: remove it; more than one prompt → merge into one.

### 9. Rotation
Append to `$FACTORY/rotation.json` → `history` (kit, date, folder, `recall_max_id` = `ideas.json` top-level `recall_max_id` (the baseline for next week's recall news), `pain` = the week's pain point in a few words, `pain_id` from `audience_rule.buyer_pains`, reel/carousel/stories/dealer (the Sunday buyer post) with pillar and title), set `last_kit = N`, `cursor = (cursor+1) % len(order)`, `dealer_angle_cursor = (dealer_angle_cursor+1) % len(dealer_angles)`.

### 9b. Put the files on Dudu's PC
The TikTok prompt uploads the reel from `C:\Users\Dudu Sabag\Desktop\לוחית\1 ערכות תוכן\marketing-kit-<D>\`, so the files must be there before Dudu needs them (Facebook and Instagram media travel through the queue, step 9c). Kit 1 was copied through the device connection to that folder (device "DESKTOP-DQITN3V (לוחית)"). If this session has the device folder tools (`mcp__remote-devices__…`, deferred ones included), create `marketing-kit-<D>` there and copy the files the prompt names (`*.png`, `reel-*.mp4`, `reel-cover.jpg`) plus the kit markdown, not `src/`, `facts.json` or `kit.json`; then list the folder and check that every file the prompt names is there. If the tools are missing or the PC is off, do not wait and do not ask for access: the reply says the folder still has to be downloaded to that path.

### 9c. Queue Facebook + Instagram for the autopost bot
Write `$KIT/autopost.json`, one item per post, times in Israel time (enqueue converts them to UTC; Israel's clock change is handled):
```json
{"tz": "Asia/Jerusalem", "items": [
 {"id": "dealer", "type": "image", "at": "2026-10-25 08:30", "targets": ["facebook", "instagram"], "files": ["dealer-post.png"],
  "caption": "<Instagram caption ... בלינק בביו\nלוחית זמינה להורדה ב-Google Play\n#...>", "caption_facebook": "<same with luchit.app/go/fb?c=seller_q>"},
 {"id": "carousel", "type": "carousel", "at": "...", "targets": [...], "files": ["carousel-01.png", "...", "carousel-05.png"], "caption": "...", "caption_facebook": "..."},
 {"id": "reel", "type": "reel", "at": "...", "targets": [...], "files": ["reel-xxx.mp4"], "cover": "reel-cover.jpg", "needs_live": "<version, only when the reel shows new app screens>", "caption": "...", "caption_facebook": "..."},
 {"id": "story-1", "type": "story", "at": "... 08:15", "targets": ["facebook", "instagram"], "files": ["story-01.png"]}],
 "reminders": []}
```
`reminders` are Telegram lines to Dudu for what only a person can do (none for TikTok since 3.11: the Cowork task runs it); with `needs_live` the bot waits for that version in Google Play, and stops trying at `until`.
Types: `image` (one 4:5 to 1.91:1 image), `carousel` (2-10 images of one shape), `reel` (mp4 9:16, 3-90 s, cover 9:16), `story` (one 9:16 image, no caption, no stickers: the API has none). Stories are always queued as `story` items for Facebook and Instagram; three with the same time post in the order listed. `needs_live`: the bot posts the item only once Google Play shows that version published in production, and reports it missed if that has not happened 6 hours after its time. Ids are lower-case letters, digits and `-`; a moved item that the bot already recorded needs a new id.
```bash
node $FACTORY/enqueue.mjs $KIT --repo $REPO --dry            # every check, a local commit, no push
COMMIT_TRAILERS="<the session's Co-Authored-By and Claude-Session lines>" node $FACTORY/enqueue.mjs $KIT --repo $REPO
```
It refuses unless `lint.mjs` passes, every item passes the bot's own validation (`$REPO/.github/scripts/social-publish.mjs`: when it is missing the bot is not on main yet, so say so in the reply and do not queue), every time is at least 15 minutes ahead, the captions carry the Google Play line, Facebook captions have no "בביו", and the media shapes fit. It copies only `autopost.json` (times in UTC) and the listed media to `social-queue:kits/<D>/` (never `facts.json`, the markdown or `src/`), adds a JPEG copy `<name>.ig.jpg` of every PNG Instagram gets (Instagram fetches the images from the public queue and takes JPEG only; needs ffmpeg), checks the queued folder again with the bot's validation, and removes kit folders older than 21 days. Make reel covers JPEG or PNG; reels themselves go as they are. `state.json` on that branch is the bot's record of what was posted: never edit it. The bot posts each item when its time comes (every 15 minutes, up to 6 hours late, never later), sends one Telegram line with the links ("עלה סטורי", "עלתה קרוסלה"...), checks every caption link right before posting (a dead link holds the post with one alert), and alerts on a failure or a missed post.

### 9f. The /live calendar (Dudu 5.11: one board of every scheduled marketing event)
Send one cross-session message to the measurement thread (registry.md, "מדידה ודשבורד") listing this kit's dated items for calendar.json, owner "שיווק", that are NOT in social-queue (since 7.11.2026 the measurement bot reads queued autopost.json posts into the board by itself, so never list them): an item held back from the queue (e.g. a reel waiting for Dudu's listen), the TikTok scheduling run (Friday 12:00) and the reel's TikTok time, the group-posting runs (Sun and Wed 19:30) and the community search (Mon 19:30) of the coming week. Hebrew wording without numbers, plates or internal ids. The kit run itself does not push to branch calendar. When a held item is queued later, tell measurement so it archives its task.

### 10. Reply in the thread
One reply, four lines, plus the folder:
```
ערכת תוכן N מוכנה (lint עבר): ריל "<title>" (<pillar>), קרוסלה "<title>" (<pillar>), פוסט לקונים "<title>"<, סטוריז>.
לוח זמנים: ראשון <dd.mm> 08:30 פוסט לקונים · שני 20:30 קרוסלה · שלישי 08:15 סטוריז · חמישי 20:30 ריל. פייסבוק ואינסטגרם בתור לפרסום אוטומטי<; | : עוד לא בתור, כי <why>>; טיקטוק: פרומפט אחד שמתזמן עד הסוף, ומשימה מתוזמנת במחשב מריצה אותו ביום שישי ב-11:30.
<הקבצים כבר במחשב, בתיקייה לוחית\1 ערכות תוכן\marketing-kit-<D> בשולחן העבודה | הקבצים עוד לא במחשב: להוריד את התיקייה ל-Desktop\לוחית\1 ערכות תוכן\marketing-kit-<D> לפני שמדביקים את הפרומפט>.
לבדוק לפני אישור: <the one or two things Dudu must check, e.g. listen to the VO / a caution from ideas.json>.
```
The posts and the reel carry the Google Play badge (step 5, step 6.5); say so only when it changed.
Attach the kit markdown (`attached_outputs` kind `file`, path `$KIT/ערכת-תוכן-שבועית-N.md`) and give the folder path `/mnt/project-files/vehicle-app/marketing-kit-<D>/`. Do not post anywhere else.

---

## Tool reference

### ideas.mjs
`node ideas.mjs <repo> [--catalog <catalog-data checkout>] [--recall-since <RECALL_ID>] [--gsc <seo-data.json>] [--camp <campaign-opens.json>] [--out ideas.json]` → JSON on stdout: `{generated, repo{commit, shallow}, ideas[], dropped_facts[], warnings[]}`. Facts that fail verification are listed in `dropped_facts` and never emitted. No network, no npm deps.

### lint.mjs
`node lint.mjs <kit-folder> --repo <checkout> [--config lint-config.json] [--json] [--allow-stale-checkout]`; `node lint.mjs --selftest`. Exit 0 pass, 1 violations, 2 usage. Works through the `/mnt/project-files` symlink.
Scans every file in the kit (skips `vendor/`, `node_modules/`, `.git/`, `__pycache__/`), including `renders/`, `frames/` and `src/`: markdown, HTML/SVG/XML, JSON (`kit.json`, HyperFrames JSON), code string literals (`.py .js .mjs .cjs .ts`), subtitle/text formats (`.txt .srt .vtt .yml .yaml .csv .ass .sbv ...`), UTF-8 or UTF-16, up to 50 MB per file; unknown binary files are checked by name and hash (short-1-oketz in any spelling), unreadable text files fail. `facts.json`/`ideas.json`/`package*.json` are only checked for plates. Any other file that looks like an extension prompt counts as a second prompt.
HTML: tags stripped (inline tags joined, so `ס<b>ו</b>חר` reads as one word; block tags `p div h1-h6 li td tr section ...` end a sentence); entities decoded; alt/title/aria text, CSS `content:`/`attr()`, script strings, `data:` URIs and bidi-override text (as displayed) are checked for words; `data-nonum` elements are skipped by the number check only when their text is a 1-2 digit counter. Rules (ids): `forbidden-word`, `winner-or-recommendation`, `golden-rule`, `entitled-claim` (זכאי near a recall/settlement word), `real-plate`, `pro-feature`, `estimate-label`, `tiktok-analytics`, `banned-asset`, `extension-prompt` (exactly one, stop marker, no publish click, poll/quiz only from the phone; either drafts, or a prompt that says it schedules to the end, may click Schedule and must forbid Post), `facts` (facts.json present and valid, each fact re-read from the checkout, each number in copy matched). Matching normalises niqqud, zero-width/bidi/tag characters, final letters, Latin/Cyrillic look-alikes, Arabic-Indic and full-width digits, quote/dash variants, percent-encoding, punctuation inside a word (`מ.צ.י.א.ה`) and spaced letters (`מ צ י א ה`), and allows the prefixes ו/ה/ש/ב/ל/מ/כ (up to four). Plates are found in any grouping or separator (`23 456 78`, `23.456.78`, `IL2345678`, mixed with invisible characters); only the demo digits 1234567 / 7654321 pass, and a git sha is not a plate.
The number check covers headings and every section of the kit markdown (schedule and checklist too). It skips only: code blocks marked bash/sh/powershell, URLs, file names, hashtags, valid dates and times, aspect ratios and pixel sizes, reel specs ("15 שניות, 9:16"), 1-2 digit slide/step counters, list enumerations, "ערכה N", model names like "MAZDA 3" (not when followed by %, ש"ח, רכבים...), "בנזין 95", "לכל 1,000", and `nonclaims`. Numbers in words ("שבעה עשר אחוז") fail. Search Console numbers (`private` facts) never pass, even when a public fact has the same value.

### Fact format
```json
{"text": "MG3: 118 מכל 1,000 רכבים פעילים עם ריקול פתוח", "value": 118, "round": 0,
 "source_path": "model/stats.json", "json_pointer": "/models/[slug=mg3-443]/rcPer",
 "fetched_at": "2026-10-22T06:00:00Z", "repo_commit": "<sha>"}
```
Locators: `json_pointer` (RFC 6901 plus array selectors `[key=value]`, `[keys.0=value]`, `[0]`, `[last]`) or `source_field` (dotted) or `regex` (group 1, on the file or on the pointed string); `number_index` (n-th number in a text field, e.g. a magazine lead); `source_rev` (a git revision of the file, needs history); `derive: {op: pct_change|diff|ratio|sum|count_where, args: [locators]}` with `abs`, `scale`, `round` (default = decimals written in `value`). `private: true` for Search Console, `estimate: true` for estimates. `source_path` is relative to the checkout (no `..`, no symlink out of it); an absolute path is allowed only with `private: true`.
Checks on every fact: `text` must contain the `value` and the words its binding requires (`rules.facts.bindings`: e.g. rcPer → "ריקול", act → "פעיל"/"כביש", market months → "מסיר"/"נמסר"); `round` is 0-4 and required whenever `value` is rounded (at most 5% away from the source); `scale` is a power of ten (0.001-1000); `regex` needs a capture group around the value written generically (`\d+`, no literal digits) and at least 3 literal characters of context; a `derive` change fact must say ירידה/עלייה in the direction of the source (swapped `pct_change` args fail); `fetched_at` is an ISO date-time at most 10 days old and not in the future; `data_as_of` older than 35 days gives a warning.

### render/build.mjs
`node render/build.mjs <kit.json> <out> [--only carousel-01,story-02] [--html-only]`. Chromium: `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`, else the first `chrome` found under `/opt/pw-browsers` (override `CHROME_PATH`); Playwright from `/opt/node-tools/node_modules/playwright` (override `PLAYWRIGHT_MODULE`).

## Known issues in kit 1 (do not repeat)
`lint.mjs` on `marketing-kit-2026-10-16` (built before the factory) fails (78 violations in 23 files: facts 56, extension-prompt 6, pro-feature 8, real-plate 4, forbidden-word 2, golden-rule 1, banned-asset 1) with: no `facts.json`, so every number in the md, `src/kit.html` and `src/gen.py` is unsourced ("10 שניות", "עד 100", "4 צעדים", demo table values, big stats); two non-demo plates on the dealer post (23-456-78, 34-567-89) in `src/kit.html` and `src/gen.py`; four extension prompts instead of one, none saying "drafts", two without "עצור לפני", one "לפרסם לפי הסדר"; the dealer post and its captions mention bulk check without "(PRO עסקי)"; the internal header line quotes "חשיפת רמאות"/"זיהוי סוחרים" and the checklist names short-1-oketz. Kit 1 itself stays as delivered.

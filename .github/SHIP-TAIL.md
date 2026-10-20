# Ship tail

`.github/workflows/ship-tail.yml` runs after every successful **Android build** on main. When the build is a release, it uploads it to Google Play's closed testing track **Alpha** and sends it for review, makes sure GA4 has the settings in `analytics/ga4-admin.json`, and sends one Telegram message. Ship tail never touches another track (`play-alpha.mjs` refuses any write that is not to `alpha`, before the request is sent). **Production is always the owner's word**: "פרסם" (see Production below).

## When is a build a release?
A release is a change of `APP_VERSION` in `index.html` on main. Bot commits (market.json and the like) rebuild the app too; those builds are **not** uploaded. The script reads every Play track inside a throwaway edit and stands down quietly when:
- a release on any track already carries this version (named `1.33`, `v1.33`, `110 (1.33)`, `1.33.0` and so on), or
- the build's versionCode is not above the highest versionCode on Play, or
- a versionCode on Play was built from a commit whose `APP_VERSION` is this version (versionCode = the Android build's run number), which covers a release renamed by hand, or
- this version is not above the newest version on Play (`APP_VERSION` went back on main).

It uploads only when the picture is clear: Play lists at least one release (alpha counts; the app need not be in production yet), and the version of the newest build on Play is known (from its commit, or a version in its release name). If Play or GitHub does not answer, or answers something unexpected, nothing is uploaded.

Only builds whose commit is on main are uploaded. A manual run started on another branch does nothing.

## When does a Telegram come?
- An upload to Alpha: always.
- A release that waits (release notes missing or wrong, `SHIP_TAIL=dry`) or an error: once, from the build that changed `APP_VERSION` (or, for a release that waits, the release notes), compared with the previous successful Android build on main. Later builds that change neither only write a line in the run log, so bot pushes do not repeat the message. When the previous build cannot be found, the message is sent.
- A manual run (Actions → Ship tail → Run workflow): every result except "already on Play", which is only in the run's job summary.

## Release notes (`android/release-notes.txt`)
- Line 1: `# <APP_VERSION>`, exactly the version being released (for example `# 1.33`).
- Later lines that start with `#` are comments and are not sent.
- The rest is the Hebrew text for Google Play (language `iw-IL`), at most **500 characters** (characters, not bytes), for example lines starting with `• `.
- Write it in the same push that changes `APP_VERSION`. The file is read at the build's commit.
- Missing, empty, too long, or a header for another version: nothing is uploaded and one Telegram says so. Fixing the file on main rebuilds the app (it is under `android/`) and the upload runs by itself. A manual run (Actions → Ship tail → Run workflow, `step=play`, `mode=on`, `build=<versionCode>`) also reads the notes from main.

## Store listing (`.github/store-listing/`)
`.github/workflows/store-listing.yml` keeps the Hebrew (`iw-IL`) main store listing on Google Play equal to these files:
- `title.txt` (at most 30 characters), `short-description.txt` (80), `full-description.txt` (4000). Characters, not bytes.
- `phone-screenshots/`: 2 to 8 PNG (no alpha) or JPEG files, each side 320 to 3840 px, the long side at most twice the short. Play shows them in file-name order (`01-…`, `02-…`).

A file or the folder that is not there leaves that part of the listing as it is on Play. A push to main that changes these files (the merge on "שחרר" included) sends only what differs: changed texts, and from the first screenshot that differs to the end (a changed last screenshot replaces that one only). Everything is read back from Play, validated and committed, which sends it for review; one Telegram says what changed. When a new Alpha build is already in review, Play withdraws that review and sends both together (its default). Nothing else on Play can be written: other languages, the icon, the feature graphic, tablet screenshots, tracks and production are refused by the script before a request is sent. A manual run (Actions → Store listing → Run workflow) is `dry` by default: it reads Play, shows what would change in the job summary and checks the permission without changing anything.

The store listing is shared by every track: what is sent here shows on the public store page once Google approves it, even while the new version is only on Alpha.

**Data safety** (`data-safety.csv` in the same folder): Play Console's own export of the Data safety form (App content → Data safety → Export to CSV), changed only where an answer changes. The same workflow sends it with `play-data-safety.mjs` (one call, `applications.dataSafety`) when the file changed since the last push run of the workflow that finished green (so a run that was replaced while pending, cancelled or died still has its change sent by the next push), or on a manual run with `mode=on` and `data_safety=send`; Google has no call that reads the declaration back. When a send fails (the Telegram says why), or the file changed while the `SHIP_TAIL` kill switch was off, send it with a manual run: `mode=on`, `data_safety=send`. The file is the truth: an answer changed by hand in Play Console is overwritten by the next push that changes the file, so change answers here. One Telegram when it is sent or fails. A release that changes what the app collects or shares (a new SDK, a new permission, analytics events with new data) updates this file in the same push as the code.

Before "שחרר", release threads update these files on next together with `android/release-notes.txt` (the Alert router check runs `play-listing.mjs check` on next, so a text that is too long or a bad screenshot is red there first). The account needs one more Play Console permission for this: **Manage store presence** (in newer consoles "Edit store listing, pricing & distribution").

## Production (`.github/workflows/production.yml`)
Every new version goes out in two words: "שחרר" (Alpha, above) and then, when the owner wants it public, **"פרסם"** in the release thread (or Actions → Production → Run workflow, `mode=on`; `version` names the version meant, so a newer build that reached Alpha since is not sent in its place). `play-production.mjs promote` then:
- takes the newest Alpha release: its build, its name and its Hebrew release notes, as they are on Alpha;
- sends it to the production track as a **staged rollout to 20%** of users, in one edit that is validated, committed (which sends it for review) and read back. The very first production release goes to all users (Google allows no staged rollout for it); its countries were chosen once in Play Console (Israel);
- refuses, with one Telegram that says why, when the Alpha build is not above the one on production, a staged rollout is still running, a halted rollout is not older than the Alpha build, the Alpha release has no notes, Google rejected the build on Alpha, or the newest Alpha version is not the one named.

When the owner asks for all users at once (no 20% step), the run takes `full=true`: the build goes to all users in one edit (status completed), with no staged rollout and so no automatic halt (the watch still tells a crash new in the build, and the fix is a new version). An older rollout that is still running is replaced by it, and the same build running at a fraction goes to 100% at once. Every other refusal above still holds.

What follows is in Release watch (three times a day, by day), `play-production.mjs auto`:
- while Google reviews the rollout (Play's release lifecycle state) nothing happens;
- the first look at it published sends one Telegram and starts the 48 hours;
- a crash or ANR that is **new in this build** (the watch's rule below), found by a later look than the watch's first one at the rollout (what that first look finds came from Alpha and was already told), **halts** it at once, with one Telegram. Users who already updated keep it; the rest stay on the previous version. To go on anyway: Play Console → Production → Resume rollout (the 48 hours then start again, and only issues found after the halt count); otherwise fix and release a new version;
- **48 hours** after it was first seen published with no such issue, and once the watch has read Play's crash data past those 48 hours, it goes to **100%**, with one Telegram;
- a rollout Google rejected, one approved but waiting for Publish (managed publishing), one not sent for review, and a review longer than 7 days each get one Telegram that says what to do.

The script can write only the production track, and only these shapes: one release of the Alpha build at 20%, the running rollout halted, or the running rollout completed (anything else is refused before the request is sent). Nothing else: no upload, no other track, no store listing, no app signing. A manual run is `dry` by default (and on any branch but main): it reads Play and writes the release it would send into an edit that is validated and deleted, never committed (this checks the permission and Play's own checks). Nothing on a schedule or a push starts a release: only the manual run does; the schedule only halts or completes the rollout the owner started. The account needs one more Play Console permission for this: **Release to production, exclude devices, and use Play App Signing**.

## Release watch (`.github/workflows/release-watch.yml`)
Three times a day, by day only, for 72 hours after a new build reaches a Play track (Alpha after "שחרר"; Production again from "פרסם", and for as long as its staged rollout runs), the watch asks Android vitals for crash and ANR issues of that versionCode. An issue that no older version had in the last 30 days gets one Telegram (what, where, how many reports and users, the link to it in Play Console), once. Issues older versions already had stay quiet: Reviews monitor's daily crash and ANR rate check covers them. It only reads: the tracks inside a throwaway edit that is deleted, and the Play Developer Reporting API (enabled in the Google Cloud project; the account's "View app information" permission is enough). Crashlytics has no public API for its issues, so the watch sees what Play sees (users who share usage data with Google). What was seen, found and told is kept in the Actions cache (`watch.json`, which the Production step reads and adds to). A broken check sends at most one Telegram a day.

## Kill switch: repository variable `SHIP_TAIL`
- `off` (also `false`, `0`, `no`, `disabled`): nothing runs.
- `dry`: plans and validates only, then reports. In a throwaway edit the Alpha track is written back exactly as it is (this checks the "Release apps to testing tracks" permission) and validated; the edit is then deleted. Nothing is uploaded, committed or created, so a dry run does not check the upload itself; GA4 is only listed.
- unset or `on`: acts. Any other value counts as `dry`. A manual run defaults to `dry` and never goes above the variable.
- The same variable holds the store listing (`off` sends nothing, `dry` reports what a push would have sent), the release watch (`off` reads nothing, `dry` sends no Telegram) and Production (`off` sends nothing and leaves a running rollout alone, `dry` only reports, for "פרסם" and for the halt or 100%).

## One-time setup (owner)
Ship tail uses its own service account. Do not reuse the reviews or GA account: their keys are also in jobs that install pip packages, and in a Cloudflare Worker.
1. **Google Cloud** (any project you own): IAM & Admin → Service Accounts → Create service account (for example `ship-tail`), no project roles. Then APIs & Services → enable **Google Play Android Developer API** and **Google Analytics Admin API** in that project.
2. The new account → Keys → Add key → Create new key → JSON. A file downloads.
3. **Play Console** → Users and permissions → Invite new users → the account's email → App permissions → Add app → *לוחית* → tick **Release apps to testing tracks** and **View app information and download bulk reports (read-only)** → Invite user. No account-level permissions. Later additions, each for one job: **Manage store presence** (Store listing) and **Release to production, exclude devices, and use Play App Signing** ("פרסם"); the scripts never call an app-signing endpoint. It can take a while before Google lets the account in.
4. **GA4** → Admin → Property access management → + → the same email → role **Editor**. The reporting account (`GA_SERVICE_ACCOUNT_JSON`) stays a Viewer.
5. **GitHub** → Settings → Secrets and variables → Actions → New repository secret `SHIP_SA_JSON`: paste the whole downloaded file. Then delete the file from your computer.
6. Check it: Actions → Ship tail → Run workflow, `mode=dry`, `step=all`. The job summary of the run shows what Play holds and what GA4 is missing; a problem also comes on Telegram with what to do. If you also want the first automatic release to be dry, set the variable `SHIP_TAIL=dry` and later delete it or set `on`.

Without `SHIP_SA_JSON` the steps print one notice and finish green. A `SHIP_SA_JSON` that is set but is not a key (cut short, quoted) is an error, reported like any other.

## Files
- `.github/scripts/play-alpha.mjs`: gate, the Alpha upload and the summary message (`node play-alpha.mjs selftest` runs offline).
- `.github/scripts/play-listing.mjs` + `.github/store-listing/`: the store listing (`node play-listing.mjs selftest`, and `check` for the files alone).
- `.github/scripts/play-data-safety.mjs` + `.github/store-listing/data-safety.csv`: the Data safety declaration (`node play-data-safety.mjs selftest`, and `check`).
- `.github/scripts/release-watch.mjs`: the release watch (`node release-watch.mjs selftest`).
- `.github/scripts/play-production.mjs`: "פרסם" and the staged rollout's halt or 100% (`node play-production.mjs selftest`).
- `.github/scripts/ga4-admin.mjs` + `analytics/ga4-admin.json`: custom dimensions and key events; only creates what is missing, never archives, deletes or renames (`node ga4-admin.mjs selftest`).
- The Android build's draft release `build-<N>` is only read, never deleted or published.

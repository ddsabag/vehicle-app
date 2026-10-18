# דוח אנליטיקה שבועי: הגדרה חד־פעמית

הדוח רץ כל יום ראשון ב-08:00 (שעון ישראל), שולף 7 ימים מ-GA4, משווה לשבוע שלפניו, מזהה חריגות ושולח סיכום קצר עם הדשבורד כקובץ. עלות: אפס (GA4 Data API ו-GitHub Actions חינמיים בהיקף הזה). הדשבורד לא מתפרסם באתר, כי הריפו ציבורי.

## 1. חשבון שירות עם גישת קריאה ל-GA4
1. ב-Google Cloud Console (אותו חשבון Google של GA4) צור פרויקט (או השתמש בפרויקט של Firebase `luchit`) והפעל בו את **Google Analytics Data API**.
2. IAM & Admin > Service Accounts > Create. שם: `luchit-analytics-reader`. אין צורך בהרשאות פרויקט.
3. בחשבון השירות: Keys > Add key > JSON. יורד קובץ. **אל תעלה אותו לריפו.**
4. ב-GA4: Admin > Property access management > הוסף את כתובת המייל של חשבון השירות (`...@...iam.gserviceaccount.com`) עם תפקיד **Viewer**.
5. ב-GA4: Admin > Property details > העתק את **Property ID** (מספר).

## 2. סודות ב-GitHub
Settings > Secrets and variables > Actions > New repository secret:
- `GA_PROPERTY_ID`: המספר מסעיף 5.
- `GA_SERVICE_ACCOUNT_JSON`: כל התוכן של קובץ ה-JSON.

## 3. ערוץ הפצה (לפחות אחד)
- **Telegram:** ב-@BotFather שלח `/newbot`, קבל טוקן (`TELEGRAM_BOT_TOKEN`). שלח הודעה כלשהי לבוט החדש, ואז פתח `https://api.telegram.org/bot<TOKEN>/getUpdates` והעתק את `chat.id` (`TELEGRAM_CHAT_ID`).
- **Slack:** Incoming Webhook: `SLACK_WEBHOOK_URL` (נשלח רק טקסט, בלי הקובץ).
- **מייל:** `SMTP_HOST`, `SMTP_PORT` (587), `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_TO`, ואפשר `SMTP_FROM`. ב-Gmail צריך סיסמת אפליקציה.

## 4. בדיקה
- Actions > Weekly analytics report > Run workflow עם `sample` מסומן: מייצר דשבורד על נתוני דוגמה (בלי שליחה). הקובץ ב-Artifacts.
- אחר כך Run workflow עם `send` מסומן: דוח אמיתי ושליחה מיידית.
- ההרצה המתוזמנת פועלת רק מהענף הראשי (main), ולכן תתחיל אחרי השחרור.

## מקורות נוספים (כולם אופציונליים, כל מקור נכלל רק אם הוגדר)
- **Search Console** (קליקים, חשיפות, שאילתות): מוסיפים את חשבון השירות כמשתמש בנכס `luchit.app` (הרשאה Restricted), ומפעילים את Google Search Console API בפרויקט.
- **Cloudflare** (ביקורים וצפיות באתר, מגזין, דפי דגמים): טוקן API עם הרשאת Account Analytics: Read ו-`CF_ACCOUNT_ID`. סודות: `CF_API_TOKEN`, `CF_ACCOUNT_ID`.
- **Google Play** (שיעור קריסות ו-ANR): מפעילים Google Play Developer Reporting API, ובפלייקונסול מזמינים את חשבון השירות עם הרשאות View app information and download bulk reports ו-View app quality data. החיבור יכול לקחת כמה שעות עד שהוא נכנס לתוקף.
- **PageSpeed Insights**: עובד בלי מפתח. אפשר להוסיף `PSI_API_KEY` (מפתח API מוגבל ל-PageSpeed Insights API).
כל מקור שנכשל מופיע בדוח כהערה ולא מפיל את ההרצה.

## המרה מהאתר להורדה
כל קישור מהאתר ל-Google Play מכיל עכשיו תגית `utm_source=luchit.app&utm_medium=web&utm_campaign=...` (דף הבית, כרטיס התוצאה, דפי דגמים, מגזין). ב-Play Console, Statistics > Acquisition אפשר לראות ביקורים בדף האפליקציה והתקנות לפי המקור הזה. זה מחליף מדידה של לחיצות באתר.

## מה נמדד ומה לא
נמדד מ-GA4 של האפליקציה: חיפושים, איטיים (`lookup_slow`), ביטולים (`lookup_abort`), כשלים (`lookup_failed`), תוצאות חלקיות, פתיחה מהמטמון, משתמשים פעילים וחוזרים, שיתופים (`share`), השוואות (`compare_open`), שמירות, פתיחות מסך שדרוג, לשוניות וגרסאות.
לא נמדד: יצרנים, דגמים וסוגי הנעה (האפליקציה לא שולחת אותם בכוונה). האפשרות להוסיף אותם היא פרמטרים אנונימיים `make` ו-`drive` באירוע `car_lookup`, בגרסה הבאה.

## ספים (config.json)
איטיים מעל 5% אדום, ביטולים בעלייה של 20% ומעלה אדום, כשלים מעל 10% אדום, ירידה של 30% בחיפושים צהוב ו-50% אדום, ויום חריג (סטייה של 2.5 סטיות תקן). אפשר לשנות בלי לגעת בקוד.

## Brevo (דיוור וקהילה)
Optional. Needs the repository secret `BREVO_API_KEY` (the workflow also accepts `BREVO_KEY`, the same key used by the newsletter part of the Magazine workflow) and the repository variable `BREVO_LIST_ID`. Without them the section is simply left out. Email traffic from GA4 (`utm_medium=email` / `utm_source=newsletter`) needs no extra setup, but only the Android app sends events to GA4.

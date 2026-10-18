// The ministry datasets the app depends on: shared by the daily health check and the schema guard.
export const SAMPLE_PLATE = "38548003";
// maxAge = days since last_modified before we call the data stale (per-car sets update daily-ish, per-model sets rarely)
// filter = a known-good lookup (also proves the filter column still works); expectEmpty = known ministry outage, reported as a note, not an alert
// (none today: owners carried it until it answered again, with 5.5 million rows and the sample plate found, in October 2026)
export const SETS = [
  { key: "active", impact: "בדיקת רכב לפי מספר רישוי תציג ״הרכב לא נמצא״ או תיכשל", title: "רכב פרטי ומסחרי (vehicle_info)", id: "053cea08-09bc-40ec-8f7a-156f0677aff3", maxAge: 7,
    filters: { mispar_rechev: SAMPLE_PLATE }, fields: ["mispar_rechev", "tozeret_nm", "shnat_yitzur", "kinuy_mishari", "sug_delek_nm", "tokef_dt"] },
  { key: "tech", impact: "היסטוריית הטסטים והק״מ של הרכב לא תוצג", title: "היסטוריית מפרט ורישוי", id: "56063a99-8a3e-4ff4-912e-5966c0279bad", maxAge: 7,
    filters: { mispar_rechev: SAMPLE_PLATE }, fields: ["mispar_rechev"] },
  { key: "recalls", impact: "ריקולים פתוחים לא יוצגו לרכב", title: "ריקולים לפי רכב", id: "36bf1404-0be4-49d2-82dc-2f1ead4a8b93", maxAge: 7,
    filters: null, fields: ["MISPAR_RECHEV"] },
  { key: "modelRecalls", impact: "פרטי תיקון הריקול (לפי דגם) לא יוצגו", title: "ריקולים לפי דגם", id: "2c33523f-87aa-44ec-a736-edbb0a82975e", maxAge: 45,
    filters: null, fields: ["TOZAR_TEUR", "RECALL_ID"] },
  { key: "wltp", impact: "מפרט טכני, צריכת דלק ויכולת גרירה לא יוצגו", title: "מפרט טכני (WLTP)", id: "142afde2-6228-49f9-8a29-9b6c3a0cbe40", maxAge: 45,
    filters: null, fields: ["tozeret_cd", "degem_cd", "shnat_yitzur", "kosher_grira_im_blamim"] },
  { key: "owners", impact: "היסטוריית הבעלויות לא תוצג", title: "היסטוריית בעלויות", id: "bb2355dc-9ec7-4f06-9c3f-3344672171da", maxAge: 7,
    filters: { mispar_rechev: SAMPLE_PLATE }, fields: ["mispar_rechev", "baalut_dt", "baalut"] },
];

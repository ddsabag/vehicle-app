// Shared wording helpers for the Telegram alerts.
// Israel time (the alerts used to print UTC), e.g. "14.10.2026 08:23".
export const ilTime = (d = new Date()) => new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(d).replace(",", "");

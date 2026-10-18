// The one sort order of magazine/posts.json, shared by magazine.mjs (monthly article) and magazine-data.mjs (weekly data articles):
// newest date first, then slug descending on the same date, so posts[0] is the latest post (pages.mjs and newsletter.mjs rely on that).
export const byNewest = (a, b) => b.date.localeCompare(a.date) || b.slug.localeCompare(a.slug);

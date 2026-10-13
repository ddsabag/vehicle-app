const r = await fetch("https://luchit.app/api/confirm?e=a%40b.co&x=1&t=x", { redirect: "manual" });
console.log("confirm (new worker answers 302 expired, old one 404):", r.status, r.headers.get("location"));
const s = await fetch("https://luchit.app/api/subscribe", { method: "POST", headers: { origin: "https://luchit.app", "content-type": "application/json" }, body: JSON.stringify({ email: "bad", consent: true }) });
console.log("subscribe invalid email:", s.status, await s.text());

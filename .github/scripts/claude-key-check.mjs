// One-off check of the repo secret ANTHROPIC_API_KEY (inspect.yml on the branch ops-claude-key-probe, never on main): one tiny
// claude-haiku-5-5 call through the official SDK. Prints only OK or the kind of error: never the key, never the reply text.
const key = process.env.ANTHROPIC_API_KEY || "";
if (!key) { console.log("ANTHROPIC_API_KEY: missing (empty in this run)"); process.exit(1); }
let Anthropic;
try { ({ default: Anthropic } = await import("@anthropic-ai/sdk")); } catch { console.log("SDK: not installed"); process.exit(1); }
const client = new Anthropic({ apiKey: key, timeout: 30000, maxRetries: 1 });
try {
  const r = await client.messages.create({ model: "claude-haiku-5-5", max_tokens: 16, output_config: { effort: "low" },
    messages: [{ role: "user", content: "Reply with the word OK." }] });
  console.log(`ANTHROPIC_API_KEY: OK (model ${r.model}, stop ${r.stop_reason})`);
} catch (e) {
  const kind = e instanceof Anthropic.AuthenticationError ? "authentication (401: the key is wrong or revoked)"
    : e instanceof Anthropic.PermissionDeniedError ? "permission (403)"
    : e instanceof Anthropic.RateLimitError ? "rate limit (429)"
    : e instanceof Anthropic.BadRequestError ? "bad request (400)" + (/credit balance/i.test(String(e.message)) ? ", credit balance too low" : "")
    : e instanceof Anthropic.APIConnectionError ? "connection (no answer)"
    : e instanceof Anthropic.APIError ? `API error ${e.status}` : "other (" + (e?.name || "error") + ")";
  console.log(`ANTHROPIC_API_KEY: FAILED, ${kind}; error type ${e?.error?.error?.type || "-"}`);
  process.exit(1);
}

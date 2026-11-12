// Dealer beta: makes the business codes' signing pair. Run on your own computer only (never in Actions: the logs are public):
//   node .github/scripts/dealer-keygen.mjs
// Paste the first line as the Worker secret DEALER_SIGN_KEY (luchit-api); the second goes into DEALER_PUB in index.html (public by design).
const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
console.log("DEALER_SIGN_KEY (secret):", Buffer.from(await crypto.subtle.exportKey("pkcs8", kp.privateKey)).toString("base64"));
console.log("DEALER_PUB (public):     ", Buffer.from(await crypto.subtle.exportKey("raw", kp.publicKey)).toString("base64"));

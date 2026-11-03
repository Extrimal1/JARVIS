// Generates a VAPID P-256 key pair for Web Push (RFC 8292).
// Usage: node scripts/generate-vapid-keys.mjs
// Prints VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY (base64url, raw bytes).
import { createECDH } from "node:crypto";

function base64UrlEncode(data) {
  return Buffer.from(data)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

const ecdh = createECDH("prime256v1");
const publicKey = ecdh.generateKeys();
const privateKey = ecdh.getPrivateKey();

if (publicKey.length !== 65 || privateKey.length !== 32) {
  console.error("Unexpected key lengths.");
  process.exit(1);
}

console.log("# Add to .env.local AND to the hosting provider env:");
console.log(`VAPID_PUBLIC_KEY=${base64UrlEncode(publicKey)}`);
console.log(`VAPID_PRIVATE_KEY=${base64UrlEncode(privateKey)}`);
console.log("VAPID_SUBJECT=mailto:deine-mail@example.com");

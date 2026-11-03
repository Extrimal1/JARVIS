/**
 * Web Push sender (SERVER-ONLY — imports node:crypto). Zero
 * dependencies: VAPID auth (RFC 8292) + aes128gcm message encryption
 * (RFC 8291 / RFC 8188) via the Node crypto primitives (ECDH P-256,
 * HKDF-SHA256, AES-128-GCM, ECDSA-SHA256). Key formats match the
 * widely used `web-push` CLI: base64url of the raw bytes (public =
 * 65-byte uncompressed point, private = 32-byte scalar).
 */

export type PushSubscriptionKeys = {
  p256dh: string;
  auth: string;
};

export type PushSubscription = {
  endpoint: string;
  keys: PushSubscriptionKeys;
};

export type VapidKeys = {
  publicKey: string;
  privateKey: string;
  subject: string;
};

export const PUSH_TTL_SECONDS = 86400;
export const VAPID_EXPIRY_SECONDS = 12 * 60 * 60;
const RECORD_SIZE = 4096;

export function base64UrlEncode(data: Uint8Array): string {
  return Buffer.from(data)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function base64UrlDecode(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value === "") return null;

  try {
    const padded = value + "=".repeat((4 - (value.length % 4)) % 4);

    return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  } catch {
    return null;
  }
}

export function isPushSubscription(value: unknown): value is PushSubscription {
  if (typeof value !== "object" || value === null) return false;

  const sub = value as Record<string, unknown>;

  if (typeof sub.endpoint !== "string") return false;

  try {
    const url = new URL(sub.endpoint);

    if (url.protocol !== "https:") return false;
  } catch {
    return false;
  }

  if (typeof sub.keys !== "object" || sub.keys === null) return false;

  const keys = sub.keys as Record<string, unknown>;
  const p256dh = base64UrlDecode(
    typeof keys.p256dh === "string" ? keys.p256dh : "",
  );
  const auth = base64UrlDecode(
    typeof keys.auth === "string" ? keys.auth : "",
  );

  return (
    p256dh !== null &&
    p256dh.length === 65 &&
    p256dh[0] === 0x04 &&
    auth !== null &&
    auth.length === 16
  );
}

export function vapidEnv(): VapidKeys | null {
  const publicKey = process.env.VAPID_PUBLIC_KEY ?? "";
  const privateKey = process.env.VAPID_PRIVATE_KEY ?? "";
  const subject = process.env.VAPID_SUBJECT ?? "";

  if (publicKey === "" || privateKey === "" || subject === "") return null;

  const pub = base64UrlDecode(publicKey);
  const priv = base64UrlDecode(privateKey);

  if (
    pub === null ||
    pub.length !== 65 ||
    pub[0] !== 0x04 ||
    priv === null ||
    priv.length !== 32
  ) {
    return null;
  }

  return { publicKey, privateKey, subject };
}

function audienceFor(endpoint: string): string | null {
  try {
    const url = new URL(endpoint);

    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

/** VAPID JWT (compact ES256), or null when signing fails. */
export async function buildVapidToken(
  vapid: VapidKeys,
  audience: string,
  nowMs: number = Date.now(),
): Promise<string | null> {
  try {
    const { createPrivateKey, sign } = await import("node:crypto");
    const pub = base64UrlDecode(vapid.publicKey);
    const priv = base64UrlDecode(vapid.privateKey);

    if (pub === null || priv === null) return null;

    const header = base64UrlEncode(
      Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })),
    );
    const payload = base64UrlEncode(
      Buffer.from(
        JSON.stringify({
          aud: audience,
          exp: Math.floor(nowMs / 1000) + VAPID_EXPIRY_SECONDS,
          sub: vapid.subject,
        }),
      ),
    );
    const signingInput = `${header}.${payload}`;
    const key = createPrivateKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: base64UrlEncode(pub.subarray(1, 33)),
        y: base64UrlEncode(pub.subarray(33, 65)),
        d: base64UrlEncode(priv),
      },
      format: "jwk",
    });
    const signature = sign("sha256", Buffer.from(signingInput), {
      key,
      dsaEncoding: "ieee-p1363",
    });

    return `${signingInput}.${base64UrlEncode(signature)}`;
  } catch {
    return null;
  }
}

export type EncryptedPush = {
  body: Buffer;
  salt: Buffer;
  serverPublicKey: Buffer;
};

/**
 * Encrypt a payload for one subscription (RFC 8291 §3 + RFC 8188
 * aes128gcm, single record). Returns null on invalid keys.
 */
export async function encryptPush(
  subscription: PushSubscription,
  payload: Uint8Array,
): Promise<EncryptedPush | null> {
  try {
    const { createECDH, hkdfSync, randomBytes } = await import("node:crypto");

    const receiverKey = base64UrlDecode(subscription.keys.p256dh);
    const authSecret = base64UrlDecode(subscription.keys.auth);

    if (
      receiverKey === null ||
      receiverKey.length !== 65 ||
      authSecret === null ||
      authSecret.length !== 16
    ) {
      return null;
    }

    const sender = createECDH("prime256v1");
    const senderKey = sender.generateKeys();

    if (senderKey.length !== 65) return null;

    const sharedSecret = sender.computeSecret(receiverKey);

    const keyInfo = Buffer.concat([
      Buffer.from("WebPush: info\0", "utf8"),
      receiverKey,
      senderKey,
    ]);
    const prk = Buffer.from(
      hkdfSync("sha256", sharedSecret, authSecret, keyInfo, 32),
    );

    const salt = randomBytes(16);
    const cek = Buffer.from(
      hkdfSync(
        "sha256",
        prk,
        salt,
        Buffer.from("Content-Encoding: aes128gcm\0", "utf8"),
        16,
      ),
    );
    const nonce = Buffer.from(
      hkdfSync(
        "sha256",
        prk,
        salt,
        Buffer.from("Content-Encoding: nonce\0", "utf8"),
        12,
      ),
    );

    // Single record: plaintext + 0x02 delimiter, padded implicitly by
    // the fixed record size (payloads here are far below it).
    if (payload.length + 1 + 16 > RECORD_SIZE - 21 - 65) return null;

    const { default: nodeCrypto } = await import("node:crypto");
    const cipher = nodeCrypto.createCipheriv("aes-128-gcm", cek, nonce);
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([0x02])])),
      cipher.final(),
      cipher.getAuthTag(),
    ]);

    const header = Buffer.alloc(21);
    salt.copy(header, 0);
    header.writeUInt32BE(RECORD_SIZE, 16);
    header.writeUInt8(senderKey.length, 20);

    return {
      body: Buffer.concat([header, senderKey, ciphertext]),
      salt,
      serverPublicKey: senderKey,
    };
  } catch {
    return null;
  }
}

export type PushSendResult = {
  ok: boolean;
  status: number;
  /** True for 404/410: the subscription is gone, delete it. */
  gone: boolean;
  error: string | null;
};

/** POST one encrypted message to the push service. */
export async function sendPush(
  subscription: PushSubscription,
  payload: string,
  vapid: VapidKeys,
  fetchImpl: typeof fetch = fetch,
): Promise<PushSendResult> {
  const audience = audienceFor(subscription.endpoint);

  if (audience === null) {
    return { ok: false, status: 0, gone: false, error: "invalid-endpoint" };
  }

  const [token, encrypted] = await Promise.all([
    buildVapidToken(vapid, audience),
    encryptPush(subscription, Buffer.from(payload, "utf8")),
  ]);

  if (token === null || encrypted === null) {
    return { ok: false, status: 0, gone: false, error: "encrypt-failed" };
  }

  let res: Response;

  try {
    res = await fetchImpl(subscription.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Encoding": "aes128gcm",
        TTL: String(PUSH_TTL_SECONDS),
        Authorization: `vapid t=${token}, k=${vapid.publicKey}`,
        Urgency: "normal",
      },
      body: new Uint8Array(encrypted.body),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return { ok: false, status: 0, gone: false, error: "network-error" };
  }

  if (res.ok) {
    return { ok: true, status: res.status, gone: false, error: null };
  }

  if (res.status === 404 || res.status === 410) {
    return { ok: true, status: res.status, gone: true, error: "gone" };
  }

  return {
    ok: false,
    status: res.status,
    gone: false,
    error: `push-service-${res.status}`,
  };
}

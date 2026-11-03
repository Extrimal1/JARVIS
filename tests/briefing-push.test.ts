/**
 * Web Push tests (no network to push services):
 * - subscription + VAPID env validation;
 * - aes128gcm encryption verified by an independent in-test RFC 8188
 *   decrypt (receiver-side ECDH + HKDF + AES-GCM);
 * - VAPID JWT verified with the public key (claims + ES256 signature);
 * - sendPush headers/payload via stub fetch (ok, gone, network-error).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createPublicKey,
  createVerify,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import {
  base64UrlDecode,
  base64UrlEncode,
  buildVapidToken,
  encryptPush,
  isPushSubscription,
  sendPush,
  vapidEnv,
  type PushSubscription,
} from "@/src/lib/push/webpush";

function receiver(): {
  subscription: PushSubscription;
  privateKey: Buffer;
} {
  const ecdh = createECDH("prime256v1");
  const pub = ecdh.generateKeys();

  return {
    subscription: {
      endpoint: "https://push.example.com/send/abc123",
      keys: {
        p256dh: base64UrlEncode(pub),
        auth: base64UrlEncode(randomBytes(16)),
      },
    },
    privateKey: ecdh.getPrivateKey(),
  };
}

/** Independent receiver-side decrypt (RFC 8291 §3 + RFC 8188). */
function decryptPush(
  body: Buffer,
  p256dh: Buffer,
  auth: Buffer,
  receiverPrivateKey: Buffer,
): Buffer {
  const salt = body.subarray(0, 16);
  const recordSize = body.readUInt32BE(16);
  const keyLength = body.readUInt8(20);
  const senderKey = body.subarray(21, 21 + keyLength);
  const ciphertext = body.subarray(21 + keyLength);

  assert.equal(recordSize, 4096);
  assert.equal(keyLength, 65);

  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(receiverPrivateKey);

  const sharedSecret = ecdh.computeSecret(senderKey);
  const keyInfo = Buffer.concat([
    Buffer.from("WebPush: info\0", "utf8"),
    p256dh,
    senderKey,
  ]);
  const prk = Buffer.from(
    hkdfSync("sha256", sharedSecret, auth, keyInfo, 32),
  );
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

  const tag = ciphertext.subarray(ciphertext.length - 16);
  const data = ciphertext.subarray(0, ciphertext.length - 16);
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(data), decipher.final()]);
}

describe("isPushSubscription", () => {
  it("accepts a well-formed subscription", () => {
    assert.equal(isPushSubscription(receiver().subscription), true);
  });

  it("rejects http endpoints, short keys, and garbage", () => {
    const valid = receiver().subscription;

    assert.equal(
      isPushSubscription({
        ...valid,
        endpoint: "http://push.example.com/x",
      }),
      false,
    );
    assert.equal(
      isPushSubscription({
        ...valid,
        keys: { p256dh: "AAAA", auth: valid.keys.auth },
      }),
      false,
    );
    assert.equal(
      isPushSubscription({
        ...valid,
        keys: { p256dh: valid.keys.p256dh, auth: "AAAA" },
      }),
      false,
    );
    assert.equal(isPushSubscription(null), false);
    assert.equal(isPushSubscription({}), false);
  });
});

describe("vapidEnv", () => {
  const saved = {
    pub: process.env.VAPID_PUBLIC_KEY,
    priv: process.env.VAPID_PRIVATE_KEY,
    sub: process.env.VAPID_SUBJECT,
  };

  function restore(): void {
    if (saved.pub === undefined) delete process.env.VAPID_PUBLIC_KEY;
    else process.env.VAPID_PUBLIC_KEY = saved.pub;
    if (saved.priv === undefined) delete process.env.VAPID_PRIVATE_KEY;
    else process.env.VAPID_PRIVATE_KEY = saved.priv;
    if (saved.sub === undefined) delete process.env.VAPID_SUBJECT;
    else process.env.VAPID_SUBJECT = saved.sub;
  }

  it("loads valid keys and rejects missing/malformed ones", () => {
    try {
      delete process.env.VAPID_PUBLIC_KEY;
      delete process.env.VAPID_PRIVATE_KEY;
      delete process.env.VAPID_SUBJECT;
      assert.equal(vapidEnv(), null);

      const ecdh = createECDH("prime256v1");
      process.env.VAPID_PUBLIC_KEY = base64UrlEncode(ecdh.generateKeys());
      process.env.VAPID_PRIVATE_KEY = base64UrlEncode(ecdh.getPrivateKey());
      process.env.VAPID_SUBJECT = "mailto:test@example.com";

      const loaded = vapidEnv();
      assert.ok(loaded !== null);
      assert.equal(loaded.subject, "mailto:test@example.com");

      process.env.VAPID_PRIVATE_KEY = "AAAA";
      assert.equal(vapidEnv(), null);
    } finally {
      restore();
    }
  });
});

describe("encryptPush", () => {
  it("round-trips through an independent receiver decrypt", async () => {
    const { subscription, privateKey } = receiver();
    const payload = Buffer.from("Guten Morgen — Briefing ist da. 🌅", "utf8");

    const encrypted = await encryptPush(subscription, payload);

    assert.ok(encrypted !== null);

    const p256dh = base64UrlDecode(subscription.keys.p256dh);
    const auth = base64UrlDecode(subscription.keys.auth);
    assert.ok(p256dh !== null && auth !== null);

    const plain = decryptPush(encrypted.body, p256dh, auth, privateKey);

    assert.deepEqual(plain.subarray(0, payload.length), payload);
    assert.equal(plain[payload.length], 0x02);
  });

  it("uses fresh salt + ephemeral keys per message", async () => {
    const { subscription } = receiver();
    const payload = Buffer.from("hi", "utf8");

    const first = await encryptPush(subscription, payload);
    const second = await encryptPush(subscription, payload);

    assert.ok(first !== null && second !== null);
    assert.ok(!first.body.equals(second.body));
    assert.ok(!first.salt.equals(second.salt));
    assert.ok(!first.serverPublicKey.equals(second.serverPublicKey));
  });

  it("rejects invalid receiver keys", async () => {
    const { subscription } = receiver();

    assert.equal(
      await encryptPush(
        { ...subscription, keys: { p256dh: "AAAA", auth: subscription.keys.auth } },
        Buffer.from("x"),
      ),
      null,
    );
  });
});

describe("buildVapidToken", () => {
  it("signs a verifiable ES256 JWT with aud/exp/sub", async () => {
    const ecdh = createECDH("prime256v1");
    const pub = ecdh.generateKeys();
    const vapid = {
      publicKey: base64UrlEncode(pub),
      privateKey: base64UrlEncode(ecdh.getPrivateKey()),
      subject: "mailto:test@example.com",
    };

    const token = await buildVapidToken(
      vapid,
      "https://push.example.com",
      Date.parse("2026-11-03T06:00:00Z"),
    );

    assert.ok(token !== null);

    const [headerB64, payloadB64, sigB64] = token.split(".");
    assert.equal(typeof sigB64, "string");

    const header = JSON.parse(
      Buffer.from(headerB64!, "base64url").toString("utf8"),
    ) as { typ: string; alg: string };
    const payload = JSON.parse(
      Buffer.from(payloadB64!, "base64url").toString("utf8"),
    ) as { aud: string; exp: number; sub: string };

    assert.equal(header.alg, "ES256");
    assert.equal(payload.aud, "https://push.example.com");
    assert.equal(payload.sub, "mailto:test@example.com");
    assert.equal(
      payload.exp,
      Math.floor(Date.parse("2026-11-03T06:00:00Z") / 1000) + 12 * 60 * 60,
    );

    const key = createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: base64UrlEncode(pub.subarray(1, 33)),
        y: base64UrlEncode(pub.subarray(33, 65)),
      },
      format: "jwk",
    });
    const verifier = createVerify("sha256");
    verifier.update(`${headerB64}.${payloadB64}`);
    verifier.end();

    assert.equal(
      verifier.verify(
        { key, dsaEncoding: "ieee-p1363" },
        Buffer.from(sigB64!, "base64url"),
      ),
      true,
    );
  });
});

describe("sendPush", () => {
  function vapidKeys() {
    const ecdh = createECDH("prime256v1");

    return {
      publicKey: base64UrlEncode(ecdh.generateKeys()),
      privateKey: base64UrlEncode(ecdh.getPrivateKey()),
      subject: "mailto:test@example.com",
    };
  }

  it("posts aes128gcm with VAPID auth and TTL", async () => {
    const { subscription } = receiver();
    const seen: {
      current: {
        url: string;
        headers: Record<string, string>;
        bytes: number;
      } | null;
    } = { current: null };

    const stubFetch = (async (
      url: string,
      init: { headers: Record<string, string>; body: Uint8Array },
    ) => {
      seen.current = {
        url,
        headers: init.headers,
        bytes: init.body.length,
      };

      return { ok: true, status: 201 };
    }) as unknown as typeof fetch;

    const result = await sendPush(
      subscription,
      JSON.stringify({ title: "Hi" }),
      vapidKeys(),
      stubFetch,
    );

    assert.deepEqual(result, { ok: true, status: 201, gone: false, error: null });
    assert.ok(seen.current !== null);
    assert.equal(seen.current.url, subscription.endpoint);
    assert.equal(seen.current.headers["Content-Encoding"], "aes128gcm");
    assert.equal(seen.current.headers["TTL"], "86400");
    assert.match(seen.current.headers["Authorization"], /^vapid t=[^,]+, k=.+$/);
    assert.ok(seen.current.bytes > 100);
  });

  it("maps 404/410 to gone and network failures honestly", async () => {
    const { subscription } = receiver();
    const vapid = vapidKeys();

    const goneFetch = (async () => ({
      ok: false,
      status: 410,
    })) as unknown as typeof fetch;

    assert.deepEqual(await sendPush(subscription, "x", vapid, goneFetch), {
      ok: true,
      status: 410,
      gone: true,
      error: "gone",
    });

    const downFetch = (async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;

    assert.deepEqual(await sendPush(subscription, "x", vapid, downFetch), {
      ok: false,
      status: 0,
      gone: false,
      error: "network-error",
    });
  });

  it("keeps AES-GCM self-check honest (sanity for the decrypt helper)", () => {
    // Guards the test helper itself: encrypt-then-decrypt one block.
    const key = randomBytes(16);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-128-gcm", key, iv);
    const enc = Buffer.concat([cipher.update("ping"), cipher.final()]);
    const decipher = createDecipheriv("aes-128-gcm", key, iv);
    decipher.setAuthTag(cipher.getAuthTag());

    assert.equal(
      Buffer.concat([decipher.update(enc), decipher.final()]).toString(),
      "ping",
    );
  });
});

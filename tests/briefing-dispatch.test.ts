/**
 * Dispatch route tests (no network):
 * - rejects missing/wrong/empty secrets with 401 (never runs);
 * - 503 when the backend or VAPID keys are missing despite valid auth;
 * - with valid auth + env and a stubbed Supabase returning no due
 *   users, reports checked:0.
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createECDH } from "node:crypto";
import { POST } from "@/app/api/briefing/dispatch/route";

const SAVED = {
  cron: process.env.CRON_SECRET,
  url: process.env.SUPABASE_URL,
  secret: process.env.SUPABASE_SECRET_KEY,
  pub: process.env.VAPID_PUBLIC_KEY,
  priv: process.env.VAPID_PRIVATE_KEY,
  sub: process.env.VAPID_SUBJECT,
};

function base64UrlEncode(data: Uint8Array): string {
  return Buffer.from(data)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function setFullEnv(): void {
  const ecdh = createECDH("prime256v1");
  process.env.CRON_SECRET = "test-cron-secret-0123456789";
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "service-key";
  process.env.VAPID_PUBLIC_KEY = base64UrlEncode(ecdh.generateKeys());
  process.env.VAPID_PRIVATE_KEY = base64UrlEncode(ecdh.getPrivateKey());
  process.env.VAPID_SUBJECT = "mailto:test@example.com";
}

afterEach(() => {
  const entries = [
    ["CRON_SECRET", SAVED.cron],
    ["SUPABASE_URL", SAVED.url],
    ["SUPABASE_SECRET_KEY", SAVED.secret],
    ["VAPID_PUBLIC_KEY", SAVED.pub],
    ["VAPID_PRIVATE_KEY", SAVED.priv],
    ["VAPID_SUBJECT", SAVED.sub],
  ] as const;

  for (const [key, value] of entries) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function request(auth: string | null): Request {
  return new Request("https://app.example/api/briefing/dispatch", {
    method: "POST",
    headers: auth === null ? {} : { authorization: auth },
  });
}

describe("briefing dispatch auth gate", () => {
  it("rejects missing auth with 401", async () => {
    const res = await POST(request(null));
    const body = (await res.json()) as {
      ok: boolean;
      error: { code: string };
    };

    assert.equal(res.status, 401);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "unauthorized");
  });

  it("rejects wrong secrets with 401", async () => {
    setFullEnv();

    const res = await POST(request("Bearer wrong-secret"));
    const body = (await res.json()) as { ok: boolean };

    assert.equal(res.status, 401);
    assert.equal(body.ok, false);
  });

  it("rejects empty CRON_SECRET even with a bearer header", async () => {
    setFullEnv();
    process.env.CRON_SECRET = "";

    const res = await POST(request("Bearer anything"));

    assert.equal(res.status, 401);
  });

  it("503s without backend config despite valid auth", async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SECRET_KEY;
    process.env.CRON_SECRET = "s3cr3t";

    const res = await POST(request("Bearer s3cr3t"));
    const body = (await res.json()) as {
      ok: boolean;
      error: { code: string };
    };

    assert.equal(res.status, 503);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "cloud-not-configured");
  });

  it("reports checked:0 when no users are due (stubbed Supabase)", async () => {
    setFullEnv();

    const realFetch = globalThis.fetch;
    const seen: string[] = [];

    globalThis.fetch = (async (url: unknown) => {
      seen.push(String(url));

      return {
        ok: true,
        status: 200,
        text: async () => "[]",
      };
    }) as unknown as typeof fetch;

    try {
      const res = await POST(request("Bearer test-cron-secret-0123456789"));
      const body = (await res.json()) as {
        ok: boolean;
        data: {
          checked: number;
          sent: number;
          failed: number;
          skipped: number;
        };
      };

      assert.equal(res.status, 200);
      assert.equal(body.ok, true);
      assert.deepEqual(body.data, {
        checked: 0,
        sent: 0,
        failed: 0,
        skipped: 0,
        truncated: false,
        errors: [],
      });
      assert.ok(
        seen.some((url) => url.includes("/rest/v1/briefing_settings")),
        `expected a settings scan, saw: ${seen.join(", ")}`,
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

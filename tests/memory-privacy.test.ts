/**
 * Memory privacy: concrete secrets are never stored (constructor,
 * assistant, and API all refuse), soft hints still warn without
 * blocking, and the kill-switch syncs across devices.
 */
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createMemoryEntry,
  detectSecretBlock,
  detectSensitiveHint,
} from "@/src/lib/memory";
import {
  isMemoryEnabledSetting,
  isUserSettings,
} from "@/src/lib/settings";
import { memoryConfig } from "@/src/lib/api/modules/memory";
import { checkFailed } from "@/src/lib/api/crud";
import {
  clearExecutionCache,
  executePlan,
  type ExecutorDeps,
} from "@/src/lib/assistant/executor";
import type { MemoryEntry } from "@/src/lib/memory";
import { EMPTY_FINANCE } from "@/src/lib/finance";
import type { RemoteResult } from "@/src/lib/db/useRemoteResource";

function entry(patch: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: "m1",
    version: 1,
    category: "preferences",
    title: "Tee",
    content: "Trinkt gern Tee.",
    origin: "user",
    approved: true,
    pinned: false,
    archived: false,
    createdAt: "2026-11-03T10:00:00.000Z",
    updatedAt: "2026-11-03T10:00:00.000Z",
    ...patch,
  };
}

function makeMemoryStore() {
  const saved = new Map<string, MemoryEntry>();

  return {
    saved,
    store: {
      saveMemory: async (
        item: MemoryEntry,
      ): Promise<RemoteResult<MemoryEntry>> => {
        saved.set(item.id, item);
        return { ok: true, data: item };
      },
      deleteMemory: async (id: string): Promise<RemoteResult<null>> => {
        saved.delete(id);
        return { ok: true, data: null };
      },
    },
  };
}

function deps(memories: ExecutorDeps["memories"]): ExecutorDeps {
  return {
    events: [],
    finance: EMPTY_FINANCE,
    calendar: {
      create: async () => ({ ok: false, error: "unused" }) as never,
      update: async () => ({ ok: false, error: "unused" }) as never,
      remove: async () => ({ ok: false, error: "unused" }) as never,
    },
    transactions: {
      saveTransaction: async () =>
        ({ ok: false, error: "unused" }) as never,
      deleteTransaction: async () =>
        ({ ok: false, error: "unused" }) as never,
    },
    memories,
    locale: "de",
  };
}

beforeEach(() => {
  clearExecutionCache();
});

describe("secret blocking", () => {
  it("blocks credential assignments and key material", () => {
    assert.deepEqual(detectSecretBlock("Passwort: hunter2"), ["Passwort"]);
    assert.deepEqual(detectSecretBlock("password=abc123"), ["Passwort"]);
    assert.deepEqual(detectSecretBlock("api_key: XYZ-123"), [
      "API-Schlüssel",
    ]);
    assert.deepEqual(
      detectSecretBlock("-----BEGIN RSA PRIVATE KEY-----\nabc"),
      ["Privater Schlüssel"],
    );
    assert.deepEqual(detectSecretBlock("token sk-abcdefgh1234"), ["Token"]);
    assert.deepEqual(detectSecretBlock("deploy ghp_abcdefgh1234"), ["Token"]);
  });

  it("allows mere mentions without credential values", () => {
    assert.deepEqual(detectSecretBlock("Passwort-Manager einrichten"), []);
    assert.deepEqual(
      detectSecretBlock("Mein Passwort ist sicher verwahrt."),
      [],
    );
    assert.deepEqual(detectSecretBlock("API-Key beim Anbieter beantragen"), []);
    assert.deepEqual(detectSecretBlock("Trinkt gern Tee."), []);
  });

  it("refuses secrets in the shared constructor", () => {
    assert.equal(
      createMemoryEntry({
        category: "assistant",
        title: "Login",
        content: "Passwort: hunter2",
        origin: "user",
      }),
      null,
    );
    assert.notEqual(
      createMemoryEntry({
        category: "goals",
        title: "Passwort-Manager einrichten",
        content: "Alle Logins umziehen.",
        origin: "user",
      }),
      null,
    );
  });

  it("keeps soft hints non-blocking", () => {
    assert.deepEqual(
      detectSensitiveHint("IBAN DE89370400440532013000 prüfen"),
      ["IBAN"],
    );
    assert.notEqual(
      createMemoryEntry({
        category: "finance",
        title: "Kontoprüfung",
        content: "IBAN prüfen lassen.",
        origin: "user",
      }),
      null,
    );
  });
});

describe("memory API guards", () => {
  const db = null as never;

  it("refuses secrets on create and update", async () => {
    const created = await memoryConfig.checkCreate(
      db,
      entry({ content: "api_key: XYZ-123" }),
    );

    assert.ok(checkFailed(created));

    const updated = await memoryConfig.checkUpdate(
      db,
      { content: "password=neu" },
      entry(),
    );

    assert.ok(checkFailed(updated));

    const innocent = await memoryConfig.checkCreate(db, entry());

    assert.ok(!checkFailed(innocent));
  });
});

describe("assistant memory secrets", () => {
  it("refuses secrets with a specific message and stores nothing", async () => {
    const fake = makeMemoryStore();
    const report = await executePlan(
      {
        type: "memory.create",
        entry: {
          category: "assistant",
          title: "Server",
          content: "password=abc123",
        },
      },
      "secret-key-1",
      deps(fake.store),
    );

    assert.equal(report.status, "error");
    assert.match(report.status === "error" ? report.message : "", /Geheimnis/);
    assert.equal(fake.saved.size, 0);
  });

  it("stores innocent memories unchanged", async () => {
    const fake = makeMemoryStore();
    const report = await executePlan(
      {
        type: "memory.create",
        entry: {
          category: "preferences",
          title: "Tee",
          content: "Trinkt gern Tee.",
        },
      },
      "secret-key-2",
      deps(fake.store),
    );

    assert.equal(report.status, "done");
    assert.equal(fake.saved.size, 1);
  });
});

describe("kill-switch settings", () => {
  it("defaults legacy settings to enabled", () => {
    assert.equal(isUserSettings({ lectureAutoUpload: false }), true);
    assert.equal(
      isUserSettings({ lectureAutoUpload: true, memoryEnabled: false }),
      true,
    );
    assert.equal(isUserSettings({ lectureAutoUpload: "ja" }), false);
    assert.equal(
      isMemoryEnabledSetting({ lectureAutoUpload: false }),
      true,
    );
    assert.equal(
      isMemoryEnabledSetting({
        lectureAutoUpload: false,
        memoryEnabled: false,
      }),
      false,
    );
  });
});

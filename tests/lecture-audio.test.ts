/**
 * Lecture audio regression tests: honest MIME plumbing plus the full
 * IndexedDB pipeline (persist -> reload -> retrieve -> verify bytes)
 * against a valid WAV fixture, using an in-memory IndexedDB stand-in.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  baseMimeType,
  blobTypeMismatch,
  buildFinalAudio,
  classifyChunk,
  extensionForMimeType,
  pickRecordingMimeType,
  rescueFileName,
  resolveFinalMimeType,
  sniffAudioMimeType,
  sniffBlobMimeType,
} from "@/src/lib/lecture/audioMime";
import {
  appendChunk,
  clearChunks,
  deleteRecordingAll,
  deleteRecordingMeta,
  deleteSession,
  getAudio,
  listChunks,
  listRecordings,
  listSessions,
  saveAudio,
  saveRecordingMeta,
  saveSession,
} from "@/src/lib/lecture/audioStore";
import type {
  LectureSession,
  LocalRecording,
} from "@/src/lib/lecture/types";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(join(HERE, "fixtures", "sample.wav"));

// ------------------------------------------------------- fake IndexedDB

type FakeRow = Record<string, unknown>;
type FakeHandler = ((event?: unknown) => void) | null;

type FakeRequest = {
  result: unknown;
  error: null;
  onsuccess: FakeHandler;
  onerror: FakeHandler;
};

type FakeStoreState = { keyPath: string; rows: Map<string, FakeRow> };

const fakeStores = new Map<string, FakeStoreState>();
let fakeUpgraded = false;

function fakeRequest(result: unknown): FakeRequest {
  const request: FakeRequest = {
    result,
    error: null,
    onsuccess: null,
    onerror: null,
  };

  // Fire async: audioStore assigns handlers synchronously after the call.
  queueMicrotask(() => request.onsuccess?.({}));

  return request;
}

function fakeObjectStore(state: FakeStoreState) {
  return {
    put(value: FakeRow): FakeRequest {
      const key = String(value[state.keyPath] ?? "");
      state.rows.set(key, value);

      return fakeRequest(undefined);
    },
    get(key: string): FakeRequest {
      return fakeRequest(state.rows.get(String(key)));
    },
    getAll(): FakeRequest {
      return fakeRequest([...state.rows.values()]);
    },
    delete(key: string): FakeRequest {
      state.rows.delete(String(key));

      return fakeRequest(undefined);
    },
  };
}

function fakeDb() {
  return {
    objectStoreNames: {
      contains: (name: string) => fakeStores.has(name),
    },
    createObjectStore(name: string, options: { keyPath: string }) {
      fakeStores.set(name, { keyPath: options.keyPath, rows: new Map() });
    },
    transaction(name: string) {
      const state = fakeStores.get(name);
      let completed: FakeHandler = null;
      const tx = {
        objectStore: () => {
          if (!state) throw new Error(`missing store ${name}`);

          return fakeObjectStore(state);
        },
        // Fire only once the handler is attached: clearChunks assigns
        // oncomplete after awaiting getAll, so an eager fire would hang.
        set oncomplete(handler: FakeHandler) {
          completed = handler;
          queueMicrotask(() => completed?.({}));
        },
        get oncomplete(): FakeHandler {
          return completed;
        },
        onerror: null as FakeHandler,
      };

      return tx;
    },
    close() {},
  };
}

function installFakeIndexedDB() {
  const fake = {
    open() {
      const request = {
        result: null as unknown,
        error: null,
        onupgradeneeded: null as FakeHandler,
        onsuccess: null as FakeHandler,
        onerror: null as FakeHandler,
      };

      queueMicrotask(() => {
        if (!fakeUpgraded) {
          fakeUpgraded = true;
          request.result = fakeDb();
          request.onupgradeneeded?.({});
        }

        request.result = fakeDb();
        request.onsuccess?.({});
      });

      return request;
    },
  };

  (globalThis as { indexedDB?: unknown }).indexedDB = fake;
}

function resetFakeDb() {
  fakeStores.clear();
  fakeUpgraded = false;
}

function seedFakeRow(store: string, row: FakeRow) {
  fakeStores.get(store)?.rows.set(String(row.id ?? row.key ?? ""), row);
}

function makeMeta(overrides: Partial<LocalRecording> = {}): LocalRecording {
  return {
    id: "rec-1",
    sessionId: null,
    courseId: null,
    title: "Vorlesung 7",
    language: "de",
    mimeType: "audio/wav",
    durationSeconds: 1,
    sizeBytes: FIXTURE.length,
    sha256: "",
    status: "saved_locally",
    errorCode: "",
    consentAt: "2026-11-03T10:00:00.000Z",
    createdAt: "2026-11-03T10:00:00.000Z",
    updatedAt: "2026-11-03T10:00:00.000Z",
    ...overrides,
  };
}

function makeSession(overrides: Partial<LectureSession> = {}): LectureSession {
  return {
    id: "session-1",
    courseId: null,
    title: "Sitzung",
    createdAt: "2026-11-03T10:00:00.000Z",
    updatedAt: "2026-11-03T10:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------- fixture

describe("lecture audio fixture", () => {
  it("sample.wav is a valid PCM WAV file", () => {
    assert.equal(FIXTURE.subarray(0, 4).toString("ascii"), "RIFF");
    assert.equal(FIXTURE.subarray(8, 12).toString("ascii"), "WAVE");
    assert.equal(FIXTURE.subarray(12, 16).toString("ascii"), "fmt ");
    assert.equal(FIXTURE.readUInt16LE(20), 1); // PCM
    assert.equal(FIXTURE.subarray(36, 40).toString("ascii"), "data");
    assert.equal(FIXTURE.readUInt32LE(40), FIXTURE.length - 44);
    assert.equal(FIXTURE.readUInt32LE(4), FIXTURE.length - 8);
  });
});

// -------------------------------------------------------------- audioMime

describe("audioMime", () => {
  it("strips codec parameters and lowercases", () => {
    assert.equal(baseMimeType("audio/webm;codecs=opus"), "audio/webm");
    assert.equal(baseMimeType("Audio/MP4"), "audio/mp4");
    assert.equal(baseMimeType(""), "");
  });

  it("maps honest extensions and never invents containers", () => {
    assert.equal(extensionForMimeType("audio/webm;codecs=opus"), ".webm");
    assert.equal(extensionForMimeType("audio/mp4"), ".m4a");
    assert.equal(extensionForMimeType("audio/ogg"), ".ogg");
    assert.equal(extensionForMimeType("audio/wav"), ".wav");
    assert.equal(extensionForMimeType("audio/mpeg"), ".mp3");
    assert.equal(extensionForMimeType(""), ".bin");
    assert.equal(extensionForMimeType("video/h264"), ".bin");
  });

  it("classifies chunks: only empty/missing drop, and visibly", () => {
    assert.deepEqual(classifyChunk(null), { keep: false, reason: "missing" });
    assert.deepEqual(classifyChunk(undefined), {
      keep: false,
      reason: "missing",
    });
    assert.deepEqual(classifyChunk(new Blob([])), {
      keep: false,
      reason: "empty",
    });
    assert.deepEqual(classifyChunk(new Blob(["x"])), {
      keep: true,
      reason: "ok",
    });
  });

  it("resolves the honest container: recorder > chunks > metadata", () => {
    assert.equal(
      resolveFinalMimeType({
        metaMime: "audio/webm",
        recorderMime: "audio/mp4",
        chunkTypes: ["audio/ogg"],
      }),
      "audio/mp4",
    );
    assert.equal(
      resolveFinalMimeType({
        metaMime: "",
        recorderMime: "",
        chunkTypes: ["", "audio/mp4"],
      }),
      "audio/mp4",
    );
    assert.equal(
      resolveFinalMimeType({
        metaMime: "audio/webm",
        recorderMime: "",
        chunkTypes: [""],
      }),
      "audio/webm",
    );
    // Unknown browser default stays unknown — never hardcoded.
    assert.equal(
      resolveFinalMimeType({ metaMime: "", recorderMime: "", chunkTypes: [] }),
      "",
    );
  });

  it("assembles the final Blob without losing bytes", async () => {
    const blob = buildFinalAudio(
      [new Blob(["ab"]), new Blob(["cd"])],
      "audio/webm",
    );

    assert.equal(blob.size, 4);
    assert.equal(blob.type, "audio/webm");
    assert.equal(await blob.text(), "abcd");
  });

  it("sniffs containers from magic bytes", () => {
    const bytes = (...values: number[]) => new Uint8Array(values);

    assert.equal(
      sniffAudioMimeType(
        bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45),
      ),
      "audio/wav",
    );
    assert.equal(
      sniffAudioMimeType(bytes(0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70, 0, 0, 0, 0)),
      "audio/mp4",
    );
    assert.equal(
      sniffAudioMimeType(bytes(0x4f, 0x67, 0x67, 0x53)),
      "audio/ogg",
    );
    assert.equal(
      sniffAudioMimeType(bytes(0x1a, 0x45, 0xdf, 0xa3)),
      "audio/webm",
    );
    assert.equal(sniffAudioMimeType(bytes(0x49, 0x44, 0x33)), "audio/mpeg");
    assert.equal(sniffAudioMimeType(bytes(0xff, 0xfb)), "audio/mpeg");
    assert.equal(sniffAudioMimeType(bytes(0xff, 0xf1)), "audio/aac");
    assert.equal(
      sniffAudioMimeType(bytes(0x66, 0x4c, 0x61, 0x43)),
      "audio/flac",
    );
    assert.equal(sniffAudioMimeType(bytes(0, 1, 2, 3)), "");
    assert.equal(sniffAudioMimeType(bytes(0xff)), "");
  });

  it("sniffs the WAV fixture as audio/wav", async () => {
    const blob = new Blob([FIXTURE], { type: "" });

    assert.equal(await sniffBlobMimeType(blob), "audio/wav");
  });

  it("builds rescue filenames with honest extensions", () => {
    assert.equal(rescueFileName("Java, Vorlesung 7", "audio/mp4"), "Java, Vorlesung 7.m4a");
    assert.equal(rescueFileName("a/b:c", "audio/webm"), "a_b_c.webm");
    assert.equal(rescueFileName("", ""), "aufnahme.bin");
  });

  it("detects blob/metadata container mismatches", () => {
    assert.equal(
      blobTypeMismatch(new Blob(["x"], { type: "audio/wav" }), "audio/webm"),
      true,
    );
    assert.equal(
      blobTypeMismatch(
        new Blob(["x"], { type: "audio/webm;codecs=opus" }),
        "audio/webm",
      ),
      false,
    );
    assert.equal(blobTypeMismatch(new Blob(["x"]), "audio/webm"), false);
  });

  it("picks no MIME type outside the browser", () => {
    assert.equal(pickRecordingMimeType(), "");
  });
});

// -------------------------------------------------------------- audioStore

describe("lecture audioStore pipeline", () => {
  beforeEach(() => {
    resetFakeDb();
    installFakeIndexedDB();
  });

  afterEach(() => {
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
    resetFakeDb();
  });

  it("persists audio and retrieves identical bytes after reload", async () => {
    const blob = new Blob([FIXTURE], { type: "audio/wav" });

    await saveAudio("rec-1", blob);

    // "Reload": every call opens a fresh connection over shared rows.
    const loaded = await getAudio("rec-1");

    assert.ok(loaded instanceof Blob);
    assert.equal(loaded.size, FIXTURE.length);
    assert.equal(loaded.type, "audio/wav");
    assert.deepEqual(Buffer.from(await loaded.arrayBuffer()), FIXTURE);
  });

  it("reports missing audio as null (no fake player data)", async () => {
    assert.equal(await getAudio("does-not-exist"), null);
  });

  it("refuses to persist empty audio", async () => {
    await assert.rejects(() => saveAudio("rec-empty", new Blob([])));
    assert.equal(await getAudio("rec-empty"), null);
  });

  it("treats a legacy zero-byte row as missing", async () => {
    await saveRecordingMeta(makeMeta({ id: "rec-legacy" }));
    seedFakeRow("audio", {
      id: "rec-legacy",
      blob: new Blob([], { type: "audio/webm" }),
    });

    assert.equal(await getAudio("rec-legacy"), null);
  });

  it("keeps chunk order and bytes, scoped per recording", async () => {
    const parts = [
      new Blob([FIXTURE.subarray(0, 1000)], { type: "audio/wav" }),
      new Blob([FIXTURE.subarray(1000, 3000)], { type: "audio/wav" }),
      new Blob([FIXTURE.subarray(3000)], { type: "audio/wav" }),
    ];

    // Out-of-order writes must still read back in index order.
    await appendChunk("rec-1", 2, parts[2]!);
    await appendChunk("rec-1", 0, parts[0]!);
    await appendChunk("rec-1", 1, parts[1]!);
    await appendChunk("rec-2", 0, new Blob(["other"]));

    const chunks = await listChunks("rec-1");

    assert.equal(chunks.length, 3);
    assert.deepEqual(
      Buffer.from(await buildFinalAudio(chunks, "audio/wav").arrayBuffer()),
      FIXTURE,
    );

    await clearChunks("rec-1");
    assert.deepEqual(await listChunks("rec-1"), []);
    assert.equal((await listChunks("rec-2")).length, 1);
  });

  it("stores recording metadata newest-first and deletes it", async () => {
    await saveRecordingMeta(
      makeMeta({ id: "old", createdAt: "2026-11-01T10:00:00.000Z" }),
    );
    await saveRecordingMeta(
      makeMeta({ id: "new", createdAt: "2026-11-03T10:00:00.000Z" }),
    );

    assert.deepEqual(
      (await listRecordings()).map((entry) => entry.id),
      ["new", "old"],
    );

    await deleteRecordingMeta("new");
    assert.deepEqual(
      (await listRecordings()).map((entry) => entry.id),
      ["old"],
    );
  });

  it("stores sessions newest-first and deletes them", async () => {
    await saveSession(
      makeSession({ id: "a", updatedAt: "2026-11-01T10:00:00.000Z" }),
    );
    await saveSession(
      makeSession({ id: "b", updatedAt: "2026-11-03T10:00:00.000Z" }),
    );

    assert.deepEqual(
      (await listSessions()).map((entry) => entry.id),
      ["b", "a"],
    );

    await deleteSession("b");
    assert.deepEqual(
      (await listSessions()).map((entry) => entry.id),
      ["a"],
    );
  });

  it("deleteRecordingAll removes metadata, chunks, and audio", async () => {
    await saveRecordingMeta(makeMeta({ id: "rec-1" }));
    await appendChunk("rec-1", 0, new Blob(["x"]));
    await saveAudio("rec-1", new Blob([FIXTURE], { type: "audio/wav" }));

    await deleteRecordingAll("rec-1");

    assert.deepEqual(await listRecordings(), []);
    assert.deepEqual(await listChunks("rec-1"), []);
    assert.equal(await getAudio("rec-1"), null);
  });

  it("end-to-end: record chunks -> finalize -> reload -> metadata matches bytes", async () => {
    const meta = makeMeta({ id: "rec-e2e", mimeType: "" });

    await saveRecordingMeta({ ...meta, status: "recording" });

    const chunkTypes: string[] = [];
    const thirds = [0, 1, 2].map((part) => {
      const start = Math.floor((FIXTURE.length * part) / 3);
      const end = Math.floor((FIXTURE.length * (part + 1)) / 3);
      const chunk = new Blob([FIXTURE.subarray(start, end)], {
        type: "audio/wav",
      });
      chunkTypes.push(chunk.type);

      return chunk;
    });

    for (const [index, chunk] of thirds.entries()) {
      const verdict = classifyChunk(chunk);

      assert.equal(verdict.keep, true);
      await appendChunk(meta.id, index, chunk);
    }

    const effectiveMime = resolveFinalMimeType({
      metaMime: meta.mimeType,
      recorderMime: "",
      chunkTypes,
    });

    assert.equal(effectiveMime, "audio/wav");

    const stored = await listChunks(meta.id);
    const blob = buildFinalAudio(stored, effectiveMime);
    await saveAudio(meta.id, blob);
    await clearChunks(meta.id);
    await saveRecordingMeta({
      ...meta,
      mimeType: effectiveMime,
      sizeBytes: blob.size,
      status: "saved_locally",
    });

    // Reload: fresh reads, metadata must reference the stored bytes.
    const [recordings, reloaded] = await Promise.all([
      listRecordings(),
      getAudio(meta.id),
    ]);

    assert.equal(recordings.length, 1);
    assert.equal(recordings[0]?.id, meta.id);
    assert.equal(recordings[0]?.mimeType, "audio/wav");
    assert.ok(reloaded instanceof Blob);
    assert.equal(reloaded.size, recordings[0]?.sizeBytes);
    assert.deepEqual(Buffer.from(await reloaded.arrayBuffer()), FIXTURE);
    assert.equal(await sniffBlobMimeType(reloaded), "audio/wav");
  });

  it("exposes legacy mislabeled bytes for the player repair path", async () => {
    // Old bug shape: mp4/wav bytes stored under a hardcoded webm label.
    const legacy = new Blob([FIXTURE], { type: "audio/webm" });
    await saveAudio("rec-legacy", legacy);
    await saveRecordingMeta(makeMeta({ id: "rec-legacy", mimeType: "audio/webm" }));

    const reloaded = await getAudio("rec-legacy");

    assert.ok(reloaded instanceof Blob);
    assert.equal(blobTypeMismatch(reloaded, "audio/webm"), false); // label agrees…
    assert.equal(await sniffBlobMimeType(reloaded), "audio/wav"); // …but bytes are wav
    assert.notEqual(
      baseMimeType(await sniffBlobMimeType(reloaded)),
      baseMimeType(reloaded.type),
    );
    assert.deepEqual(Buffer.from(await reloaded.arrayBuffer()), FIXTURE);
  });
});

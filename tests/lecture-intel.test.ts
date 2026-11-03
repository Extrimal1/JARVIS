/**
 * Lecture intelligence contract: worker configuration states and
 * transcript validation. Without a reachable worker nothing is ever
 * transcribed — and nothing is ever faked.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isTranscript,
  transcriptionStatusFromEnv,
  workerAuthHeaders,
  type Transcript,
} from "@/src/lib/lecture/transcription";

function transcript(patch: Partial<Transcript> = {}): Transcript {
  return {
    recordingId: "r1",
    language: "de",
    segments: [{ start: 0, end: 4.5, text: "Hallo." }],
    fullText: "Hallo.",
    transcribedAt: "2026-11-03T10:00:00.000Z",
    ...patch,
  };
}

describe("worker configuration", () => {
  it("stays unconfigured without a usable URL", () => {
    for (const value of [undefined, null, "", "   ", "ftp://x"]) {
      const status = transcriptionStatusFromEnv(value);

      assert.equal(status.configured, false);
    }
  });

  it("normalizes http(s) worker URLs", () => {
    const status = transcriptionStatusFromEnv("https://worker:8123///");

    assert.equal(status.configured, true);
    assert.equal(
      status.configured && status.workerUrl,
      "https://worker:8123",
    );
  });

  it("sends auth headers only when a token exists", () => {
    assert.deepEqual(workerAuthHeaders("abc"), {
      Authorization: "Bearer abc",
    });
    assert.equal(workerAuthHeaders(undefined), undefined);
    assert.equal(workerAuthHeaders("   "), undefined);
  });
});

describe("transcript validation", () => {
  it("accepts well-formed worker responses", () => {
    assert.equal(isTranscript(transcript()), true);
    assert.equal(isTranscript(transcript({ segments: [] })), true);
  });

  it("rejects malformed worker responses", () => {
    assert.equal(isTranscript(null), false);
    assert.equal(isTranscript({ ...transcript(), fullText: 42 }), false);
    assert.equal(
      isTranscript({
        ...transcript(),
        segments: [{ start: "0", end: 1, text: "x" }],
      }),
      false,
    );
    assert.equal(
      isTranscript({ ...transcript(), segments: "Hallo." }),
      false,
    );
    assert.equal(isTranscript({ ...transcript(), recordingId: 7 }), false);
  });
});

"use client";

import { useEffect, useRef, useState } from "react";
import { Pause, Play, RotateCcw, Volume2, VolumeX } from "lucide-react";
import { getAudio } from "@/src/lib/lecture/audioStore";
import {
  baseMimeType,
  blobTypeMismatch,
  sniffBlobMimeType,
} from "@/src/lib/lecture/audioMime";
import { formatDuration } from "@/src/lib/lecture/types";

const SPEEDS = [1, 1.25, 1.5, 2] as const;

type Status = "loading" | "ready" | "missing" | "error";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1).replace(".", ",")} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
}

/**
 * Per-recording audio player backed by IndexedDB.
 *
 * Loads the stored bytes on mount (so replay works after reload,
 * navigation, or reopen), owns exactly one object URL with strict
 * cleanup, and never renders fake controls when the audio is
 * missing or undecodable.
 */
export function RecordingPlayer({
  recordingId,
  title,
  metaMimeType,
  fallbackDurationSeconds,
  onMimeRepair,
}: {
  recordingId: string;
  title: string;
  metaMimeType: string;
  fallbackDurationSeconds: number;
  /** Persist a corrected container label (bytes stay untouched). */
  onMimeRepair?: (actualMime: string) => void;
}) {
  const [status, setStatus] = useState<Status>("loading");
  const [url, setUrl] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState<number>(1);
  const [blobInfo, setBlobInfo] = useState({ size: 0, type: "" });
  const [reloadKey, setReloadKey] = useState(0);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const blobRef = useRef<Blob | null>(null);
  const repairedRef = useRef(false);
  const metaMimeRef = useRef(metaMimeType);
  const repairRef = useRef(onMimeRepair);

  // Pause the previous element when React detaches or replaces it, so
  // unmounts never leave audio playing after the URL is revoked.
  function attachAudio(node: HTMLAudioElement | null) {
    const prev = audioRef.current;

    if (prev !== null && prev !== node) prev.pause();

    audioRef.current = node;
  }

  function retry() {
    setStatus("loading");
    setDetail(null);
    setUrl(null);
    setCurrentTime(0);
    setDuration(0);
    setPlaying(false);
    setReloadKey((key) => key + 1);
  }

  // Load bytes from IndexedDB; exactly one object URL per mount.
  // The parent keys this component by recording id, so a new recording
  // always starts from the initial state above — no reset needed here.
  useEffect(() => {
    let cancelled = false;
    repairedRef.current = false;
    blobRef.current = null;
    metaMimeRef.current = metaMimeType;
    repairRef.current = onMimeRepair;

    void getAudio(recordingId).then(
      (blob) => {
        if (cancelled) return;

        if (blob === null) {
          setStatus("missing");
          return;
        }

        // Stored bytes declare their own container; when it honestly
        // differs from old metadata, offer the correction upward.
        if (blobTypeMismatch(blob, metaMimeRef.current)) {
          repairRef.current?.(blob.type);
        }

        blobRef.current = blob;
        const objectUrl = URL.createObjectURL(blob);
        urlRef.current = objectUrl;
        setBlobInfo({ size: blob.size, type: blob.type });
        setUrl(objectUrl);
        setStatus("ready");
      },
      () => {
        if (cancelled) return;

        setDetail("Das Audio konnte nicht aus dem lokalen Speicher geladen werden.");
        setStatus("error");
      },
    );

    return () => {
      cancelled = true;

      if (urlRef.current !== null) {
        URL.revokeObjectURL(urlRef.current);
        urlRef.current = null;
      }

      blobRef.current = null;
    };
    // State callbacks stay stable by id; repair props flow via refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordingId, reloadKey]);

  // One legacy rescue: recordings whose metadata/Blob label lied about
  // the container (e.g. mp4 bytes labeled webm) are re-wrapped with the
  // sniffed container — same bytes, honest label — and retried once.
  async function repairBySniffing(): Promise<boolean> {
    const blob = blobRef.current;

    if (blob === null || repairedRef.current) return false;

    repairedRef.current = true;
    const sniffed = await sniffBlobMimeType(blob);
    const current = blob.type !== "" ? blob.type : metaMimeRef.current;

    if (
      sniffed === "" ||
      baseMimeType(sniffed) === baseMimeType(current)
    ) {
      return false;
    }

    const rewrapped = new Blob([blob], { type: sniffed });
    const objectUrl = URL.createObjectURL(rewrapped);

    if (urlRef.current !== null) URL.revokeObjectURL(urlRef.current);

    urlRef.current = objectUrl;
    setBlobInfo({ size: rewrapped.size, type: rewrapped.type });
    setUrl(objectUrl);
    repairRef.current?.(sniffed);

    return true;
  }

  async function togglePlay() {
    const audio = audioRef.current;

    if (audio === null) return;

    if (audio.paused) {
      if (audio.ended) audio.currentTime = 0;

      try {
        await audio.play();
      } catch {
        setDetail(
          "Wiedergabe blockiert — tippe erneut auf Abspielen (Browser-Autoplay-Schutz).",
        );
      }
    } else {
      audio.pause();
    }
  }

  function seek(seconds: number) {
    const audio = audioRef.current;

    if (audio === null || !Number.isFinite(seconds)) return;

    audio.currentTime = Math.max(0, Math.min(seconds, duration));
    setCurrentTime(audio.currentTime);
  }

  function changeVolume(next: number) {
    const audio = audioRef.current;
    const clamped = Math.max(0, Math.min(1, next));

    setVolume(clamped);
    setMuted(clamped === 0);

    if (audio !== null) {
      audio.volume = clamped;
      audio.muted = clamped === 0;
    }
  }

  function toggleMute() {
    const audio = audioRef.current;
    const next = !muted;

    setMuted(next);

    if (audio !== null) audio.muted = next;
  }

  function changeRate(next: number) {
    const audio = audioRef.current;

    setRate(next);

    if (audio !== null) audio.playbackRate = next;
  }

  if (status === "loading") {
    return (
      <p aria-live="polite" className="mt-3 text-xs text-slate-500">
        Audio wird geladen …
      </p>
    );
  }

  // Missing audio: honest message, no fake player controls.
  if (status === "missing") {
    return (
      <p role="status" className="mt-3 rounded-xl border border-white/10 bg-black/20 p-3 text-xs leading-5 text-slate-400">
        „{title}“: kein Audio gespeichert (nur Metadaten vorhanden).
      </p>
    );
  }

  if (status === "error") {
    return (
      <div role="alert" className="mt-3 rounded-xl border border-rose-400/30 bg-rose-400/5 p-4">
        <p className="text-xs leading-5 text-rose-200">
          „{title}“ kann nicht abgespielt werden.
          {detail !== null ? ` ${detail}` : ""}
        </p>
        <button
          onClick={retry}
          className="mt-3 flex items-center gap-2 rounded-xl border border-rose-300/30 px-3 py-2 text-xs text-rose-100 transition hover:bg-rose-400/10"
        >
          <RotateCcw size={13} />
          Erneut versuchen
        </button>
      </div>
    );
  }

  const effectiveDuration =
    duration > 0 ? duration : Math.max(0, fallbackDurationSeconds);
  const ended =
    effectiveDuration > 0 && currentTime >= effectiveDuration - 0.25;

  return (
    <div className="mt-3 rounded-xl border border-white/[0.07] bg-black/20 p-3">
      <audio
        ref={attachAudio}
        key={url ?? "no-url"}
        src={url ?? undefined}
        preload="metadata"
        onLoadedMetadata={(event) => {
          const audio = event.currentTarget;
          const probed =
            Number.isFinite(audio.duration) && audio.duration > 0
              ? audio.duration
              : 0;

          setDuration(probed);
          audio.volume = volume;
          audio.muted = muted;
          audio.playbackRate = rate;
        }}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
        onPlay={() => {
          setPlaying(true);
          setDetail(null);
        }}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onError={() => {
          void repairBySniffing().then((repaired) => {
            if (repaired) return;

            const container =
              blobInfo.type !== "" ? blobInfo.type : metaMimeRef.current;
            setDetail(
              container !== ""
                ? `Das Format (${container}) wird von diesem Browser nicht unterstützt oder die Daten sind beschädigt.`
                : "Das Format wird von diesem Browser nicht unterstützt oder die Daten sind beschädigt.",
            );
            setStatus("error");
          });
        }}
      />

      {detail !== null && (
        <p role="alert" className="mb-2 text-xs leading-5 text-amber-200">
          {detail}
        </p>
      )}

      <div className="flex items-center gap-2">
        <button
          onClick={() => void togglePlay()}
          aria-label={playing ? `Pause: ${title}` : ended ? `Erneut abspielen: ${title}` : `Abspielen: ${title}`}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-cyan-300 text-slate-950 transition hover:bg-cyan-200"
        >
          {playing ? <Pause size={15} /> : <Play size={15} />}
        </button>

        <span aria-live="off" className="shrink-0 text-xs tabular-nums text-slate-400">
          {formatDuration(currentTime)} / {formatDuration(effectiveDuration)}
        </span>

        <div role="group" aria-label="Wiedergabegeschwindigkeit" className="ml-auto flex shrink-0 gap-1">
          {SPEEDS.map((speed) => (
            <button
              key={speed}
              onClick={() => changeRate(speed)}
              aria-pressed={rate === speed}
              aria-label={`${String(speed).replace(".", ",")}fache Geschwindigkeit`}
              className={`rounded-lg px-2 py-1 text-[11px] tabular-nums transition ${
                rate === speed
                  ? "bg-cyan-300/20 text-cyan-200"
                  : "text-slate-500 hover:bg-white/5 hover:text-slate-300"
              }`}
            >
              {speed}×
            </button>
          ))}
        </div>
      </div>

      <input
        type="range"
        min={0}
        max={effectiveDuration}
        step={0.1}
        value={Math.min(currentTime, effectiveDuration)}
        disabled={effectiveDuration <= 0}
        onChange={(event) => seek(Number(event.target.value))}
        aria-label={`Position: ${title}`}
        className="mt-2 w-full accent-cyan-300 disabled:opacity-40"
      />

      <div className="mt-1 flex items-center gap-2">
        <button
          onClick={toggleMute}
          aria-label={muted ? "Ton einschalten" : "Ton ausschalten"}
          className="rounded-lg p-1.5 text-slate-500 transition hover:bg-white/5 hover:text-slate-200"
        >
          {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
        </button>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={muted ? 0 : volume}
          onChange={(event) => changeVolume(Number(event.target.value))}
          aria-label={`Lautstärke: ${title}`}
          className="w-28 accent-cyan-300"
        />
        <span className="ml-auto text-[11px] tabular-nums text-slate-600">
          {(blobInfo.type !== "" ? baseMimeType(blobInfo.type) : baseMimeType(metaMimeType)) || "unbekanntes Format"}
          {" · "}
          {formatBytes(blobInfo.size)}
        </span>
      </div>
    </div>
  );
}

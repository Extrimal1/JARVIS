"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Download,
  GitMerge,
  Pencil,
  Plus,
  Scissors,
  Trash2,
} from "lucide-react";
import {
  listDocuments,
  type DocumentMeta,
} from "@/src/lib/db/documents";
import { createId } from "@/src/lib/ids";
import type { Entry, StudyData, TopicMastery } from "@/src/lib/study";
import type { QuizQuestion } from "@/src/lib/quiz";
import type { ListResource } from "@/src/lib/db/useRemoteResource";
import type { StudyResource } from "@/src/lib/db/useModules";
import {
  mergeTopicsManual,
  removeTopic,
  renameTopic,
  splitTopic,
} from "@/src/lib/study/topics";
import { extractDocumentTopics } from "@/src/lib/db/studyActions";
import {
  classifyTopicError,
  formatTopicSummary,
  runDocumentTopicExtraction,
  topicCauseLabel,
  type ClassifiedTopicError,
  type DocumentTopicSummary,
} from "@/src/lib/study/autoTopics";

const MASTERY_LABELS: Record<TopicMastery, string> = {
  "not-started": "Neu",
  learning: "Lernt",
  "needs-revision": "Wiederholen",
  understood: "Verstanden",
  mastered: "Gemeistert",
};

const MASTERY_STYLES: Record<TopicMastery, string> = {
  "not-started": "bg-white/[0.05] text-slate-400",
  learning: "bg-cyan-300/[0.08] text-cyan-200",
  "needs-revision": "bg-amber-300/[0.08] text-amber-200",
  understood: "bg-emerald-300/[0.08] text-emerald-200",
  mastered: "bg-violet-300/[0.08] text-violet-200",
};

const PRIORITY_LABELS = { high: "Wichtig", normal: "Normal", low: "Später" } as const;

type DocExtractNote = {
  docId: string;
  name: string;
  covered: string[];
  done: boolean;
  insufficient: boolean;
};

type ExtractState = {
  combined: DocumentTopicSummary;
  perDoc: DocExtractNote[];
  /** Names of subject docs skipped (not fully processed). */
  skippedDocs: string[];
  /** Names of docs without enough text for topics. */
  insufficientDocs: string[];
  done: boolean;
};

/**
 * Topic tree: nested extracted topics with rename/merge/split/
 * remove, priority editing, mastery chips, and source refs.
 * Every structural edit reassigns linked questions — nothing
 * linked is ever deleted. Extraction runs per subject across
 * its documents and merges without duplicates.
 */
export function TopicTree({
  data,
  studyStore,
  quizStore,
}: {
  data: StudyData;
  studyStore: StudyResource;
  quizStore: ListResource<QuizQuestion>;
}) {
  const [docs, setDocs] = useState<DocumentMeta[]>([]);
  const [subject, setSubject] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [merging, setMerging] = useState(false);
  const [mergeIds, setMergeIds] = useState<string[]>([]);
  const [splitting, setSplitting] = useState<string | null>(null);
  const [splitParts, setSplitParts] = useState<string[]>(["", ""]);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [docsError, setDocsError] = useState<string | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [extract, setExtract] = useState<ExtractState | null>(null);
  const [extractProgress, setExtractProgress] = useState<string | null>(null);
  const [extractError, setExtractError] =
    useState<ClassifiedTopicError | null>(null);
  const [locale, setLocale] = useState<"de" | "ru">("de");

  useEffect(() => {
    // Post-mount locale detection (SSR renders "de" first).
    if (
      typeof navigator !== "undefined" &&
      navigator.language.toLowerCase().startsWith("ru")
    ) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLocale("ru");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    listDocuments()
      .then((items) => {
        if (cancelled) return;

        setDocs(items);
        setDocsError(null);
      })
      .catch((loadError: unknown) => {
        if (cancelled) return;

        setDocs([]);
        setDocsError(
          loadError instanceof Error
            ? loadError.message
            : "Dokumente konnten nicht geladen werden.",
        );
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const activeSubject = subject !== "" ? subject : (data.subjects[0]?.title ?? "");
  const subjectDocs = useMemo(
    () => docs.filter((doc) => doc.subject === activeSubject),
    [docs, activeSubject],
  );
  const completedDocs = useMemo(
    () =>
      subjectDocs.filter((doc) => doc.extractionStatus === "completed"),
    [subjectDocs],
  );
  const subjectTopics = useMemo(
    () => data.topics.filter((topic) => topic.subject === activeSubject),
    [data.topics, activeSubject],
  );

  const childrenOf = useMemo(() => {
    const map = new Map<string, Entry[]>();
    const ids = new Set(subjectTopics.map((topic) => topic.id));

    for (const topic of subjectTopics) {
      if (topic.parentId === undefined || topic.parentId === null) continue;
      if (!ids.has(topic.parentId)) continue;

      const list = map.get(topic.parentId) ?? [];

      list.push(topic);
      map.set(topic.parentId, list);
    }

    for (const list of map.values()) {
      list.sort((a, b) => a.title.localeCompare(b.title, "de"));
    }

    return map;
  }, [subjectTopics]);

  const roots = useMemo(() => {
    const ids = new Set(subjectTopics.map((topic) => topic.id));

    return subjectTopics
      .filter(
        (topic) =>
          topic.parentId === undefined ||
          topic.parentId === null ||
          !ids.has(topic.parentId),
      )
      .sort((a, b) => a.title.localeCompare(b.title, "de"));
  }, [subjectTopics]);

  async function applyQuestionPatches(
    patches: { id: string; topicId: string | null }[],
  ) {
    for (const patch of patches) {
      await quizStore.update(patch.id, { topicId: patch.topicId });
    }
  }

  async function applyRename(topic: Entry) {
    const renamed = renameTopic(data.topics, topic.id, renameValue);

    if (!renamed.ok) {
      setError(renamed.error);

      return;
    }

    setBusy(true);
    setError(null);

    try {
      await studyStore.updateEntry(topic.id, { title: renameValue.trim() });
      setRenaming(null);
    } catch (renameError) {
      setError(
        renameError instanceof Error ? renameError.message : "Umbenennen fehlgeschlagen.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function applyMerge() {
    const merged = mergeTopicsManual(
      data.topics,
      quizStore.items,
      mergeIds,
      mergeIds[0],
    );

    if (!merged.ok) {
      setError(merged.error);

      return;
    }

    setBusy(true);
    setError(null);

    try {
      const survivor = merged.result.entries.find(
        (entry) => entry.id === mergeIds[0],
      );

      if (survivor !== undefined) {
        await studyStore.updateEntry(survivor.id, {
          title: survivor.title,
          detail: survivor.detail,
          parentId: survivor.parentId ?? null,
          sourceRefs: survivor.sourceRefs ?? [],
          topicData: survivor.topicData,
        });
      }

      for (const entry of merged.result.entries) {
        const before = data.topics.find((item) => item.id === entry.id);

        if (
          before !== undefined &&
          entry.id !== mergeIds[0] &&
          before.parentId !== entry.parentId
        ) {
          await studyStore.updateEntry(entry.id, {
            parentId: entry.parentId ?? null,
          });
        }
      }

      await applyQuestionPatches(merged.result.questionPatches);

      for (const id of merged.result.removedIds) {
        await studyStore.deleteEntry("topics", id);
      }

      setMerging(false);
      setMergeIds([]);
    } catch (mergeError) {
      setError(
        mergeError instanceof Error ? mergeError.message : "Verbinden fehlgeschlagen.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function applySplit(topic: Entry) {
    const parts = splitParts
      .map((title) => title.trim())
      .filter((title) => title !== "")
      .map((title) => ({ title }));
    const split = splitTopic(
      data.topics,
      quizStore.items,
      topic.id,
      parts,
      createId,
    );

    if (!split.ok) {
      setError(split.error);

      return;
    }

    setBusy(true);
    setError(null);

    try {
      const created = split.result.entries.filter(
        (entry) => !data.topics.some((item) => item.id === entry.id),
      );

      for (const entry of created) {
        await studyStore.addEntry("topics", entry);
      }

      for (const entry of split.result.entries) {
        const before = data.topics.find((item) => item.id === entry.id);

        if (
          before !== undefined &&
          entry.id !== topic.id &&
          before.parentId !== entry.parentId
        ) {
          await studyStore.updateEntry(entry.id, {
            parentId: entry.parentId ?? null,
          });
        }
      }

      await applyQuestionPatches(split.result.questionPatches);
      await studyStore.deleteEntry("topics", topic.id);
      setSplitting(null);
      setSplitParts(["", ""]);
    } catch (splitError) {
      setError(
        splitError instanceof Error ? splitError.message : "Teilen fehlgeschlagen.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function applyDelete(topic: Entry) {
    const removed = removeTopic(data.topics, quizStore.items, topic.id);

    if (!removed.ok) {
      setError(removed.error);

      return;
    }

    setBusy(true);
    setError(null);

    try {
      for (const entry of removed.result.entries) {
        const before = data.topics.find((item) => item.id === entry.id);

        if (before !== undefined && before.parentId !== entry.parentId) {
          await studyStore.updateEntry(entry.id, {
            parentId: entry.parentId ?? null,
          });
        }
      }

      await applyQuestionPatches(removed.result.questionPatches);
      await studyStore.deleteEntry("topics", topic.id);
      setDeleting(null);
    } catch (deleteError) {
      setError(
        deleteError instanceof Error ? deleteError.message : "Löschen fehlgeschlagen.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function applyPriority(
    topic: Entry,
    priority: "high" | "normal" | "low",
  ) {
    setBusy(true);
    setError(null);

    try {
      await studyStore.updateEntry(topic.id, {
        topicData: {
          concepts: topic.topicData?.concepts ?? [],
          formulas: topic.topicData?.formulas ?? [],
          examples: topic.topicData?.examples ?? [],
          prerequisites: topic.topicData?.prerequisites ?? [],
          priority,
        },
      });
    } catch (priorityError) {
      setError(
        priorityError instanceof Error
          ? priorityError.message
          : "Speichern fehlgeschlagen.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function runExtraction(options?: { resetCovered?: boolean }) {
    if (extracting || activeSubject === "") return;

    const resetCovered = options?.resetCovered === true;

    const ready = completedDocs;
    const skipped = subjectDocs.filter(
      (doc) => doc.extractionStatus !== "completed",
    );

    if (ready.length === 0) {
      setExtract({
        combined: {
          documentId: "",
          created: 0,
          merged: 0,
          droppedInvalid: 0,
          droppedUngrounded: 0,
          spansDone: [],
          skippedSpans: [],
          exhaustedLabels: [],
          insufficient: false,
          done: true,
        },
        perDoc: [],
        skippedDocs: skipped.map((doc) => doc.name),
        insufficientDocs: [],
        done: true,
      });

      return;
    }

    setExtracting(true);
    setExtractError(null);

    try {
      // Working list threads through every doc: merges never see
      // stale render-time state, retries stay duplicate-safe.
      // Counts seed from the previous run so resumed docs keep
      // their history (subject change resets via setExtract(null)).
      let working = data.topics.map((entry) => ({ ...entry }));
      const seed = extract?.combined;
      const combined: DocumentTopicSummary = {
        documentId: "",
        created: seed?.created ?? 0,
        merged: seed?.merged ?? 0,
        droppedInvalid: seed?.droppedInvalid ?? 0,
        droppedUngrounded: seed?.droppedUngrounded ?? 0,
        spansDone: [],
        skippedSpans: [],
        exhaustedLabels: [],
        insufficient: false,
        done: true,
      };
      const perDoc: DocExtractNote[] = [];
      const insufficientDocs: string[] = [];

      for (const doc of ready) {
        const previous = resetCovered
          ? undefined
          : extract?.perDoc.find((note) => note.docId === doc.id);

        if (previous?.done === true) {
          perDoc.push(previous);
          continue;
        }

        setExtractProgress(`„${doc.name}“ wird ausgewertet …`);

        const summary = await runDocumentTopicExtraction({
          documentId: doc.id,
          subject: activeSubject,
          locale,
          topics: working,
          makeId: createId,
          initialCovered: previous?.covered,
          call: (coveredLabels, maxSpans) =>
            extractDocumentTopics(doc.id, locale, coveredLabels, maxSpans, fetch),
          store: studyStore,
          onProgress: (progress) => {
            setExtractProgress(
              `„${doc.name}“: ${progress.spansDone.length} Abschnitte · +${progress.created} neu, ${progress.merged} ergänzt`,
            );
          },
        });

        working = summary.topics;
        combined.created += summary.created;
        combined.merged += summary.merged;
        combined.droppedInvalid += summary.droppedInvalid;
        combined.droppedUngrounded += summary.droppedUngrounded;
        combined.skippedSpans.push(...summary.skippedSpans);
        combined.exhaustedLabels.push(...summary.exhaustedLabels);

        const noteDone =
          summary.done || summary.skippedSpans.length === 0;

        if (summary.insufficient) insufficientDocs.push(doc.name);
        if (!noteDone) combined.done = false;

        perDoc.push({
          docId: doc.id,
          name: doc.name,
          covered: summary.spansDone,
          done: noteDone,
          insufficient: summary.insufficient,
        });
      }

      setExtract({
        combined,
        perDoc,
        skippedDocs: skipped.map((doc) => doc.name),
        insufficientDocs,
        done: combined.done,
      });
    } catch (extractFailed) {
      setExtractError(classifyTopicError(extractFailed));
    } finally {
      setExtracting(false);
      setExtractProgress(null);
    }
  }

  function docName(documentId: string): string {
    return docs.find((doc) => doc.id === documentId)?.name ?? "Dokument";
  }

  function renderTopic(topic: Entry, depth: number) {
    const children = childrenOf.get(topic.id) ?? [];
    const isCollapsed = collapsed.has(topic.id);
    const mastery: TopicMastery = topic.mastery ?? "not-started";
    const questionCount = quizStore.items.filter(
      (question) => question.topicId === topic.id,
    ).length;
    const evidence = topic.masteryEvidence;

    return (
      <div key={topic.id}>
        <div
          className={`rounded-2xl border border-white/[0.05] bg-white/[0.02] p-3 ${
            depth > 0 ? "ml-4 border-l-2 border-l-cyan-300/20" : ""
          }`}
        >
          <div className="flex items-start gap-2">
            {merging && (
              <input
                type="checkbox"
                checked={mergeIds.includes(topic.id)}
                onChange={() =>
                  setMergeIds((current) =>
                    current.includes(topic.id)
                      ? current.filter((id) => id !== topic.id)
                      : [...current, topic.id],
                  )
                }
                aria-label={`Thema wählen: ${topic.title}`}
                className="mt-1 h-4 w-4 shrink-0 accent-cyan-300"
              />
            )}

            {children.length > 0 && (
              <button
                onClick={() =>
                  setCollapsed((current) => {
                    const next = new Set(current);

                    if (next.has(topic.id)) next.delete(topic.id);
                    else next.add(topic.id);

                    return next;
                  })
                }
                aria-label={isCollapsed ? "Aufklappen" : "Zuklappen"}
                aria-expanded={!isCollapsed}
                className="shrink-0 rounded-lg p-1 text-slate-500 hover:text-cyan-200"
              >
                {isCollapsed ? (
                  <ChevronRight size={15} />
                ) : (
                  <ChevronDown size={15} />
                )}
              </button>
            )}

            <div className="min-w-0 flex-1">
              {renaming === topic.id ? (
                <div className="flex gap-2">
                  <input
                    value={renameValue}
                    onChange={(event) => setRenameValue(event.target.value)}
                    aria-label="Themenname"
                    maxLength={160}
                    className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/20 px-3 py-1.5 text-sm text-white outline-none focus:border-cyan-300/50"
                  />
                  <button
                    onClick={() => void applyRename(topic)}
                    disabled={busy}
                    className="shrink-0 rounded-xl bg-cyan-300 px-3 py-1.5 text-xs font-medium text-slate-950 disabled:opacity-50"
                  >
                    OK
                  </button>
                  <button
                    onClick={() => setRenaming(null)}
                    className="shrink-0 rounded-xl border border-white/10 px-3 py-1.5 text-xs text-slate-300"
                  >
                    Abbr.
                  </button>
                </div>
              ) : (
                <p className="text-sm text-slate-200">{topic.title}</p>
              )}

              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] ${MASTERY_STYLES[mastery]}`}
                >
                  {MASTERY_LABELS[mastery]}
                </span>

                {evidence !== undefined && evidence.reviews > 0 && (
                  <span className="text-[10px] tabular-nums text-slate-500">
                    {evidence.quizAccuracy === null
                      ? "–"
                      : `${Math.round(evidence.quizAccuracy * 100)} %`}
                    {" · "}
                    {evidence.reviews}{" "}
                    {evidence.reviews === 1 ? "Antwort" : "Antworten"}
                  </span>
                )}

                <span className="text-[10px] text-slate-500">
                  {questionCount} {questionCount === 1 ? "Frage" : "Fragen"}
                </span>

                <select
                  value={topic.topicData?.priority ?? "normal"}
                  onChange={(event) =>
                    void applyPriority(
                      topic,
                      event.target.value as "high" | "normal" | "low",
                    )
                  }
                  disabled={busy}
                  aria-label={`Priorität: ${topic.title}`}
                  title="Priorität"
                  className="rounded-full border border-white/10 bg-black/20 px-2 py-0.5 text-[10px] text-slate-300 outline-none focus:border-cyan-300/50 disabled:opacity-50"
                >
                  {(Object.keys(PRIORITY_LABELS) as (keyof typeof PRIORITY_LABELS)[]).map(
                    (key) => (
                      <option key={key} value={key}>
                        {PRIORITY_LABELS[key]}
                      </option>
                    ),
                  )}
                </select>
              </div>

              {(topic.sourceRefs ?? []).length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {(topic.sourceRefs ?? []).slice(0, 4).map((ref, index) => (
                    <span
                      key={`${ref.documentId}-${ref.label}-${index}`}
                      title={docName(ref.documentId)}
                      className="rounded-full bg-white/[0.05] px-2 py-0.5 text-[10px] text-slate-400"
                    >
                      {ref.label}
                    </span>
                  ))}
                  {(topic.sourceRefs ?? []).length > 4 && (
                    <span className="text-[10px] text-slate-500">
                      +{(topic.sourceRefs ?? []).length - 4} weitere
                    </span>
                  )}
                </div>
              )}
            </div>

            <div className="flex shrink-0">
              <button
                onClick={() => {
                  setRenaming(topic.id);
                  setRenameValue(topic.title);
                }}
                aria-label={`Thema umbenennen: ${topic.title}`}
                title="Umbenennen"
                className="rounded-lg p-1.5 text-slate-500 transition hover:bg-cyan-300/10 hover:text-cyan-200"
              >
                <Pencil size={14} />
              </button>
              <button
                onClick={() => {
                  setSplitting(topic.id);
                  setSplitParts(["", ""]);
                }}
                aria-label={`Thema teilen: ${topic.title}`}
                title="Teilen"
                className="rounded-lg p-1.5 text-slate-500 transition hover:bg-cyan-300/10 hover:text-cyan-200"
              >
                <Scissors size={14} />
              </button>
              <button
                onClick={() =>
                  setDeleting(deleting === topic.id ? null : topic.id)
                }
                aria-label={`Thema entfernen: ${topic.title}`}
                title="Entfernen"
                className="rounded-lg p-1.5 text-slate-500 transition hover:bg-rose-400/10 hover:text-rose-300"
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>

          {splitting === topic.id && (
            <div className="jarvis-fade mt-2 space-y-2 rounded-2xl border border-cyan-300/15 bg-cyan-300/[0.03] p-3">
              {splitParts.map((part, index) => (
                <input
                  // Parts only append — indices stay stable.
                  key={index}
                  value={part}
                  onChange={(event) =>
                    setSplitParts((current) =>
                      current.map((entry, position) =>
                        position === index ? event.target.value : entry,
                      ),
                    )
                  }
                  placeholder={`Teil ${index + 1}`}
                  aria-label={`Teil ${index + 1}`}
                  maxLength={160}
                  className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none focus:border-cyan-300/50"
                />
              ))}

              <div className="flex gap-2">
                <button
                  onClick={() => setSplitParts((current) => [...current, ""])}
                  className="flex items-center gap-1 rounded-xl border border-white/10 px-3 py-2 text-xs text-slate-300"
                >
                  <Plus size={13} />
                  Teil
                </button>
                <button
                  onClick={() => void applySplit(topic)}
                  disabled={busy}
                  className="flex-1 rounded-xl bg-cyan-300 px-3 py-2 text-xs font-medium text-slate-950 disabled:opacity-50"
                >
                  Teilen
                </button>
                <button
                  onClick={() => setSplitting(null)}
                  className="rounded-xl border border-white/10 px-3 py-2 text-xs text-slate-300"
                >
                  Abbrechen
                </button>
              </div>

              <p className="text-[11px] leading-4 text-slate-500">
                Unterthemen und Fragen wandern zum ersten Teil und können
                danach verteilt werden.
              </p>
            </div>
          )}

          {deleting === topic.id && (
            <DeleteConfirm
              topic={topic}
              topics={data.topics}
              questions={quizStore.items}
              busy={busy}
              onCancel={() => setDeleting(null)}
              onConfirm={() => void applyDelete(topic)}
            />
          )}
        </div>

        {!isCollapsed &&
          children.map((child) => renderTopic(child, depth + 1))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-white/[0.05] bg-white/[0.02] p-4">
        <div className="flex flex-wrap items-center gap-2">
          <label className="min-w-0 flex-1 text-xs text-slate-400">
            Fach
            <select
              value={subject}
              onChange={(event) => {
                setSubject(event.target.value);
                setExtract(null);
              }}
              className="mt-1 w-full rounded-xl border border-white/10 bg-[#111827] px-3 py-2 text-sm text-white outline-none focus:border-cyan-300/50"
            >
              {data.subjects.map((entry) => (
                <option key={entry.id} value={entry.title}>
                  {entry.title}
                </option>
              ))}
            </select>
          </label>

          <button
            onClick={() => void runExtraction()}
            disabled={extracting || completedDocs.length === 0}
            title={
              subjectDocs.length === 0
                ? "Keine Dokumente mit diesem Fach verknüpft"
                : completedDocs.length === 0
                  ? "Noch kein Dokument dieses Fachs ist verarbeitet"
                  : "Themen aus den Dokumenten dieses Fachs extrahieren"
            }
            className="flex shrink-0 items-center gap-1 rounded-xl border border-white/10 px-3 py-2 text-xs text-slate-300 transition hover:border-cyan-300/30 disabled:opacity-50"
          >
            <Download size={14} />
            {extracting ? "Läuft …" : "Themen extrahieren"}
          </button>

          <button
            onClick={() => {
              setMerging((value) => !value);
              setMergeIds([]);
            }}
            aria-pressed={merging}
            className={`flex shrink-0 items-center gap-1 rounded-xl border px-3 py-2 text-xs transition ${
              merging
                ? "border-cyan-300/40 text-cyan-200"
                : "border-white/10 text-slate-300 hover:border-cyan-300/30"
            }`}
          >
            <GitMerge size={14} />
            Verbinden
          </button>
        </div>

        <p className="mt-2 text-[11px] text-slate-500">
          {subjectDocs.length} {subjectDocs.length === 1 ? "Dokument" : "Dokumente"} ·{" "}
          {subjectTopics.length} {subjectTopics.length === 1 ? "Thema" : "Themen"}
          {extract !== null && ` · ${formatTopicSummary(extract.combined)}`}
        </p>

        {extracting && extractProgress !== null && (
          <p role="status" className="mt-2 text-xs text-cyan-200">
            {extractProgress}
          </p>
        )}

        {docsError !== null && (
          <p role="alert" className="mt-2 text-xs text-rose-300">
            Dokumente konnten nicht geladen werden: {docsError}
          </p>
        )}

        {extract !== null && extract.skippedDocs.length > 0 && (
          <p
            className="mt-2 text-[11px] text-slate-500"
            title={extract.skippedDocs.join(", ")}
          >
            {extract.skippedDocs.length}{" "}
            {extract.skippedDocs.length === 1 ? "Dokument" : "Dokumente"} noch
            nicht verarbeitet — nur abgeschlossene werden extrahiert.
          </p>
        )}

        {extract !== null && extract.insufficientDocs.length > 0 && (
          <p
            className="mt-2 text-[11px] text-slate-500"
            title={extract.insufficientDocs.join(", ")}
          >
            Ohne ausreichenden Text für Themen:{" "}
            {extract.insufficientDocs.join(", ")}.
          </p>
        )}

        {extractError !== null && (
          <div role="alert" className="mt-2 flex flex-wrap items-center gap-2">
            <p className="min-w-0 flex-1 text-xs text-rose-300">
              Ursache: {topicCauseLabel(extractError.cause)} —{" "}
              {extractError.detail}
            </p>
            {extractError.retryable && !extracting && (
              <button
                onClick={() => void runExtraction()}
                className="shrink-0 rounded-xl border border-rose-300/30 px-3 py-1.5 text-xs text-rose-200 hover:bg-rose-400/10"
              >
                Erneut versuchen
              </button>
            )}
          </div>
        )}

        {extract !== null && !extract.done && !extracting && (
          <button
            onClick={() => void runExtraction()}
            className="mt-2 rounded-xl border border-cyan-300/30 px-3 py-2 text-xs text-cyan-200 hover:bg-cyan-300/10"
          >
            Weiter — restliche Abschnitte extrahieren
          </button>
        )}

        {extract !== null &&
          extract.done &&
          extract.combined.exhaustedLabels.length > 0 &&
          !extracting && (
            <button
              onClick={() => void runExtraction({ resetCovered: true })}
              title="Fehlerhafte Abschnitte werden neu angefragt; bereits gespeicherte Themen bleiben bestehen."
              className="mt-2 rounded-xl border border-amber-300/30 px-3 py-2 text-xs text-amber-200 hover:bg-amber-300/10"
            >
              Fehlerhafte Abschnitte erneut versuchen
            </button>
          )}

        {merging && (
          <div className="mt-2 flex flex-wrap items-center gap-2 rounded-xl border border-cyan-300/20 bg-cyan-300/[0.04] p-2">
            <p className="min-w-0 flex-1 text-[11px] text-slate-300">
              {mergeIds.length} {mergeIds.length === 1 ? "Thema" : "Themen"} gewählt
              {mergeIds.length > 0 &&
                " — das zuerst gewählte bleibt bestehen."}
            </p>
            <button
              onClick={() => void applyMerge()}
              disabled={busy || mergeIds.length < 2}
              className="rounded-lg bg-cyan-300 px-3 py-1.5 text-[11px] font-medium text-slate-950 disabled:opacity-50"
            >
              Verbinden
            </button>
            <button
              onClick={() => {
                setMerging(false);
                setMergeIds([]);
              }}
              className="rounded-lg border border-white/10 px-3 py-1.5 text-[11px] text-slate-300"
            >
              Abbrechen
            </button>
          </div>
        )}
      </div>

      {error !== null && (
        <p role="alert" className="text-xs text-rose-300">
          {error}
        </p>
      )}

      {roots.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-white/10 p-5 text-center text-sm text-slate-500">
          {subjectDocs.length === 0
            ? "Keine Dokumente für dieses Fach — lade Material hoch und ordne es zu."
            : "Noch keine Themen — starte die Extraktion."}
        </div>
      ) : (
        <div className="space-y-2">
          {roots.map((topic) => renderTopic(topic, 0))}
        </div>
      )}
    </div>
  );
}

function DeleteConfirm({
  topic,
  topics,
  questions,
  busy,
  onCancel,
  onConfirm,
}: {
  topic: Entry;
  topics: Entry[];
  questions: QuizQuestion[];
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const children = topics.filter((entry) => entry.parentId === topic.id);
  const linked = questions.filter(
    (question) => question.topicId === topic.id,
  );
  const parent =
    topic.parentId === undefined || topic.parentId === null
      ? null
      : (topics.find((entry) => entry.id === topic.parentId)?.title ?? null);

  return (
    <div className="jarvis-fade mt-2 rounded-2xl border border-rose-400/20 bg-rose-400/[0.04] p-3">
      <p className="text-xs leading-5 text-slate-300">
        „{topic.title}“ entfernen? Nichts geht verloren:
      </p>
      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px] leading-4 text-slate-400">
        <li>
          {children.length} {children.length === 1 ? "Unterthema wandert" : "Unterthemen wandern"}{" "}
          {parent === null ? "zur obersten Ebene" : `zu „${parent}“`}.
        </li>
        <li>
          {linked.length} {linked.length === 1 ? "Frage bleibt" : "Fragen bleiben"} erhalten
          {parent === null && linked.length > 0 ? " (ohne Thema)" : ""}.
        </li>
        <li>Quellen und Verlauf bleiben bestehen.</li>
      </ul>

      <div className="mt-2 flex gap-2">
        <button
          onClick={onConfirm}
          disabled={busy}
          className="flex-1 rounded-xl border border-rose-300/30 px-3 py-2 text-xs text-rose-200 hover:bg-rose-400/10 disabled:opacity-50"
        >
          Endgültig entfernen
        </button>
        <button
          onClick={onCancel}
          className="rounded-xl border border-white/10 px-3 py-2 text-xs text-slate-300"
        >
          Abbrechen
        </button>
      </div>
    </div>
  );
}

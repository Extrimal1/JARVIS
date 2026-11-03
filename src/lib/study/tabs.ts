import type { PrepView } from "@/src/components/study/ExamOverview";

export type StudyTab = "overview" | "documents" | "prep";

export const STUDY_TABS: { key: StudyTab; label: string }[] = [
  { key: "overview", label: "Übersicht" },
  { key: "documents", label: "Dokumente" },
  { key: "prep", label: "Prüfungsvorbereitung" },
];

export const PREP_TABS: { key: PrepView; label: string }[] = [
  { key: "overview", label: "Übersicht" },
  { key: "exams", label: "Meine Prüfungen" },
  { key: "topics", label: "Themen" },
  { key: "plan", label: "Lernplan" },
  { key: "progress", label: "Fortschritt" },
];

function isStudyTab(value: unknown): value is StudyTab {
  return value === "overview" || value === "documents" || value === "prep";
}

function isPrepView(value: unknown): value is PrepView {
  return (
    value === "overview" ||
    value === "exams" ||
    value === "topics" ||
    value === "plan" ||
    value === "progress"
  );
}

/**
 * Deep-link parsing for /study (?tab=…&prep=…). Unknown values fall back
 * to the defaults instead of breaking the view. Pure and URL-decoding
 * safe: accepts a URLSearchParams instance built by the caller.
 */
export function parseStudyTabs(search: URLSearchParams): {
  tab: StudyTab;
  prep: PrepView;
} {
  const tabParam = search.get("tab");
  const prepParam = search.get("prep");

  return {
    tab: isStudyTab(tabParam) ? tabParam : "overview",
    prep: isPrepView(prepParam) ? prepParam : "overview",
  };
}

/** Canonical deep link for a study tab (sidebar + dashboard use this). */
export function studyHref(tab: StudyTab, prep?: PrepView): string {
  if (tab !== "prep" || prep === undefined || prep === "overview") {
    return tab === "overview" ? "/study" : `/study?tab=${tab}`;
  }

  return `/study?tab=prep&prep=${prep}`;
}

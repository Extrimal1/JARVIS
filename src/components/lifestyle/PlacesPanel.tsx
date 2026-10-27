"use client";

import { useMemo, useState } from "react";
import {
  Bookmark,
  ExternalLink,
  MapPin,
  Pencil,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { createId } from "@/src/lib/ids";
import { formatUploadDate } from "@/src/lib/documents";
import type { RemoteResult } from "@/src/lib/db/useRemoteResource";
import {
  centsToEuroInput,
  formatCents,
  parseEuroToCentsAllowingZero,
} from "@/src/lib/finance";
import {
  CATEGORY_LABELS,
  PLACE_CATEGORIES,
  formatDistanceKm,
  haversineKm,
  type Place,
  type PlaceCategory,
  type PlaceSetting,
  type SettingPreference,
} from "@/src/lib/lifestyle/types";
import {
  MANUAL_SOURCE,
  filterPlaces,
  type GeoPoint,
  type PlaceSearch,
} from "@/src/lib/lifestyle/providers";

type SortKey = "name" | "newest" | "distance";

const SETTING_LABELS: Record<PlaceSetting, string> = {
  indoor: "Drinnen",
  outdoor: "Draußen",
  both: "Drinnen & Draußen",
};

function mapUrl(place: Place): string | null {
  if (place.latitude !== null && place.longitude !== null) {
    return `https://www.openstreetmap.org/?mlat=${place.latitude}&mlon=${place.longitude}#map=16/${place.latitude}/${place.longitude}`;
  }

  if (place.address.trim() !== "") {
    return `https://www.openstreetmap.org/search?query=${encodeURIComponent(place.address.trim())}`;
  }

  return null;
}

function distanceOf(
  place: Place,
  center: GeoPoint | null,
): number | null {
  if (
    center === null ||
    place.latitude === null ||
    place.longitude === null
  ) {
    return null;
  }

  return haversineKm(
    center.latitude,
    center.longitude,
    place.latitude,
    place.longitude,
  );
}

export function PlacesPanel({
  places,
  loading,
  error,
  onRetry,
  onCreate,
  onUpdate,
  onDelete,
  savedIds,
  onToggleSave,
  center,
}: {
  places: Place[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onCreate: (place: Place) => Promise<RemoteResult<Place>>;
  onUpdate: (id: string, patch: Partial<Place>) => Promise<RemoteResult<Place>>;
  onDelete: (id: string) => Promise<unknown>;
  savedIds: string[];
  onToggleSave: (id: string) => void;
  center: GeoPoint | null;
}) {
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<"all" | PlaceCategory>(
    "all",
  );
  const [settingFilter, setSettingFilter] = useState<SettingPreference>("any");
  const [freeOnly, setFreeOnly] = useState(false);
  const [maxCost, setMaxCost] = useState("");
  const [sort, setSort] = useState<SortKey>("name");
  const [editing, setEditing] = useState<"new" | string | null>(null);
  const [name, setName] = useState("");
  const [category, setCategory] = useState<PlaceCategory>("nature");
  const [address, setAddress] = useState("");
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [cost, setCost] = useState("");
  const [duration, setDuration] = useState("");
  const [setting, setSetting] = useState<"" | PlaceSetting>("");
  const [openingHours, setOpeningHours] = useState("");
  const [notes, setNotes] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Opening hours are user-entered and therefore never treated as
  // verified data: no filter is offered for them by design.

  const visible = useMemo(() => {
    const maxCostCents =
      maxCost.trim() === ""
        ? null
        : parseEuroToCentsAllowingZero(maxCost);
    const search: PlaceSearch = {
      query,
      categories: categoryFilter === "all" ? [] : [categoryFilter],
      maxCostCents,
      setting: settingFilter,
      freeOnly,
      center: null,
      radiusKm: null,
    };
    const filtered = filterPlaces(places, search);

    if (sort === "newest") {
      return [...filtered].sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      );
    }

    if (sort === "distance" && center !== null) {
      return [...filtered].sort((a, b) => {
        const da = distanceOf(a, center);
        const db = distanceOf(b, center);

        if (da === null && db === null) return 0;
        if (da === null) return 1;
        if (db === null) return -1;

        return da - db;
      });
    }

    return filtered;
  }, [places, query, categoryFilter, settingFilter, freeOnly, maxCost, sort, center]);

  function openNew() {
    setEditing("new");
    setName("");
    setCategory(categoryFilter === "all" ? "nature" : categoryFilter);
    setAddress("");
    setLatitude("");
    setLongitude("");
    setCost("");
    setDuration("");
    setSetting("");
    setOpeningHours("");
    setNotes("");
    setFormError(null);
    setConfirmDeleteId(null);
  }

  function openEdit(place: Place) {
    setEditing(place.id);
    setName(place.name);
    setCategory(place.category);
    setAddress(place.address);
    setLatitude(place.latitude === null ? "" : String(place.latitude));
    setLongitude(place.longitude === null ? "" : String(place.longitude));
    setCost(place.costCents === null ? "" : centsToEuroInput(place.costCents));
    setDuration(
      place.durationMinutes === null ? "" : String(place.durationMinutes),
    );
    setSetting(place.setting ?? "");
    setOpeningHours(place.openingHours);
    setNotes(place.notes);
    setFormError(null);
    setConfirmDeleteId(null);
  }

  async function savePlace(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (editing === null) return;

    if (name.trim() === "") {
      setFormError("Bitte gib einen Namen ein.");
      return;
    }

    const latRaw = latitude.trim().replace(",", ".");
    const lngRaw = longitude.trim().replace(",", ".");

    if ((latRaw === "") !== (lngRaw === "")) {
      setFormError(
        "Bitte gib Breiten- und Längengrad gemeinsam an – oder lasse beide leer.",
      );
      return;
    }

    const lat = latRaw === "" ? null : Number(latRaw);
    const lng = lngRaw === "" ? null : Number(lngRaw);

    if (
      (lat !== null && (!Number.isFinite(lat) || lat < -90 || lat > 90)) ||
      (lng !== null && (!Number.isFinite(lng) || lng < -180 || lng > 180))
    ) {
      setFormError("Die Koordinaten sind ungültig.");
      return;
    }

    const costCents =
      cost.trim() === "" ? null : parseEuroToCentsAllowingZero(cost);

    if (cost.trim() !== "" && costCents === null) {
      setFormError("Der Preis ist ungültig (z. B. 12,50).");
      return;
    }

    const durationMinutes =
      duration.trim() === "" ? null : Number(duration.trim());

    if (
      durationMinutes !== null &&
      (!Number.isInteger(durationMinutes) || durationMinutes <= 0)
    ) {
      setFormError("Die Dauer muss eine positive Minutenzahl sein.");
      return;
    }

    const now = new Date().toISOString();

    if (editing === "new") {
      const entry: Place = {
        id: createId(),
        name: name.trim(),
        category,
        address: address.trim(),
        latitude: lat,
        longitude: lng,
        costCents,
        durationMinutes,
        setting: setting === "" ? null : setting,
        openingHours: openingHours.trim(),
        notes: notes.trim(),
        source: MANUAL_SOURCE,
        createdAt: now,
        updatedAt: now,
      };
      const result = await onCreate(entry);

      if (!result.ok) {
        setFormError(`Speichern fehlgeschlagen: ${result.error}`);
        return;
      }
    } else {
      const result = await onUpdate(editing, {
        name: name.trim(),
        category,
        address: address.trim(),
        latitude: lat,
        longitude: lng,
        costCents,
        durationMinutes,
        setting: setting === "" ? null : setting,
        openingHours: openingHours.trim(),
        notes: notes.trim(),
        updatedAt: now,
      });

      if (!result.ok) {
        setFormError(`Speichern fehlgeschlagen: ${result.error}`);
        return;
      }
    }

    setEditing(null);
    setFormError(null);
  }

  async function deletePlace(id: string) {
    await onDelete(id);
    setConfirmDeleteId(null);
  }

  return (
    <section
      id="orte"
      aria-label="Orte"
      className="scroll-mt-4 rounded-3xl border border-white/[0.08] bg-[#0d111b] p-5 sm:p-6"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-cyan-300/[0.08] text-cyan-300">
            <MapPin size={21} />
          </div>

          <div>
            <h2 className="font-semibold">Orte & Aktivitäten</h2>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              Deine selbst eingetragenen Orte – alle Angaben stammen von
              dir und sind nicht verifiziert.
            </p>
            <p className="mt-2 text-xs text-cyan-300">
              {places.length} {places.length === 1 ? "Eintrag" : "Einträge"}
            </p>
          </div>
        </div>

        <button
          onClick={openNew}
          className="flex shrink-0 items-center gap-1.5 rounded-xl bg-cyan-300 px-4 py-2.5 text-sm font-medium text-slate-950 transition hover:bg-cyan-200"
        >
          <Plus size={16} />
          Ort anlegen
        </button>
      </div>

      {loading ? (
        <p className="mt-5 text-sm text-slate-500">Orte werden geladen …</p>
      ) : error !== null ? (
        <div
          role="alert"
          className="mt-5 flex flex-wrap items-center gap-3 rounded-2xl border border-rose-400/25 bg-rose-400/5 px-4 py-3 text-sm text-rose-200"
        >
          <span className="min-w-0 flex-1">
            Orte konnten nicht geladen werden: {error}
          </span>
          <button
            onClick={onRetry}
            className="rounded-xl border border-rose-300/30 px-3 py-1.5 text-xs transition hover:bg-rose-400/10"
          >
            Erneut versuchen
          </button>
        </div>
      ) : (
        <>
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <div className="relative min-w-40 flex-1">
              <Search
                size={15}
                aria-hidden="true"
                className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"
              />
              <input
                value={query}
                onChange={(change) => setQuery(change.target.value)}
                placeholder="Orte suchen …"
                aria-label="Orte suchen"
                className="w-full rounded-xl border border-white/10 bg-black/20 py-2.5 pl-9 pr-3 text-sm text-white outline-none placeholder:text-slate-600 focus:border-cyan-300/50"
              />
            </div>

            <select
              value={categoryFilter}
              onChange={(change) =>
                setCategoryFilter(
                  change.target.value as "all" | PlaceCategory,
                )
              }
              aria-label="Nach Kategorie filtern"
              className="rounded-xl border border-white/10 bg-[#111827] px-3 py-2.5 text-xs text-white outline-none focus:border-cyan-300/50"
            >
              <option value="all">Alle Kategorien</option>
              {PLACE_CATEGORIES.map((item) => (
                <option key={item} value={item}>
                  {CATEGORY_LABELS[item]}
                </option>
              ))}
            </select>

            <select
              value={settingFilter}
              onChange={(change) =>
                setSettingFilter(
                  change.target.value as SettingPreference,
                )
              }
              aria-label="Drinnen oder draußen filtern"
              className="rounded-xl border border-white/10 bg-[#111827] px-3 py-2.5 text-xs text-white outline-none focus:border-cyan-300/50"
            >
              <option value="any">Drinnen & Draußen</option>
              <option value="indoor">Nur drinnen</option>
              <option value="outdoor">Nur draußen</option>
            </select>

            <input
              value={maxCost}
              onChange={(change) => setMaxCost(change.target.value)}
              placeholder="Max. €"
              aria-label="Maximale Kosten in Euro"
              inputMode="decimal"
              className="w-24 rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-xs tabular-nums text-white outline-none placeholder:text-slate-600 focus:border-cyan-300/50"
            />

            <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-white/10 px-3 py-2.5 text-xs text-slate-400 transition hover:text-slate-200">
              <input
                type="checkbox"
                checked={freeOnly}
                onChange={(change) => setFreeOnly(change.target.checked)}
                className="h-4 w-4 accent-cyan-300"
              />
              Nur kostenlos
            </label>

            <select
              value={sort}
              onChange={(change) => setSort(change.target.value as SortKey)}
              aria-label="Sortierung"
              className="rounded-xl border border-white/10 bg-[#111827] px-3 py-2.5 text-xs text-white outline-none focus:border-cyan-300/50"
            >
              <option value="name">Sortiert: Name</option>
              <option value="newest">Sortiert: Neueste</option>
              <option value="distance" disabled={center === null}>
                Sortiert: Entfernung
              </option>
            </select>
          </div>

          {editing !== null && (
            <form
              onSubmit={savePlace}
              noValidate
              className="mt-4 space-y-3 rounded-2xl border border-cyan-300/15 bg-cyan-300/[0.03] p-4"
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-xs text-slate-400">
                  Name
                  <input
                    autoFocus
                    value={name}
                    onChange={(change) => {
                      setName(change.target.value);
                      setFormError(null);
                    }}
                    placeholder="z. B. Lieblingscafé am Park"
                    maxLength={120}
                    className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/50"
                  />
                </label>

                <label className="block text-xs text-slate-400">
                  Kategorie
                  <select
                    value={category}
                    onChange={(change) =>
                      setCategory(change.target.value as PlaceCategory)
                    }
                    className="mt-2 w-full rounded-xl border border-white/10 bg-[#111827] px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/50"
                  >
                    {PLACE_CATEGORIES.map((item) => (
                      <option key={item} value={item}>
                        {CATEGORY_LABELS[item]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <label className="block text-xs text-slate-400">
                Adresse (optional)
                <input
                  value={address}
                  onChange={(change) => setAddress(change.target.value)}
                  placeholder="z. B. Musterstraße 1, Berlin"
                  maxLength={200}
                  className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/50"
                />
              </label>

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-xs text-slate-400">
                  Breitengrad (optional)
                  <input
                    value={latitude}
                    onChange={(change) => {
                      setLatitude(change.target.value);
                      setFormError(null);
                    }}
                    placeholder="z. B. 52,52"
                    inputMode="decimal"
                    className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm tabular-nums text-white outline-none focus:border-cyan-300/50"
                  />
                </label>

                <label className="block text-xs text-slate-400">
                  Längengrad (optional)
                  <input
                    value={longitude}
                    onChange={(change) => {
                      setLongitude(change.target.value);
                      setFormError(null);
                    }}
                    placeholder="z. B. 13,40"
                    inputMode="decimal"
                    className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm tabular-nums text-white outline-none focus:border-cyan-300/50"
                  />
                </label>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <label className="block text-xs text-slate-400">
                  Kosten p. P. (€, leer = unbekannt)
                  <input
                    value={cost}
                    onChange={(change) => {
                      setCost(change.target.value);
                      setFormError(null);
                    }}
                    placeholder="z. B. 12,50"
                    inputMode="decimal"
                    className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm tabular-nums text-white outline-none focus:border-cyan-300/50"
                  />
                </label>

                <label className="block text-xs text-slate-400">
                  Dauer in Min. (optional)
                  <input
                    value={duration}
                    onChange={(change) => {
                      setDuration(change.target.value);
                      setFormError(null);
                    }}
                    placeholder="z. B. 90"
                    inputMode="numeric"
                    className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm tabular-nums text-white outline-none focus:border-cyan-300/50"
                  />
                </label>

                <label className="block text-xs text-slate-400">
                  Drinnen / Draußen
                  <select
                    value={setting}
                    onChange={(change) =>
                      setSetting(change.target.value as "" | PlaceSetting)
                    }
                    className="mt-2 w-full rounded-xl border border-white/10 bg-[#111827] px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/50"
                  >
                    <option value="">Unbekannt</option>
                    <option value="indoor">Drinnen</option>
                    <option value="outdoor">Draußen</option>
                    <option value="both">Beides</option>
                  </select>
                </label>
              </div>

              <label className="block text-xs text-slate-400">
                Öffnungszeiten (optional, unbestätigt)
                <input
                  value={openingHours}
                  onChange={(change) => setOpeningHours(change.target.value)}
                  placeholder="z. B. Mo–Fr 9–18 Uhr"
                  maxLength={120}
                  className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/50"
                />
              </label>

              <label className="block text-xs text-slate-400">
                Notizen (optional)
                <textarea
                  value={notes}
                  onChange={(change) => setNotes(change.target.value)}
                  placeholder="Was macht diesen Ort besonders?"
                  maxLength={500}
                  rows={2}
                  className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/50"
                />
              </label>

              {formError !== null && (
                <p role="alert" className="text-xs text-rose-300">
                  {formError}
                </p>
              )}

              <div className="flex gap-2">
                <button
                  type="submit"
                  className="flex-1 rounded-xl bg-cyan-300 px-4 py-2.5 text-sm font-medium text-slate-950 transition hover:bg-cyan-200"
                >
                  {editing === "new" ? "Ort speichern" : "Speichern"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditing(null);
                    setFormError(null);
                  }}
                  className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-slate-300 hover:bg-white/5"
                >
                  Abbrechen
                </button>
              </div>
            </form>
          )}

          <div className="mt-4">
            {places.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-white/10 p-5 text-center text-sm text-slate-500">
                Noch keine Orte eingetragen. Lege oben deinen ersten Ort
                an – Empfehlungen entstehen aus deinen Einträgen.
              </div>
            ) : visible.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-white/10 p-5 text-center text-sm text-slate-500">
                Keine Orte für diese Filter gefunden.
              </div>
            ) : (
              <ul className="space-y-2">
                {visible.map((place) => {
                  const saved = savedIds.includes(place.id);
                  const distance = distanceOf(place, center);
                  const map = mapUrl(place);

                  return (
                    <li
                      key={place.id}
                      className="jarvis-lift rounded-2xl border border-white/[0.05] bg-white/[0.02] p-4"
                    >
                      <div className="flex items-start gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-slate-200">
                            {place.name}
                          </p>
                          <div className="mt-1.5 flex flex-wrap gap-2">
                            <span className="rounded-full bg-cyan-300/[0.08] px-2 py-1 text-[10px] text-cyan-200">
                              {CATEGORY_LABELS[place.category]}
                            </span>
                            {distance !== null && (
                              <span className="rounded-full bg-white/[0.05] px-2 py-1 text-[10px] tabular-nums text-slate-400">
                                {formatDistanceKm(distance)}
                              </span>
                            )}
                            <span className="rounded-full bg-white/[0.05] px-2 py-1 text-[10px] tabular-nums text-slate-400">
                              {place.costCents === null
                                ? "Preis unbekannt"
                                : place.costCents === 0
                                  ? "Kostenlos"
                                  : formatCents(place.costCents)}
                            </span>
                            {place.setting !== null && (
                              <span className="rounded-full bg-white/[0.05] px-2 py-1 text-[10px] text-slate-400">
                                {SETTING_LABELS[place.setting]}
                              </span>
                            )}
                          </div>

                          {place.address !== "" && (
                            <p className="mt-2 truncate text-xs text-slate-500">
                              {place.address}
                            </p>
                          )}
                          {place.openingHours !== "" && (
                            <p className="mt-1 truncate text-xs text-slate-500">
                              {place.openingHours} (selbst eingetragen)
                            </p>
                          )}
                          {place.notes !== "" && (
                            <p className="mt-1 break-words text-xs leading-5 text-slate-500">
                              {place.notes}
                            </p>
                          )}
                          <p className="mt-2 text-[10px] text-slate-600">
                            {place.source.label} · Stand{" "}
                            {formatUploadDate(place.updatedAt)}
                          </p>
                        </div>

                        <div className="flex shrink-0 gap-1">
                          <button
                            onClick={() => onToggleSave(place.id)}
                            aria-pressed={saved}
                            aria-label={
                              saved
                                ? `Entfernen: ${place.name}`
                                : `Merken: ${place.name}`
                            }
                            title={saved ? "Entfernen" : "Merken"}
                            className={`rounded-lg p-2 transition ${
                              saved
                                ? "text-cyan-300 hover:text-cyan-200"
                                : "text-slate-500 hover:bg-white/5 hover:text-slate-200"
                            }`}
                          >
                            <Bookmark
                              size={15}
                              fill={saved ? "currentColor" : "none"}
                            />
                          </button>
                          {map !== null && (
                            <a
                              href={map}
                              target="_blank"
                              rel="noreferrer"
                              aria-label={`Karte öffnen: ${place.name}`}
                              title="In OpenStreetMap öffnen"
                              className="rounded-lg p-2 text-slate-500 transition hover:bg-white/5 hover:text-slate-200"
                            >
                              <ExternalLink size={15} />
                            </a>
                          )}
                          <button
                            onClick={() => openEdit(place)}
                            aria-label={`Bearbeiten: ${place.name}`}
                            title="Bearbeiten"
                            className="rounded-lg p-2 text-slate-500 transition hover:bg-white/5 hover:text-slate-200"
                          >
                            <Pencil size={15} />
                          </button>
                          <button
                            onClick={() => setConfirmDeleteId(place.id)}
                            aria-label={`Löschen: ${place.name}`}
                            title="Löschen"
                            className="rounded-lg p-2 text-slate-500 transition hover:bg-rose-400/10 hover:text-rose-300"
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </div>

                      {confirmDeleteId === place.id && (
                        <div className="mt-3 rounded-xl border border-rose-400/30 bg-rose-400/5 p-4">
                          <p className="text-sm text-rose-200">
                            „{place.name}“ wirklich löschen?
                          </p>
                          <div className="mt-3 flex gap-2">
                            <button
                              onClick={() => deletePlace(place.id)}
                              className="flex-1 rounded-xl bg-rose-400 px-4 py-2.5 text-sm font-medium text-slate-950 transition hover:bg-rose-300"
                            >
                              Endgültig löschen
                            </button>
                            <button
                              onClick={() => setConfirmDeleteId(null)}
                              className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-slate-300 hover:bg-white/5"
                            >
                              Abbrechen
                            </button>
                          </div>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  );
}

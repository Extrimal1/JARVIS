/**
 * Cross-cutting user settings (synced in cloud mode, local otherwise).
 * Lecture upload behavior lives here: local-first by default, cloud
 * upload only when the user explicitly enables it.
 *
 * `memoryEnabled` is the cloud side of the memory kill-switch: false
 * hides approved memory from the assistant and the dashboard on ALL
 * devices. It defaults to true (absent = enabled) so legacy records
 * and pre-migration databases behave as before.
 */

export const USER_SETTINGS_KEY = "jarvis-user-settings";

export type UserSettings = {
  lectureAutoUpload: boolean;
  memoryEnabled?: boolean;
};

export const DEFAULT_USER_SETTINGS: UserSettings = {
  lectureAutoUpload: false,
  memoryEnabled: true,
};

export function isUserSettings(value: unknown): value is UserSettings {
  if (typeof value !== "object" || value === null) return false;

  const record = value as Record<string, unknown>;

  return (
    typeof record.lectureAutoUpload === "boolean" &&
    (record.memoryEnabled === undefined ||
      typeof record.memoryEnabled === "boolean")
  );
}

/** Effective cloud kill-switch: anything but explicit false = enabled. */
export function isMemoryEnabledSetting(settings: UserSettings): boolean {
  return settings.memoryEnabled !== false;
}

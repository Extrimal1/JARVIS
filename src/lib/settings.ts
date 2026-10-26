/**
 * Cross-cutting user settings (synced in cloud mode, local otherwise).
 * Lecture upload behavior lives here: local-first by default, cloud
 * upload only when the user explicitly enables it.
 */

export const USER_SETTINGS_KEY = "jarvis-user-settings";

export type UserSettings = {
  lectureAutoUpload: boolean;
};

export const DEFAULT_USER_SETTINGS: UserSettings = {
  lectureAutoUpload: false,
};

export function isUserSettings(value: unknown): value is UserSettings {
  if (typeof value !== "object" || value === null) return false;

  return (
    typeof (value as Record<string, unknown>).lectureAutoUpload === "boolean"
  );
}

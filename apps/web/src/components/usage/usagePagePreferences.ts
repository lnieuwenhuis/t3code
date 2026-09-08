import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";

const STORAGE_KEY = "t3code:usage-page-preferences:v1";
const UsagePagePreferencesSchema = Schema.Struct({
  metric: Schema.Literals(["cost", "tokens", "limits"]),
  windowDays: Schema.Literals([1, 7, 30, 90]),
});
export type UsagePagePreferences = typeof UsagePagePreferencesSchema.Type;

export function readUsagePagePreferences(): UsagePagePreferences {
  try {
    return (
      getLocalStorageItem(STORAGE_KEY, UsagePagePreferencesSchema) ?? {
        metric: "cost",
        windowDays: 30,
      }
    );
  } catch (error) {
    console.error("Could not read Usage page preferences.", error);
    return { metric: "cost", windowDays: 30 };
  }
}

type Listener = (preferences: UsagePagePreferences) => void;
const listeners = new Set<Listener>();

/**
 * Hear every save, wherever it came from, so a mounted Usage page follows a
 * change made outside it, such as the sidebar opening Limits. Storage is only
 * persistence: listeners run even when the write fails.
 */
export function subscribeUsagePagePreferences(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function saveUsagePagePreferences(preferences: UsagePagePreferences): void {
  try {
    setLocalStorageItem(STORAGE_KEY, preferences, UsagePagePreferencesSchema);
  } catch (error) {
    console.error("Could not save Usage page preferences.", error);
  }
  for (const listener of listeners) listener(preferences);
}

"use client";

import { useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";

type Validator<T> = (value: unknown) => value is T;

/**
 * localStorage-backed state for client components.
 *
 * The stored value is read in an effect (after mount) because client
 * components are prerendered on the server, where `localStorage` does not
 * exist and reading it during render would cause hydration mismatches.
 * Nothing is written back until the stored value has been loaded, so an
 * initial state can never overwrite existing saved data. Malformed or
 * invalid stored data is ignored and the initial value is kept.
 */
export function useLocalStorage<T>(
  key: string,
  initialValue: T,
  isValid: Validator<T>,
): [T, Dispatch<SetStateAction<T>>, boolean] {
  const [value, setValue] = useState<T>(initialValue);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(key);

      if (saved !== null) {
        const parsed: unknown = JSON.parse(saved);

        if (isValid(parsed)) {
          // Reading storage post-mount is intentional (see hook docs above).
          // eslint-disable-next-line react-hooks/set-state-in-effect
          setValue(parsed);
        }
      }
    } catch (error) {
      console.error(`Failed to load "${key}" from localStorage:`, error);
    } finally {
      setLoaded(true);
    }
  }, [key, isValid]);

  useEffect(() => {
    if (!loaded) return;

    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      console.error(`Failed to save "${key}" to localStorage:`, error);
    }
  }, [key, value, loaded]);

  return [value, setValue, loaded];
}

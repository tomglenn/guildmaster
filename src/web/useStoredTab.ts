import { useState } from 'react';

export default function useStoredTab<T extends string>(key: string, options: readonly T[], fallback: T): [T, (value: T) => void] {
  const read = (): T => {
    try {
      const value = localStorage.getItem(key);
      return options.includes(value as T) ? value as T : fallback;
    } catch { return fallback; }
  };
  const [selection, setSelection] = useState(() => ({ key, value: read() }));
  // Project-specific keys can change without unmounting the Projects view.
  const value = selection.key === key ? selection.value : read();
  return [value, next => {
    setSelection({ key, value: next });
    try { localStorage.setItem(key, next); } catch { /* Keep navigation usable without browser storage. */ }
  }];
}

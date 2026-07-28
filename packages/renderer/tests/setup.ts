import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});

// Under Node's experimental webstorage (no --localstorage-file), vitest's
// jsdom environment ends up with `window.localStorage === undefined`. Real
// browsers always provide it, so back it with memory here — tests that cover
// the *unavailable* storage case pass their own storage explicitly.
if (typeof window !== 'undefined' && window.localStorage === undefined) {
  const backing = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return backing.size;
    },
    clear: () => backing.clear(),
    getItem: (key: string) => backing.get(key) ?? null,
    key: (index: number) => [...backing.keys()][index] ?? null,
    removeItem: (key: string) => {
      backing.delete(key);
    },
    setItem: (key: string, value: string) => {
      backing.set(key, value);
    },
  };
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: true });
  if (globalThis.localStorage === undefined) {
    Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
  }
}

/**
 * Theme preference: system-following by default, with a manual override the
 * reader can cycle (auto → light → dark). The override is stamped on
 * `<html data-theme=…>` — theme.css keys every token off that attribute —
 * and persisted per browser.
 */

export type ThemePreference = 'auto' | 'light' | 'dark';

export const THEME_STORAGE_KEY = 'ramplab-theme';

/**
 * Inline this (as a plain `<script>`) in the host's HTML head so an explicit
 * theme choice applies before first paint — no flash of the wrong printing.
 * Kept dependency-free and ES5-safe on purpose.
 */
export const themeInitScript = `(function(){try{var t=localStorage.getItem('${THEME_STORAGE_KEY}');if(t==='light'||t==='dark'){document.documentElement.dataset.theme=t}}catch(e){}})();`;

function safeStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function readThemePreference(): ThemePreference {
  const raw = safeStorage()?.getItem(THEME_STORAGE_KEY);
  return raw === 'light' || raw === 'dark' ? raw : 'auto';
}

/** Apply and persist a preference; 'auto' removes the override entirely. */
export function applyThemePreference(preference: ThemePreference): void {
  const root = globalThis.document?.documentElement;
  if (root !== undefined) {
    if (preference === 'auto') {
      delete root.dataset['theme'];
    } else {
      root.dataset['theme'] = preference;
    }
  }
  const storage = safeStorage();
  try {
    if (preference === 'auto') {
      storage?.removeItem(THEME_STORAGE_KEY);
    } else {
      storage?.setItem(THEME_STORAGE_KEY, preference);
    }
  } catch {
    // Storage failures are never fatal; the attribute still applied.
  }
}

export function nextThemePreference(preference: ThemePreference): ThemePreference {
  return preference === 'auto' ? 'light' : preference === 'light' ? 'dark' : 'auto';
}

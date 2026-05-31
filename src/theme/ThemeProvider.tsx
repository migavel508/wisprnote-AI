import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { THEME_STORAGE_KEY } from './constants';

export type ThemePreference = 'light' | 'dark' | 'system';

type ResolvedTheme = 'light' | 'dark';

type ThemeContextValue = {
  preference: ThemePreference;
  setPreference: (value: ThemePreference) => void;
  resolved: ResolvedTheme;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStoredPreference(): ThemePreference {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  } catch {
    /* ignore */
  }
  return 'system';
}

function readOsDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function resolveTheme(preference: ThemePreference, osDark: boolean): ResolvedTheme {
  if (preference === 'dark') return 'dark';
  if (preference === 'light') return 'light';
  return osDark ? 'dark' : 'light';
}

// Canvas RGB — MUST match --color-app-canvas in index.css per theme.
// Light #e5ddd4 → [229,221,212]; Dark #141414 → [20,20,20].
const CANVAS_LIGHT_RGB: [number, number, number] = [229, 221, 212];
const CANVAS_DARK_RGB: [number, number, number] = [20, 20, 20];

// Keep the NATIVE (Tauri) window background in sync with the theme. The native
// window paints this color in the brief gap between an OS resize (minimize/
// maximize) and the WebView repaint. Without a matching opaque color that gap
// shows the default black — the blank/black flash. Matching it to the canvas
// makes the transition seamless in both themes.
function syncNativeWindowBackground(resolved: ResolvedTheme) {
  if (typeof window === 'undefined' || !(window as any).__TAURI_INTERNALS__) return;
  const rgb = resolved === 'dark' ? CANVAS_DARK_RGB : CANVAS_LIGHT_RGB;
  void import('@tauri-apps/api/window')
    .then(({ getCurrentWindow }) => {
      const win = getCurrentWindow() as unknown as {
        setBackgroundColor?: (c: [number, number, number]) => Promise<void>;
      };
      return win.setBackgroundColor?.(rgb);
    })
    .catch(() => { /* web build or API unavailable — CSS canvas bg still applies */ });
}

function applyDomTheme(resolved: ResolvedTheme) {
  document.documentElement.classList.toggle('dark', resolved === 'dark');
  document.documentElement.style.colorScheme = resolved === 'dark' ? 'dark' : 'light';
  syncNativeWindowBackground(resolved);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(() =>
    typeof window !== 'undefined' ? readStoredPreference() : 'system',
  );

  const [osDark, setOsDark] = useState(() =>
    typeof window !== 'undefined' ? readOsDark() : false,
  );

  const resolved = useMemo(
    () => resolveTheme(preference, osDark),
    [preference, osDark],
  );

  const setPreference = useCallback((value: ThemePreference) => {
    setPreferenceState(value);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, value);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    applyDomTheme(resolved);
  }, [resolved]);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setOsDark(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const value = useMemo(
    () => ({ preference, setPreference, resolved }),
    [preference, setPreference, resolved],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used within ThemeProvider');
  }
  return ctx;
}

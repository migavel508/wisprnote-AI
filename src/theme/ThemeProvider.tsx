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

function applyDomTheme(resolved: ResolvedTheme) {
  document.documentElement.classList.toggle('dark', resolved === 'dark');
  document.documentElement.style.colorScheme = resolved === 'dark' ? 'dark' : 'light';
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

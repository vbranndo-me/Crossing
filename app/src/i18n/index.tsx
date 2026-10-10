import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { en } from './en.ts';
import { ptBR } from './pt-BR.ts';
import type { Messages } from './pt-BR.ts';

/** Adding a language: write its file (same keys as pt-BR.ts) and list it here. */
export const LOCALES: Record<string, Messages> = { 'pt-BR': ptBR, en };

const STORAGE_KEY = 'crossing.locale';

interface I18n {
  locale: string;
  setLocale(locale: string): void;
  /** The texts of the current language. */
  t: Messages;
  formatNumber(value: number): string;
}

function initialLocale(): string {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && LOCALES[saved]) return saved;
  } catch {
    // No storage: fall back to the browser language.
  }
  const prefix = navigator.language.slice(0, 2);
  return Object.keys(LOCALES).find((l) => l.slice(0, 2) === prefix) ?? 'en';
}

const Context = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState(initialLocale);

  useEffect(() => {
    document.documentElement.lang = locale;
    try {
      localStorage.setItem(STORAGE_KEY, locale);
    } catch {
      // The choice simply is not remembered.
    }
  }, [locale]);

  const value = useMemo<I18n>(() => {
    const number = new Intl.NumberFormat(locale);
    return { locale, setLocale, t: LOCALES[locale], formatNumber: (v) => number.format(v) };
  }, [locale]);

  return <Context value={value}>{children}</Context>;
}

export function useI18n(): I18n {
  const value = useContext(Context);
  if (!value) throw new Error('useI18n outside I18nProvider');
  return value;
}

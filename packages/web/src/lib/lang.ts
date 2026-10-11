import type { Lang } from '@agentistics/core'

export interface LangStorage { getItem(key: string): string | null }

/** First paint language: keep an explicit browser choice, otherwise follow the browser locale. */
export function initialLang(storage: LangStorage | null, browserLanguage: string | undefined): Lang {
  try {
    const stored = storage?.getItem('agentistics-lang')
    if (stored === 'pt' || stored === 'en') return stored
  } catch { /* private mode or unavailable storage */ }
  return (browserLanguage ?? '').toLowerCase().startsWith('pt') ? 'pt' : 'en'
}

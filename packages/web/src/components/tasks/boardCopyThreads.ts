/**
 * Strings for the mobile board and the thread badge. Kept apart from `copy.ts` (owned elsewhere).
 */
export type ThreadsLang = 'pt' | 'en'

/** "💬 3 threads esperam você" — VISUAL only; `n` ≤ 0 yields `null` (nothing is drawn). */
export function threadsAwaitingText(n: number | undefined, lang: ThreadsLang): string | null {
  if (!n || n <= 0) return null
  if (lang === 'pt') return `💬 ${n} ${n === 1 ? 'thread espera' : 'threads esperam'} você`
  return `💬 ${n} ${n === 1 ? 'thread' : 'threads'} waiting on you`
}

export function mobileBoardCopy(lang: ThreadsLang) {
  return lang === 'pt'
    ? {
      adjust: 'Ajustes', adjustTitle: 'Ajustes do quadro', close: 'Fechar', search: 'Buscar',
      view: 'Visualização', manage: 'Gerenciar', emptyLane: 'Nada neste status.',
      statuses: 'Status', types: 'Tipos', chips: 'Status do quadro',
    }
    : {
      adjust: 'Adjust', adjustTitle: 'Board settings', close: 'Close', search: 'Search',
      view: 'View', manage: 'Manage', emptyLane: 'Nothing in this status.',
      statuses: 'Statuses', types: 'Types', chips: 'Board statuses',
    }
}

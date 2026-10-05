/**
 * Strings for the mobile board and the thread badge. Kept apart from `copy.ts` (owned elsewhere).
 */
export type ThreadsLang = 'pt' | 'en'

/**
 * "💬 3 threads" — a COUNT of the task's records, nothing more. A thread is history, not a chat, so
 * the card never says one is waiting on anybody. `n` ≤ 0 or unknown yields `null` (nothing drawn).
 */
export function threadsCountText(n: number | undefined, lang: ThreadsLang): string | null {
  if (!n || n <= 0) return null
  return lang === 'pt'
    ? `💬 ${n} ${n === 1 ? 'tópico' : 'tópicos'}`
    : `💬 ${n} ${n === 1 ? 'thread' : 'threads'}`
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

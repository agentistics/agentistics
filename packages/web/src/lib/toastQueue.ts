import type { AppNotification } from './notifications'

export const SUMMARY_ID = 'toast-summary'
export const BURST_MS = 2000
export interface ToastQueue {
  items: AppNotification[]
  summary: { ids: string[]; away: boolean } | null
  recent: number[]
}
export const emptyToastQueue = (): ToastQueue => ({ items: [], summary: null, recent: [] })

/** Presentation only: no bell entries are added, removed or marked read here. */
export function enqueueToasts(state: ToastQueue, incoming: AppNotification[], now: number, away: boolean): ToastQueue {
  if (!incoming.length) return state
  const recent = [...state.recent.filter(t => now - t < BURST_MS), ...incoming.map(() => now)].slice(-4)
  const burst = recent.length > 3
  let items = [...incoming, ...state.items.filter(n => !incoming.some(x => x.id === n.id))]
  const ids = new Set(state.summary?.ids ?? [])
  // Severity changes refresh one notification rather than counting the same news twice.
  for (const n of incoming) ids.delete(n.id)
  const summarize = (n: AppNotification) => { ids.add(n.id) }
  if (away || burst) {
    items = items.filter(n => {
      if (!away && n.type === 'error') return true
      summarize(n)
      return false
    })
  }
  // A summary takes a slot too. Prefer errors when several cards compete for space.
  if (items.length + (ids.size ? 1 : 0) > 3) {
    const ranked = [...items.filter(n => n.type === 'error'), ...items.filter(n => n.type !== 'error')]
    items = ranked.slice(0, 2)
    ranked.slice(2).forEach(summarize)
  }
  return { items, summary: ids.size ? { ids: [...ids], away: away || state.summary?.away === true } : null, recent }
}

export function removeToast(state: ToastQueue, id: string): ToastQueue {
  return id === SUMMARY_ID ? { ...state, summary: null } : { ...state, items: state.items.filter(n => n.id !== id) }
}

export function summaryToast(summary: NonNullable<ToastQueue['summary']>, lang: 'pt' | 'en'): AppNotification {
  const count = summary.ids.length
  return { id: SUMMARY_ID, type: 'info', ts: 0, read: false,
    title: summary.away
      ? (lang === 'pt' ? `${count} ${count === 1 ? 'novidade' : 'novidades'} enquanto você estava fora` : `${count} ${count === 1 ? 'update' : 'updates'} while you were away`)
      : (lang === 'pt' ? `+${count} ${count === 1 ? 'novidade' : 'novidades'} — abrir no sino` : `+${count} more — open the bell`),
    message: summary.away ? (lang === 'pt' ? 'Abrir no sino' : 'Open the bell') : undefined,
  }
}

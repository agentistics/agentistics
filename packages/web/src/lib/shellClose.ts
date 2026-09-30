/**
 * shellClose.ts — ENDING A SESSION'S SHELL FROM ITS PANEL'S OWN X, said in words at every step.
 *
 * Owner, 2026-09-29: the gear that held "End this shell" is gone; an X sits beside minimize, only
 * where the item is REALLY closable (today: the Shell alone — `panelClosable`), and pressing it shows
 * a small progress bar captioned "Encerrando o processo deste terminal…", then a sentence saying
 * whether it worked. A close that reported nothing was a click that might or might not have killed a
 * process, which is the one thing a destructive control may never leave open.
 *
 * TWO HALVES, as elsewhere in `lib/`:
 *  - PURE (this block): which panels close, how the server's answer reads, and the sentences.
 *  - THE STORE (below): per SESSION, because the X can live in two places — the bottom band's own
 *    bar (inside `ShellBand`, which holds the shell id) and a FLOATING window's header (drawn by
 *    `SessionsPage`, which does not). `ShellBand` publishes the shell it holds; either header asks
 *    for the close; the band that holds that shell hears the outcome and drops it. The process is
 *    ended through the one existing route, `POST /api/shell/close`, never a second path.
 *
 * `/api/shell/close` answers `{ closed: string[], unknown: string[] }` — an id it did not know is
 * REPORTED, never counted as closed (`shell-backend.ts`'s `closeShells`). So there are three
 * outcomes, not two: `closed`, `gone` (it was no longer running — not a failure, and not a success
 * this click produced either), and `failed` (the request failed or the answer named neither).
 */

import { useSyncExternalStore } from 'react'
import type { PanelId } from './panelSlots'

/** Is this panel an item a person can END, as opposed to only hide/minimize? Only the Shell: it is
 *  a process the person opened. The Claude Code pane IS the session (ending it is `kill`, a verb
 *  with its own confirmation elsewhere), and every other panel is a view that merely closes. */
export function panelClosable(panel: PanelId): boolean {
  return panel === 'shell'
}

export type ShellCloseOutcome = 'closed' | 'gone' | 'failed'

export type ShellCloseFlow =
  | { phase: 'idle' }
  | { phase: 'closing'; id: string }
  | { phase: 'done'; id: string; outcome: ShellCloseOutcome; at: number }

export const IDLE_CLOSE: ShellCloseFlow = { phase: 'idle' }

/** How long the result sentence stays up before the row returns to normal. */
export const CLOSE_RESULT_MS = 4500

/** Read the server's answer for ONE id. `res` is `null` when the request itself failed. */
export function closeOutcome(id: string, res: { ok: boolean; body: unknown } | null): ShellCloseOutcome {
  if (!res || !res.ok) return 'failed'
  const body = res.body
  if (typeof body !== 'object' || body === null) return 'failed'
  const { closed, unknown } = body as { closed?: unknown; unknown?: unknown }
  if (Array.isArray(closed) && closed.includes(id)) return 'closed'
  if (Array.isArray(unknown) && unknown.includes(id)) return 'gone'
  return 'failed'
}

/** Does this outcome mean the shell is no longer running (so the band must drop it)? */
export function closeEndsShell(outcome: ShellCloseOutcome): boolean {
  return outcome !== 'failed'
}

/** The sentence for the current step, or `null` when there is nothing to say. */
export function shellCloseText(flow: ShellCloseFlow, lang: 'pt' | 'en'): string | null {
  const pt = lang === 'pt'
  if (flow.phase === 'idle') return null
  if (flow.phase === 'closing') {
    return pt ? 'Encerrando o processo deste terminal…' : 'Ending this terminal’s process…'
  }
  switch (flow.outcome) {
    case 'closed': return pt ? 'Shell encerrado.' : 'Shell ended.'
    case 'gone': return pt ? 'Este shell já não estava rodando.' : 'This shell was no longer running.'
    case 'failed': return pt
      ? 'Não foi possível encerrar este shell — ele continua rodando.'
      : 'Could not end this shell — it is still running.'
  }
}

/** Is the result still worth showing at `now`? A `closing` flow always is. */
export function closeFlowVisible(flow: ShellCloseFlow, now: number): boolean {
  if (flow.phase === 'idle') return false
  if (flow.phase === 'closing') return true
  return now - flow.at < CLOSE_RESULT_MS
}

// ---------------------------------------------------------------------------------------------
// The store — per session.
// ---------------------------------------------------------------------------------------------

interface Entry { live: string | null; flow: ShellCloseFlow; ended: number }
const EMPTY: Entry = Object.freeze({ live: null, flow: IDLE_CLOSE, ended: 0 }) as Entry
const entries = new Map<string, Entry>()
const listeners = new Set<() => void>()
const emit = (): void => { for (const l of listeners) l() }
function set(sessionId: string, patch: Partial<Entry>): void {
  entries.set(sessionId, { ...(entries.get(sessionId) ?? EMPTY), ...patch })
  emit()
}

export function subscribeShellClose(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

export function shellCloseEntry(sessionId: string): Entry {
  return entries.get(sessionId) ?? EMPTY
}

/** `ShellBand` reports the shell it holds. Only a REAL id is published: a band that never resolved
 *  one (showing the Claude Code pane) must not erase what another band of the same session holds. */
export function publishLiveShell(sessionId: string, shellId: string | null): void {
  if (!shellId || shellCloseEntry(sessionId).live === shellId) return
  set(sessionId, { live: shellId })
}

/** End the session's shell through `/api/shell/close`. A second press while one is in flight is
 *  ignored. `url` is `shellApiUrl('/api/shell/close', lang)` — passed in so this stays free of the
 *  band's own helpers. */
export async function requestShellClose(sessionId: string, url: string, shellId?: string): Promise<void> {
  const cur = shellCloseEntry(sessionId)
  if (cur.flow.phase === 'closing') return
  const id = shellId ?? cur.live
  if (!id) return
  set(sessionId, { flow: { phase: 'closing', id } })
  let res: { ok: boolean; body: unknown } | null = null
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [id] }),
    })
    res = { ok: r.ok, body: await r.json().catch(() => null) }
  } catch { res = null }
  const outcome = closeOutcome(id, res)
  const after = shellCloseEntry(sessionId)
  set(sessionId, {
    flow: { phase: 'done', id, outcome, at: Date.now() },
    ...(closeEndsShell(outcome) ? { live: after.live === id ? null : after.live, ended: after.ended + 1 } : {}),
  })
}

export function useShellClose(sessionId: string | null | undefined): Entry {
  return useSyncExternalStore(
    subscribeShellClose,
    () => (sessionId ? shellCloseEntry(sessionId) : EMPTY),
    () => EMPTY,
  )
}

/** For tests. */
export function resetShellClose(): void { entries.clear(); emit() }

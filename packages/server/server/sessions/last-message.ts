/**
 * FLUXO.AVISOS: the newest message TYPED INTO a session by someone else (a leader's `agentistics_session_message`, or a
 * person's composer) — never the session's own output. The engine's `fechar-entregue` reads it through the host op
 * `ultima-mensagem-sessao` to refuse closing a worker that was given new work after its final handback.
 *
 * Memory only, on purpose: it answers "since this handback", a window of minutes, and a restart loses the engine's
 * handback evidence just the same. An absent entry is `no message known`, which the engine reads as nothing newer.
 */
export interface LastMessage { at: string; from?: string; kind?: string }

const last = new Map<string, LastMessage>()
const MAX = 2000

/** Record a delivered message; only a NEWER one replaces the stored one. */
export function noteMessageTo(sessionId: string, atMs: number, extra: { from?: string; kind?: string } = {}): void {
  if (!sessionId || !Number.isFinite(atMs)) return
  const prev = last.get(sessionId)
  if (prev && Date.parse(prev.at) > atMs) return
  last.set(sessionId, { at: new Date(atMs).toISOString(), ...(extra.from ? { from: extra.from } : {}), ...(extra.kind ? { kind: extra.kind } : {}) })
  if (last.size > MAX) for (const k of last.keys()) { last.delete(k); if (last.size <= MAX * 0.8) break }
}

export const lastMessageTo = (sessionId: string): LastMessage | undefined => last.get(sessionId)
export const resetLastMessages = (): void => last.clear()

/**
 * FLUXO.AVISOS: the newest message TYPED INTO a session by someone else (a leader's `agentistics_session_message`, or a
 * person's composer) — never the session's own output. The engine's `fechar-entregue` reads it through the host op
 * `ultima-mensagem-sessao` to refuse closing a worker that was given new work after its final handback, and the fleet
 * reads its `kind` to know a finished turn only reacted to a `notice` (`SessionView.afterNotice`).
 *
 * PERSISTED (SESSAO.AVISO-NA-THREAD r2): the notice mark must survive a server restart — a leader who got a
 * notice and then saw the server bounce would otherwise read as "needs you" again, which is the owner's complaint.
 *
 * This module does NO IO of its own, on purpose: the delivery guard pins every raw writer and every importer of a
 * writing helper (`delivery/doors.lint.test.ts`), and a store this small must not widen that ceiling. The SERVER binds
 * a `LastMessagesPort` at boot (`index.ts`): each entry lives on its session's own registry row (`ManagedSession.lastMessage`,
 * written through `patchSession`), so it travels, is sanitised and is pruned with the row — no file of its own;
 * unbound — a test, a one-shot CLI — it is memory only, which is what it always was. An absent entry is
 * `no message known`, which the engine reads as nothing newer.
 */
export interface LastMessage { at: string; from?: string; kind?: string }

/** Where the map lives between restarts: `read` answers every stored entry; `save` stores one (null clears it). */
export interface LastMessagesPort {
  read(): Iterable<readonly [string, LastMessage]>
  save(sessionId: string, message: LastMessage | null): Promise<void>
}

const MAX = 2000
let last: Map<string, LastMessage> | null = null
let port: LastMessagesPort | null = null
let chain: Promise<void> = Promise.resolve()

const valid = (m: Partial<LastMessage> | null | undefined): m is LastMessage =>
  !!m && typeof m.at === 'string' && Number.isFinite(Date.parse(m.at))

function load(): Map<string, LastMessage> {
  if (last) return last
  last = new Map()
  try {
    for (const [id, m] of port?.read() ?? []) {
      if (id && valid(m)) last.set(id, { at: m.at, ...(m.from ? { from: m.from } : {}), ...(m.kind ? { kind: m.kind } : {}) })
    }
  } catch { /* an unreadable store is "nothing known", never a crash */ }
  return last
}

/** Saves are serialised, so the newest note for a session always lands last. A failed save keeps memory. */
function persist(sessionId: string, message: LastMessage | null): void {
  const p = port
  if (!p) return
  chain = chain.then(() => p.save(sessionId, message)).catch(err => { console.error('[last-message] could not persist', String(err)) })
}

/** Record a delivered message; only a NEWER one replaces the stored one. */
export function noteMessageTo(sessionId: string, atMs: number, extra: { from?: string; kind?: string } = {}): void {
  if (!sessionId || !Number.isFinite(atMs)) return
  const map = load()
  const prev = map.get(sessionId)
  if (prev && Date.parse(prev.at) > atMs) return
  map.set(sessionId, { at: new Date(atMs).toISOString(), ...(extra.from ? { from: extra.from } : {}), ...(extra.kind ? { kind: extra.kind } : {}) })
  if (map.size > MAX) for (const k of map.keys()) { map.delete(k); if (map.size <= MAX * 0.8) break }
  persist(sessionId, map.get(sessionId)!)
}

export const lastMessageTo = (sessionId: string): LastMessage | undefined => load().get(sessionId)

/** Forget memory AND the bound store (tests, and a clean slate). */
export const resetLastMessages = (): void => {
  const map = load()
  for (const id of map.keys()) persist(id, null)
  map.clear()
}

/** Drop the in-memory copy so the next read comes from the store — what a server restart does. */
export const reloadLastMessagesFromDisk = (): void => { last = null }

/** Resolves once every write queued so far has landed (or failed and been logged). */
export const flushLastMessages = (): Promise<void> => chain

/** Bind (or, with null, unbind) the persistence port. The next read comes from the new store. */
export function bindLastMessagesStore(p: LastMessagesPort | null): void { port = p; last = null; chain = Promise.resolve() }

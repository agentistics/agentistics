/**
 * handoff-relay-io.ts — the IO half of HANDOFF.RELAY (`handoff-relay.ts` is the pure rule).
 *
 * Three moments: the successor's SPAWN reads the predecessor's conversation into its briefing
 * (`captureHandoffRelay` + `recordHandoffLink`); a periodic FLUSH forwards whatever the owner wrote
 * into the predecessor afterwards (`flushAllHandoffRelays`); and a KILL of a predecessor flushes
 * first and refuses when the flush could not deliver (`flushBeforeKill`). Every harness goes through
 * its own transcript reader (`HARNESS_TRANSCRIPTS`); a harness with none is SAID in the briefing.
 */
import type { ChatTurn } from '@agentistics/core'
import { transcriptReaderFor } from './harness-transcript'
import {
  forwardHasContent, forwardText, planForward, planRelay, relaySection,
} from './handoff-relay'
import { patchSession, readRegistry } from './registry'
import type { ManagedSession } from './types'

/** Turns read from the predecessor — wide enough for a long leader turn, bounded for a poll. */
const RELAY_READ_TURNS = 400
/** A predecessor is watched this long after its hand-off; past it nobody types into it any more. */
export const RELAY_WATCH_MS = 48 * 60 * 60 * 1000

export type TurnsRead = { turns: ChatTurn[] } | { unavailable: string }

export async function readSessionTurns(m: Pick<ManagedSession, 'harness' | 'conversationId' | 'cwd'>): Promise<TurnsRead> {
  const reader = transcriptReaderFor(m.harness)
  if (!reader) return { unavailable: `o harness "${m.harness}" não tem leitor de conversa no agentistics` }
  if (!m.conversationId) return { unavailable: 'a sessão não tem conversa vinculada' }
  try {
    const path = await reader.resolve({ conversationId: m.conversationId, ...(m.cwd ? { cwd: m.cwd } : {}) })
    if (!path) return { unavailable: 'o arquivo da conversa não foi encontrado' }
    return { turns: (await reader.read(path, RELAY_READ_TURNS)).turns }
  } catch (e) {
    return { unavailable: `a leitura da conversa falhou (${e instanceof Error ? e.message : String(e)})` }
  }
}

export interface CapturedRelay {
  /** The briefing section (always present — an unreadable conversation is said, not skipped). */
  section: string
  cursor?: string
  awaiting: boolean
}

/** The predecessor's owner messages + last reply, as the successor's briefing section. */
export async function captureHandoffRelay(
  parent: ManagedSession,
  read: (m: ManagedSession) => Promise<TurnsRead> = readSessionTurns,
): Promise<CapturedRelay> {
  const got = await read(parent)
  if ('unavailable' in got) return { section: relaySection(parent.id, null, got.unavailable), awaiting: false }
  // "Since the predecessor's previous hand-off": a predecessor born from a hand-off starts there.
  const relay = planRelay(got.turns, parent.handoffFrom ? parent.createdAt : undefined)
  return {
    section: relaySection(parent.id, relay),
    ...(relay.cursor ? { cursor: relay.cursor } : {}),
    awaiting: relay.unanswered,
  }
}

/** Link both rows once the successor exists: the injection above counts as delivered. */
export async function recordHandoffLink(parentId: string, childId: string, captured: CapturedRelay | undefined): Promise<void> {
  await patchSession(parentId, {
    handoffTo: childId,
    handoffRelayedAt: captured?.cursor ?? new Date().toISOString(),
    handoffRelayAwaiting: captured?.awaiting === true ? true : null,
  }).catch(() => false)
  await patchSession(childId, { handoffFrom: parentId }).catch(() => false)
}

/**
 * The successor's CURRENT row: the linked id, or — when that row was retired by a reopen — the
 * live row carrying the same conversation.
 */
export function successorRow(registry: readonly ManagedSession[], handoffTo: string): ManagedSession | undefined {
  const linked = registry.find(m => m.id === handoffTo)
  if (!linked) return undefined
  if (!linked.endedAt || !linked.conversationId) return linked
  return registry.find(m => m.id !== linked.id && !m.endedAt && m.conversationId === linked.conversationId) ?? linked
}

export type RelaySend = (successorId: string, text: string) => Promise<boolean>

export interface FlushResult {
  /** Nothing is owed any more (delivered, or nothing to deliver). */
  ok: boolean
  delivered: boolean
  /** Why it could not be checked (no reader…) — not owed, but not verified either. */
  unverified?: string
}

/** Forward what the owner wrote into ONE predecessor after its snapshot. */
export async function flushHandoffRelay(
  parent: ManagedSession,
  registry: readonly ManagedSession[],
  send: RelaySend,
  io: { read?: (m: ManagedSession) => Promise<TurnsRead>; patch?: typeof patchSession } = {},
): Promise<FlushResult> {
  const read = io.read ?? readSessionTurns
  const patch = io.patch ?? patchSession
  if (!parent.handoffTo) return { ok: true, delivered: false }
  const got = await read(parent)
  if ('unavailable' in got) return { ok: true, delivered: false, unverified: got.unavailable }
  const fwd = planForward(got.turns, parent.handoffRelayedAt, parent.handoffRelayAwaiting === true)
  if (!fwd) return { ok: true, delivered: false }
  const cursorPatch = {
    ...(fwd.cursor ? { handoffRelayedAt: fwd.cursor } : {}),
    handoffRelayAwaiting: fwd.awaiting ? true : null,
  }
  if (!forwardHasContent(fwd)) {
    await patch(parent.id, cursorPatch).catch(() => false)
    return { ok: true, delivered: false }
  }
  const successor = successorRow(registry, parent.handoffTo)
  if (!successor) return { ok: false, delivered: false }
  const sent = await send(successor.id, forwardText(parent.id, fwd)).catch(() => false)
  if (!sent) return { ok: false, delivered: false }
  await patch(parent.id, cursorPatch).catch(() => false)
  return { ok: true, delivered: true }
}

/** The periodic pass: every predecessor still inside its watch window. Returns how many forwarded. */
export async function flushAllHandoffRelays(send: RelaySend, now = Date.now()): Promise<number> {
  const registry = await readRegistry().catch(() => [] as ManagedSession[])
  let n = 0
  for (const m of registry) {
    if (!m.handoffTo || !m.handoffRelayedAt) continue
    const since = Date.parse(m.handoffRelayedAt)
    if (Number.isFinite(since) && now - since > RELAY_WATCH_MS) continue
    const r = await flushHandoffRelay(m, registry, send).catch(() => ({ ok: false, delivered: false }))
    if (r.delivered) n++
  }
  return n
}

/**
 * Before a kill: a predecessor whose last reply (or a later owner message) has not reached its
 * successor is flushed first. `null` = proceed; a sentence = refuse, nothing was killed.
 */
export async function flushBeforeKill(id: string, send: RelaySend, lang: 'en' | 'pt' = 'pt'): Promise<string | null> {
  const registry = await readRegistry().catch(() => [] as ManagedSession[])
  const row = registry.find(m => m.id === id)
  if (!row?.handoffTo) return null
  const r = await flushHandoffRelay(row, registry, send).catch(() => ({ ok: false, delivered: false }))
  if (r.ok) return null
  return lang === 'pt'
    ? `Não encerrei ${id}: a última resposta ao dono (ou uma mensagem dele) ainda não chegou à sessão sucessora ${row.handoffTo}, e o encaminhamento falhou. Tente de novo em instantes.`
    : `Did not kill ${id}: the owner's last answer (or a message from the owner) has not reached the successor ${row.handoffTo} yet, and forwarding it failed. Try again in a moment.`
}

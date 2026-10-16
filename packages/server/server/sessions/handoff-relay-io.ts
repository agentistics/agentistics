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
  forwardHasContent, forwardText, planForward, planRelay, relaySection, type RelayForward,
} from './handoff-relay'
import { stat } from 'node:fs/promises'
import { patchSession, readRegistry } from './registry'
import type { ManagedSession } from './types'

/** Turns read from the predecessor — wide enough for a long leader turn, bounded for a poll. */
const RELAY_READ_TURNS = 400
/** A predecessor is watched this long after its hand-off; past it nobody types into it any more. */
export const RELAY_WATCH_MS = 48 * 60 * 60 * 1000

/** The 30 s pass and the owner-waiting gate read only the END of a transcript. */
const RECENT_TURNS = 120

export type TurnsRead = { turns: ChatTurn[] } | { unavailable: string }

export interface ReadOpts {
  /** Read only the tail (`readRecent`) — the 30 s loop's budget. */
  recent?: boolean
  /** Skip the read entirely when the transcript was last written before this instant (ms). */
  unchangedSince?: number
}

export async function readSessionTurns(
  m: Pick<ManagedSession, 'harness' | 'conversationId' | 'cwd'>,
  opts: ReadOpts = {},
): Promise<TurnsRead> {
  const reader = transcriptReaderFor(m.harness)
  if (!reader) return { unavailable: `o harness "${m.harness}" não tem leitor de conversa no agentistics` }
  if (!m.conversationId) return { unavailable: 'a sessão não tem conversa vinculada' }
  try {
    const path = await reader.resolve({ conversationId: m.conversationId, ...(m.cwd ? { cwd: m.cwd } : {}) })
    if (!path) return { unavailable: 'o arquivo da conversa não foi encontrado' }
    if (opts.unchangedSince !== undefined) {
      const st = await stat(path).catch(() => null)
      if (st && st.mtimeMs <= opts.unchangedSince) return { turns: [] }
    }
    if (opts.recent) return { turns: await reader.readRecent(path, RECENT_TURNS) }
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
  /** `ok: false` only: why it could not be delivered, and what was owed. */
  reason?: 'missing' | 'dead' | 'send-failed'
  owed?: RelayForward
}

/** A successor row that can still take a prompt (ended / exited / lost rows are not targets). */
export function successorAlive(m: ManagedSession): boolean {
  if (m.endedAt) return false
  const status = (m as { status?: string }).status
  return status !== 'exited' && status !== 'lost' && status !== 'closed'
}

/** Forward what the owner wrote into ONE predecessor after its snapshot. */
export async function flushHandoffRelay(
  parent: ManagedSession,
  registry: readonly ManagedSession[],
  send: RelaySend,
  io: { read?: (m: ManagedSession) => Promise<TurnsRead>; patch?: typeof patchSession } = {},
): Promise<FlushResult> {
  const patch = io.patch ?? patchSession
  const cursorMs = parent.handoffRelayedAt ? Date.parse(parent.handoffRelayedAt) : NaN
  // Incremental: only the tail, and not even that when nothing was written since the cursor.
  const read = io.read ?? ((m: ManagedSession) => readSessionTurns(m, {
    recent: true,
    ...(Number.isFinite(cursorMs) ? { unchangedSince: cursorMs } : {}),
  }))
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
  if (!successor) return { ok: false, delivered: false, reason: 'missing', owed: fwd }
  if (!successorAlive(successor)) return { ok: false, delivered: false, reason: 'dead', owed: fwd }
  const sent = await send(successor.id, forwardText(parent.id, fwd)).catch(() => false)
  if (!sent) return { ok: false, delivered: false, reason: 'send-failed', owed: fwd }
  await patch(parent.id, cursorPatch).catch(() => false)
  return { ok: true, delivered: true }
}

/** Inside the 48 h watch window (from the last relayed turn). */
export function relayWatched(m: Pick<ManagedSession, 'handoffTo' | 'handoffRelayedAt'>, now: number): boolean {
  if (!m.handoffTo || !m.handoffRelayedAt) return false
  const since = Date.parse(m.handoffRelayedAt)
  return !(Number.isFinite(since) && now - since > RELAY_WATCH_MS)
}

/** One flush per predecessor at a time (the 30 s loop and a kill must not both send). */
const inFlight = new Set<string>()

async function flushOnce(
  m: ManagedSession, registry: readonly ManagedSession[], send: RelaySend,
  io: Parameters<typeof flushHandoffRelay>[3] = {},
): Promise<FlushResult> {
  if (inFlight.has(m.id)) return { ok: true, delivered: false }
  inFlight.add(m.id)
  try { return await flushHandoffRelay(m, registry, send, io) } finally { inFlight.delete(m.id) }
}

/** The periodic pass: every predecessor still inside its watch window. Returns how many forwarded. */
export async function flushAllHandoffRelays(
  send: RelaySend, now = Date.now(),
  io: { registry?: readonly ManagedSession[]; read?: (m: ManagedSession) => Promise<TurnsRead>; patch?: typeof patchSession } = {},
): Promise<number> {
  const registry = io.registry ?? await readRegistry().catch(() => [] as ManagedSession[])
  let n = 0
  for (const m of registry) {
    if (!relayWatched(m, now)) continue
    const r = await flushOnce(m, registry, send, { ...(io.read ? { read: io.read } : {}), ...(io.patch ? { patch: io.patch } : {}) }).catch(() => ({ ok: false, delivered: false }) as FlushResult)
    if (r.delivered) n++
  }
  return n
}

export interface KillFlush {
  /** What happened, in a sentence, when something was owed and could not be delivered; else null. */
  warning: string | null
}

/**
 * Before a kill: forward what is still owed to the successor — BEST EFFORT. A kill is never refused
 * because of the relay. When the successor is missing, dead or the send fails, what was owed is
 * recorded as a comment on the successor's (else the predecessor's) task, and the kill proceeds.
 */
export async function flushBeforeKill(
  id: string, send: RelaySend, lang: 'en' | 'pt' = 'pt',
  io: { now?: number; registry?: readonly ManagedSession[]; read?: (m: ManagedSession) => Promise<TurnsRead>; patch?: typeof patchSession; comment?: (taskRef: string, body: string, subtaskId?: string) => Promise<boolean> } = {},
): Promise<KillFlush> {
  try {
    const registry = io.registry ?? await readRegistry().catch(() => [] as ManagedSession[])
    const row = registry.find(m => m.id === id)
    if (!row?.handoffTo || !relayWatched(row, io.now ?? Date.now())) return { warning: null }
    const r = await flushOnce(row, registry, send, { ...(io.read ? { read: io.read } : {}), ...(io.patch ? { patch: io.patch } : {}) })
    if (r.ok || !r.owed) return { warning: null }
    const successor = successorRow(registry, row.handoffTo)
    const taskId = successor?.taskId ?? row.taskId
    const subtaskId = successor?.taskId ? successor.subtaskId : row.subtaskId
    const body = `${forwardText(row.id, r.owed)}\n\n(O encaminhamento à sessão sucessora ${row.handoffTo} falhou — ${r.reason} — antes de encerrar ${row.id}.)`
    const comment = io.comment ?? defaultComment
    const recorded = taskId ? await comment(taskId, body, subtaskId).catch(() => false) : false
    const warning = lang === 'pt'
      ? `Encerrei ${id}, mas a última resposta ao dono não chegou à sucessora ${row.handoffTo} (${r.reason}).${recorded ? ' Ficou registrada como comentário na tarefa.' : ' Não há tarefa vinculada para registrar.'}`
      : `Killed ${id}, but the owner's last answer did not reach the successor ${row.handoffTo} (${r.reason}).${recorded ? ' It was recorded as a task comment.' : ' No task is linked to record it.'}`
    return { warning }
  } catch {
    return { warning: null }
  }
}

async function defaultComment(taskRef: string, body: string, subtaskId?: string): Promise<boolean> {
  const { addComment } = await import('./task-web')
  const res = await addComment(taskRef, { author: 'agentistics · relay', body, ...(subtaskId ? { subtaskId } : {}) })
  return res.ok
}

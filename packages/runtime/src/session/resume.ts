/**
 * session/resume.ts — B4.2: opening a stored session, reading older turns on demand, and repairing
 * a run a dead driver left `running` (spec docs/superpowers/specs/2026-09-27-runtime-b4-sessions.md
 * §4).
 *
 * ## Opening a session (§24.5: no whole-history load, ever)
 *
 * `openSession` reads the session's metadata plus its NEWEST window (`listMessages` with no
 * `before` — the store's own default/max, spec §2). `olderMessages` is the cursor: `before` +
 * `limit` reproduce exactly the shape `runtime.ts`'s own `run()` reads for context, so a surface
 * scrolling up sees the same records the model would be shown on the next turn.
 *
 * A message body that cannot be read from the content store (evicted, corrupted, a bad hash) is
 * never invented — `hydrate` SKIPS it and reports its `seq` in `missing` (added to `OpenedSession`
 * beyond the bare contract: a caller that ignores it still gets a correct, if shorter, window; one
 * that cares can say so).
 *
 * ## Repairing an interrupted run (§4)
 *
 * A run is `running` in the store for exactly as long as its driving process is alive. `resume.ts`
 * is called AFTER the caller has already taken the session's lease — so a `running` row found here
 * names a process that is provably gone (the lease could not have been re-acquired otherwise), and
 * the three-way split below is what makes each dangling tool_use in the last assistant turn
 * reportable to the model on the next run rather than left as a `tool_use` with no `tool_result`
 * (which the model would refuse to build on, per `runtime.ts`'s `isCleanUserBoundary`).
 *
 * The interrupted branch's `tool.failed` event is built by hand rather than through
 * `loop/emit.ts`'s `createToolEventEmitter` — that sink's typed `failed()` call REQUIRES a numeric
 * `durationMs` (nothing here was measured, so there is none to give it) while the canonical
 * `ToolFailedData.durationMs` is optional; the CONTRACT explicitly asks for the field to be absent.
 * `toolScopeKey` + `deriveEventId` are reused directly instead, with the exact same inputs
 * (`sourceKind: 'runtime'`, `sourceId: 'agentistics'`, `sourceRef: '<scope>:tx:<toolExecutionId>'`,
 * `type: 'tool.failed'`) the emitter would have hashed — `eventIdPreimage` never reads `data`, so
 * the id this module mints is byte-for-byte the id the loop would have minted for the very same
 * call, and a replay (this repair running twice, or a differential reader) converges on it exactly.
 *
 * Every store/journal write here is wrapped so a failure is REPORTED in `RepairReport.sentence`
 * rather than thrown past the caller — the same "a journal that fails never fails the call" rule
 * `loop/emit.ts` and `provider/emit.ts` state for their own appends.
 */

import {
  CANONICAL_EVENT_SCHEMA,
  deriveEventId,
  type AgentisticsEvent,
  type EventSource,
  type ToolFailedData,
} from '@agentistics/core'
import { toolScopeKey } from '../loop/emit.ts'
import type { EmitScope, ProviderJournalSink } from '../provider/emit.ts'
import type { ProviderMessage, ProviderMessagePart } from '../provider/client.ts'
import { runEndedEvent, type LifecycleEventContext } from './lifecycle.ts'
import type { SessionContentStore } from './runtime.ts'
import type { MessageRecord, SessionRecord, SessionStore } from './types.ts'

export interface ResumeDeps {
  store: SessionStore
  content: SessionContentStore
  /** `null` = no journal at all — the run.ended / tool.failed writes are then counted lost. */
  journal: ProviderJournalSink | null
  runtimeVersion: string
  now?: () => Date
}

export interface OpenedSession {
  session: SessionRecord
  /** Ascending by `seq` — the newest window (spec §2's `listMessages`). */
  messages: { seq: number; message: ProviderMessage }[]
  /** Absent when there is nothing older. */
  nextBefore?: number
  /**
   * `seq`s whose body could not be read from the content store — never invented as a placeholder
   * message. Absent (not an empty array) when every message in the window read cleanly.
   */
  missing?: number[]
}

/** Metadata + the NEWEST window (default 50, max 200). Never the whole history. `null` = no such session. */
export async function openSession(
  deps: Pick<ResumeDeps, 'store' | 'content'>,
  sessionId: string,
  opts?: { window?: number },
): Promise<OpenedSession | null> {
  const session = await deps.store.getSession(sessionId)
  if (!session) return null
  const page = await deps.store.listMessages(sessionId, { limit: opts?.window })
  const { messages, missing } = await hydrate(deps.content, page.messages)
  const out: OpenedSession = { session, messages }
  if (page.nextBefore !== undefined) out.nextBefore = page.nextBefore
  if (missing.length > 0) out.missing = missing
  return out
}

/** Older turns on demand: the window strictly before `before`. */
export async function olderMessages(
  deps: Pick<ResumeDeps, 'store' | 'content'>,
  sessionId: string,
  before: number,
  limit?: number,
): Promise<{ messages: { seq: number; message: ProviderMessage }[]; nextBefore?: number }> {
  const page = await deps.store.listMessages(sessionId, { before, limit })
  const { messages } = await hydrate(deps.content, page.messages)
  return page.nextBefore === undefined ? { messages } : { messages, nextBefore: page.nextBefore }
}

async function hydrate(
  content: Pick<SessionContentStore, 'get'>,
  records: readonly MessageRecord[],
): Promise<{ messages: { seq: number; message: ProviderMessage }[]; missing: number[] }> {
  const messages: { seq: number; message: ProviderMessage }[] = []
  const missing: number[] = []
  for (const rec of records) {
    const body = await content.get(rec.content.sha256)
    if (body === null) { missing.push(rec.seq); continue }
    try {
      messages.push({ seq: rec.seq, message: JSON.parse(body) as ProviderMessage })
    } catch {
      missing.push(rec.seq)
    }
  }
  return { messages, missing }
}

export interface RepairReport {
  runId: string | null
  repaired: boolean
  settled: number
  interrupted: number
  notStarted: number
  /** For a person or a log — never parsed back. Names every IO failure met along the way. */
  sentence: string
}

const INTERRUPTED_TEXT =
  'This call was interrupted: the process running the session ended before it finished. It may or may not have taken effect — check before repeating it.'
const NOT_STARTED_TEXT = 'Not run: the process ended before this call started.'

const RUNTIME_SOURCE_ID = 'agentistics'

function isToolUsePart(p: ProviderMessagePart): p is Extract<ProviderMessagePart, { type: 'tool_use' }> {
  return p.type === 'tool_use'
}

/**
 * `tool.failed {status:'cancelled', errorClass:'killed'}` with no `durationMs` (module doc — never
 * measured, so there is none to journal), keyed exactly as `loop/emit.ts`'s `createToolEventEmitter`
 * would key the very same call: same `sourceKind`/`sourceId`/`sourceRef`/`type`, so the id this
 * module mints IS the id the loop would have minted, and a repeated repair converges on it.
 */
function killedToolFailedEvent(
  scope: EmitScope,
  toolExecutionId: string,
  occurredAt: string,
  recordedAt: string,
  adapterVersion: string,
): AgentisticsEvent<'tool.failed'> {
  const sourceRef = `${toolScopeKey(scope)}:tx:${toolExecutionId}`
  const data: ToolFailedData = { toolExecutionId, status: 'cancelled', errorClass: 'killed' }
  const source: EventSource = { kind: 'runtime', id: RUNTIME_SOURCE_ID }
  const e: AgentisticsEvent<'tool.failed'> = {
    eventId: deriveEventId({ sourceKind: 'runtime', sourceId: RUNTIME_SOURCE_ID, sourceRef, type: 'tool.failed' }),
    schema: CANONICAL_EVENT_SCHEMA,
    type: 'tool.failed',
    occurredAt,
    recordedAt,
    source,
    provenance: { mode: 'native', confidence: 'exact', adapterVersion, sourceRef },
    data,
  }
  if (scope.sessionId !== undefined) e.sessionId = scope.sessionId
  if (scope.runId !== undefined) e.runId = scope.runId
  if (scope.agentId !== undefined) e.agentId = scope.agentId
  if (scope.taskId !== undefined) e.taskId = scope.taskId
  return e
}

async function appendOne(journal: ProviderJournalSink | null, event: AgentisticsEvent, onLost: () => void): Promise<void> {
  if (!journal) { onLost(); return }
  try {
    const r = await journal.append([event])
    if (r.written + r.duplicates < 1) onLost()
  } catch {
    onLost()
  }
}

/**
 * Call ONLY while holding the session's lease (module doc). Idempotent: a second call finds the
 * run no longer `running` (this one already moved it to `lost`) and repairs nothing.
 */
export async function repairInterruptedRun(deps: ResumeDeps, sessionId: string): Promise<RepairReport> {
  const now = deps.now ?? (() => new Date())
  const run = await deps.store.latestRun(sessionId)
  if (!run || run.status !== 'running') {
    return {
      runId: run?.runId ?? null,
      repaired: false,
      settled: 0,
      interrupted: 0,
      notStarted: 0,
      sentence: run
        ? `Run ${run.runId} is ${run.status}, not running — nothing to repair.`
        : `Session ${sessionId} has no run to repair.`,
    }
  }

  const failures: string[] = []
  let settled = 0
  let interrupted = 0
  let notStarted = 0

  const last = (await deps.store.listMessages(sessionId, { limit: 1 })).messages[0]
  // The tool_results for this run's dangling calls were already persisted (or there is nothing to
  // persist them onto) unless the very last stored message is this run's own assistant turn.
  const isDanglingAssistantTurn = last !== undefined && last.role === 'assistant' && last.runId === run.runId

  if (isDanglingAssistantTurn) {
    const body = await deps.content.get(last!.content.sha256)
    if (body === null) {
      failures.push(`could not read the last assistant message (seq ${last!.seq}) to find its tool calls`)
    } else {
      let assistantMsg: ProviderMessage | null = null
      try {
        assistantMsg = JSON.parse(body) as ProviderMessage
      } catch {
        failures.push(`the last assistant message (seq ${last!.seq}) was not valid JSON`)
      }
      const toolUses = assistantMsg !== null && Array.isArray(assistantMsg.content)
        ? assistantMsg.content.filter(isToolUsePart)
        : []

      if (toolUses.length > 0) {
        const calls = await deps.store.listToolCalls(run.runId)
        const byToolUseId = new Map(calls.map(c => [c.toolUseId, c]))
        const parts: ProviderMessagePart[] = []
        const repairIso = now().toISOString()
        const scope: EmitScope = { sessionId, runId: run.runId }

        for (const tu of toolUses) {
          const call = byToolUseId.get(tu.id)
          if (call && call.state === 'settled') {
            let text = ''
            if (call.result) {
              const resultBody = await deps.content.get(call.result.sha256)
              if (resultBody === null) failures.push(`could not read the settled result for ${tu.id}`)
              else text = resultBody
            }
            parts.push({ type: 'tool_result', toolUseId: tu.id, content: text, isError: call.isError ?? false })
            settled += 1
          } else if (call && call.state === 'started') {
            parts.push({ type: 'tool_result', toolUseId: tu.id, content: INTERRUPTED_TEXT, isError: true })
            interrupted += 1
            await appendOne(
              deps.journal,
              killedToolFailedEvent(scope, call.toolExecutionId, repairIso, now().toISOString(), deps.runtimeVersion),
              () => failures.push(`could not journal the interruption of ${tu.id}`),
            )
          } else {
            parts.push({ type: 'tool_result', toolUseId: tu.id, content: NOT_STARTED_TEXT, isError: true })
            notStarted += 1
          }
        }

        if (parts.length > 0) {
          const userMsg: ProviderMessage = { role: 'user', content: parts }
          const ref = await deps.content.put(JSON.stringify(userMsg))
          if (ref) {
            await deps.store.appendMessage({ sessionId, runId: run.runId, role: 'user', content: ref, createdAt: repairIso })
          } else {
            failures.push('could not persist the repaired tool results')
          }
        }
      }
    }
  }

  const endedIso = now().toISOString()
  await deps.store.updateRun(run.runId, { status: 'lost', endedAt: endedIso })
  const ctx: LifecycleEventContext = { adapterVersion: deps.runtimeVersion, occurredAt: endedIso, recordedAt: endedIso }
  await appendOne(deps.journal, runEndedEvent(sessionId, run.runId, 'lost', ctx), () => failures.push('could not journal run.ended'))

  const counts = `settled ${settled}, interrupted ${interrupted}, not started ${notStarted}`
  const sentence = failures.length > 0
    ? `Repaired run ${run.runId} (${counts}), but: ${failures.join('; ')}.`
    : `Repaired run ${run.runId}: ${counts}.`

  return { runId: run.runId, repaired: true, settled, interrupted, notStarted, sentence }
}

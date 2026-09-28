/**
 * session/runtime.ts — `createSessionRuntime(deps)`: the session/run lifecycle on top of the B3
 * tool loop (spec §3, §4's `contextFrom`). `create` / `run` / `cancel` / `finish` / `fail` / `get`.
 *
 * ## What a run does, in order
 *
 * `tryAcquire()` on the scheduler FIRST — a machine already at its ceiling never mints a run id,
 * never opens a lease and never spends a model call finding out it should have refused. Then
 * `run.started` is journaled, the newest window of stored messages is read back and trimmed to a
 * clean boundary (`contextFrom`), the new user message is persisted BEFORE the model ever sees it
 * (so a kill in the first second still leaves it durable), and the B3 loop runs with `onHistory` /
 * `onToolCall` hooks wired to the store — every message the loop appends and every tool call it
 * starts or settles reaches disk as it happens, not at the end of the run (module doc, `loop.ts`).
 *
 * ## The journal tap (`onEvent`)
 *
 * `deps.onEvent`, when given, sees EVERY event this runtime's journal receives — the loop's own
 * `tool.*`/`policy.*`/`model.*` events AND this module's own `session.*`/`run.*` ones — because the
 * journal handed to the loop and used for the lifecycle events is the SAME teed sink
 * (`createTeeJournal`), never two independent appends that could disagree about what happened. This
 * is the seam B4.3's shared-session hub subscribes through.
 *
 * ## The policy is cached PER SESSION, not per run
 *
 * `policy/policy.ts`'s own doc states it: "approvals live in memory for the policy's lifetime (one
 * session)". A person who says "allow for this session" on turn 1 must still have that answer on
 * turn 2 of the SAME open session — so `policyFor` builds the policy once (via `deps.policyFactory`)
 * and keeps it for as long as the session is open, evicting it in `finish`/`fail`. Bounded by the
 * number of sessions this runtime currently has OPEN, which is the same population `store` already
 * tracks; a session that never finishes leaks one policy object, exactly as it leaks one open row.
 *
 * ## Status mapping (spec §3)
 *
 * `end-turn` / `max-turns` / `max-tool-calls` / `wall-time` → `completed` (the run reached a bound or
 * the model chose to stop — neither is a failure of the run itself). `model-failed` /
 * `invalid-catalogue` → `failed`. `aborted` → `abandoned` (a person or `cancel()` stopped it on
 * purpose). `lost` is never produced here — it is B4.2's finding, made by resume when a `running` row
 * is opened and its lease holder is gone.
 */

import type { AgentisticsEvent, ProviderId, RunStartedData, RunStatus, SessionStartedData } from '@agentistics/core'
import type { CredentialRef } from '../provider/credential.ts'
import type { ProviderClient, ProviderMessage, ProviderMessagePart, ProviderStreamEvent } from '../provider/client.ts'
import type { EmitScope, ProviderJournalSink } from '../provider/emit.ts'
import type { ContentSink, PersonAsker, Tool, ToolPolicy } from '../tools/contract.ts'
import { runToolLoop, type ToolLoopLimits, type ToolLoopOptions, type ToolLoopStatus } from '../loop/loop.ts'
import { runEndedEvent, runStartedEvent, sessionEndedEvent, sessionStartedEvent, type LifecycleEventContext } from './lifecycle.ts'
import type { RunScheduler } from './scheduler.ts'
import type { MessageRecord, RecordToolCallInput, RunRecord, SessionRecord, SessionStore } from './types.ts'

// ── Context assembly (§4 — the resume item reuses this exact function) ─────────────────────────

/** A user message that is NOT only tool results — a genuine boundary the model can resume from. */
export function isCleanUserBoundary(msg: ProviderMessage): boolean {
  if (msg.role !== 'user') return false
  if (typeof msg.content === 'string') return true
  if (msg.content.length === 0) return true
  return msg.content.some((p: ProviderMessagePart) => p.type !== 'tool_result')
}

/**
 * Trims a message window FORWARD to the first clean user boundary, so the model never sees a
 * `tool_use` with no `tool_result` (or vice versa) at the start of what it reads. When the window
 * carries no such boundary at all (every message in it is part of one very long tool-calling
 * exchange with no fresh human turn inside the window) the whole window is kept rather than emptied
 * — a record that cannot be safely trimmed is not a record that said nothing.
 */
export function contextFrom(messages: readonly ProviderMessage[]): ProviderMessage[] {
  const idx = messages.findIndex(isCleanUserBoundary)
  return idx < 0 ? [...messages] : messages.slice(idx)
}

// ── Status mapping ──────────────────────────────────────────────────────────────────────────────

function mapStopToRunStatus(stop: ToolLoopStatus): Exclude<RunStatus, 'running' | 'lost'> {
  switch (stop) {
    case 'end-turn':
    case 'max-turns':
    case 'max-tool-calls':
    case 'wall-time':
      return 'completed'
    case 'model-failed':
    case 'invalid-catalogue':
      return 'failed'
    case 'aborted':
      return 'abandoned'
  }
}

// ── The journal tap: one teed sink, so `onEvent` sees exactly what the journal sees ────────────

function createTeeJournal(inner: ProviderJournalSink | null, onEvent: ((e: AgentisticsEvent) => void) | undefined): ProviderJournalSink {
  return {
    async append(events) {
      if (onEvent) {
        for (const e of events) {
          try { onEvent(e) } catch { /* a watcher never fails the append */ }
        }
      }
      if (!inner) return { written: 0, duplicates: events.length }
      return inner.append(events)
    },
  }
}

// ── Public shapes ───────────────────────────────────────────────────────────────────────────────

export interface CreateSessionInput {
  title?: string
  workspaceRoot: string
  cwd: string
  provider: ProviderId
  model: string
  credential: CredentialRef
}

export interface RunOptions {
  signal?: AbortSignal
  limits?: Partial<ToolLoopLimits>
}

export type RunOutcome =
  | { ok: true; runId: string; status: Exclude<RunStatus, 'running' | 'lost'>; stop: ToolLoopStatus; sentence: string; turns: number; toolCalls: number }
  | { ok: false; reason: 'session-not-found' | 'session-not-open' | 'at-ceiling'; sentence: string }

export interface SessionContentStore extends ContentSink {
  /** `null`: not found, unreadable, or a bad (untrusted) sha — never a throw. */
  get(sha256: string): Promise<string | null>
}

export interface CreateSessionRuntimeDeps {
  store: SessionStore
  content: SessionContentStore
  /** `null` = no journal at all; every event is then counted lost by the loop's own emitters. */
  journal: ProviderJournalSink | null
  clientFor(provider: ProviderId): ProviderClient
  tools: readonly Tool<unknown>[]
  /** Builds the policy for a session ONCE (see module doc — approvals live for the session). */
  policyFactory(session: SessionRecord): ToolPolicy
  asker?: PersonAsker
  /**
   * The person to ask for ONE session — wins over `asker`. A shared session asks every surface
   * watching IT (the hub's asker is per session), never whoever happens to watch another one.
   */
  askerFor?: (sessionId: string) => PersonAsker | undefined
  runtimeVersion: string
  scheduler: RunScheduler
  now?: () => Date
  /** Default: `${prefix}` + a 32-hex-char id (a UUID v4 with its dashes stripped). */
  mintId?: (prefix: string) => string
  /** Sees every event this runtime's journal receives — the shared-session hub subscribes here. */
  onEvent?: (e: AgentisticsEvent) => void
  /** Live provider events, with the run they belong to — one process may host many sessions. */
  onStreamEvent?: (e: ProviderStreamEvent, scope: { sessionId: string; runId: string }) => void
  /** Default 8192. */
  maxTokens?: number
  defaultLimits?: Partial<ToolLoopLimits>
  /** Default 200 (spec §4) — the newest messages fed to the model on a run. */
  contextMessages?: number
  retry?: ToolLoopOptions['retry']
}

export interface SessionRuntime {
  create(input: CreateSessionInput): Promise<SessionRecord>
  run(sessionId: string, userText: string, opts?: RunOptions): Promise<RunOutcome>
  /** `true`: a live run was found and its abort signal was raised. `false`: nothing to cancel. */
  cancel(runId: string): boolean
  finish(sessionId: string): Promise<void>
  fail(sessionId: string): Promise<void>
  get(sessionId: string): Promise<SessionRecord | null>
}

const DEFAULT_MAX_TOKENS = 8192
const DEFAULT_MAX_TURNS = 60
const DEFAULT_MAX_TOOL_CALLS = 200
const DEFAULT_WALL_TIME_MS = 30 * 60 * 1000
const DEFAULT_CONTEXT_MESSAGES = 200

function defaultMintId(prefix: string): string {
  return `${prefix}${crypto.randomUUID().replaceAll('-', '')}`
}

// ── The runtime ─────────────────────────────────────────────────────────────────────────────────

export function createSessionRuntime(deps: CreateSessionRuntimeDeps): SessionRuntime {
  const now = deps.now ?? (() => new Date())
  const mintId = deps.mintId ?? defaultMintId
  const contextMessages = deps.contextMessages ?? DEFAULT_CONTEXT_MESSAGES
  const journal = createTeeJournal(deps.journal, deps.onEvent)

  /** Bounded by the number of sessions currently OPEN under this runtime (module doc). */
  const policies = new Map<string, ToolPolicy>()
  /** Bounded by the scheduler's own ceiling: one entry per run in flight, removed in the `finally`. */
  const activeRuns = new Map<string, AbortController>()

  function policyFor(session: SessionRecord): ToolPolicy {
    const existing = policies.get(session.sessionId)
    if (existing) return existing
    const built = deps.policyFactory(session)
    policies.set(session.sessionId, built)
    return built
  }

  async function emit(event: AgentisticsEvent): Promise<void> {
    try { await journal.append([event]) } catch { /* the journal never fails the caller */ }
  }

  async function hydrateMessages(records: readonly MessageRecord[]): Promise<ProviderMessage[]> {
    const out: ProviderMessage[] = []
    for (const rec of records) {
      const body = await deps.content.get(rec.content.sha256)
      if (body === null) continue // the body is gone; skipped rather than guessed at
      try {
        out.push(JSON.parse(body) as ProviderMessage)
      } catch { /* a corrupt body is treated the same as a missing one */ }
    }
    return out
  }

  async function create(input: CreateSessionInput): Promise<SessionRecord> {
    const sessionId = mintId('ses_')
    const iso = now().toISOString()
    const session: SessionRecord = {
      sessionId,
      createdAt: iso,
      updatedAt: iso,
      status: 'open',
      workspaceRoot: input.workspaceRoot,
      cwd: input.cwd,
      provider: input.provider,
      model: input.model,
      credential: input.credential,
      messageCount: 0,
      lastSeq: 0,
      runCount: 0,
    }
    if (input.title !== undefined) session.title = input.title
    await deps.store.createSession(session)

    const data: SessionStartedData = { origin: 'native', projectPath: input.workspaceRoot }
    if (input.title !== undefined) data.title = input.title
    const ctx: LifecycleEventContext = { adapterVersion: deps.runtimeVersion, occurredAt: iso, recordedAt: iso }
    await emit(sessionStartedEvent(sessionId, data, ctx))
    return session
  }

  async function run(sessionId: string, userText: string, opts: RunOptions = {}): Promise<RunOutcome> {
    const session = await deps.store.getSession(sessionId)
    if (!session) return { ok: false, reason: 'session-not-found', sentence: `No such session: ${sessionId}.` }
    if (session.status !== 'open') {
      return { ok: false, reason: 'session-not-open', sentence: `Session ${sessionId} is ${session.status}, not open.` }
    }

    const slot = deps.scheduler.tryAcquire()
    if (!slot.ok) return { ok: false, reason: 'at-ceiling', sentence: slot.sentence }

    const runId = mintId('run_')
    const startedIso = now().toISOString()
    const runRecord: RunRecord = { runId, sessionId, startedAt: startedIso, status: 'running', turns: 0, toolCalls: 0 }
    await deps.store.createRun(runRecord)

    const ctl = new AbortController()
    activeRuns.set(runId, ctl)
    if (opts.signal) {
      if (opts.signal.aborted) ctl.abort()
      else opts.signal.addEventListener('abort', () => ctl.abort(), { once: true })
    }

    const runStartedData: RunStartedData = { harness: 'agentistics', conversationLink: 'none', cwd: session.cwd }
    const startCtx: LifecycleEventContext = { adapterVersion: deps.runtimeVersion, occurredAt: startedIso, recordedAt: startedIso }
    await emit(runStartedEvent(sessionId, runId, runStartedData, startCtx))

    try {
      const window = await deps.store.listMessages(sessionId, { limit: contextMessages })
      const prior = contextFrom(await hydrateMessages(window.messages))
      const userMsg: ProviderMessage = { role: 'user', content: userText }
      const messages: ProviderMessage[] = [...prior, userMsg]

      // Persisted BEFORE the model ever sees it: a process killed in the first second still leaves
      // the person's own message durable.
      const userRef = await deps.content.put(JSON.stringify(userMsg))
      if (userRef) await deps.store.appendMessage({ sessionId, runId, role: 'user', content: userRef, createdAt: startedIso })

      const client = deps.clientFor(session.provider)
      const policy = policyFor(session)
      const scope: EmitScope = { sessionId, runId }

      const loopResult = await runToolLoop({
        client,
        model: session.model,
        maxTokens: deps.maxTokens ?? DEFAULT_MAX_TOKENS,
        credential: session.credential,
        messages,
        tools: deps.tools,
        limits: {
          maxTurns: DEFAULT_MAX_TURNS,
          maxToolCalls: DEFAULT_MAX_TOOL_CALLS,
          wallTimeMs: DEFAULT_WALL_TIME_MS,
          ...deps.defaultLimits,
          ...opts.limits,
        },
        policy,
        content: deps.content,
        asker: deps.askerFor?.(sessionId) ?? deps.asker,
        journal,
        runtimeVersion: deps.runtimeVersion,
        workspaceRoot: session.workspaceRoot,
        cwd: session.cwd,
        scope,
        signal: ctl.signal,
        onStreamEvent: deps.onStreamEvent ? (e: ProviderStreamEvent) => deps.onStreamEvent!(e, { sessionId, runId }) : undefined,
        onHistory: async appended => {
          for (const msg of appended) {
            const ref = await deps.content.put(JSON.stringify(msg))
            if (!ref) continue
            await deps.store.appendMessage({ sessionId, runId, role: msg.role, content: ref, createdAt: now().toISOString() })
          }
        },
        onToolCall: async e => {
          const base = { runId, toolExecutionId: e.toolExecutionId, toolUseId: e.toolUseId, name: e.name }
          const input: RecordToolCallInput = e.phase === 'started'
            ? { ...base, state: 'started' }
            : { ...base, state: 'settled', isError: e.isError, result: (await deps.content.put(e.text)) ?? undefined }
          await deps.store.recordToolCall(input)
        },
        now,
        retry: deps.retry,
      })

      const status = mapStopToRunStatus(loopResult.status)
      const endedIso = now().toISOString()
      await deps.store.updateRun(runId, {
        status,
        stop: loopResult.status,
        sentence: loopResult.sentence,
        turns: loopResult.turns,
        toolCalls: loopResult.toolCalls,
        endedAt: endedIso,
      })
      const endCtx: LifecycleEventContext = { adapterVersion: deps.runtimeVersion, occurredAt: endedIso, recordedAt: endedIso }
      await emit(runEndedEvent(sessionId, runId, status, endCtx))

      return { ok: true, runId, status, stop: loopResult.status, sentence: loopResult.sentence, turns: loopResult.turns, toolCalls: loopResult.toolCalls }
    } finally {
      activeRuns.delete(runId)
      slot.release()
    }
  }

  function cancel(runId: string): boolean {
    const ctl = activeRuns.get(runId)
    if (!ctl) return false
    ctl.abort()
    return true
  }

  async function endSession(sessionId: string, status: 'ended' | 'failed'): Promise<void> {
    const iso = now().toISOString()
    await deps.store.updateSession(sessionId, { status, updatedAt: iso })
    const ctx: LifecycleEventContext = { adapterVersion: deps.runtimeVersion, occurredAt: iso, recordedAt: iso }
    await emit(sessionEndedEvent(sessionId, ctx))
    policies.delete(sessionId)
  }

  return {
    create,
    run,
    cancel,
    finish: sessionId => endSession(sessionId, 'ended'),
    fail: sessionId => endSession(sessionId, 'failed'),
    get: sessionId => deps.store.getSession(sessionId),
  }
}

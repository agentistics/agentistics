import { readPreferences as realReadPreferences, updatePreferences as realUpdatePreferences } from './preferences'
import type { Preferences } from './preferences'
import { AGENTISTICS_DATA_DIR as realDataDir, HOME_DIR } from './config'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readRegistry as realReadRegistry } from './sessions/registry'
import { readRolesDoc as realReadRolesDoc, roleOfRow as realRoleOfRow } from './sessions/session-roles'
import { readFleet as realReadFleet, runFleetAction as realRunFleetAction } from './sessions/fleet-web'
import { loadTaskWorld as realLoadTaskWorld } from './sessions/task-source'
import { newEventId as realNewEventId, type TaskEvent } from './sessions/task-model'
import { sseEncoder, sseClients as realSseClients } from './sse'
import { awayActive, planBudget, planPace, parseAwayState, windowRenewed, type HarnessId, type PlanLimits, type PlanBudget, type PlanPace } from '@agentistics/core'
import { harnessEnabled } from './adapters/types'
import { createHash } from 'node:crypto'
import { isClosedRow } from './sessions/fleet-events'
import { kimiMcpPath } from './kimi-mcp'
import { AGY_MCP_CONFIG } from './agy-mcp'

export interface CheckinDeps {
  readPreferences: typeof realReadPreferences
  updatePreferences: typeof realUpdatePreferences
  readRegistry: typeof realReadRegistry
  readRolesDoc: typeof realReadRolesDoc
  roleOfRow: typeof realRoleOfRow
  readFleet: typeof realReadFleet
  runFleetAction: typeof realRunFleetAction
  loadTaskWorld: typeof realLoadTaskWorld
  newEventId: typeof realNewEventId
  dataDir: string
  sseClients: typeof realSseClients
  /** Cheap, server-side inputs for idle-skip. Each is replaceable in tests. */
  readCheckinActivity: (since: number, leader: string) => Promise<unknown>
  readCheckinLimits: (now: number) => Promise<unknown>
  readCheckinRelease: () => Promise<unknown>
  readCheckinMcpConfigs: (cwd: string) => Promise<unknown>
}

// Board kinds are open-ended. Ignore check-in reports (our own feedback) and filter
// session-message comment mirrors by their resolved recipient.
export function checkinActivity(events: readonly TaskEvent[], leader: string): unknown {
  return events.flatMap(e => {
    if (e.kind === 'checkin') return []
    if (e.kind !== 'comment') return [{ ...e }]
    if (!e.detail) return []
    try {
      const { message } = JSON.parse(e.detail)
      return message?.to === leader && ['handback', 'block', 'question'].includes(message.kind)
        ? [{ id: e.id, kind: message.kind, at: e.at, taskId: e.taskId, actor: e.actor }] : []
    } catch { return [] }
  })
}

export function checkinLimitInputs(limits: readonly PlanLimits[], now: number, budgets?: readonly (PlanBudget & PlanPace & { accountLabel?: string })[]): unknown {
  return limits.map((l, index) => {
    // Payload budgets follow the limits order, including separate accounts of one harness.
    const budget = budgets?.[index] ?? { ...planBudget(l, now), ...planPace(l, now) }
    return {
      harness: l.harness, account: l.account, ...(budget.accountLabel ? { accountLabel: budget.accountLabel } : {}), plan: l.plan, sourcePlan: l.sourcePlan,
      status: budget.status, paceStatus: budget.paceStatus, hold: budget.status === 'hold',
      pause: budget.pauseUntil !== undefined && budget.pauseUntil > now,
      // Retain renewal identity, including a zero-usage renewal, without raw usage.
      windows: l.windows.map(w => ({ kind: w.kind, resetsAt: w.resetsAt, renewed: windowRenewed(w, now) })),
    }
  })
}

/** One line per VISIBLE account: an account the owner switched off has no budget row and is absent. */
export function checkinAccountLimits(limits: readonly PlanLimits[], budgets: readonly (PlanBudget & PlanPace & { account?: string; accountLabel?: string })[], now: number): unknown {
  const rows = limits.flatMap(l => {
    const budget = budgets.find(b => b.harness === l.harness && b.account === l.account)
    return budget ? [{ l, budget }] : []
  })
  return checkinLimitInputs(rows.map(r => r.l), now, rows.map(r => r.budget))
}

const defaultCheckinActivity: CheckinDeps['readCheckinActivity'] = async (_since, leader) => checkinActivity((await deps.loadTaskWorld()).book.events, leader)

const defaultDeps: CheckinDeps = {
  readPreferences: realReadPreferences,
  updatePreferences: realUpdatePreferences,
  readRegistry: realReadRegistry,
  readRolesDoc: realReadRolesDoc,
  roleOfRow: realRoleOfRow,
  readFleet: realReadFleet,
  runFleetAction: realRunFleetAction,
  loadTaskWorld: realLoadTaskWorld,
  newEventId: realNewEventId,
  dataDir: realDataDir,
  sseClients: realSseClients,
  readCheckinActivity: defaultCheckinActivity,
  readCheckinLimits: async now => {
    const { planLimitsPayload } = await import('./plan-limits')
    const { limits, registered, budgets } = await planLimitsPayload((await deps.readPreferences()).billing, now)
    return { registered, limits: checkinAccountLimits(limits, budgets, now) }
  },
  readCheckinRelease: async () => {
    try {
      const { getVersionInfo } = await import('./version')
      const v = await getVersionInfo()
      return { current: v.current, latest: v.latest }
    } catch { return null }
  },
  readCheckinMcpConfigs: async cwd => {
    const { listMcp } = await import('./mcp-admin')
    const listed = harnessEnabled('claude') ? await listMcp(cwd) : null
    // The other harnesses store their own configuration. Only digests leave this reader.
    const files: [HarnessId, string][] = [
      ['codex', join(HOME_DIR, '.codex', 'config.toml')], ['codex', join(cwd, '.codex', 'config.toml')],
      ['gemini', join(HOME_DIR, '.gemini', 'settings.json')], ['gemini', join(cwd, '.gemini', 'settings.json')],
      ['copilot', join(HOME_DIR, '.copilot', 'mcp-config.json')],
      ['antigravity', AGY_MCP_CONFIG],
      ['kimi', kimiMcpPath()],
    ]
    const configs = await Promise.all(files.filter(([h]) => harnessEnabled(h)).map(async ([harness, file]) => {
      try { return { harness, file, digest: createHash('sha256').update(await readFile(file)).digest('hex') } }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { harness, file, digest: null }; throw error }
    }))
    return { claude: listed?.servers.map(s => ({ name: s.name, scope: s.scope, transport: s.transport, url: s.url ?? null, config: s.config })), configs }
  },
}
let deps: CheckinDeps = defaultDeps
export function setCheckinDeps(partial: Partial<CheckinDeps> = {}): void { deps = { ...defaultDeps, ...partial } }

export const CHECKIN_ITEMS = ['fleet', 'handbacks', 'limits', 'releases', 'mcp-configs', 'handoff'] as const
export type CheckinItemId = typeof CHECKIN_ITEMS[number]
export type CheckinRoundState = 'ok' | 'resolved' | 'needs_you'
export interface CheckinLink { kind: 'session' | 'subtask' | 'task'; id: string; taskId?: string }
export interface CheckinAction { text: string; link?: CheckinLink }
export interface CheckinNeed { subject: string; text: string; critical?: boolean; link?: CheckinLink }
export interface CheckinDelivered { text: string; ref?: string }
export interface CheckinInProgress { item: string; stage: string; release?: string; session?: string }
export interface CheckinNext { text: string; when?: string }
export type CheckinHealthState = 'ok' | 'warn' | 'bad'
export interface CheckinHealth { label: string; value: string; state: CheckinHealthState }
export interface CheckinRound {
  state: CheckinRoundState
  summary: string
  headline?: string
  delivered?: CheckinDelivered[]
  inProgress?: CheckinInProgress[]
  next?: CheckinNext[]
  health?: CheckinHealth[]
  actions?: CheckinAction[]
  needs?: CheckinNeed[]
}
export interface CheckinReportRefusal { error: string }
export interface CheckinConfig {
  intervalMin: 15 | 30 | 60 | 120
  paused: null | { until: number | null }
  checklist: { id: CheckinItemId; enabled: boolean }[]
}
const CHECKIN_INTERVALS = [15, 30, 60, 120] as const
export interface CheckinState extends CheckinConfig {
  session: string
  lastRunAt: number | null
  nextRunAt: number | null
  last: CheckinRound | null
  skipped?: { count: number; lastAt: number }
}
type Stored = CheckinState & { inherits?: boolean; pending?: boolean; fingerprint?: string; lastFiredAt?: number | null }

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
/** Global defaults support enabled or indefinitely paused check-ins, never a timed snooze. */
export function validateCheckinDefaults(value: unknown): value is CheckinConfig {
  return isRecord(value)
    && CHECKIN_INTERVALS.includes(value.intervalMin as CheckinConfig['intervalMin'])
    && (value.paused === null || (isRecord(value.paused) && value.paused.until === null))
    && Array.isArray(value.checklist)
    && value.checklist.every(item => isRecord(item) && CHECKIN_ITEMS.includes(item.id as CheckinItemId) && typeof item.enabled === 'boolean')
}
const optionalString = (value: Record<string, unknown>, key: string): boolean => value[key] === undefined || typeof value[key] === 'string'
const validLink = (value: unknown): boolean => isRecord(value) && (value.kind === 'session' || value.kind === 'subtask' || value.kind === 'task') && typeof value.id === 'string' && optionalString(value, 'taskId')

/** Runtime boundary check for the structured arrays accepted by the check-in report route. */
export function validateCheckinRound(round: Record<string, unknown>): boolean {
  const valid = (key: string, check: (entry: unknown) => boolean) => round[key] === undefined || (Array.isArray(round[key]) && round[key].every(check))
  return valid('delivered', entry => isRecord(entry) && typeof entry.text === 'string' && optionalString(entry, 'ref'))
    && valid('inProgress', entry => isRecord(entry) && typeof entry.item === 'string' && typeof entry.stage === 'string' && optionalString(entry, 'release') && optionalString(entry, 'session'))
    && valid('next', entry => isRecord(entry) && typeof entry.text === 'string' && optionalString(entry, 'when'))
    && valid('health', entry => isRecord(entry) && typeof entry.label === 'string' && typeof entry.value === 'string' && (entry.state === 'ok' || entry.state === 'warn' || entry.state === 'bad'))
    && valid('actions', entry => isRecord(entry) && typeof entry.text === 'string' && (entry.link === undefined || validLink(entry.link)))
    && valid('needs', entry => isRecord(entry) && typeof entry.subject === 'string' && typeof entry.text === 'string' && (entry.critical === undefined || typeof entry.critical === 'boolean') && (entry.link === undefined || validLink(entry.link)))
}

const labels: Record<CheckinItemId, string> = {
  fleet: 'Sessões e memória', handbacks: 'Entregas dos workers', limits: 'Limites de uso',
  releases: 'Releases e motor', 'mcp-configs': 'Configs MCP dos harnesses', handoff: 'Passagem (HANDOFF)',
}
/** Sessions without an owner override follow these defaults on every read and scheduler tick. */
export function leaderDefaults(prefs: Preferences): CheckinConfig {
  const base = defaultConfig()
  const saved = prefs.checkinDefaults
  if (!isRecord(saved)) return base
  const checklist = Array.isArray(saved.checklist) ? saved.checklist.filter(
    (item): item is { id: CheckinItemId; enabled: boolean } => isRecord(item) && CHECKIN_ITEMS.includes(item.id as CheckinItemId) && typeof item.enabled === 'boolean',
  ) : undefined
  return mergeConfig(base, {
    intervalMin: saved.intervalMin as CheckinConfig['intervalMin'],
    paused: isRecord(saved.paused) && saved.paused.until === null ? { until: null } : null,
    checklist,
  })
}
export const defaultConfig = (): CheckinConfig => ({ intervalMin: 30, paused: null, checklist: CHECKIN_ITEMS.map(id => ({ id, enabled: true })) })
const pausedNow = (c: CheckinConfig, now: number): boolean => c.paused !== null && (c.paused.until === null || c.paused.until > now)
export const nextRun = (now: number, c: CheckinConfig): number | null => pausedNow(c, now) ? null : now + c.intervalMin * 60_000
export function mergeConfig(base: CheckinConfig, patch: Partial<CheckinConfig>): CheckinConfig {
  const intervalMin = CHECKIN_INTERVALS.includes(patch.intervalMin as CheckinConfig['intervalMin']) ? patch.intervalMin! : base.intervalMin
  const checklist = patch.checklist ? CHECKIN_ITEMS.map(id => ({ id, enabled: patch.checklist!.find(x => x.id === id)?.enabled ?? base.checklist.find(x => x.id === id)?.enabled ?? true })) : base.checklist
  return { intervalMin: intervalMin as CheckinConfig['intervalMin'], paused: patch.paused === undefined ? base.paused : patch.paused, checklist }
}
export function promptFor(c: CheckinConfig): string {
  const items = c.checklist.filter(x => x.enabled).map(x => `- ${labels[x.id]}`).join('\n')
  return `[from agentistics · check-in]\nFaça o check-in da liderança agora.\n${items}\n\nQuando terminar, chame agentistics_checkin_report.`
}
async function promptForLeader(c: CheckinConfig): Promise<string> {
  const prompt = promptFor(c)
  const away = awayActive(parseAwayState((await deps.readPreferences()).away), Date.now())
  return away ? `${prompt}\nAWAY MODE — decide within the authorisations, record the decision, and never ask the owner; anything urgent goes as an away notice.` : prompt
}
export function due(s: CheckinState, now: number): boolean { return s.nextRunAt !== null && s.nextRunAt <= now && !pausedNow(s, now) }

function emit(state: CheckinState): void {
  const payload = sseEncoder.encode(`event: checkin\ndata: ${JSON.stringify(state)}\n\n`)
  for (const c of [...deps.sseClients]) { try { c.enqueue(payload) } catch { deps.sseClients.delete(c) } }
}
async function allStored(): Promise<Record<string, Stored>> { return ((await deps.readPreferences()).checkin ?? {}) as Record<string, Stored> }
async function updateStored<T>(mutate: (all: Record<string, Stored>, prefs: Preferences) => T): Promise<T> {
  let result!: T
  await deps.updatePreferences(current => {
    const all = { ...((current.checkin ?? {}) as Record<string, Stored>) }
    result = mutate(all, current)
    return { checkin: all }
  })
  return result
}
function publicState(stored: Stored): CheckinState {
  const { inherits: _inherits, pending: _pending, fingerprint: _fingerprint, lastFiredAt: _lastFiredAt, ...state } = stored
  return state
}

const HEARTBEAT_MS = 2 * 60 * 60_000
const liveWorkers = (rows: Awaited<ReturnType<CheckinDeps['readFleet']>>['rows'], roles: Awaited<ReturnType<CheckinDeps['readRolesDoc']>>['roles']): boolean =>
  rows.some(row => deps.roleOfRow(roles, row) === 'worker' && !isClosedRow(row.id, row.state))
function scheduledNext(now: number, state: Stored, workersAlive: boolean, next = nextRun(now, state)): number | null {
  return next !== null && workersAlive && state.lastFiredAt != null ? Math.min(next, state.lastFiredAt + HEARTBEAT_MS) : next
}
async function workersAlive(): Promise<boolean> {
  return liveWorkers((await deps.readFleet('pt')).rows, (await deps.readRolesDoc(deps.dataDir)).roles)
}

function stable(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).sort().join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`
}

async function fingerprint(row: { id: string; cwd: string }, state: CheckinState, rows: readonly any[], now: number): Promise<string> {
  const enabled = new Set(state.checklist.filter(x => x.enabled).map(x => x.id))
  const inputs: Record<string, unknown> = {}
  if (enabled.has('fleet')) inputs.fleet = rows.filter(r => !isClosedRow(r.id, r.state)).map(r => ({ id: r.id, status: r.status ?? r.state ?? r.activity ?? null })).sort((a, b) => a.id.localeCompare(b.id))
  if (enabled.has('handbacks') || enabled.has('handoff')) inputs.activity = await deps.readCheckinActivity(0, row.id)
  if (enabled.has('limits')) inputs.limits = await deps.readCheckinLimits(now)
  if (enabled.has('releases')) inputs.release = await deps.readCheckinRelease()
  if (enabled.has('mcp-configs')) inputs.mcp = await deps.readCheckinMcpConfigs(row.cwd)
  return createHash('sha256').update(stable(inputs)).digest('hex')
}
/** Legacy agendas equal to the built-in config were automatic; preserve all other choices. */
export function inheritsDefaults(old: (CheckinConfig & { inherits?: boolean }) | undefined): boolean {
  return old?.inherits ?? (!old || stable(mergeConfig(defaultConfig(), old)) === stable(defaultConfig()))
}
export async function checkinDefaultFollowers(): Promise<{ following: number; adjusted: number }> {
  const prefs = await deps.readPreferences()
  const roles = (await deps.readRolesDoc(deps.dataDir)).roles
  const rows = (await deps.readFleet('en')).rows.filter(r => !isClosedRow(r.id, r.state) && deps.roleOfRow(roles, r) === 'leader')
  const stored = (prefs.checkin ?? {}) as Record<string, Stored>
  const following = rows.filter(r => inheritsDefaults(stored[r.conversationId ?? r.id])).length
  return { following, adjusted: rows.length - following }
}
function agendaState(session: string, old: Stored | undefined, prefs: Preferences, now: number): CheckinState {
  const config = inheritsDefaults(old) ? leaderDefaults(prefs) : mergeConfig(defaultConfig(), old!)
  const changed = old && stable(config) !== stable(mergeConfig(defaultConfig(), old))
  const expired = config.paused !== null && config.paused.until !== null && config.paused.until <= now
  const resumed = expired ? { ...config, paused: null } : config
  // A timed pause that ran out resumes AT its deadline: the round it held back is due now, not one
  // whole interval after somebody happened to look at the panel.
  const nextRunAt = expired ? config.paused!.until : changed ? nextRun(now, resumed) : (old?.nextRunAt ?? nextRun(now, resumed))
  return { ...resumed, session, lastRunAt: old?.lastRunAt ?? null, nextRunAt, last: old?.last ?? null, ...(old?.skipped ? { skipped: old.skipped } : {}) }
}
export async function stateFor(session: string, now = Date.now()): Promise<CheckinState> {
  const prefs = await deps.readPreferences()
  const old = (prefs.checkin as Record<string, Stored> | undefined)?.[session]
  const state = agendaState(session, old, prefs, now)
  if (old?.inherits !== undefined && stable(state) === stable(publicState(old))) return state
  // Re-read within the preference write chain: a concurrent per-session override wins over seeding.
  const result = await updateStored((all, current) => {
    const state = agendaState(session, all[session], current, now)
    all[session] = { ...all[session], ...state, inherits: inheritsDefaults(all[session]) }
    return state
  })
  if (old && stable(result) !== stable(publicState(old))) emit(result)
  return result
}
export async function putState(session: string, patch: Partial<CheckinConfig>, now = Date.now()): Promise<CheckinState> {
  const alive = await workersAlive()
  const state = await updateStored((all, prefs) => {
    const old = all[session] ?? { ...leaderDefaults(prefs), inherits: true, session, lastRunAt: null, nextRunAt: null, last: null }
    const current = agendaState(session, old, prefs, now)
    const config = mergeConfig(current, patch)
    const customized = ['intervalMin', 'paused', 'checklist'].some(key => Object.prototype.hasOwnProperty.call(patch, key))
    const state: Stored = {
      ...old, ...config, inherits: customized ? false : inheritsDefaults(old), session,
      lastRunAt: old.lastRunAt, nextRunAt: config.paused ? null : (current.nextRunAt ?? nextRun(now, config)),
      last: old.last, ...(old.skipped ? { skipped: old.skipped } : {}),
    }
    if (stable(config.checklist) !== stable(old.checklist)) delete state.fingerprint
    if (patch.intervalMin !== undefined || patch.paused !== undefined) state.nextRunAt = nextRun(now, config)
    state.nextRunAt = scheduledNext(now, state, alive, state.nextRunAt)
    all[session] = state
    return state
  })
  const publicResult = publicState(state)
  emit(publicResult); return publicResult
}
export async function recordReport(session: string, round: CheckinRound, now = Date.now()): Promise<CheckinState> {
  const alive = await workersAlive()
  const state = await updateStored((all, prefs) => {
    const old = all[session] ?? { ...leaderDefaults(prefs), inherits: true, session, lastRunAt: null, nextRunAt: null, last: null }
    const { pending: _pending, ...previous } = { ...old, ...agendaState(session, old, prefs, now), inherits: inheritsDefaults(old) }
    const resumed = previous.paused && previous.paused.until !== null && previous.paused.until <= now ? { ...previous, paused: null } : previous
    const state: CheckinState = { ...resumed, session, last: round, lastRunAt: now, nextRunAt: nextRun(now, resumed) }
    state.nextRunAt = scheduledNext(now, state, alive)
    all[session] = state
    return state
  })
  const publicResult = publicState(state)
  emit(publicResult)
  const reg = (await deps.readRegistry()).find(x => x.id === session || x.conversationId === session)
  if (reg?.taskId) {
    const w = await deps.loadTaskWorld()
    const event: TaskEvent = {
      id: deps.newEventId(), taskId: reg.taskId, actor: reg.label || reg.id, kind: 'checkin', at: new Date(now).toISOString(),
      detail: JSON.stringify({ sessionId: session, state: round.state, summary: round.summary,
        ...(round.headline ? { headline: round.headline } : {}), ...(round.delivered ? { delivered: round.delivered } : {}),
        ...(round.inProgress ? { inProgress: round.inProgress } : {}), ...(round.next ? { next: round.next } : {}),
        ...(round.health ? { health: round.health } : {}), ...(round.actions ? { actions: round.actions } : {}),
        ...(round.needs ? { needs: round.needs } : {}) }),
    }
    await w.store.logEvents([event])
  }
  return publicResult
}
export async function report(session: string, round: CheckinRound): Promise<CheckinState> { return recordReport(session, round) }
/** MCP-facing guard: only a session identity verified by the HTTP boundary may report. */
export async function reportFromIdentity(session: string | null, round: CheckinRound): Promise<CheckinState | CheckinReportRefusal | null> {
  if (!session) return null
  const rows = (await deps.readFleet('pt')).rows
  const row = rows.find(r => r.id === session)
  if (!row) return null
  const roles = (await deps.readRolesDoc(deps.dataDir)).roles
  if (deps.roleOfRow(roles, row) !== 'leader') return null
  if (round.needs?.length && awayActive(parseAwayState((await deps.readPreferences()).away), Date.now())) {
    return { error: 'Away mode is on: decide within the authorisations, record the decision, and use an away notice for anything urgent instead of asking the owner.' }
  }
  return report(row.conversationId ?? row.id, round)
}

let timer: ReturnType<typeof setInterval> | undefined
const SWEEP_MS = 5 * 60_000
let lastSweep = 0
const firing = new Map<string, Promise<void>>()
function guard(session: string): () => void {
  let release!: () => void
  firing.set(session, new Promise<void>(resolve => { release = resolve }))
  return () => { firing.delete(session); release() }
}
/** One 15 s tick. Empty storage is discovered by the sweep (first pass immediately, then every SWEEP_MS), never every tick. */
export async function checkinTick(now = Date.now()): Promise<void> {
  // A periodic sweep also seeds leaders that appeared after the first agenda was stored.
  const sweep = now - lastSweep >= SWEEP_MS
  if (sweep) lastSweep = now
  if (!(await anyDue(now)) && !sweep) return
  await fireDue(now)
}
export function resetCheckinSweep(): void { lastSweep = 0 }
export function startCheckinTimer(): void {
  if (timer) return
  timer = setInterval(() => { void checkinTick() }, 15_000); timer.unref?.(); void checkinTick()
}
/** Cheap gate for the 15 s tick: one preferences read, no fleet or roles read unless a round may be due. */
export async function anyDue(now: number): Promise<boolean> {
  const prefs = await deps.readPreferences()
  const stored = (prefs.checkin ?? {}) as Record<string, Stored>
  const entries = Object.entries(stored)
  // Nothing stored yet: nothing can be due. Seeding is the tick's sweep (first pass, then every SWEEP_MS).
  if (entries.length === 0) return false
  // Inherited agendas whose defaults changed must be persisted, or every tick would push their
  // deadline forward again. Done here, without a fleet read, and only when something drifted.
  const drifted = entries.filter(([session, old]) => old.inherits !== false && stable(agendaState(session, old, prefs, now)) !== stable(publicState(old)))
  let current = prefs
  if (drifted.length) {
    await updateStored((all, latest) => {
      for (const [session] of drifted) {
        if (!all[session] || all[session].inherits === false) continue
        all[session] = { ...all[session], ...agendaState(session, all[session], latest, now), inherits: inheritsDefaults(all[session]) }
      }
    })
    current = await deps.readPreferences()
  }
  const latest = (current.checkin ?? {}) as Record<string, Stored>
  return Object.entries(latest).some(([session, old]) => due(agendaState(session, old, current, now), now))
}
export async function fireDue(now = Date.now()): Promise<string[]> {
  const rows = (await deps.readFleet('pt')).rows; const roles = (await deps.readRolesDoc(deps.dataDir)).roles; const fired: string[] = []
  for (const row of rows) {
    if (isClosedRow(row.id, row.state) || deps.roleOfRow(roles, row) !== 'leader' || firing.has(row.id)) continue
    const releaseGuard = guard(row.id)
    try {
      const state = await stateFor(row.conversationId ?? row.id, now); if (!due(state, now)) continue
      const existing = (await allStored())[state.session]
      if (existing?.pending) await recordReport(state.session, { state: 'needs_you', summary: 'check-in sem resposta' }, now)
      const currentFingerprint = await fingerprint(row, state, rows, now)
      const liveWorker = liveWorkers(rows, roles)
      const heartbeat = liveWorker && (existing?.lastFiredAt == null || now - existing.lastFiredAt >= HEARTBEAT_MS)
      if (existing?.fingerprint === currentFingerprint && !heartbeat) {
        await updateStored(all => {
          const latest = all[state.session] ?? state
          all[state.session] = { ...latest, skipped: { count: (latest.skipped?.count ?? 0) + 1, lastAt: now }, nextRunAt: scheduledNext(now, latest, liveWorker) }
        })
        emit(publicState((await allStored())[state.session]!))
        continue
      }
      const next = await promptForLeader(state).then(text => deps.runFleetAction('pt', { action: 'prompt', id: row.id, text })).catch(() => ({ ok: false }))
      await updateStored(all => {
        const latest = all[state.session] ?? state
        const updated = { ...latest, ...(next.ok ? { fingerprint: currentFingerprint, lastFiredAt: now, pending: true } : {}) }
        all[state.session] = { ...updated, nextRunAt: scheduledNext(now, updated, liveWorker) }
      })
      if (next.ok) fired.push(row.id)
      if (next.ok) emit(publicState((await allStored())[state.session]!))
    } finally {
      releaseGuard()
    }
  }
  return fired
}
export async function runNow(session: string, now = Date.now()): Promise<boolean> {
  const rows = (await deps.readFleet('pt')).rows; const row = rows.find(r => (r.conversationId ?? r.id) === session || r.id === session)
  if (!row) return false
  const roles = (await deps.readRolesDoc(deps.dataDir)).roles
  if (deps.roleOfRow(roles, row) !== 'leader') return false
  // Manual requests still always run, but wait for an in-flight round before reading state.
  while (firing.has(row.id)) await firing.get(row.id)
  const releaseGuard = guard(row.id)
  try {
    const state = await stateFor(row.conversationId ?? row.id, now)
    const currentFingerprint = await fingerprint(row, state, rows, now)
    const result = await deps.runFleetAction('pt', { action: 'prompt', id: row.id, text: await promptForLeader(state) })
    if (!result.ok) return false
    await updateStored(all => { all[state.session] = { ...all[state.session], ...state, fingerprint: currentFingerprint, lastFiredAt: now, nextRunAt: nextRun(now, state), pending: true } })
    emit(publicState((await allStored())[state.session]!))
    return result.ok
  } finally {
    releaseGuard()
  }
}

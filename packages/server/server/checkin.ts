import { readPreferences as realReadPreferences, updatePreferences as realUpdatePreferences } from './preferences'
import { AGENTISTICS_DATA_DIR as realDataDir } from './config'
import { readRegistry as realReadRegistry } from './sessions/registry'
import { readRolesDoc as realReadRolesDoc, roleOfRow as realRoleOfRow } from './sessions/session-roles'
import { readFleet as realReadFleet, runFleetAction as realRunFleetAction } from './sessions/fleet-web'
import { loadTaskWorld as realLoadTaskWorld } from './sessions/task-source'
import { newEventId as realNewEventId, type TaskEvent } from './sessions/task-model'
import { sseEncoder, sseClients as realSseClients } from './sse'
import { awayActive, parseAwayState } from '@agentistics/core'
import { createHash } from 'node:crypto'

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
  readCheckinLimits: () => Promise<unknown>
  readCheckinRelease: () => Promise<unknown>
  readCheckinMcpConfigs: () => Promise<unknown>
}

const defaultCheckinActivity = async (since: number, leader: string): Promise<unknown> => {
  try {
    const world = await realLoadTaskWorld()
    return world.book.events
      .filter(e => Date.parse(e.at) > since && ['handback', 'block', 'question'].includes(e.kind))
      .filter(e => !leader || JSON.stringify(e).includes(leader))
      .map(e => ({ id: e.id, kind: e.kind, at: e.at, taskId: e.taskId, actor: e.actor }))
  } catch { return [] }
}

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
  readCheckinLimits: async () => null,
  readCheckinRelease: async () => {
    try {
      const { getVersionInfo } = await import('./version')
      const v = await getVersionInfo()
      return { current: v.current, latest: v.latest }
    } catch { return null }
  },
  readCheckinMcpConfigs: async () => {
    try {
      const { listMcp } = await import('./mcp-admin')
      const listed = await listMcp()
      return listed.servers.map(s => ({ name: s.name, scope: s.scope, transport: s.transport, url: s.url ?? null, config: s.config }))
    } catch { return null }
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
export interface CheckinRound { state: CheckinRoundState; summary: string; actions?: CheckinAction[]; needs?: CheckinNeed[] }
export interface CheckinReportRefusal { error: string }
export interface CheckinConfig {
  intervalMin: 15 | 30 | 60 | 120
  paused: null | { until: number | null }
  checklist: { id: CheckinItemId; enabled: boolean }[]
}
export interface CheckinState extends CheckinConfig {
  session: string
  lastRunAt: number | null
  nextRunAt: number | null
  last: CheckinRound | null
  skipped?: { count: number; lastAt: number }
}
type Stored = CheckinState & { pending?: boolean; fingerprint?: string; lastFiredAt?: number | null }

const labels: Record<CheckinItemId, string> = {
  fleet: 'Sessões e memória', handbacks: 'Entregas dos workers', limits: 'Limites de uso',
  releases: 'Releases e motor', 'mcp-configs': 'Configs MCP dos harnesses', handoff: 'Passagem (HANDOFF)',
}
export const defaultConfig = (): CheckinConfig => ({ intervalMin: 30, paused: null, checklist: CHECKIN_ITEMS.map(id => ({ id, enabled: true })) })
const pausedNow = (c: CheckinConfig, now: number): boolean => c.paused !== null && (c.paused.until === null || c.paused.until > now)
export const nextRun = (now: number, c: CheckinConfig): number | null => pausedNow(c, now) ? null : now + c.intervalMin * 60_000
export function mergeConfig(base: CheckinConfig, patch: Partial<CheckinConfig>): CheckinConfig {
  const intervalMin = [15, 30, 60, 120].includes(patch.intervalMin as number) ? patch.intervalMin! : base.intervalMin
  const checklist = patch.checklist ? CHECKIN_ITEMS.map(id => ({ id, enabled: patch.checklist!.find(x => x.id === id)?.enabled ?? base.checklist.find(x => x.id === id)?.enabled ?? true })) : base.checklist
  return { intervalMin: intervalMin as CheckinConfig['intervalMin'], paused: patch.paused === undefined ? base.paused : patch.paused, checklist }
}
export function promptFor(c: CheckinConfig): string {
  const items = c.checklist.filter(x => x.enabled).map(x => `- ${labels[x.id]}`).join('\n')
  return `Faça o check-in da liderança agora.\n${items}\n\nQuando terminar, chame agentistics_checkin_report.`
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
async function updateStored<T>(mutate: (all: Record<string, Stored>) => T): Promise<T> {
  let result!: T
  await deps.updatePreferences(current => {
    const all = { ...((current.checkin ?? {}) as Record<string, Stored>) }
    result = mutate(all)
    return { checkin: all }
  })
  return result
}
function publicState(stored: Stored): CheckinState {
  const { pending: _pending, fingerprint: _fingerprint, lastFiredAt: _lastFiredAt, ...state } = stored
  return state
}

const endedRow = (row: { status?: string; state?: string; activity?: string }): boolean =>
  [row.status, row.state, row.activity].some(x => ['ended', 'closed', 'exited'].includes(String(x).toLowerCase()))

function stable(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).sort().join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`
}

async function fingerprint(row: { id: string }, state: CheckinState, rows: readonly any[]): Promise<string> {
  const enabled = new Set(state.checklist.filter(x => x.enabled).map(x => x.id))
  const inputs: Record<string, unknown> = {}
  if (enabled.has('fleet')) inputs.fleet = rows.filter(r => !endedRow(r)).map(r => ({ id: r.id, status: r.status ?? r.state ?? r.activity ?? null })).sort((a, b) => a.id.localeCompare(b.id))
  if (enabled.has('handbacks') || enabled.has('handoff')) inputs.activity = await deps.readCheckinActivity(state.lastRunAt ?? 0, row.id)
  if (enabled.has('limits')) inputs.limits = await deps.readCheckinLimits()
  if (enabled.has('releases')) inputs.release = await deps.readCheckinRelease()
  if (enabled.has('mcp-configs')) inputs.mcp = await deps.readCheckinMcpConfigs()
  return createHash('sha256').update(stable(inputs)).digest('hex')
}
export async function stateFor(session: string, now = Date.now()): Promise<CheckinState> {
  const all = await allStored(); const old = all[session]
  const config = old ? mergeConfig(defaultConfig(), old) : defaultConfig()
  const expired = config.paused !== null && config.paused.until !== null && config.paused.until <= now
  const resumed = expired ? { ...config, paused: null } : config
  // A timed pause that ran out resumes AT its deadline: the round it held back is due now, not one
  // whole interval after somebody happened to look at the panel.
  const nextRunAt = expired ? config.paused!.until : (old?.nextRunAt ?? nextRun(now, resumed))
  const state: CheckinState = { ...resumed, session, lastRunAt: old?.lastRunAt ?? null, nextRunAt, last: old?.last ?? null, ...(old?.skipped ? { skipped: old.skipped } : {}) }
  if (!old || state.paused !== config.paused) await updateStored(current => { current[session] = state; return state })
  return state
}
export async function putState(session: string, patch: Partial<CheckinConfig>, now = Date.now()): Promise<CheckinState> {
  const state = await updateStored(all => {
    const old = all[session] ?? { ...defaultConfig(), session, lastRunAt: null, nextRunAt: null, last: null }
    const config = mergeConfig(old, patch)
    const state: CheckinState = { ...config, session, lastRunAt: old.lastRunAt, nextRunAt: config.paused ? null : (old.nextRunAt ?? nextRun(now, config)), last: old.last, ...(old.skipped ? { skipped: old.skipped } : {}) }
    if (patch.intervalMin !== undefined || patch.paused !== undefined) state.nextRunAt = nextRun(now, config)
    all[session] = state
    return state
  })
  emit(state); return state
}
export async function recordReport(session: string, round: CheckinRound, now = Date.now()): Promise<CheckinState> {
  const state = await updateStored(all => {
    const old = all[session] ?? { ...defaultConfig(), session, lastRunAt: null, nextRunAt: null, last: null }
    const { pending: _pending, ...previous } = old
    const resumed = previous.paused && previous.paused.until !== null && previous.paused.until <= now ? { ...previous, paused: null } : previous
    const state: CheckinState = { ...resumed, session, last: round, lastRunAt: now, nextRunAt: nextRun(now, resumed) }
    all[session] = state
    return state
  })
  emit(publicState(state))
  const reg = (await deps.readRegistry()).find(x => x.id === session || x.conversationId === session)
  if (reg?.taskId) { const w = await deps.loadTaskWorld(); const event: TaskEvent = { id: deps.newEventId(), taskId: reg.taskId, actor: reg.label || reg.id, kind: 'checkin', at: new Date(now).toISOString(), detail: JSON.stringify({ sessionId: session, state: round.state, summary: round.summary, ...(round.actions ? { actions: round.actions } : {}), ...(round.needs ? { needs: round.needs } : {}) }) }; await w.store.logEvents([event]) }
  return state
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
let firing = new Set<string>()
export function startCheckinTimer(): void {
  if (timer) return
  const tick = async () => {
    const now = Date.now()
    const stored = await allStored()
    // Due, or held by a timed pause that has run out (nothing else would ever resume it).
    if (!Object.values(stored).some(s => (s.nextRunAt !== null && s.nextRunAt <= now) || (s.paused?.until != null && s.paused.until <= now))) return
    await fireDue(now)
  }
  timer = setInterval(() => { void tick() }, 15_000); timer.unref?.(); void tick()
}
export async function fireDue(now = Date.now()): Promise<string[]> {
  const rows = (await deps.readFleet('pt')).rows; const roles = (await deps.readRolesDoc(deps.dataDir)).roles; const fired: string[] = []
  for (const row of rows) {
    if (deps.roleOfRow(roles, row) !== 'leader' || firing.has(row.id)) continue
    const state = await stateFor(row.conversationId ?? row.id, now); if (!due(state, now)) continue
    const existing = (await allStored())[state.session]
    if (existing?.pending) await recordReport(state.session, { state: 'needs_you', summary: 'check-in sem resposta' }, now)
    const currentFingerprint = await fingerprint(row, state, rows)
    const liveWorker = rows.some(r => deps.roleOfRow(roles, r) !== 'leader' && !endedRow(r))
    const heartbeat = liveWorker && (existing?.lastFiredAt == null || now - existing.lastFiredAt >= 2 * 60 * 60_000)
    if (existing?.fingerprint === currentFingerprint && !heartbeat) {
      await updateStored(all => {
        const latest = all[state.session] ?? state
        all[state.session] = { ...latest, skipped: { count: (latest.skipped?.count ?? 0) + 1, lastAt: now }, nextRunAt: nextRun(now, latest) }
      })
      emit(publicState((await allStored())[state.session]!))
      continue
    }
    firing.add(row.id); fired.push(row.id)
    const next = await deps.runFleetAction('pt', { action: 'prompt', id: row.id, text: await promptForLeader(state) }).catch(() => ({ ok: false }))
    await updateStored(all => {
      const latest = all[state.session] ?? state
      all[state.session] = { ...latest, fingerprint: currentFingerprint, lastFiredAt: now, nextRunAt: nextRun(now, latest), ...(next.ok ? { pending: true } : {}) }
    })
    if (next.ok) emit(publicState((await allStored())[state.session]!))
    firing.delete(row.id)
  }
  return fired
}
export async function runNow(session: string, now = Date.now()): Promise<boolean> {
  const rows = (await deps.readFleet('pt')).rows; const row = rows.find(r => (r.conversationId ?? r.id) === session || r.id === session)
  if (!row) return false
  const roles = (await deps.readRolesDoc(deps.dataDir)).roles
  if (deps.roleOfRow(roles, row) !== 'leader') return false
  const state = await stateFor(row.conversationId ?? row.id, now)
  const result = await deps.runFleetAction('pt', { action: 'prompt', id: row.id, text: await promptForLeader(state) })
  if (!result.ok) return false
  const currentFingerprint = await fingerprint(row, state, rows)
  await updateStored(all => { all[state.session] = { ...state, fingerprint: currentFingerprint, lastFiredAt: now, nextRunAt: nextRun(now, state), pending: true } })
  emit(publicState((await allStored())[state.session]!))
  return result.ok
}

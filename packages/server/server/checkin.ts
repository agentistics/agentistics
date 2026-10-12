import { readPreferences as realReadPreferences, updatePreferences as realUpdatePreferences } from './preferences'
import { AGENTISTICS_DATA_DIR as realDataDir, HOME_DIR } from './config'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readRegistry as realReadRegistry } from './sessions/registry'
import { readRolesDoc as realReadRolesDoc, roleOfRow as realRoleOfRow } from './sessions/session-roles'
import { readFleet as realReadFleet, runFleetAction as realRunFleetAction } from './sessions/fleet-web'
import { loadTaskWorld as realLoadTaskWorld } from './sessions/task-source'
import { newEventId as realNewEventId, type TaskEvent } from './sessions/task-model'
import { sseEncoder, sseClients as realSseClients } from './sse'
import { awayActive, parseAwayState, type HarnessId } from '@agentistics/core'
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
  readCheckinLimits: () => Promise<unknown>
  readCheckinRelease: () => Promise<unknown>
  readCheckinMcpConfigs: (cwd: string) => Promise<unknown>
}

// Session-message mirrors are comment events, with the resolved recipient recorded in detail.
export function checkinActivity(events: readonly TaskEvent[], leader: string): unknown {
  return events.flatMap(e => {
    if (e.kind !== 'comment' || !e.detail) return []
    try {
      const { message } = JSON.parse(e.detail)
      return message?.to === leader && ['handback', 'block', 'question'].includes(message.kind)
        ? [{ id: e.id, kind: message.kind, at: e.at, taskId: e.taskId, actor: e.actor }] : []
    } catch { return [] }
  })
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
  readCheckinLimits: async () => {
    const { planLimitsPayload } = await import('./plan-limits')
    const { limits, registered } = await planLimitsPayload((await deps.readPreferences()).billing)
    return { registered, limits: limits.map(({ harness, account, plan, sourcePlan, windows }) => ({ harness, account, plan, sourcePlan, windows })) }
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

async function fingerprint(row: { id: string; cwd: string }, state: CheckinState, rows: readonly any[]): Promise<string> {
  const enabled = new Set(state.checklist.filter(x => x.enabled).map(x => x.id))
  const inputs: Record<string, unknown> = {}
  if (enabled.has('fleet')) inputs.fleet = rows.filter(r => !isClosedRow(r.id, r.state)).map(r => ({ id: r.id, status: r.status ?? r.state ?? r.activity ?? null })).sort((a, b) => a.id.localeCompare(b.id))
  if (enabled.has('handbacks') || enabled.has('handoff')) inputs.activity = await deps.readCheckinActivity(0, row.id)
  if (enabled.has('limits')) inputs.limits = await deps.readCheckinLimits()
  if (enabled.has('releases')) inputs.release = await deps.readCheckinRelease()
  if (enabled.has('mcp-configs')) inputs.mcp = await deps.readCheckinMcpConfigs(row.cwd)
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
  if (!old || state.paused !== config.paused) await updateStored(current => { current[session] = { ...current[session], ...state }; return state })
  return state
}
export async function putState(session: string, patch: Partial<CheckinConfig>, now = Date.now()): Promise<CheckinState> {
  const alive = await workersAlive()
  const state = await updateStored(all => {
    const old = all[session] ?? { ...defaultConfig(), session, lastRunAt: null, nextRunAt: null, last: null }
    const config = mergeConfig(old, patch)
    const state: Stored = { ...old, ...config, session, lastRunAt: old.lastRunAt, nextRunAt: config.paused ? null : (old.nextRunAt ?? nextRun(now, config)), last: old.last, ...(old.skipped ? { skipped: old.skipped } : {}) }
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
  const state = await updateStored(all => {
    const old = all[session] ?? { ...defaultConfig(), session, lastRunAt: null, nextRunAt: null, last: null }
    const { pending: _pending, ...previous } = old
    const resumed = previous.paused && previous.paused.until !== null && previous.paused.until <= now ? { ...previous, paused: null } : previous
    const state: CheckinState = { ...resumed, session, last: round, lastRunAt: now, nextRunAt: nextRun(now, resumed) }
    state.nextRunAt = scheduledNext(now, state, alive)
    all[session] = state
    return state
  })
  const publicResult = publicState(state)
  emit(publicResult)
  const reg = (await deps.readRegistry()).find(x => x.id === session || x.conversationId === session)
  if (reg?.taskId) { const w = await deps.loadTaskWorld(); const event: TaskEvent = { id: deps.newEventId(), taskId: reg.taskId, actor: reg.label || reg.id, kind: 'checkin', at: new Date(now).toISOString(), detail: JSON.stringify({ sessionId: session, state: round.state, summary: round.summary, ...(round.actions ? { actions: round.actions } : {}), ...(round.needs ? { needs: round.needs } : {}) }) }; await w.store.logEvents([event]) }
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
    firing.add(row.id)
    const next = await promptForLeader(state).then(text => deps.runFleetAction('pt', { action: 'prompt', id: row.id, text })).catch(() => ({ ok: false }))
    await updateStored(all => {
      const latest = all[state.session] ?? state
      const updated = { ...latest, ...(next.ok ? { fingerprint: currentFingerprint, lastFiredAt: now, pending: true } : {}) }
      all[state.session] = { ...updated, nextRunAt: scheduledNext(now, updated, liveWorker) }
    })
    if (next.ok) fired.push(row.id)
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
  await updateStored(all => { all[state.session] = { ...all[state.session], ...state, fingerprint: currentFingerprint, lastFiredAt: now, nextRunAt: nextRun(now, state), pending: true } })
  emit(publicState((await allStored())[state.session]!))
  return result.ok
}

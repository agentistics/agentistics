import { readPreferences as realReadPreferences, updatePreferences as realUpdatePreferences } from './preferences'
import { AGENTISTICS_DATA_DIR as realDataDir } from './config'
import { readRegistry as realReadRegistry } from './sessions/registry'
import { readRolesDoc as realReadRolesDoc, roleOfRow as realRoleOfRow } from './sessions/session-roles'
import { readFleet as realReadFleet, runFleetAction as realRunFleetAction } from './sessions/fleet-web'
import { loadTaskWorld as realLoadTaskWorld } from './sessions/task-source'
import { newEventId as realNewEventId, type TaskEvent } from './sessions/task-model'
import { sseEncoder, sseClients as realSseClients } from './sse'

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
}
type Stored = CheckinState & { pending?: boolean }

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
  const { pending: _pending, ...state } = stored
  return state
}
export async function stateFor(session: string, now = Date.now()): Promise<CheckinState> {
  const all = await allStored(); const old = all[session]
  const config = old ? mergeConfig(defaultConfig(), old) : defaultConfig()
  const expired = config.paused !== null && config.paused.until !== null && config.paused.until <= now
  const resumed = expired ? { ...config, paused: null } : config
  // A timed pause that ran out resumes AT its deadline: the round it held back is due now, not one
  // whole interval after somebody happened to look at the panel.
  const nextRunAt = expired ? config.paused!.until : (old?.nextRunAt ?? nextRun(now, resumed))
  const state: CheckinState = { ...resumed, session, lastRunAt: old?.lastRunAt ?? null, nextRunAt, last: old?.last ?? null }
  if (!old || state.paused !== config.paused) await updateStored(current => { current[session] = state; return state })
  return state
}
export async function putState(session: string, patch: Partial<CheckinConfig>, now = Date.now()): Promise<CheckinState> {
  const state = await updateStored(all => {
    const old = all[session] ?? { ...defaultConfig(), session, lastRunAt: null, nextRunAt: null, last: null }
    const config = mergeConfig(old, patch)
    const state: CheckinState = { ...config, session, lastRunAt: old.lastRunAt, nextRunAt: config.paused ? null : (old.nextRunAt ?? nextRun(now, config)), last: old.last }
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
export async function reportFromIdentity(session: string | null, round: CheckinRound): Promise<CheckinState | null> {
  if (!session) return null
  const rows = (await deps.readFleet('pt')).rows
  const row = rows.find(r => r.id === session)
  if (!row) return null
  const roles = (await deps.readRolesDoc(deps.dataDir)).roles
  if (deps.roleOfRow(roles, row) !== 'leader') return null
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
    firing.add(row.id); fired.push(row.id)
    const next = await deps.runFleetAction('pt', { action: 'prompt', id: row.id, text: promptFor(state) }).catch(() => ({ ok: false }))
    await updateStored(all => {
      const latest = all[state.session] ?? state
      all[state.session] = { ...latest, nextRunAt: nextRun(now, latest), ...(next.ok ? { pending: true } : {}) }
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
  const result = await deps.runFleetAction('pt', { action: 'prompt', id: row.id, text: promptFor(state) })
  if (!result.ok) return false
  await updateStored(all => { all[state.session] = { ...state, nextRunAt: nextRun(now, state), pending: true } })
  emit(publicState((await allStored())[state.session]!))
  return result.ok
}

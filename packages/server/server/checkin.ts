import { readPreferences, writePreferences } from './preferences'
import { AGENTISTICS_DATA_DIR } from './config'
import { readRegistry } from './sessions/registry'
import { readRolesDoc, roleOfRow } from './sessions/session-roles'
import { readFleet, runFleetAction } from './sessions/fleet-web'
import { loadTaskWorld } from './sessions/task-source'
import { newEventId, type TaskEvent } from './sessions/task-model'
import { sseEncoder, sseClients } from './sse'

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
  last: { state: CheckinRoundState; summary: string } | null
}
type Stored = CheckinState & { pending?: boolean }

const labels: Record<CheckinItemId, string> = {
  fleet: 'Sessões e memória', handbacks: 'Entregas dos workers', limits: 'Limites de uso',
  releases: 'Releases e motor', 'mcp-configs': 'Configs MCP dos harnesses', handoff: 'Passagem (HANDOFF)',
}
export const defaultConfig = (): CheckinConfig => ({ intervalMin: 30, paused: null, checklist: CHECKIN_ITEMS.map(id => ({ id, enabled: true })) })
export const nextRun = (now: number, c: CheckinConfig): number | null => c.paused ? null : now + c.intervalMin * 60_000
export function mergeConfig(base: CheckinConfig, patch: Partial<CheckinConfig>): CheckinConfig {
  const intervalMin = [15, 30, 60, 120].includes(patch.intervalMin as number) ? patch.intervalMin! : base.intervalMin
  const checklist = patch.checklist ? CHECKIN_ITEMS.map(id => ({ id, enabled: patch.checklist!.find(x => x.id === id)?.enabled ?? base.checklist.find(x => x.id === id)?.enabled ?? true })) : base.checklist
  return { intervalMin: intervalMin as CheckinConfig['intervalMin'], paused: patch.paused === undefined ? base.paused : patch.paused, checklist }
}
export function promptFor(c: CheckinConfig): string {
  const items = c.checklist.filter(x => x.enabled).map(x => `- ${labels[x.id]}`).join('\n')
  return `Faça o check-in da liderança agora.\n${items}\n\nQuando terminar, chame agentistics_checkin_report.`
}
export function due(s: CheckinState, now: number): boolean { return s.nextRunAt !== null && s.nextRunAt <= now && !s.paused }

function emit(state: CheckinState): void {
  const payload = sseEncoder.encode(`event: checkin\ndata: ${JSON.stringify(state)}\n\n`)
  for (const c of [...sseClients]) { try { c.enqueue(payload) } catch { sseClients.delete(c) } }
}
async function allStored(): Promise<Record<string, Stored>> { return ((await readPreferences()).checkin ?? {}) as Record<string, Stored> }
async function save(all: Record<string, Stored>): Promise<void> { await writePreferences({ checkin: all } as any) }
export async function stateFor(session: string, now = Date.now()): Promise<CheckinState> {
  const all = await allStored(); const old = all[session]
  const config = old ? mergeConfig(defaultConfig(), old) : defaultConfig()
  const state: CheckinState = { ...config, session, lastRunAt: old?.lastRunAt ?? null, nextRunAt: old?.nextRunAt ?? nextRun(now, config), last: old?.last ?? null }
  if (!old) { all[session] = state; await save(all) }
  return state
}
export async function putState(session: string, patch: Partial<CheckinConfig>, now = Date.now()): Promise<CheckinState> {
  const all = await allStored(); const old = all[session] ?? { ...defaultConfig(), session, lastRunAt: null, nextRunAt: null, last: null }
  const config = mergeConfig(old, patch); const state: CheckinState = { ...config, session, lastRunAt: old.lastRunAt, nextRunAt: config.paused ? null : (old.nextRunAt ?? nextRun(now, config)), last: old.last }
  if (patch.intervalMin !== undefined || patch.paused !== undefined) state.nextRunAt = config.paused ? null : nextRun(now, config)
  all[session] = state; await save(all); emit(state); return state
}
export async function recordReport(session: string, round: CheckinRound, now = Date.now()): Promise<CheckinState> {
  const all = await allStored(); const old = all[session] ?? { ...defaultConfig(), session, lastRunAt: null, nextRunAt: null, last: null }
  const state: CheckinState = { ...old, session, last: { state: round.state, summary: round.summary }, lastRunAt: now, nextRunAt: old.paused ? null : nextRun(now, old) }
  all[session] = state; await save(all); emit(state)
  const reg = (await readRegistry()).find(x => x.id === session || x.conversationId === session)
  if (reg?.taskId) { const w = await loadTaskWorld(); const event: TaskEvent = { id: newEventId(), taskId: reg.taskId, actor: reg.label || reg.id, kind: 'checkin', at: new Date(now).toISOString(), detail: JSON.stringify({ sessionId: session, state: round.state, summary: round.summary, ...(round.actions ? { actions: round.actions } : {}), ...(round.needs ? { needs: round.needs } : {}) }) }; await w.store.logEvents([event]) }
  return state
}
export async function report(session: string, round: CheckinRound): Promise<CheckinState> { return recordReport(session, round) }

let timer: ReturnType<typeof setInterval> | undefined
let firing = new Set<string>()
export function startCheckinTimer(): void {
  if (timer) return
  timer = setInterval(() => { void fireDue() }, 15_000); timer.unref?.(); void fireDue()
}
export async function fireDue(now = Date.now()): Promise<string[]> {
  const rows = (await readFleet('pt')).rows; const roles = (await readRolesDoc(AGENTISTICS_DATA_DIR)).roles; const fired: string[] = []
  for (const row of rows) {
    if (roleOfRow(roles, row) !== 'leader' || firing.has(row.id)) continue
    const state = await stateFor(row.conversationId ?? row.id, now); if (!due(state, now)) continue
    const existing = (await allStored())[state.session]
    if (existing?.pending) await recordReport(state.session, { state: 'needs_you', summary: 'check-in sem resposta' }, now)
    firing.add(row.id); fired.push(row.id)
    const all = await allStored(); all[state.session] = { ...state, nextRunAt: nextRun(now, state), pending: true }; await save(all); emit(all[state.session]!)
    void runFleetAction('pt', { action: 'prompt', id: row.id, text: promptFor(state) }).then(async () => { firing.delete(row.id) }).catch(() => { firing.delete(row.id) })
  }
  return fired
}
export async function runNow(session: string, now = Date.now()): Promise<boolean> {
  const rows = (await readFleet('pt')).rows; const row = rows.find(r => (r.conversationId ?? r.id) === session || r.id === session)
  if (!row) return false
  const roles = (await readRolesDoc(AGENTISTICS_DATA_DIR)).roles
  if (roleOfRow(roles, row) !== 'leader') return false
  const state = await stateFor(row.conversationId ?? row.id, now)
  const all = await allStored(); all[state.session] = { ...state, nextRunAt: nextRun(now, state) }; await save(all); emit(all[state.session]!)
  await runFleetAction('pt', { action: 'prompt', id: row.id, text: promptFor(state) })
  return true
}

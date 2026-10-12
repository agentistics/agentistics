import { afterAll, describe, expect, test } from 'bun:test'
import {
  defaultConfig, due, fireDue, mergeConfig, nextRun, putState, recordReport, reportFromIdentity, setCheckinDeps, stateFor,
  type CheckinAction, type CheckinDeps, type CheckinNeed,
} from './checkin'

let preferences: Record<string, unknown> = {}
let rows: any[] = []
let roles: Record<string, string> = {}
let prompts: any[] = []
let activity: any[] = []
let frames: string[] = []

const fakeSseClients = new Set<{ enqueue(data: Uint8Array): void }>()
setCheckinDeps({
  readPreferences: (async () => preferences) as CheckinDeps['readPreferences'],
  updatePreferences: (async (mutate: (p: any) => any) => { const patch = mutate(preferences); if (patch) preferences = { ...preferences, ...patch }; return preferences }) as CheckinDeps['updatePreferences'],
  readRegistry: (async () => rows) as CheckinDeps['readRegistry'],
  readRolesDoc: (async () => ({ roles })) as unknown as CheckinDeps['readRolesDoc'],
  roleOfRow: ((r: Record<string, string>, row: { id: string; conversationId?: string }) => r[row.conversationId ?? row.id] ?? r[row.id]) as CheckinDeps['roleOfRow'],
  readFleet: (async () => ({ rows })) as unknown as CheckinDeps['readFleet'],
  runFleetAction: (async (_lang: string, request: unknown) => { prompts.push(request); return { ok: true, message: 'sent' } }) as CheckinDeps['runFleetAction'],
  loadTaskWorld: (async () => ({ store: { logEvents: async (events: unknown[]) => { activity.push(...events) } } })) as CheckinDeps['loadTaskWorld'],
  newEventId: (() => 'event-1') as CheckinDeps['newEventId'],
  dataDir: '/tmp/checkin-test',
  sseClients: fakeSseClients as CheckinDeps['sseClients'],
})

afterAll(() => setCheckinDeps())

const leader = { id: 'managed-leader', conversationId: 'conversation-leader', label: 'Leader', taskId: 'task-1' }
const worker = { id: 'managed-worker', conversationId: 'conversation-worker', label: 'Worker' }

function reset() {
  preferences = {}
  rows = []
  roles = {}
  prompts = []
  activity = []
  frames = []
  fakeSseClients.clear()
  fakeSseClients.add({ enqueue: (data: Uint8Array) => frames.push(new TextDecoder().decode(data)) })
}

describe('check-in agenda', () => {
  test('defaults are complete and scheduled', async () => {
    reset()
    const state = await stateFor('conversation-leader', 1_000)
    expect(state).toEqual({ ...defaultConfig(), session: 'conversation-leader', lastRunAt: null, nextRunAt: 1_801_000, last: null })
  })

  test('PUT merges partial config without resetting unrelated fields', async () => {
    reset()
    await putState('conversation-leader', { intervalMin: 60, checklist: [{ id: 'fleet', enabled: false }] }, 1_000)
    const state = await putState('conversation-leader', { paused: { until: null } }, 2_000)
    expect(state.intervalMin).toBe(60)
    expect(state.checklist.find(x => x.id === 'fleet')?.enabled).toBe(false)
    expect(state.checklist.find(x => x.id === 'limits')?.enabled).toBe(true)
    expect(state.paused).toEqual({ until: null })
    expect(state.nextRunAt).toBeNull()
    expect(mergeConfig(defaultConfig(), { intervalMin: 120 }).intervalMin).toBe(120)
  })

  test('pauses until a deadline, resumes after it, and supports indefinite pause', async () => {
    reset()
    const paused = await putState('conversation-leader', { paused: { until: 10_000 } }, 1_000)
    expect(paused.nextRunAt).toBeNull()
    expect(due(paused, 9_999)).toBe(false)
    const resumed = await stateFor('conversation-leader', 10_001)
    expect(resumed.paused).toBeNull()
    expect(resumed.nextRunAt).toBe(1_810_001)
    const forever = await putState('conversation-leader', { paused: { until: null } }, 20_000)
    expect(nextRun(20_000, forever)).toBeNull()
  })

  test('fires only leaders and only when due', async () => {
    reset(); rows = [leader, worker]; roles = { [leader.conversationId]: 'leader', [worker.conversationId]: 'worker' }
    await putState(leader.conversationId, { intervalMin: 15 }, 1_000)
    await putState(worker.conversationId, { intervalMin: 15 }, 1_000)
    expect(await fireDue(1_000 + 15 * 60_000)).toEqual([leader.id])
    expect(prompts).toHaveLength(1)
    expect(prompts[0].id).toBe(leader.id)
  })

  test('does not stack while a prompt is pending', async () => {
    reset(); rows = [leader]; roles = { [leader.conversationId]: 'leader' }
    await putState(leader.conversationId, { intervalMin: 15 }, 1_000)
    const now = 1_000 + 15 * 60_000
    await fireDue(now)
    await fireDue(now)
    expect(prompts).toHaveLength(1)
  })

  test('an unanswered pending round becomes needs_you and remains visible', async () => {
    reset(); rows = [leader]; roles = { [leader.conversationId]: 'leader' }
    await putState(leader.conversationId, { intervalMin: 15 }, 1_000)
    const first = 1_000 + 15 * 60_000
    await fireDue(first)
    await fireDue(first + 15 * 60_000)
    expect((await stateFor(leader.conversationId, first + 15 * 60_000)).last).toEqual({ state: 'needs_you', summary: 'check-in sem resposta' })
  })

  test('leader report resolves managed identity, stores needs/actions, and emits SSE', async () => {
    reset(); rows = [leader]; roles = { [leader.conversationId]: 'leader' }
    const needs: CheckinNeed[] = [{ subject: 'disk', text: 'Disk is nearly full', critical: true, link: { kind: 'session', id: 's1' } }]
    const actions: CheckinAction[] = [{ text: 'Paused worker', link: { kind: 'subtask', id: 'sub1', taskId: 'task1' } }]
    const state = await reportFromIdentity(leader.id, { state: 'resolved', summary: 'Handled', needs, actions })
    expect(state?.session).toBe(leader.conversationId)
    expect(state?.last).toEqual({ state: 'resolved', summary: 'Handled', needs, actions })
    expect(JSON.parse(frames.at(-1)!.split('data: ')[1]!.trim()).last.needs).toEqual(needs)
    expect(activity.at(-1).detail).toContain('"needs"')
  })

  test('report is refused without verified identity and for workers', async () => {
    reset(); rows = [worker]; roles = { [worker.conversationId]: 'worker' }
    expect(await reportFromIdentity(null, { state: 'ok', summary: 'nope' })).toBeNull()
    expect(await reportFromIdentity(worker.id, { state: 'ok', summary: 'nope' })).toBeNull()
    expect(preferences.checkin).toBeUndefined()
  })

  test('recording a report clears pending so a later round is not falsely missed', async () => {
    reset(); rows = [leader]; roles = { [leader.conversationId]: 'leader' }
    await putState(leader.conversationId, { intervalMin: 15 }, 1_000)
    const first = 1_000 + 15 * 60_000
    await fireDue(first)
    await reportFromIdentity(leader.id, { state: 'ok', summary: 'All good' })
    await fireDue(first + 15 * 60_000)
    expect((await stateFor(leader.conversationId, first + 15 * 60_000)).last?.summary).toBe('All good')
  })

  test('recordReport keeps the activity report fields', async () => {
    reset(); rows = [leader]; roles = { [leader.conversationId]: 'leader' }
    await recordReport(leader.conversationId, { state: 'ok', summary: 'Done', actions: [{ text: 'Closed it' }] }, 42)
    expect(JSON.parse(activity[0].detail).actions).toEqual([{ text: 'Closed it' }])
  })
})

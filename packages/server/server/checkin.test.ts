import { afterAll, describe, expect, spyOn, test } from 'bun:test'
import { planBudget, planPace, type PlanLimits } from '@agentistics/core'
import {
  checkinActivity, checkinLimitInputs, defaultConfig, due, fireDue, mergeConfig, nextRun, promptFor, putState, recordReport, reportFromIdentity, setCheckinDeps, stateFor,
  runNow, type CheckinAction, type CheckinDeps, type CheckinNeed,
} from './checkin'

let preferences: Record<string, unknown> = {}
let rows: any[] = []
let roles: Record<string, string> = {}
let prompts: any[] = []
let activity: any[] = []
let frames: string[] = []
let limits: unknown = null
let release: unknown = null
let mcp: unknown = null
let mcpCwds: string[] = []
let delivery: 'ok' | 'false' | 'throw' = 'ok'


const fakeSseClients = new Set<{ enqueue(data: Uint8Array): void }>()
const testDeps: Partial<CheckinDeps> = {
  readPreferences: (async () => preferences) as CheckinDeps['readPreferences'],
  updatePreferences: (async (mutate: (p: any) => any) => { const patch = mutate(preferences); if (patch) preferences = { ...preferences, ...patch }; return preferences }) as CheckinDeps['updatePreferences'],
  readRegistry: (async () => rows) as CheckinDeps['readRegistry'],
  readRolesDoc: (async () => ({ roles })) as unknown as CheckinDeps['readRolesDoc'],
  roleOfRow: ((r: Record<string, string>, row: { id: string; conversationId?: string }) => r[row.conversationId ?? row.id] ?? r[row.id]) as CheckinDeps['roleOfRow'],
  readFleet: (async () => ({ rows })) as unknown as CheckinDeps['readFleet'],
  runFleetAction: (async (_lang: string, request: unknown) => { prompts.push(request); if (delivery === 'throw') throw new Error('delivery failed'); return { ok: delivery === 'ok', message: 'sent' } }) as CheckinDeps['runFleetAction'],
  loadTaskWorld: (async () => ({ store: { logEvents: async (events: unknown[]) => { activity.push(...events) } } })) as CheckinDeps['loadTaskWorld'],
  readCheckinActivity: async (_since, id) => checkinActivity(activity, id),
  readCheckinLimits: async () => limits,
  readCheckinRelease: async () => release,
  readCheckinMcpConfigs: async cwd => { mcpCwds.push(cwd); return mcp },
  newEventId: (() => 'event-1') as CheckinDeps['newEventId'],
  dataDir: '/tmp/checkin-test',
  sseClients: fakeSseClients as CheckinDeps['sseClients'],
}
setCheckinDeps(testDeps)

afterAll(() => setCheckinDeps())

const leader = { id: 'managed-leader', conversationId: 'conversation-leader', label: 'Leader', cwd: '/test/project', state: 'idle', taskId: 'task-1' }
const worker = { id: 'managed-worker', conversationId: 'conversation-worker', label: 'Worker', cwd: '/test/project', state: 'idle' }

function reset() {
  setCheckinDeps(testDeps)
  limits = null; release = null; mcp = null; mcpCwds = []; delivery = 'ok'
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
    // The held round is due at the deadline itself, not one interval after somebody looked.
    expect(resumed.nextRunAt).toBe(10_000)
    expect(due(resumed, 10_001)).toBe(true)
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

  test('a timed pause that ran out fires the held round on the next tick', async () => {
    reset(); rows = [leader]; roles = { [leader.conversationId]: 'leader' }
    await putState(leader.conversationId, { paused: { until: 5_000 } }, 1_000)
    expect(await fireDue(4_000)).toEqual([])
    expect(await fireDue(6_000)).toEqual([leader.id])
    expect(prompts).toHaveLength(1)
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
    const reported = await reportFromIdentity(leader.id, { state: 'resolved', summary: 'Handled', needs, actions })
    const state = reported && 'session' in reported ? reported : null
    expect(state?.session).toBe(leader.conversationId)
    expect(state?.last).toEqual({ state: 'resolved', summary: 'Handled', needs, actions })
    expect(JSON.parse(frames.at(-1)!.split('data: ')[1]!.trim()).last.needs).toEqual(needs)
    expect(activity.at(-1).detail).toContain('"needs"')
  })

  test('away mode adds a no-owner line to the leader prompt', async () => {
    reset(); rows = [leader]; roles = { [leader.conversationId]: 'leader' }
    preferences = { away: { on: true, until: null, authorised: [], maxWorkers: 6, topCaps: {} } }
    await putState(leader.conversationId, { intervalMin: 15 }, 1_000)
    await fireDue(1_000 + 15 * 60_000)
    expect(prompts[0].text).toContain('decide within the authorisations, record the decision, and never ask the owner')
    expect(promptFor(defaultConfig())).not.toContain('AWAY MODE')
  })

  test('away mode refuses non-empty needs, but allows a needs-free report', async () => {
    reset(); rows = [leader]; roles = { [leader.conversationId]: 'leader' }
    preferences = { away: { on: true, until: null, authorised: [], maxWorkers: 6, topCaps: {} } }
    const needs: CheckinNeed[] = [{ subject: 'disk', text: 'Disk is nearly full' }]
    const refused = await reportFromIdentity(leader.id, { state: 'needs_you', summary: 'Blocked', needs })
    expect(refused).toEqual({ error: 'Away mode is on: decide within the authorisations, record the decision, and use an away notice for anything urgent instead of asking the owner.' })
    expect(preferences.checkin).toBeUndefined()
    const accepted = await reportFromIdentity(leader.id, { state: 'resolved', summary: 'Handled' })
    expect(accepted && 'last' in accepted ? accepted.last?.summary : '').toBe('Handled')
  })

  test('away mode off keeps needs allowed', async () => {
    reset(); rows = [leader]; roles = { [leader.conversationId]: 'leader' }
    preferences = { away: { on: false, until: null, authorised: [], maxWorkers: 6, topCaps: {} } }
    const needs: CheckinNeed[] = [{ subject: 'disk', text: 'Disk is nearly full' }]
    const accepted = await reportFromIdentity(leader.id, { state: 'needs_you', summary: 'Needs attention', needs })
    expect(accepted && 'last' in accepted ? accepted.last?.needs : undefined).toEqual(needs)
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

const MINUTE = 60_000
const first = 15 * MINUTE
const stored = () => (preferences.checkin as Record<string, any>)[leader.conversationId]!
async function begin(withWorker = false) {
  reset(); rows = withWorker ? [leader, worker] : [leader]
  roles = { [leader.conversationId]: 'leader', [worker.conversationId]: 'worker' }
  await putState(leader.conversationId, { intervalMin: 15 }, 0)
  await fireDue(first)
  await recordReport(leader.conversationId, { state: 'ok', summary: 'Done' }, first)
}

describe('idle check-ins', () => {
  test('unchanged idle inputs skip and emit a public skip count', async () => {
    await begin()
    expect(await fireDue(first + 15 * MINUTE)).toEqual([])
    expect(prompts).toHaveLength(1)
    expect(stored().skipped).toEqual({ count: 1, lastAt: first + 15 * MINUTE })
    const emitted = JSON.parse(frames.at(-1)!.split('data: ')[1]!.trim())
    expect(emitted.fingerprint).toBeUndefined()
    expect(emitted.lastFiredAt).toBeUndefined()
  })
  for (const kind of ['status', 'assign', 'block', 'claim', 'release', 'session', 'move']) {
    test(`board ${kind} event triggers one round without live workers`, async () => {
      await begin()
      activity.push({ id: 'board-event', taskId: 'task-1', kind, actor: 'owner',
        at: new Date(first + MINUTE).toISOString(), from: 'in_progress', to: 'blocked', detail: 'waiting' })
      expect(await fireDue(first + 15 * MINUTE)).toEqual([leader.id])
      await recordReport(leader.conversationId, { state: 'ok', summary: 'Read' }, first + 15 * MINUTE)
      expect(await fireDue(first + 30 * MINUTE)).toEqual([])
    })
  }
  test('20% to 21% in the same decision bands skips; crossing hold fires', async () => {
    await begin()
    const records: PlanLimits[] = [{ harness: 'codex', account: 'default', source: 'codex-rollout',
      updatedAt: first, windows: [{ kind: '5h', usedPct: 20, resetsAt: first + 300 * MINUTE }] }]
    setCheckinDeps({ ...testDeps, readCheckinLimits: async now => checkinLimitInputs(records, now) })
    await runNow(leader.conversationId, first)
    await recordReport(leader.conversationId, { state: 'ok', summary: 'Read' }, first)
    records[0]!.windows[0]!.usedPct = 21
    expect(await fireDue(first + 15 * MINUTE)).toEqual([])
    records[0]!.windows[0]!.usedPct = 85
    expect(await fireDue(first + 30 * MINUTE)).toEqual([leader.id])
  })
  test('default limits reader retains time-driven pace bands from payload budgets', async () => {
    await begin()
    const records: PlanLimits[] = [{ harness: 'codex', account: 'default', source: 'codex-rollout',
      updatedAt: first, windows: [{ kind: 'week', usedPct: 20, resetsAt: first + 120 * MINUTE }] }]
    const history: PlanLimits[] = [{ ...records[0]!, updatedAt: first - 24 * MINUTE,
      windows: [{ ...records[0]!.windows[0]!, usedPct: 0 }] }]
    const module = await import('./plan-limits')
    const seen: number[] = []
    const reader = spyOn(module, 'planLimitsPayload').mockImplementation(async (_billing, now = Date.now()) => {
      seen.push(now)
      return { limits: records, registered: [], budgets: records.map(l => ({ ...planBudget(l, now), ...planPace(l, now, history) })),
        freeSlots: 0, freeSlotsByHarness: {}, liveSessions: [], now }
    })
    const { readCheckinLimits: _reader, ...otherDeps } = testDeps
    setCheckinDeps(otherDeps)
    try {
      expect(planPace(records[0]!, first, history).paceStatus).toBe('over')
      expect(planPace(records[0]!, first + 30 * MINUTE, history).paceStatus).toBe('on')
      await runNow(leader.conversationId, first)
      await recordReport(leader.conversationId, { state: 'ok', summary: 'Read' }, first)
      expect(await fireDue(first + 15 * MINUTE)).toEqual([leader.id]) // over -> on
      await recordReport(leader.conversationId, { state: 'ok', summary: 'Read' }, first + 15 * MINUTE)
      expect(await fireDue(first + 30 * MINUTE)).toEqual([])
      expect(seen).toEqual([first, first + 15 * MINUTE, first + 30 * MINUTE])
    } finally { reader.mockRestore(); setCheckinDeps(testDeps) }
  })
  for (const manualFirst of [false, true]) {
    test(`${manualFirst ? 'manual' : 'scheduled'} round guards concurrent manual/scheduled readers`, async () => {
      await begin(); limits = { changed: true }
      let entered!: () => void
      let releaseReader!: () => void
      const reading = new Promise<void>(resolve => { entered = resolve })
      const blocked = new Promise<void>(resolve => { releaseReader = resolve })
      let reads = 0
      setCheckinDeps({ ...testDeps, readCheckinLimits: async () => {
        if (++reads === 1) { entered(); await blocked }
        return limits
      } })
      const firstRound = manualFirst ? runNow(leader.conversationId, first + 15 * MINUTE) : fireDue(first + 15 * MINUTE)
      await reading
      const secondRound = manualFirst ? fireDue(first + 15 * MINUTE) : runNow(leader.conversationId, first + 15 * MINUTE)
      try {
        if (manualFirst) expect(await secondRound).toEqual([])
        // Flush the second caller's fleet/roles awaits, without releasing the reader.
        for (let i = 0; i < 10; i++) await Promise.resolve()
        expect(reads).toBe(1)
        expect(prompts).toHaveLength(1)
      } finally { releaseReader(); await firstRound; await secondRound }
      expect(prompts).toHaveLength(manualFirst ? 2 : 3)
      expect(stored().lastFiredAt).toBe(first + 15 * MINUTE)
      await recordReport(leader.conversationId, { state: 'ok', summary: 'Read' }, first + 15 * MINUTE)
      expect(await fireDue(first + 30 * MINUTE)).toEqual([])
    })
  }
  for (const usedPct of [0, 85]) {
    test(`stored ${usedPct}% usage triggers one delivery when its window renews`, async () => {
      await begin()
      const records = [{ harness: 'codex' as const, account: 'default', source: 'codex-rollout' as const,
        updatedAt: first, windows: [{ kind: '5h' as const, usedPct, resetsAt: first + 30 * MINUTE }] }]
      setCheckinDeps({ ...testDeps, readCheckinLimits: async now => ({ registered: {}, limits: checkinLimitInputs(records, now) }) })
      expect(await fireDue(first + 15 * MINUTE)).toEqual([leader.id])
      await recordReport(leader.conversationId, { state: 'ok', summary: 'Read' }, first + 15 * MINUTE)
      const baseline = stored().fingerprint
      expect(await fireDue(first + 30 * MINUTE)).toEqual([leader.id])
      expect(stored().fingerprint).not.toBe(baseline)
      await recordReport(leader.conversationId, { state: 'ok', summary: 'Renewed' }, first + 30 * MINUTE)
      expect(await fireDue(first + 45 * MINUTE)).toEqual([])
      expect(records[0]!.windows[0]!.usedPct).toBe(usedPct)
    })
  }
  test('overlapping due rounds share a guard while fingerprint readers are pending', async () => {
    await begin(); limits = { changed: true }
    let entered!: () => void
    let releaseReader!: () => void
    const reading = new Promise<void>(resolve => { entered = resolve })
    const blocked = new Promise<void>(resolve => { releaseReader = resolve })
    let reads = 0
    setCheckinDeps({ ...testDeps, readCheckinLimits: async () => {
      if (++reads === 1) { entered(); await blocked }
      return limits
    } })
    const round = fireDue(first + 15 * MINUTE)
    await reading
    try {
      expect(await fireDue(first + 15 * MINUTE)).toEqual([])
      expect(reads).toBe(1)
    } finally {
      releaseReader()
      await round
    }
    expect(prompts).toHaveLength(2)
  })
  test('a fingerprint reader error releases the firing guard for retry', async () => {
    await begin(); limits = { changed: true }
    setCheckinDeps({ ...testDeps, readCheckinLimits: async () => { throw new Error('reader failed') } })
    await expect(fireDue(first + 15 * MINUTE)).rejects.toThrow('reader failed')
    setCheckinDeps(testDeps)
    expect(await fireDue(first + 15 * MINUTE)).toEqual([leader.id])
  })
  test('manual fingerprint errors prevent delivery and preserve delivery history', async () => {
    await begin()
    const baseline = { fingerprint: stored().fingerprint, lastFiredAt: stored().lastFiredAt, nextRunAt: stored().nextRunAt }
    setCheckinDeps({ ...testDeps, readCheckinLimits: async () => { throw new Error('reader failed') } })
    await expect(runNow(leader.conversationId, first + MINUTE)).rejects.toThrow('reader failed')
    expect(prompts).toHaveLength(1)
    expect(stored()).toMatchObject(baseline)
    expect(stored().pending).toBeUndefined()
    setCheckinDeps(testDeps)
    expect(await runNow(leader.conversationId, first + MINUTE)).toBe(true)
    expect(stored()).toMatchObject({ lastFiredAt: first + MINUTE, pending: true })
  })
  test('manual delivery uses the fingerprint captured before sending', async () => {
    await begin()
    const baseline = stored().fingerprint
    setCheckinDeps({ ...testDeps, runFleetAction: (async (_lang, request) => {
      prompts.push(request); limits = { arrivedDuringDelivery: true }
      return { ok: true, message: 'sent' }
    }) as CheckinDeps['runFleetAction'] })
    expect(await runNow(leader.conversationId, first + MINUTE)).toBe(true)
    expect(stored().fingerprint).toBe(baseline)
    setCheckinDeps(testDeps)
    await recordReport(leader.conversationId, { state: 'ok', summary: 'Read' }, first + MINUTE)
    expect(await fireDue(first + 16 * MINUTE)).toEqual([leader.id])
  })
  test('heartbeat fires at two hours and late reports cannot delay it', async () => {
    await begin(true)
    await putState(leader.conversationId, { intervalMin: 120 }, first)
    await recordReport(leader.conversationId, { state: 'ok', summary: 'Late' }, first + 119 * MINUTE)
    expect(stored().nextRunAt).toBe(first + 120 * MINUTE)
    expect(await fireDue(first + 120 * MINUTE - 1)).toEqual([])
    expect(await fireDue(first + 120 * MINUTE)).toEqual([leader.id])
  })
  test('skips are also bounded by the heartbeat deadline', async () => {
    await begin(true)
    await fireDue(first + 119 * MINUTE)
    expect(stored().nextRunAt).toBe(first + 120 * MINUTE)
    expect(await fireDue(first + 120 * MINUTE)).toEqual([leader.id])
  })
  for (const failure of ['false', 'throw'] as const) {
    test(`${failure} delivery preserves the baseline and retries changed inputs`, async () => {
      await begin(); limits = { windows: [{ usedPct: 90, resetsAt: 123 }] }
      const baseline = { fingerprint: stored().fingerprint, lastFiredAt: stored().lastFiredAt }
      delivery = failure
      expect(await fireDue(first + 15 * MINUTE)).toEqual([])
      expect(stored()).toMatchObject(baseline)
      expect(stored().pending).toBeUndefined()
      delivery = 'ok'
      expect(await fireDue(first + 30 * MINUTE)).toEqual([leader.id])
    })
    test(`${failure} first delivery does not establish an idle baseline`, async () => {
      reset(); rows = [leader]; roles = { [leader.conversationId]: 'leader' }
      await putState(leader.conversationId, { intervalMin: 15 }, 0)
      delivery = failure; await fireDue(first)
      expect(stored().fingerprint).toBeUndefined(); expect(stored().lastFiredAt).toBeUndefined()
      delivery = 'ok'; expect(await fireDue(first + 15 * MINUTE)).toEqual([leader.id])
    })
  }
  for (const kind of ['handback', 'block', 'question']) {
    test(`real comment event for ${kind} matches only the exact recipient`, async () => {
      await begin()
      activity.push({ id: 'foreign', taskId: 'task-1', kind: 'comment', at: new Date(first + 1).toISOString(), actor: leader.id,
        detail: JSON.stringify({ message: { from: worker.id, to: leader.id + '-other', kind } }) })
      expect(await fireDue(first + 15 * MINUTE)).toEqual([])
      activity.push({ id: 'mine', taskId: 'task-1', kind: 'comment', at: new Date(first + 2).toISOString(), actor: 'session:managed-',
        detail: JSON.stringify({ message: { from: worker.id, to: leader.id, kind } }) })
      expect(await fireDue(first + 30 * MINUTE)).toEqual([leader.id])
      await recordReport(leader.conversationId, { state: 'ok', summary: 'Read' }, first + 31 * MINUTE)
      expect(await fireDue(first + 46 * MINUTE)).toEqual([])
    })
  }
  test('plain and malformed comment events are ignored', () => {
    expect(checkinActivity([{ kind: 'comment', detail: 'on task' }, { kind: 'comment', detail: '{' },
      { kind: 'checkin', detail: JSON.stringify({ message: { to: leader.id, kind: 'question' } }) }] as any, leader.id)).toEqual([])
  })
  for (const state of ['lost', 'closed', 'exited']) {
    test(`${state} workers cannot keep heartbeats alive`, async () => {
      await begin(); rows.push({ ...worker, state })
      expect(await fireDue(first + 120 * MINUTE)).toEqual([])
    })
  }
  test('unassigned and historical-id sessions are not live workers', async () => {
    await begin(); rows.push({ ...worker, id: 'unassigned', conversationId: 'unassigned' }, { ...worker, id: 'closed:worker' })
    await fireDue(first + 15 * MINUTE) // the newly added fleet rows are a real change
    await recordReport(leader.conversationId, { state: 'ok', summary: 'Read' }, first + 15 * MINUTE)
    expect(await fireDue(first + 135 * MINUTE)).toEqual([])
  })
  test('a failed heartbeat stays due for retry without advancing delivery history', async () => {
    await begin(true); delivery = 'false'
    expect(await fireDue(first + 120 * MINUTE)).toEqual([])
    expect(stored().lastFiredAt).toBe(first)
    expect(stored().nextRunAt).toBe(first + 120 * MINUTE)
    delivery = 'ok'
    expect(await fireDue(first + 120 * MINUTE + 1)).toEqual([leader.id])
  })
  test('manual runs preserve internal state and only commit successful delivery', async () => {
    await begin(); const baseline = stored().fingerprint
    stored().skipped = { count: 2, lastAt: first }
    limits = { changed: true }; delivery = 'false'
    expect(await runNow(leader.conversationId, first + MINUTE)).toBe(false)
    expect(stored().fingerprint).toBe(baseline)
    delivery = 'ok'
    expect(await runNow(leader.conversationId, first + MINUTE)).toBe(true)
    expect(stored().lastFiredAt).toBe(first + MINUTE)
    expect(stored().skipped.count).toBe(2)
  })
  test('restart uses persisted idle and heartbeat history', async () => {
    await begin(true)
    preferences = JSON.parse(JSON.stringify(preferences)); setCheckinDeps(testDeps)
    expect(await fireDue(first + 15 * MINUTE)).toEqual([])
    expect(await fireDue(first + 120 * MINUTE)).toEqual([leader.id])
  })
  test('config updates and pause expiry preserve private state; checklist changes invalidate inputs', async () => {
    await begin(true)
    const baseline = { fingerprint: stored().fingerprint, lastFiredAt: stored().lastFiredAt }
    stored().pending = true
    const updated = await putState(leader.conversationId, { intervalMin: 120 }, first + MINUTE)
    expect(stored()).toMatchObject({ ...baseline, pending: true })
    expect(updated).not.toHaveProperty('pending')
    expect(updated.nextRunAt).toBe(first + 120 * MINUTE)
    await putState(leader.conversationId, { paused: { until: first + 2 * MINUTE } }, first + MINUTE)
    await stateFor(leader.conversationId, first + 2 * MINUTE)
    expect(stored()).toMatchObject({ ...baseline, pending: true })
    await recordReport(leader.conversationId, { state: 'ok', summary: 'Read' }, first + 2 * MINUTE)
    await putState(leader.conversationId, { intervalMin: 15, checklist: [{ id: 'limits', enabled: false }] }, first + 2 * MINUTE)
    expect(stored().fingerprint).toBeUndefined()
    expect(stored().lastFiredAt).toBe(baseline.lastFiredAt)
    expect(await fireDue(first + 17 * MINUTE)).toEqual([leader.id])
  })
  test('limit/reset, release and project MCP changes trigger delivery', async () => {
    await begin()
    for (const [i, change] of [() => { limits = { windows: [{ usedPct: 85, resetsAt: 100 }] } },
      () => { limits = { windows: [{ usedPct: 85, resetsAt: 200 }] } },
      () => { release = { current: '1', latest: '2' } }, () => { mcp = { project: 'changed' } }].entries()) {
      change(); const now = first + (i + 1) * 15 * MINUTE
      expect(await fireDue(now)).toEqual([leader.id])
      await recordReport(leader.conversationId, { state: 'ok', summary: 'Read' }, now)
    }
    expect(mcpCwds.every(cwd => cwd === leader.cwd)).toBe(true)
  })
})

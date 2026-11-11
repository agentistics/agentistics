/**
 * A finished structured Hermes turn must not read as "needs you" ANYWHERE. The server used to patch
 * only its own label and count, while the web reads the raw row `state`. These tests build the row
 * through the real server path (`buildSessionViews` -> `toControlSession`) and hand it to the REAL
 * web functions that decide attention, the aside summary and the turn notification.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { attentionCount as webAttentionCount, needsAttention } from '../../../web/src/components/nav/AttentionDot'
import { summaryCounts } from '../../../web/src/lib/asideSummary'
import {
  DEFAULT_NOTIFICATION_SETTINGS, fleetActivityStates, notifyFleetTransitions, observeDeliveries,
  resetNotificationMemory, saveNotificationSettings,
} from '../../../web/src/lib/sessionNotifications'
import { cliStrings } from '../cli-i18n'
import { toControlSession } from './control-session'
import { buildSessionViews } from './session-view'
import type { ReconciledSession } from './session-ref'
import type { ManagedSession, SessionActivity } from './types'

const managed = (id: string, harness: string): ManagedSession =>
  ({ id, harness, cwd: '/repo/a', createdAt: '2026-08-13T10:00:00.000Z' }) as ManagedSession

const reconciled = (id: string, harness: string): ReconciledSession => ({
  id, managed: managed(id, harness),
  backend: { id, createdMs: 1000, attached: false, alive: true, lastActivityMs: 1000 },
  status: 'running',
})

/** The rows the web receives: server views mapped exactly as `/api/fleet` maps them. */
function fleet(spec: Array<[id: string, harness: string, activity: SessionActivity]>, structured: string[]) {
  const views = buildSessionViews({
    reconciled: spec.map(([id, h]) => reconciled(id, h)),
    activity: new Map(spec.map(([id, , a]) => [id, a] as const)),
    processes: [],
    structured: new Set(structured),
  })
  return views.map(v => toControlSession(v, cliStrings('en')))
}

describe('a structured Hermes turn that ended', () => {
  it('a finished structured Hermes turn is not counted as needing you by the web', () => {
    const rows = fleet([['hermes', 'hermes', 'waiting']], ['hermes'])
    expect(rows).toHaveLength(1)
    expect(needsAttention(rows[0]!)).toBe(false)
    expect(webAttentionCount(rows)).toBe(0)
    expect(summaryCounts(rows)).toEqual({ active: 1, working: 0, needs: 0 })
  })
})

describe('other harnesses are unchanged', () => {
  it('a Claude row waiting on a permission still needs you', () => {
    const rows = fleet([
      ['claude-a', 'claude', 'waiting-approval'],
      ['claude-b', 'claude', 'waiting'],
      ['hermes', 'hermes', 'waiting'],
    ], ['claude-a', 'hermes'])
    expect(webAttentionCount(rows)).toBe(2)
    expect(summaryCounts(rows)).toEqual({ active: 3, working: 0, needs: 2 })
    expect(rows.find(r => r.id === 'claude-a')!.state).toBe('waiting-approval')
  })

  it('a Hermes row that is NOT structured keeps the old reading', () => {
    const rows = fleet([['hermes-tty', 'hermes', 'waiting']], [])
    expect(rows[0]!.state).toBe('waiting')
  })
})

describe('the turn notification', () => {
  const deliveries: string[] = []
  beforeEach(() => {
    const store = new Map<string, string>()
    const g = globalThis as Record<string, unknown>
    g.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v) },
      removeItem: (k: string) => { store.delete(k) },
    }
    g.window = g
    deliveries.length = 0
    observeDeliveries(d => { deliveries.push(d.title) })
    saveNotificationSettings({
      ...DEFAULT_NOTIFICATION_SETTINGS, enabled: true, soundEnabled: false,
      events: { 'waiting-approval': true, waiting: true, working: true, exited: true, stale: true },
    })
    resetNotificationMemory()
  })
  afterEach(() => { observeDeliveries(null as never); resetNotificationMemory() })

  it('a finished structured Hermes turn fires no needs-you notification', () => {
    const working = fleet([['hermes', 'hermes', 'working']], ['hermes'])
    const done = fleet([['hermes', 'hermes', 'waiting']], ['hermes'])
    let memory = notifyFleetTransitions(null, working, 'en')
    memory = notifyFleetTransitions(memory, working, 'en')
    memory = notifyFleetTransitions(memory, done, 'en')
    notifyFleetTransitions(memory, done, 'en')
    expect(fleetActivityStates(done)).toEqual({})
    expect(deliveries).toEqual([])
  })

  it('a Claude turn that ended still notifies (control)', () => {
    const working = fleet([['claude', 'claude', 'working']], [])
    const done = fleet([['claude', 'claude', 'waiting']], [])
    let memory = notifyFleetTransitions(null, working, 'en')
    memory = notifyFleetTransitions(memory, working, 'en')
    memory = notifyFleetTransitions(memory, done, 'en')
    notifyFleetTransitions(memory, done, 'en')
    expect(deliveries.length).toBeGreaterThan(0)
  })
})


describe('rows[] always carries conversationLinkVia', () => {
  it('rows[] always carries conversationLinkVia, null without a conversation', () => {
    const views = buildSessionViews({
      reconciled: [
        reconciled('no-conversation', 'claude'),
        { ...reconciled('linked', 'claude'), managed: { ...managed('linked', 'claude'), conversationId: 'c-1', conversationLink: 'assigned', conversationLinkVia: 'assigned-id' } as ManagedSession },
      ],
      activity: new Map(), processes: [],
    })
    const rows = views.map(v => toControlSession(v, cliStrings('en')))
    const bare = rows.find(r => r.id === 'no-conversation')!
    expect('conversationLinkVia' in bare).toBe(true)
    expect(bare.conversationLinkVia).toBeNull()
    expect(rows.find(r => r.id === 'linked')!.conversationLinkVia).toBe('assigned-id')
  })
})

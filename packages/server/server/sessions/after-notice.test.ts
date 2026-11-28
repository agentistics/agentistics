import { afterEach, describe, expect, it } from 'bun:test'
import { cliStrings } from '../cli-i18n'
import { toCandidate } from '../events/producer'
import { toControlSession } from './control-session'
import { fleetRow } from './fleet-row'
import { controlStrings } from '../../../tui/src/control/i18n'
import { asksNoOne, attentionCount, bellTransitions, buildSessionViews, withAfterNotice, type SessionView } from './session-view'
import { noteMessageTo, resetLastMessages } from './last-message'
import { waitingOnReader } from './session-table'
import type { ReconciledSession } from './session-ref'
import type { ManagedSession, SessionActivity } from './types'

// Owner, 27/11: "esses avisos aparecem como pergunta, não deveria". A turn set off by a `notice` from another
// session asks the owner nothing, so it must not read as "needs you", ring, or emit a waiting event.

const managed = (id: string, over: Partial<ManagedSession> = {}): ManagedSession => ({
  id, harness: 'claude', cwd: '/repo/a', createdAt: '2026-11-26T10:00:00.000Z', ...over,
})
const row = (id: string): ReconciledSession => ({
  id,
  managed: managed(id),
  backend: { id, createdMs: 1000, attached: false, alive: true, lastActivityMs: 1000 },
  status: 'running',
})
const build = (activity: Array<[string, SessionActivity]>): SessionView[] =>
  buildSessionViews({ reconciled: activity.map(([id]) => row(id)), activity: new Map(activity), processes: [] })
const find = (views: SessionView[], id: string) => views.find(v => v.id === id)!

afterEach(resetLastMessages)

describe('a leader whose turn ended after a notice', () => {
  it('is marked, and reads as nobody\'s to answer everywhere', () => {
    noteMessageTo('lead', 1_000, { from: 'worker', kind: 'notice' })
    const views = build([['lead', 'waiting']])
    const lead = find(views, 'lead')
    expect(lead.afterNotice).toBe(true)
    expect(asksNoOne(lead)).toBe(true)
    expect(attentionCount(views)).toBe(0)
    expect(bellTransitions(new Map(), views)).toEqual([])
    expect(toCandidate(lead).activity).toBe('working')
    const en = toControlSession(lead, cliStrings('en'), undefined as never)
    expect(en.afterNotice).toBe(true)
    expect(en.stateLabel).toBe('read a notice')
    expect(toControlSession(lead, cliStrings('pt'), undefined as never).stateLabel).toBe('leu um aviso')
    expect(fleetRow(en, controlStrings('en')).afterNotice).toBe(true)
    expect(waitingOnReader([en])).toEqual([])
  })

  it('any newer message (the composer, a handback) lifts the mark', () => {
    noteMessageTo('lead', 1_000, { from: 'worker', kind: 'notice' })
    noteMessageTo('lead', 2_000)
    const views = build([['lead', 'waiting']])
    expect(find(views, 'lead').afterNotice).toBeUndefined()
    expect(attentionCount(views)).toBe(1)
    expect(bellTransitions(new Map(), views)).toEqual(['lead'])
  })

  it('the older kinds keep "needs you"', () => {
    for (const kind of ['handback', 'block', 'question']) {
      resetLastMessages()
      noteMessageTo('lead', 1_000, { from: 'worker', kind })
      const views = build([['lead', 'waiting']])
      expect(find(views, 'lead').afterNotice).toBeUndefined()
      expect(attentionCount(views)).toBe(1)
    }
  })

  it('a dialog or a working turn is never marked', () => {
    const v = (activity: SessionActivity) => ({ id: 'x', status: 'running', activity } as SessionView)
    expect(withAfterNotice([v('waiting-approval'), v('working')], () => 'notice').map(x => x.afterNotice)).toEqual([undefined, undefined])
    expect(withAfterNotice([v('waiting')], () => 'notice')[0]!.afterNotice).toBe(true)
  })
})

import { describe, expect, it } from 'bun:test'
import { cliStrings } from '../cli-i18n'
import { toCandidate } from '../events/producer'
import { toControlSession } from './control-session'
import { fleetRow } from './fleet-row'
import { controlStrings } from '../../../tui/src/control/i18n'
import { attentionCount, bellTransitions, buildSessionViews, type SessionView } from './session-view'
import { describeLive, liveRowOf } from './task-live-view'
import type { ReconciledSession } from './session-ref'
import type { BackendSession, ManagedSession, SessionActivity, SessionBackend } from './types'
import { createSessionsPoller } from './sessions-host'
import { waitingOnReader } from './session-table'

const managed = (id: string, over: Partial<ManagedSession> = {}): ManagedSession => ({
  id, harness: 'claude', cwd: '/repo/a', createdAt: '2026-11-26T10:00:00.000Z', ...over,
})
const row = (id: string, over: Partial<ManagedSession> = {}, status: ReconciledSession['status'] = 'running'): ReconciledSession => ({
  id,
  managed: managed(id, over),
  backend: { id, createdMs: 1000, attached: false, alive: true, lastActivityMs: 1000 },
  status,
})
const build = (reconciled: ReconciledSession[], activity: Array<[string, SessionActivity]>, extra: Partial<Parameters<typeof buildSessionViews>[0]> = {}): SessionView[] =>
  buildSessionViews({ reconciled, activity: new Map(activity), processes: [], ...extra })

const team = () => [row('lead', { conversationId: 'c-lead' }), row('f7', { parentSessionId: 'lead' })]
const find = (views: SessionView[], id: string) => views.find(v => v.id === id)!

describe('a leader whose turn ended with workers still working', () => {
  const views = build(team(), [['lead', 'waiting'], ['f7', 'working']])
  const lead = find(views, 'lead')

  it('is marked waiting on that many workers, and the worker is untouched', () => {
    expect(lead.waitingOnWorkers).toBe(1)
    expect(find(views, 'f7').waitingOnWorkers).toBeUndefined()
  })

  it('says so instead of "needs you" on the header word, in both languages', () => {
    const en = toControlSession(lead, cliStrings('en'), undefined as never)
    expect(en.state).toBe('waiting')
    expect(en.waitingOnWorkers).toBe(1)
    expect(en.stateLabel).toBe('waiting on 1 worker')
    expect(toControlSession(lead, cliStrings('pt'), undefined as never).stateLabel).toBe('esperando 1 worker')
    expect(fleetRow(en, controlStrings('en')).waitingOnWorkers).toBe(1)
  })

  it('is not counted as needing a person, and does not ring', () => {
    expect(attentionCount(views)).toBe(0)
    expect(bellTransitions(new Map(), views)).toEqual([])
  })

  it('is left out of the "N waiting on you" line of `session ls`', () => {
    const rows = views.map(v => toControlSession(v, cliStrings('en'), undefined as never))
    expect(waitingOnReader(rows)).toEqual([])
    const alone = build([row('x')], [['x', 'waiting']]).map(v => toControlSession(v, cliStrings('en'), undefined as never))
    expect(waitingOnReader(alone).map(r => r.id)).toEqual(['x'])
  })

  it('does not emit a "waiting" event', () => {
    expect(toCandidate(lead).activity).toBe('working')
  })

  it('counts a worker queued on the heavy lock as working', () => {
    const v = build(team(), [['lead', 'waiting'], ['f7', 'waiting']], { heavyLocks: new Map([['f7', 'waiting']]) })
    expect(find(v, 'lead').waitingOnWorkers).toBe(1)
  })

  it('goes back to "needs you" once the last worker stops, and rings then', () => {
    for (const [activity, status] of [['waiting', 'running'], ['waiting-approval', 'running'], ['exited', 'exited']] as const) {
      const v = build([team()[0]!, row('f7', { parentSessionId: 'lead' }, status)], [['lead', 'waiting'], ['f7', activity]])
      expect(find(v, 'lead').waitingOnWorkers).toBeUndefined()
      expect(bellTransitions(new Map(), v)).toContain('lead')
      expect(toCandidate(find(v, 'lead')).activity).toBe('waiting')
    }
  })

  it('a dialog on the leader wins over its workers', () => {
    const v = build(team(), [['lead', 'waiting-approval'], ['f7', 'working']])
    expect(find(v, 'lead').waitingOnWorkers).toBeUndefined()
    expect(attentionCount(v)).toBe(1)
    expect(toControlSession(find(v, 'lead'), cliStrings('en'), undefined as never).state).toBe('waiting-approval')
  })
})

describe('leaders of leaders (transitive)', () => {
  const chain = () => [
    row('top', { conversationId: 'c-top' }),
    row('mid', { parentSessionId: 'top' }),
    row('sub', { parentConversationId: 'c-top' }),
    row('leaf', { parentSessionId: 'mid' }),
  ]

  it('a top leader whose sub-leader waits on its own worker is waiting on workers too', () => {
    const v = build(chain(), [['top', 'waiting'], ['mid', 'waiting'], ['sub', 'waiting'], ['leaf', 'working']])
    expect(find(v, 'mid').waitingOnWorkers).toBe(1)
    // N stays the DIRECT children that are busy: mid (through leaf), not sub (idle, no workers).
    expect(find(v, 'top').waitingOnWorkers).toBe(1)
    expect(find(v, 'sub').waitingOnWorkers).toBeUndefined()
    expect(attentionCount(v)).toBe(1) // only `sub`
  })

  it('three levels: the chain goes back to the owner once the leaf stops', () => {
    const v = build(chain(), [['top', 'waiting'], ['mid', 'waiting'], ['sub', 'waiting'], ['leaf', 'exited']])
    expect(find(v, 'top').waitingOnWorkers).toBeUndefined()
    expect(find(v, 'mid').waitingOnWorkers).toBeUndefined()
  })

  it('a sub-leader in a dialog does not pass its workers up: the dialog is the owner\'s', () => {
    const v = build(chain(), [['top', 'waiting'], ['mid', 'waiting-approval'], ['sub', 'waiting'], ['leaf', 'working']])
    expect(find(v, 'top').waitingOnWorkers).toBeUndefined()
  })

  it('a cycle in the team links is harmless', () => {
    const cyc = [row('a', { parentSessionId: 'b' }), row('b', { parentSessionId: 'a' })]
    const v = build(cyc, [['a', 'waiting'], ['b', 'waiting']])
    expect(find(v, 'a').waitingOnWorkers).toBeUndefined()
    expect(find(v, 'b').waitingOnWorkers).toBeUndefined()
    expect(attentionCount(v)).toBe(2)
  })
})

describe('across real polls (QA probe M2b)', () => {
  const NOW = 1_786_600_000_000
  const bs = (id: string, over: Partial<BackendSession> = {}): BackendSession => ({
    id, createdMs: NOW - 600_000, attached: false, alive: true, lastActivityMs: NOW - 30_000, ...over,
  })
  function backend(sessions: BackendSession[], frames: Record<string, string[]>): SessionBackend {
    return {
      id: 'tmux',
      async unavailable() { return undefined },
      async spawn() {},
      async list() { return sessions },
      async capture(id: string) { return frames[id] ?? [] },
      async captureTerminal(id: string) {
        const lines = frames[id] ?? []
        return { lines, info: { cols: 80, rows: lines.length, cursorX: 0, cursorY: 0, alive: true, historySize: 0 } }
      },
      async kill() { return true },
      attachCommand(id: string) { return ['tmux', 'attach', id] },
      async detachHint() { return 'Ctrl-b then d' },
      async sendText() { return true },
      async sendTextRaw() { return true },
      async sendKey() { return true },
      async sendPaste() { return true },
    } as unknown as SessionBackend
  }

  it('never rings while the worker works, rings exactly once when it ends', async () => {
    let tick = 0
    const sessions = [bs('lead'), bs('f7')]
    const frames: Record<string, string[]> = { lead: ['❯ '], f7: ['· Working… (3s · ↓ 12 tokens)'] }
    const p = createSessionsPoller({
      backend: backend(sessions, frames),
      readRegistry: async () => [managed('lead', { conversationId: 'c-lead' }), managed('f7', { parentSessionId: 'lead' })],
      scanProcesses: async () => ({ procs: [] }),
      now: () => NOW + (tick++) * 5000,
    })
    const out: Array<{ rang: string[]; att: number; w?: number | undefined }> = []
    for (let i = 0; i < 3; i++) {
      frames.f7 = [`· Working… (${3 + i}s · ↓ ${12 + i} tokens)`]
      const s = await p.poll()
      out.push({ rang: s.rang, att: s.attention, w: s.sessions.find(x => x.id === 'lead')?.waitingOnWorkers })
    }
    sessions[1] = bs('f7', { alive: false })
    for (let i = 0; i < 3; i++) {
      const s = await p.poll()
      out.push({ rang: s.rang, att: s.attention, w: s.sessions.find(x => x.id === 'lead')?.waitingOnWorkers })
    }
    for (const o of out.slice(0, 3)) { expect(o.rang).toEqual([]); expect(o.att).toBe(0); expect(o.w).toBe(1) }
    expect(out.slice(3).flatMap(o => o.rang).filter(id => id === 'lead')).toHaveLength(1)
    expect(out[5]!.att).toBe(1)
  })
})

describe('the Live leaders lane', () => {
  it('carries the same count', () => {
    const [lead, f7] = [
      liveRowOf({ id: 'lead', title: 'Prontuario', harness: 'claude', state: 'waiting', waitingOnWorkers: 1 }),
      liveRowOf({ id: 'f7', title: 'F7', harness: 'claude', state: 'working', parentSessionId: 'lead' }),
    ]
    const view = describeLive({ reply: { generatedAt: '', samples: 0, deliveries: [], hidden: [], sessionTasks: {} } as never, rows: [lead, f7], leaderIds: new Set(['lead']), nowMs: 0 })
    expect(view.leaders[0]!.waitingOnWorkers).toBe(1)
  })
})

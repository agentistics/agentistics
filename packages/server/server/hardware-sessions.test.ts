import { describe, expect, test } from 'bun:test'
import { HUB_SNAPSHOT_MAX_AGE_MS, hardwareFromSnapshot } from './hardware-sessions'
import type { SessionSnapshot } from './sessions/sessions-host'
import type { SessionView } from './sessions/session-view'

const NOW = 1_800_000_000_000

function view(v: Partial<SessionView> & Pick<SessionView, 'id' | 'status'>): SessionView {
  return { cwd: '/w', attached: false, approvalDetection: true, searchFields: {} as SessionView['searchFields'], ...v } as SessionView
}

function snap(sessions: SessionView[], extra: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return { sessions, attention: 0, rang: [], polledAtMs: NOW - 1000, ...extra }
}

describe('hardwareFromSnapshot — the fleet half of /api/hardware-resources, off the hub', () => {
  test('a fresh snapshot answers: live rows only, heaviest first, with the poller\'s own figures', () => {
    const out = hardwareFromSnapshot(snap([
      view({ id: 'a', status: 'running', harness: 'claude', label: 'one', task: 't', activity: 'working', pid: 11, cpuPercent: 3.5, rssBytes: 100 }),
      view({ id: 'b', status: 'running', harness: 'codex', activity: 'waiting', pid: 12, cpuPercent: 1, rssBytes: 900 }),
      view({ id: 'c', status: 'exited', activity: 'exited', pid: 13 }),
      view({ id: 'd', status: 'lost' }),
      view({ id: 'e', status: 'unregistered', activity: 'exited' }),
      view({ id: 'f', status: 'unregistered', activity: 'waiting', pid: 14, cpuPercent: null, rssBytes: 50 }),
      view({ id: 'closed:x', status: 'closed' }),
      view({ id: 'g', status: 'external' }),
    ]), { nowMs: NOW, canReadProc: true })
    expect(out).not.toBeNull()
    expect(out!.procAvailable).toBe(true)
    expect(out!.sessions.map(s => s.id)).toEqual(['b', 'a', 'f'])
    expect(out!.sessions[1]).toEqual({ id: 'a', harness: 'claude', label: 'one', cwd: '/w', task: 't', alive: true, pid: 11, cpuPercent: 3.5, rssBytes: 100 })
    expect(out!.sessions[2]!.metricsReason).toBe('first-sample')
  })

  test('a row with no pid says so, and no /proc says so for every row', () => {
    const rows = [view({ id: 'a', status: 'running', activity: 'waiting' })]
    expect(hardwareFromSnapshot(snap(rows), { nowMs: NOW, canReadProc: true })!.sessions[0]!.metricsReason).toBe('no-pid')
    const noProc = hardwareFromSnapshot(snap([view({ id: 'a', status: 'running', activity: 'waiting', pid: 5, cpuPercent: 2, rssBytes: 7 })]), { nowMs: NOW, canReadProc: false })!
    expect(noProc.procAvailable).toBe(false)
    expect(noProc.sessions[0]).toMatchObject({ metricsReason: 'no-proc', cpuPercent: null, rssBytes: null })
  })

  test('no snapshot, a stale one, or one the poller marked unavailable: the caller reads directly', () => {
    expect(hardwareFromSnapshot(null, { nowMs: NOW, canReadProc: true })).toBeNull()
    expect(hardwareFromSnapshot(undefined, { nowMs: NOW, canReadProc: true })).toBeNull()
    expect(hardwareFromSnapshot(snap([], { polledAtMs: NOW - HUB_SNAPSHOT_MAX_AGE_MS - 1 }), { nowMs: NOW, canReadProc: true })).toBeNull()
    expect(hardwareFromSnapshot(snap([], { unavailable: 'tmux went away' }), { nowMs: NOW, canReadProc: true })).toBeNull()
    // An empty fleet in a fresh snapshot IS an answer: nothing is running.
    expect(hardwareFromSnapshot(snap([]), { nowMs: NOW, canReadProc: true })).toEqual({ sessions: [], procAvailable: true })
  })
})

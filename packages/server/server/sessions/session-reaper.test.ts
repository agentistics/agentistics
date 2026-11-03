import { describe, expect, test } from 'bun:test'
import { planSessionReap, reapSentence, type ReapInput, type ReapProc } from './session-reaper'

const ENDED = 1_000_000
const NOW = ENDED + 10 * 60_000
const proc = (pid: number, ppid: number, managedId?: string, o: Partial<ReapProc> = {}): ReapProc =>
  ({ pid, ppid, comm: 'claude', startMs: ENDED - 60_000, ...(managedId ? { managedId } : {}), ...o })
const input = (procs: ReapProc[], o: Partial<ReapInput> = {}): ReapInput =>
  ({ procs, ended: new Map([['dead', ENDED]]), liveIds: new Set(), nowMs: NOW, graceMs: 2 * 60_000, selfPid: 10, ...o })
const stopped = (i: ReapInput) => planSessionReap(i).stop.map(p => p.pid).sort((a, b) => a - b)
const why = (i: ReapInput, pid: number) => planSessionReap(i).skipped.find(s => s.pid === pid)?.why

describe('planSessionReap', () => {
  const tree = [proc(1, 0), proc(10, 1), proc(100, 1, 'dead'), proc(101, 100, 'dead', { comm: 'node' }), proc(102, 1, 'dead', { comm: 'npx' })]

  test('every process carrying an ended session marker is stopped — the double-forked one too', () => {
    expect(stopped(input(tree))).toEqual([100, 101, 102])
  })
  test('a session the backend lists alive is NEVER touched, whatever the registry says', () => {
    expect(stopped(input(tree, { liveIds: new Set(['dead']) }))).toEqual([])
    expect(why(input(tree, { liveIds: new Set(['dead']) }), 100)).toBe('live')
  })
  test('a session without endedAt (a live leader) is not a candidate at all', () => {
    expect(stopped(input([proc(200, 1, 'leader')]))).toEqual([])
  })
  test('inside the grace nothing is stopped; at kill time (grace 0) it is', () => {
    const i = input(tree, { nowMs: ENDED + 60_000 })
    expect(stopped(i)).toEqual([])
    expect(why(i, 100)).toBe('too-recent')
    expect(stopped({ ...i, graceMs: 0 })).toEqual([100, 101, 102])
  })
  test('a process YOUNGER than the session close is somebody else\'s doing', () => {
    const i = input([proc(300, 1, 'dead', { startMs: ENDED + 1 })])
    expect(stopped(i)).toEqual([])
    expect(why(i, 300)).toBe('younger')
  })
  test('this process and its ancestors are never stopped, nor a marker equal to our own', () => {
    const procs = [proc(1, 0), proc(5, 1, 'dead'), proc(10, 5, 'dead')]
    expect(stopped(input(procs))).toEqual([])
    expect(stopped(input([proc(400, 1, 'dead')], { selfManagedId: 'dead' }))).toEqual([])
  })
  test('a tmux server started from inside the pane is never stopped', () => {
    expect(why(input([proc(500, 1, 'dead', { comm: 'tmux: server' })]), 500)).toBe('tmux')
  })
  test('a process hosting another session beneath it is never stopped (a relay started from session X serving Y)', () => {
    const procs = [proc(600, 1, 'dead', { comm: 'bun' }), proc(601, 600, 'other-live')]
    expect(stopped(input(procs))).toEqual([])
    expect(why(input(procs), 600)).toBe('hosts-other')
  })
  test('onlyIds restricts the plan to the session being killed', () => {
    const procs = [proc(700, 1, 'dead'), proc(701, 1, 'gone')]
    const ended = new Map([['dead', ENDED], ['gone', ENDED]])
    expect(stopped(input(procs, { ended, onlyIds: new Set(['dead']) }))).toEqual([700])
  })
  test('the sentence', () => {
    expect(reapSentence({ freedBytes: 5 * 1048576, processes: 3 })).toBe('freed 5 MB from 3 leftover processes of closed sessions')
    expect(reapSentence({ freedBytes: 1048576, processes: 1, dryRun: true })).toBe('would free 1 MB from 1 leftover process of closed sessions')
  })
})

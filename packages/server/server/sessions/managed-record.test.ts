import { describe, expect, test } from 'bun:test'
import type { HarnessSessionFile } from './harness-session-file'
import { pickManagedRecord, type ManagedCandidate } from './managed-record'

function cand(pid: number, sessionId: string, over: Partial<ManagedCandidate> & { alive?: boolean } = {}): ManagedCandidate {
  const { alive = true, ...rest } = over
  const file: HarnessSessionFile = { pid, sessionId, cwd: '/home/u/ws', tmux: 'agentop-m1:@0.%0', alive }
  return { file, mtimeMs: pid, ancestors: [], ...rest }
}

describe('pickManagedRecord — a record names our pane only by an INHERITED env var', () => {
  test('one record: it is the answer, exactly as before', () => {
    expect(pickManagedRecord([cand(100, 'c-own', { ancestors: [10] })], 10)?.sessionId).toBe('c-own')
  })

  test('LINK.CROSSTALK: a process started FROM inside the pane (a preview server spawning claude) never wins', () => {
    // The leader claude (pid 100) runs in pane 10. It starts a preview server, which starts another
    // claude that inherits TMUX/TMUX_PANE and writes `tmux: agentop-m1:…` into its own record. That
    // record is NEWER, so newest-wins handed the leader's row the preview's conversation.
    const own = cand(100, 'c-leader', { ancestors: [10, 1], mtimeMs: 1 })
    const nested = cand(200, 'c-preview', { ancestors: [150, 100, 10, 1], mtimeMs: 2 })
    expect(pickManagedRecord([own, nested], 10)?.sessionId).toBe('c-leader')
    // Without pane information the nesting alone decides.
    expect(pickManagedRecord([own, nested], undefined)?.sessionId).toBe('c-leader')
  })

  test('a live process outside the pane tree (daemonised, reparented to init) never wins', () => {
    const own = cand(100, 'c-leader', { ancestors: [10, 1], mtimeMs: 1 })
    const orphan = cand(200, 'c-preview', { ancestors: [1], mtimeMs: 2 })
    expect(pickManagedRecord([own, orphan], 10)?.sessionId).toBe('c-leader')
  })

  test('a live record claiming a pane that does not exist is foreign', () => {
    // `null` = the pane list was read and this row has no pane.
    expect(pickManagedRecord([cand(200, 'c-preview', { ancestors: [1] })], null)).toBeUndefined()
  })

  test('a DEAD record is history (the name a person typed) and still answers', () => {
    expect(pickManagedRecord([cand(100, 'c-old', { alive: false })], null)?.sessionId).toBe('c-old')
  })

  test('a live record is preferred over a dead older one in the same pane', () => {
    const dead = cand(90, 'c-old', { alive: false, mtimeMs: 5 })
    const live = cand(100, 'c-new', { ancestors: [10], mtimeMs: 1 })
    expect(pickManagedRecord([dead, live], 10)?.sessionId).toBe('c-new')
  })

  test('two live unrelated records both under the pane: AMBIGUOUS, nobody wins (keep the current link)', () => {
    const a = cand(100, 'c-a', { ancestors: [10] })
    const b = cand(101, 'c-b', { ancestors: [10] })
    expect(pickManagedRecord([a, b], 10)).toBeUndefined()
  })

  test('liveness unknown (off Linux): nothing can be checked, newest wins as before', () => {
    const a = cand(100, 'c-a', { alive: undefined as never, mtimeMs: 1 })
    const b = cand(101, 'c-b', { alive: undefined as never, mtimeMs: 2 })
    delete (a.file as { alive?: boolean }).alive
    delete (b.file as { alive?: boolean }).alive
    expect(pickManagedRecord([a, b], undefined)?.sessionId).toBe('c-b')
  })

  test('the pane process itself is the record (claude launched as the pane command)', () => {
    expect(pickManagedRecord([cand(10, 'c-own', { ancestors: [1] })], 10)?.sessionId).toBe('c-own')
  })
})

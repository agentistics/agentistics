import { describe, expect, it } from 'bun:test'
import { FOLLOW_MS, createTerminalHub, type TerminalSink } from './terminal-hub'
import type { TerminalFrame } from './terminal-stream'
import type { PaneInfo, TerminalCapture } from './types'

const info = (over: Partial<PaneInfo> = {}): PaneInfo => ({
  cols: 80, rows: 40, cursorX: 0, cursorY: 0, alive: true, historySize: 0, ...over,
})
const cap = (lines: string[], over: Partial<PaneInfo> = {}): TerminalCapture => ({ lines, info: info(over) })

const flush = () => new Promise<void>(r => setTimeout(r, 0))

/** A recording sink. */
function sink() {
  const frames: TerminalFrame[] = []
  const ends: string[] = []
  const s: TerminalSink = { onFrame: f => frames.push(f), onEnd: r => ends.push(r) }
  return { s, frames, ends }
}

/**
 * A harness whose "tmux" is a variable and whose interval is a captured callback, so ticks happen
 * exactly when the test calls `tick()`. This is dependency injection, not filesystem mocking — the
 * same shape `createSessionsPoller` is built with in this directory.
 */
function harness(opts: { managed?: boolean } = {}) {
  let next: TerminalCapture | null = cap(['boot'])
  let intervalFn: (() => void) | null = null
  let cleared = false
  let captureCalls = 0
  const follows: { fn: () => void; ms: number }[] = []

  const hub = createTerminalHub({
    capture: async () => { captureCalls++; return next },
    isManaged: async () => opts.managed ?? true,
    historyLimit: 50_000,
    viewLines: 200,
    pollMs: 500,
    setInterval: fn => { intervalFn = fn; return 1 as unknown as ReturnType<typeof setInterval> },
    clearInterval: () => { cleared = true },
    setTimeout: (fn, ms) => { follows.push({ fn, ms }) },
  })

  return {
    hub,
    set: (c: TerminalCapture | null) => { next = c },
    tick: async () => { intervalFn?.(); await flush() },
    intervalStarted: () => intervalFn !== null,
    cleared: () => cleared,
    captureCalls: () => captureCalls,
    follows,
  }
}

describe('createTerminalHub', () => {
  it('one loop, one tmux read per tick, however many readers share a session', async () => {
    const h = harness()
    const a = sink()
    const b = sink()
    await h.hub.subscribe('s1', a.s)
    await h.hub.subscribe('s1', b.s)
    await flush()

    expect(h.hub.activeLoops()).toBe(1) // ONE loop for two readers — no duplicated work
    expect(h.hub.subscribers()).toBe(2)

    const before = h.captureCalls()
    h.set(cap(['moved']))
    await h.tick()
    // Exactly one more capture served BOTH readers.
    expect(h.captureCalls()).toBe(before + 1)
    expect(a.frames.at(-1)!.content).toBe('moved')
    expect(b.frames.at(-1)!.content).toBe('moved')
  })

  it('sends an unchanged frame to nobody, and a changed one to everybody', async () => {
    const h = harness()
    const a = sink()
    await h.hub.subscribe('s1', a.s)
    await flush()
    const seen = a.frames.length // the immediate first frame

    h.set(cap(['boot'])) // identical to the first
    await h.tick()
    expect(a.frames.length).toBe(seen) // deduped — nothing sent

    h.set(cap(['different']))
    await h.tick()
    expect(a.frames.length).toBe(seen + 1)
    expect(a.frames.at(-1)!.seq).toBeGreaterThan(a.frames[0]!.seq) // seq advances only on change
  })

  it('hands a late reader the current screen immediately, without waiting for a change', async () => {
    const h = harness()
    const a = sink()
    await h.hub.subscribe('s1', a.s)
    await flush()

    const b = sink()
    await h.hub.subscribe('s1', b.s)
    // b gets the last frame at subscribe time — no tick in between.
    expect(b.frames).toHaveLength(1)
    expect(b.frames[0]!.content).toBe('boot')
  })

  it('ends every reader cleanly when the session is gone, and stops the loop', async () => {
    const h = harness()
    const a = sink()
    const b = sink()
    await h.hub.subscribe('s1', a.s)
    await h.hub.subscribe('s1', b.s)
    await flush()

    h.set(null) // tmux no longer has the session
    await h.tick()

    expect(a.ends).toEqual(['gone'])
    expect(b.ends).toEqual(['gone'])
    expect(h.hub.activeLoops()).toBe(0) // a dying session takes nothing else down and leaks nothing
    expect(h.cleared()).toBe(true)
  })

  it('serves an EXITED but still-capturable pane as a dead-but-readable frame, not an end', async () => {
    const h = harness()
    const a = sink()
    await h.hub.subscribe('s1', a.s)
    await flush()

    h.set(cap(['last words'], { alive: false }))
    await h.tick()

    expect(a.ends).toEqual([]) // NOT ended: the session is still there, just finished
    expect(a.frames.at(-1)!.alive).toBe(false)
    expect(a.frames.at(-1)!.cursor).toBeNull()
    expect(a.frames.at(-1)!.content).toBe('last words')
  })

  it('refuses a session this machine does not manage — scope, before any loop starts', async () => {
    const h = harness({ managed: false })
    const a = sink()
    await h.hub.subscribe('elsewhere', a.s)
    await flush()

    expect(a.ends).toEqual(['not-found'])
    expect(a.frames).toEqual([])
    expect(h.hub.activeLoops()).toBe(0)
    expect(h.intervalStarted()).toBe(false)
  })

  it('stops capturing once the last reader leaves', async () => {
    const h = harness()
    const a = sink()
    const b = sink()
    const offA = await h.hub.subscribe('s1', a.s)
    const offB = await h.hub.subscribe('s1', b.s)
    await flush()

    offA()
    expect(h.hub.activeLoops()).toBe(1) // b is still watching
    expect(h.cleared()).toBe(false)

    offB()
    expect(h.hub.activeLoops()).toBe(0) // nobody left — the loop is stopped
    expect(h.cleared()).toBe(true)
  })

  it('is idempotent on a double unsubscribe', async () => {
    const h = harness()
    const a = sink()
    const off = await h.hub.subscribe('s1', a.s)
    await flush()
    off()
    off() // must not throw or double-count
    expect(h.hub.activeLoops()).toBe(0)
  })

  it('follows a CHANGING screen faster than the interval (an answer being written), and stops when it settles', async () => {
    const h = harness()
    const a = sink()
    await h.hub.subscribe('s1', a.s)
    await flush()
    // the first frame armed a follow-up; the screen has not changed since, so it arms nothing more
    while (h.follows.length) { h.follows.shift()!.fn(); await flush() }
    h.set(cap(['writing 1']))
    await h.tick()
    // a changed frame arms ONE quick follow-up capture
    expect(h.follows.map(f => f.ms)).toEqual([FOLLOW_MS])
    expect(FOLLOW_MS).toBeLessThan(500)
    h.set(cap(['writing 2']))
    h.follows.shift()!.fn(); await flush()
    expect(JSON.stringify(a.frames.at(-1))).toContain('writing 2')
    expect(h.follows.length).toBe(1) // still changing: keeps following
    h.follows.shift()!.fn(); await flush() // unchanged now
    expect(h.follows.length).toBe(0) // settled: back to the interval alone
  })
})

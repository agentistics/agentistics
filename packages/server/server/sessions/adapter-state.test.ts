import { describe, expect, it } from 'bun:test'
import type { ChatDeclaration, HarnessChat, HarnessChatDelta } from '@agentistics/engine-api'
import { HARNESS_ORDER, type HarnessId } from '@agentistics/core'
import {
  adapterActivity, createAdapterStateFeed, planScreen, SCREEN_REFRESH_MS, type AdapterReading, type AdapterStateFeed,
} from './adapter-state'
import { createSessionsPoller } from './sessions-host'
import type { BackendSession, ManagedSession, SessionBackend } from './types'

const idle: AdapterReading = { working: false, attention: false, coversAttention: false }

describe('planScreen — when an adapter-stated row still needs its screen', () => {
  const base = { lastScreenMs: 1_000, nowMs: 2_000, forced: false }
  it('no reading yet: the screen decides', () => expect(planScreen({ ...base, reading: undefined })).toBe(true))
  it('idle: no screen (a dialog lives inside a turn)', () => expect(planScreen({ ...base, reading: idle })).toBe(false))
  it('working, file cannot say "waiting on you": the screen shows the dialog', () =>
    expect(planScreen({ ...base, reading: { ...idle, working: true } })).toBe(true))
  it('working, file states attention: no screen', () =>
    expect(planScreen({ ...base, reading: { ...idle, working: true, coversAttention: true } })).toBe(false))
  it('waiting on a person per the file: the screen, for the options', () =>
    expect(planScreen({ ...base, reading: { working: true, attention: true, coversAttention: true } })).toBe(true))
  it('the periodic refresh and a forced read win', () => {
    expect(planScreen({ ...base, reading: idle, nowMs: base.lastScreenMs + SCREEN_REFRESH_MS })).toBe(true)
    expect(planScreen({ ...base, reading: idle, lastScreenMs: undefined })).toBe(true)
    expect(planScreen({ ...base, reading: idle, forced: true })).toBe(true)
  })
})

describe('adapterActivity', () => {
  it('the harness says working / idle', () => {
    expect(adapterActivity({ ...idle, working: true }, undefined)).toBe('working')
    expect(adapterActivity(idle, 'working')).toBe('waiting') // a screen that MOVED does not overrule the harness
  })
  it('a dialog wins, from the file or the screen', () => {
    expect(adapterActivity({ ...idle, working: true, attention: true }, undefined)).toBe('waiting-approval')
    expect(adapterActivity({ ...idle, working: true }, 'waiting-approval')).toBe('waiting-approval')
  })
})

// ── a fake engine: the declarations mirror the F1.1 engine's (`harness-chat.ts`) ──────────────────
const STATE_FROM_FILE: ReadonlySet<HarnessId> = new Set(['claude', 'codex', 'copilot', 'kimi', 'antigravity'])
const ATTENTION_FROM_FILE: ReadonlySet<HarnessId> = new Set(['copilot', 'kimi'])

function fakeEngine() {
  const emitters = new Map<string, (d: HarnessChatDelta) => void>()
  const chats = new Map<string, HarnessChat>()
  for (const h of HARNESS_ORDER) {
    if (h === 'opencode') continue // a declared absence: no chat at all
    const declares: ChatDeclaration = {
      state: STATE_FROM_FILE.has(h) ? { from: 'transcript markers' } : { absent: 'no turn boundary' },
      attention: ATTENTION_FROM_FILE.has(h) ? { from: 'transcript markers' } : { absent: 'not in the file' },
      live: { absent: 'n/a' },
      fork: { absent: 'n/a' },
    }
    chats.set(h, {
      declares,
      async resolve(ref) { return { harness: h, conversationId: ref.conversationId, sourceRef: `/x/${ref.conversationId}` } },
      follow(src, _max, on) { emitters.set(src.conversationId, on); return () => emitters.delete(src.conversationId) },
    })
  }
  return {
    chatOf: (h: string) => chats.get(h),
    state: (conv: string, working: boolean, attention = false) =>
      emitters.get(conv)?.({ kind: 'state', working, ...(attention ? { attention: { kind: 'permission' } } : {}) }),
    following: (conv: string) => emitters.has(conv),
  }
}

const NOW = 1_786_600_000_000
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }

function harnessPoller(harness: HarnessId, o: { feed: AdapterStateFeed | null; frame: string[]; now: () => number }) {
  const captures: string[] = []
  const session: BackendSession = { id: 'r1', createdMs: NOW - 600_000, attached: false, alive: true, lastActivityMs: NOW - 30_000 }
  const backend: SessionBackend = {
    id: 'tmux',
    async unavailable() { return undefined },
    async spawn() {},
    async list() { return [session] },
    async capture(id) { captures.push(id); return o.frame },
    async captureTerminal() { return { lines: [], info: { cols: 80, rows: 0, cursorX: 0, cursorY: 0, alive: true, historySize: 0 } } },
    async kill() { return true },
    attachCommand: id => ['tmux', 'attach', id],
    async detachHint() { return '' },
    async sendText() { return true },
    async sendTextRaw() { return true },
    async sendKey() { return true },
    async sendPaste() { return true },
  }
  const managed: ManagedSession = { id: 'r1', harness, cwd: '/repo', createdAt: '2026-10-09T00:00:00Z', conversationId: `conv-${harness}` }
  const poller = createSessionsPoller({
    backend,
    readRegistry: async () => [managed],
    scanProcesses: async () => ({ procs: [] }),
    now: o.now,
    adapterState: () => o.feed,
  })
  return { poller, captures }
}

describe('the poller, per harness — the harness states its state when ON; the screen decides when OFF or absent', () => {
  for (const h of HARNESS_ORDER) {
    const stated = STATE_FROM_FILE.has(h)
    it(`${h}: ${stated ? 'ON = adapter state, idle rows skip the screen' : 'no state declared = the screen, every poll'}`, async () => {
      let t = NOW
      const eng = fakeEngine()
      const feed = createAdapterStateFeed({ chatOf: eng.chatOf, setTimer: () => 0, clearTimer: () => {} })
      // A STILL frame with no prompt marker: the screen alone would hold this row's previous state.
      const { poller, captures } = harnessPoller(h, { feed, frame: ['some output'], now: () => t })
      await poller.poll() // first poll: subscribes; the screen is read (no reading yet)
      await flush()
      expect(captures.length).toBe(1)
      expect(eng.following(`conv-${h}`)).toBe(stated)
      if (!stated) {
        t += 5_000
        await poller.poll()
        expect(captures.length).toBe(2)
        return
      }
      // The harness says a turn is running, then that it ended.
      eng.state(`conv-${h}`, true)
      t += 5_000
      let snap = await poller.poll()
      expect(snap.sessions[0]!.activity).toBe('working')
      const workingCaptures = captures.length
      expect(workingCaptures).toBe(ATTENTION_FROM_FILE.has(h) ? 1 : 2) // attention not in the file → screen
      eng.state(`conv-${h}`, false)
      t += 5_000
      snap = await poller.poll()
      // Believed AT ONCE (no two-poll confirmation) and with no screen read.
      expect(snap.sessions[0]!.activity).toBe('waiting')
      expect(captures.length).toBe(workingCaptures)
      // The file says a person is being waited on (copilot, kimi): read the screen for the options.
      if (ATTENTION_FROM_FILE.has(h)) {
        eng.state(`conv-${h}`, true, true)
        t += 5_000
        snap = await poller.poll()
        expect(snap.sessions[0]!.activity).toBe('waiting-approval')
        expect(captures.length).toBe(workingCaptures + 1)
      }
      feed.stop()
    })

    it(`${h}: flag OFF = the screen, every poll`, async () => {
      let t = NOW
      const { poller, captures } = harnessPoller(h, { feed: null, frame: ['some output'], now: () => t })
      await poller.poll(); t += 5_000; await poller.poll(); t += 5_000; await poller.poll()
      expect(captures.length).toBe(3)
    })
  }

  it('an act forces the row\'s screen on the next poll; the periodic refresh reads it anyway', async () => {
    let t = NOW
    const eng = fakeEngine()
    const feed = createAdapterStateFeed({ chatOf: eng.chatOf, setTimer: () => 0, clearTimer: () => {} })
    const { poller, captures } = harnessPoller('claude', { feed, frame: ['x'], now: () => t })
    await poller.poll(); await flush()
    eng.state('conv-claude', false)
    t += 5_000; await poller.poll()
    expect(captures.length).toBe(1)
    feed.forceScreen('r1')
    t += 5_000; await poller.poll()
    expect(captures.length).toBe(2)
    t += SCREEN_REFRESH_MS; await poller.poll()
    expect(captures.length).toBe(3)
    feed.stop()
  })
})

describe('createAdapterStateFeed', () => {
  it('follows only live linked rows of harnesses that state their state, and releases gone ones', async () => {
    const eng = fakeEngine()
    const feed = createAdapterStateFeed({ chatOf: eng.chatOf, setTimer: () => 0, clearTimer: () => {} })
    feed.sync([
      { id: 'a', harness: 'claude', conversationId: 'c-a' },
      { id: 'b', harness: 'gemini', conversationId: 'c-b' }, // declares no state
      { id: 'c', harness: 'codex' }, // no link
      { id: 'd', harness: 'opencode', conversationId: 'c-d' }, // no chat
    ])
    await flush()
    expect(feed.followed()).toEqual(['a'])
    feed.sync([])
    expect(feed.followed()).toEqual([])
    expect(eng.following('c-a')).toBe(false)
  })

  it('a change is announced (debounced); an unchanged reading is not', async () => {
    const eng = fakeEngine()
    const timers: Array<() => void> = []
    const feed = createAdapterStateFeed({ chatOf: eng.chatOf, setTimer: f => { timers.push(f); return timers.length }, clearTimer: () => {} })
    let changes = 0
    feed.onChange(() => { changes++ })
    feed.sync([{ id: 'a', harness: 'codex', conversationId: 'c-a' }])
    await flush()
    eng.state('c-a', true); eng.state('c-a', false)
    expect(timers.length).toBe(1) // one debounce for the burst
    timers.shift()!()
    expect(changes).toBe(1)
    eng.state('c-a', false)
    expect(timers.length).toBe(0)
    feed.stop()
  })
})

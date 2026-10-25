import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatDeclaration, HarnessChat, HarnessChatDelta } from '@agentistics/engine-api'
import { HARNESS_ORDER, type HarnessId } from '@agentistics/core'
import {
  adapterActivity, createAdapterStateFeed, planScreen, SCREEN_REFRESH_MS, TAIL_WINDOW, type AdapterReading, type AdapterStateFeed,
} from './adapter-state'
import { createSessionsPoller } from './sessions-host'
import type { BackendSession, ManagedSession, SessionActivity, SessionBackend } from './types'

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
  it('a dialog on the last screen read keeps the screen read, even for an idle row', () => {
    expect(planScreen({ ...base, reading: idle, screenApproval: true })).toBe(true)
    expect(planScreen({ ...base, reading: idle, screenApproval: false })).toBe(false)
  })
  it('the periodic refresh and a forced read win', () => {
    expect(planScreen({ ...base, reading: idle, nowMs: base.lastScreenMs + SCREEN_REFRESH_MS })).toBe(true)
    expect(planScreen({ ...base, reading: idle, lastScreenMs: undefined })).toBe(true)
    expect(planScreen({ ...base, reading: idle, forced: true })).toBe(true)
  })
})

describe('CROSSBIND: the state feed does not follow another row\'s conversation', () => {
  it('a resolved source owned by another row is not followed', async () => {
    const eng = fakeEngine()
    const real = eng.chatOf('claude')!
    const chat: HarnessChat = { ...real, async resolve() { return { harness: 'claude', conversationId: 'other-conv', sourceRef: '/x/other-conv.jsonl' } } }
    const feed = createAdapterStateFeed({ chatOf: () => chat, foreign: async () => new Set(['other-conv']) })
    feed.sync([{ id: 'r1', harness: 'claude', conversationId: 'conv-claude', cwd: '/repo' }])
    await flush(); await Bun.sleep(5)
    expect(eng.following('other-conv')).toBe(false)
    feed.stop()
  })
})

describe('CROSSBIND fix2: forks and ownership changes inside the subscription', () => {
  const row = { id: 'r1', harness: 'claude', conversationId: 'conv-claude', cwd: '/repo' }
  const to = (c: string) => ({ harness: 'claude' as const, conversationId: c, sourceRef: `/x/${c}.jsonl` })
  const secret = { kind: 'window' as const, turns: [{ role: 'user' as const, text: 'SECRET of the other chat' }], older: false }
  const tailText = (feed: AdapterStateFeed) => JSON.stringify(feed.tail('r1') ?? [])

  it('HIGH-1: a fork into another row\'s conversation keeps NONE of its turns or state, and stops following', async () => {
    const eng = fakeEngine()
    const feed = createAdapterStateFeed({ chatOf: eng.chatOf, foreign: async () => new Set(['other-conv']) })
    feed.sync([row])
    await flush(); await Bun.sleep(5)
    eng.emit('conv-claude', { kind: 'window', turns: [{ role: 'user', text: 'mine' }], older: false })
    eng.emit('conv-claude', { kind: 'fork', to: to('other-conv') })
    eng.emit('conv-claude', secret)
    eng.emit('conv-claude', { kind: 'state', working: true })
    expect(tailText(feed)).not.toContain('SECRET') // held aside while the check runs
    await flush(); await Bun.sleep(5)
    expect(tailText(feed)).not.toContain('SECRET')
    expect(feed.reading('r1')).toBeUndefined()
    expect(eng.following('conv-claude')).toBe(false)
    feed.sync([row]) // refused for a while: not re-followed on the next poll
    await flush()
    expect(eng.following('conv-claude')).toBe(false)
    feed.stop()
  })

  it('a fork into an UNOWNED source commits what it held once its check passes', async () => {
    const eng = fakeEngine()
    const feed = createAdapterStateFeed({ chatOf: eng.chatOf, foreign: async () => new Set(['other-conv']) })
    feed.sync([row])
    await flush(); await Bun.sleep(5)
    eng.emit('conv-claude', { kind: 'fork', to: to('login-successor') })
    eng.emit('conv-claude', { kind: 'window', turns: [{ role: 'user', text: 'continued' }], older: false })
    eng.emit('conv-claude', { kind: 'state', working: true })
    await flush(); await Bun.sleep(5)
    expect(tailText(feed)).toContain('continued')
    expect(feed.reading('r1')?.working).toBe(true)
    feed.stop()
  })

  it('HIGH-2 (feed): an older fork\'s check passing never commits a newer, foreign fork\'s frames', async () => {
    const eng = fakeEngine()
    let call = 0
    const feed = createAdapterStateFeed({
      chatOf: eng.chatOf,
      foreign: async () => { const n = ++call; await Bun.sleep(n === 2 ? 20 : n === 3 ? 80 : 0); return new Set(['other-conv']) },
    })
    feed.sync([row])
    await flush(); await Bun.sleep(5)
    eng.emit('conv-claude', { kind: 'fork', to: to('unowned') }) // check #2, 20 ms, allowed
    eng.emit('conv-claude', { kind: 'window', turns: [{ role: 'user', text: 'fine' }], older: false })
    eng.emit('conv-claude', { kind: 'fork', to: to('other-conv') }) // check #3, 80 ms, refused
    eng.emit('conv-claude', secret)
    await Bun.sleep(40) // #2 settled, #3 still pending
    expect(tailText(feed)).not.toContain('SECRET')
    await Bun.sleep(80)
    expect(tailText(feed)).not.toContain('SECRET')
    expect(eng.following('conv-claude')).toBe(false)
    feed.stop()
  })

  it('HIGH-4 (feed): a source adopted before its owner registered is dropped on the next sync', async () => {
    const eng = fakeEngine()
    const real = eng.chatOf('claude')!
    let owners = new Set<string>()
    const chat: HarnessChat = { ...real, async resolve() { return to('other-conv') } }
    const feed = createAdapterStateFeed({ chatOf: () => chat, foreign: async () => owners })
    feed.sync([row])
    await flush(); await Bun.sleep(5)
    expect(eng.following('other-conv')).toBe(true) // nobody owned it yet
    eng.emit('other-conv', secret)
    owners = new Set(['other-conv']) // B registers with that conversation
    feed.sync([row])
    await flush(); await Bun.sleep(5)
    expect(eng.following('other-conv')).toBe(false)
    expect(feed.tail('r1')).toBeUndefined()
    feed.stop()
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
    emit: (conv: string, d: HarnessChatDelta) => emitters.get(conv)?.(d),
  }
}

const NOW = 1_786_600_000_000
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }

function harnessPoller(harness: HarnessId, o: { feed: AdapterStateFeed | null; frame: string[] | (() => string[]); now: () => number; activityOf?: () => SessionActivity | undefined }) {
  const captures: string[] = []
  const session: BackendSession = { id: 'r1', createdMs: NOW - 600_000, attached: false, alive: true, lastActivityMs: NOW - 30_000 }
  const backend: SessionBackend = {
    id: 'tmux',
    async unavailable() { return undefined },
    async spawn() {},
    async list() { return [session] },
    async capture(id) { captures.push(id); return typeof o.frame === 'function' ? o.frame() : o.frame },
    async captureTerminal() { return { lines: [], info: { cols: 80, rows: 0, cursorX: 0, cursorY: 0, alive: true, historySize: 0 } } },
    async kill() { return true },
    attachCommand: id => ['tmux', 'attach', id],
    async detachHint() { return '' },
    async sendText() { return true },
    async sendTextRaw() { return true },
    async sendKey() { return true },
    async sendPaste() { return true },
    ...(o.activityOf ? { activityOf: o.activityOf } : {}),
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
      // F4.A: every harness with a chat (not opencode) is followed for the row's tail; only a stated one decides.
      expect(eng.following(`conv-${h}`)).toBe(h !== 'opencode')
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

  // ADAPTER.ESSENTIALS-B item 1 — a STRUCTURED row's state is the PROTOCOL's statement (an open turn:
  // a 634 s Bash beating `tool_progress` heartbeats), never the transcript file's reading. Measured on
  // 2.116: with the flag on the poller took the file feed's `working: false` and skipped the backend,
  // so a Claude row running a long Bash read `waiting` for ten minutes. Every harness alike.
  for (const h of HARNESS_ORDER) {
    it(`${h}: a structured row's protocol state outranks the file's reading, both ways`, async () => {
      let t = NOW
      let said: SessionActivity = 'working'
      const eng = fakeEngine()
      const feed = createAdapterStateFeed({ chatOf: eng.chatOf, setTimer: () => 0, clearTimer: () => {} })
      const { poller } = harnessPoller(h, { feed, frame: [], now: () => t, activityOf: () => said })
      await poller.poll(); await flush()
      eng.state(`conv-${h}`, false) // the file: nothing moving
      for (let i = 0; i < 3; i++) { t += 5_000; expect((await poller.poll()).sessions[0]!.activity).toBe('working') }
      said = 'waiting' // the protocol: the turn ended
      eng.state(`conv-${h}`, true) // the file, stale, still says working
      t += 5_000
      expect((await poller.poll()).sessions[0]!.activity).toBe('waiting')
      said = 'waiting-approval'
      t += 5_000
      expect((await poller.poll()).sessions[0]!.activity).toBe('waiting-approval')
      feed.stop()
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

// A dialog the harness's transcript does not record (agy's directory-trust prompt, captured from agy
// 1.4.7) while the file says the turn is over: it must be confirmed by the screen and must not flip back.
describe('agy: a screen dialog outside a turn is confirmed and kept', () => {
  const trust = readFileSync(join(import.meta.dir, 'fixtures', 'antigravity-1.4.7', 'trust.txt'), 'utf8').trimEnd().split('\n') // the backend trims capture-pane's padding
  const idleChat = ['agy idle prompt', '', '> ', '', '  Gemini 3.8 Flash · high']

  it('idle, screen, idle, screen: waiting-approval after the 2nd screen read, and it stays', async () => {
    let t = NOW
    let frame = idleChat
    const eng = fakeEngine()
    const feed = createAdapterStateFeed({ chatOf: eng.chatOf, setTimer: () => 0, clearTimer: () => {} })
    const { poller, captures } = harnessPoller('antigravity', { feed, frame: () => frame, now: () => t })
    await poller.poll(); await flush()
    eng.state('conv-antigravity', false) // the transcript says the turn is over
    t += 5_000
    expect((await poller.poll()).sessions[0]!.activity).toBe('waiting') // idle: no screen
    const before = captures.length
    frame = trust // the dialog appears; nothing in the transcript changes
    feed.forceScreen('r1') // first screen read (an act / the periodic refresh)
    t += 5_000
    expect((await poller.poll()).sessions[0]!.activity).toBe('waiting') // one read is not yet a fact
    expect(captures.length).toBe(before + 1)
    for (let i = 0; i < 4; i++) {
      t += 5_000
      expect((await poller.poll()).sessions[0]!.activity).toBe('waiting-approval') // confirmed, and kept
    }
    expect(captures.length).toBe(before + 5) // the screen is read on EVERY poll while the dialog is up
    feed.stop()
  })

  it('once the dialog is gone the row is waiting again and the cadence returns to normal', async () => {
    let t = NOW
    let frame = trust
    const eng = fakeEngine()
    const feed = createAdapterStateFeed({ chatOf: eng.chatOf, setTimer: () => 0, clearTimer: () => {} })
    const { poller, captures } = harnessPoller('antigravity', { feed, frame: () => frame, now: () => t })
    await poller.poll(); await flush()
    eng.state('conv-antigravity', false)
    feed.forceScreen('r1')
    for (let i = 0; i < 3; i++) { t += 5_000; await poller.poll() }
    expect((await poller.poll()).sessions[0]!.activity).toBe('waiting-approval')
    frame = idleChat
    t += 5_000
    expect((await poller.poll()).sessions[0]!.activity).toBe('waiting')
    expect(feed.screenApproval('r1')).toBe(false)
    const n = captures.length
    for (let i = 0; i < 3; i++) { t += 5_000; expect((await poller.poll()).sessions[0]!.activity).toBe('waiting') }
    expect(captures.length).toBe(n) // idle again: no screen read until the periodic refresh
    feed.stop()
  })
})

describe('createAdapterStateFeed', () => {
  it('follows every live linked row whose harness serves a chat, and releases gone ones', async () => {
    const eng = fakeEngine()
    const feed = createAdapterStateFeed({ chatOf: eng.chatOf, setTimer: () => 0, clearTimer: () => {} })
    feed.sync([
      { id: 'a', harness: 'claude', conversationId: 'c-a' },
      { id: 'b', harness: 'gemini', conversationId: 'c-b' }, // declares no state: followed for the tail
      { id: 'c', harness: 'codex' }, // no link
      { id: 'd', harness: 'opencode', conversationId: 'c-d' }, // no chat
    ])
    await flush()
    expect(feed.followed()).toEqual(['a', 'b'])
    expect(feed.reading('b')).toBeUndefined()
    feed.sync([])
    expect(feed.followed()).toEqual([])
    expect(eng.following('c-a')).toBe(false)
  })

  it('keeps the row\'s last TAIL_WINDOW turns from the same cursor (F4.A: the poll reads no file)', async () => {
    const eng = fakeEngine()
    const feed = createAdapterStateFeed({ chatOf: eng.chatOf, setTimer: () => 0, clearTimer: () => {} })
    feed.sync([{ id: 'g', harness: 'gemini', conversationId: 'c-g' }])
    await flush()
    expect(feed.tail('g')).toBeUndefined()
    const turn = (i: number) => ({ role: 'assistant' as const, text: `t${i}` })
    eng.emit('c-g', { kind: 'window', turns: [turn(1), turn(2)], older: false })
    eng.emit('c-g', { kind: 'append', turns: [3, 4, 5, 6, 7].map(turn) })
    expect(feed.tail('g')!.map(t => t.text)).toEqual(['t2', 't3', 't4', 't5', 't6', 't7'])
    expect(TAIL_WINDOW).toBe(6)
    feed.sync([])
    expect(feed.tail('g')).toBeUndefined()
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

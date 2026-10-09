import { describe, expect, it } from 'bun:test'
import type { HarnessId } from '@agentistics/core'
import type { HarnessProcess } from '../live-sessions'
import type { BackendSession, ManagedSession, SessionBackend } from './types'
import { createSessionsPoller, linkProcessConversation } from './sessions-host'

const NOW = 1_786_600_000_000

const managed = (id: string, over: Partial<ManagedSession> = {}): ManagedSession => ({
  id, harness: 'claude', cwd: '/repo/a', createdAt: '2026-08-13T10:00:00.000Z', ...over,
})

const backendSession = (id: string, over: Partial<BackendSession> = {}): BackendSession => ({
  id,
  createdMs: NOW - 600_000,
  attached: false,
  alive: true,
  // Quiet enough that movement cannot fire, recent enough that a probed marker is still trusted.
  lastActivityMs: NOW - 30_000,
  ...over,
})

function fakeBackend(o: {
  sessions: BackendSession[]
  frames?: Record<string, string[]>
  unavailable?: string
  onCapture?: (id: string) => void
  panePids?: Record<string, number>
}): SessionBackend {
  return {
    id: 'tmux',
    async unavailable() { return o.unavailable },
    async spawn() {},
    async list() { return o.sessions },
    async capture(id) { o.onCapture?.(id); return o.frames?.[id] ?? [] },
    async captureTerminal(id) {
      const lines = o.frames?.[id] ?? []
      return { lines, info: { cols: 80, rows: lines.length, cursorX: 0, cursorY: 0, alive: true, historySize: 0 } }
    },
    async kill() { return true },
    attachCommand(id) { return ['tmux', 'attach', id] },
    async detachHint() { return 'Ctrl-b then d' },
    async sendText() { return true },
    async sendTextRaw() { return true },
    async sendKey() { return true },
    async sendPaste() { return true },
    ...(o.panePids ? { async listPanePids() { return new Map(Object.entries(o.panePids!)) } } : {}),
  }
}

const poller = (o: {
  backend: SessionBackend
  registry?: ManagedSession[]
  processes?: HarnessProcess[]
  now?: () => number
  touchSessions?: (ids: readonly string[], atMs: number) => Promise<unknown>
  heartbeatMs?: number
}) => createSessionsPoller({
  backend: o.backend,
  readRegistry: async () => o.registry ?? [],
  scanProcesses: async () => ({ procs: o.processes ?? [] }),
  now: o.now ?? (() => NOW),
  ...(o.touchSessions ? { touchSessions: o.touchSessions } : {}),
  ...(o.heartbeatMs !== undefined ? { heartbeatMs: o.heartbeatMs } : {}),
})

describe('createSessionsPoller', () => {
  it('measures only a row with a living command — an exited or lost row never borrows a neighbour\'s pid', async () => {
    // A live claude process in the SAME folder as two dead rows: before F1.2b the directory match handed
    // its pid (and memory) to both, re-attributed on every poll, and every fleet push re-sent them.
    const p = poller({
      backend: fakeBackend({
        sessions: [backendSession('live'), backendSession('dead', { alive: false })],
        frames: { live: ['❯ '] },
        panePids: { live: process.pid },
      }),
      registry: [managed('live'), managed('dead'), managed('gone')],
      processes: [{ harness: 'claude', cwd: '/repo/a', pid: process.pid } as HarnessProcess],
    })
    const snap = await p.poll()
    const by = new Map(snap.sessions.map(s => [s.id, s]))
    expect(by.get('dead')!.status).toBe('exited')
    expect(by.get('gone')!.status).toBe('lost')
    for (const id of ['dead', 'gone']) {
      expect(by.get(id)!.pid).toBeUndefined()
      expect(by.get(id)!.rssBytes).toBeUndefined()
      expect(by.get(id)!.cpuPercent).toBeUndefined()
    }
    if (process.platform === 'linux') expect(by.get('live')!.pid).toBe(process.pid)
  })

  it('reports a quiet session as waiting and counts it', async () => {
    const p = poller({
      backend: fakeBackend({ sessions: [backendSession('a')], frames: { a: ['❯ '] } }),
      registry: [managed('a')],
    })
    const snap = await p.poll()
    expect(snap.sessions[0]!.activity).toBe('waiting')
    expect(snap.attention).toBe(1)
  })

  it('does NOT count a working session that goes quiet for a single poll — the reported false positive', async () => {
    // The field report: the fleet said "waiting on you" about a session that had already gone back to
    // work. It reproduces at the poller: a session working (its probed footer moving), then ONE poll
    // where the frame is momentarily quiet — a repaint settling, a sub-turn finishing — reads `waiting`
    // raw. Before this fix the counter jumped to 1 on that single frame and a person was summoned.
    const frames: Record<string, string[]> = { a: ['· Working… (12s · ↓ 1.7k tokens)'] }
    const p = poller({
      backend: fakeBackend({ sessions: [backendSession('a')], frames }),
      registry: [managed('a')],
    })
    // Establish the confirmed working state.
    expect((await p.poll()).attention).toBe(0)
    // The marker goes away and the frame stops moving for exactly one poll.
    frames.a = ['❯ ']
    const blip = await p.poll()
    expect(blip.sessions[0]!.activity).toBe('working') // held — not summoned on one frame
    expect(blip.attention).toBe(0)
    expect(blip.rang).toEqual([])
  })

  it('the waiting count DROPS on the sample after work resumes', async () => {
    // The transition the acceptance names: waiting -> back to working -> the count falls on the next
    // sample. Clearing attention is the cheap direction, so it is believed at once.
    const frames: Record<string, string[]> = { a: ['❯ '] }
    const p = poller({
      backend: fakeBackend({ sessions: [backendSession('a')], frames }),
      registry: [managed('a')],
    })
    // Two quiet polls confirm waiting.
    await p.poll()
    expect((await p.poll()).attention).toBe(1)
    // The session resumes — a moving footer.
    frames.a = ['back at it · esc to interrupt']
    expect((await p.poll()).attention).toBe(0) // fell on the very next sample
  })

  it('reports a session working from its probed MAIN-agent marker', async () => {
    const p = poller({
      backend: fakeBackend({
        sessions: [backendSession('a')],
        frames: { a: ['  ⏸ manual mode on · Jitterbugging… (37s · ↓ 1.7k tokens) · ← 6 agents'] },
      }),
      registry: [managed('a')],
    })
    expect((await p.poll()).sessions[0]!.activity).toBe('working')
    expect((await p.poll()).attention).toBe(0)
  })

  it('a session whose ONLY marker is the interruptible one needs a person, and says a subagent runs', async () => {
    // claude prints `esc to interrupt` whenever ANYTHING is interruptible — a background subagent
    // included — so a session that has finished its own turn and is waiting for the person to type
    // still carried it. Reported exactly that way: the fleet said `working` about sessions that were
    // waiting. The main agent's own spinner is what says it is producing; the bare interruptible
    // marker says only that something else is.
    const p = poller({
      backend: fakeBackend({
        sessions: [backendSession('a')],
        frames: { a: ['  ⏸ manual mode on · esc to interrupt · ← 6 agents'] },
      }),
      registry: [managed('a')],
    })
    await p.poll()
    const snap = await p.poll()
    expect(snap.sessions[0]!.activity).toBe('waiting')
    expect(snap.sessions[0]!.background).toBe(true)
    expect(snap.attention).toBe(1)
  })

  it('a SINGLE frame change never reaches the row — that is what a repaint looks like', async () => {
    // On claude, which prints `esc to interrupt` whenever it is working, movement WITHOUT that
    // marker is most likely a repaint: a tmux advisory line, a plugin notice, a status clock. Each
    // one used to flip the row to `working` for a poll and back, so the row alternated between
    // `working` and `needs you` continuously with a notification each time — reported exactly that
    // way. `confirmActivities`' `corroborated` set is where this lives.
    const frames: Record<string, string[]> = { a: ['one'] }
    const p = poller({
      backend: fakeBackend({ sessions: [backendSession('a')], frames }),
      registry: [managed('a')],
    })
    expect((await p.poll()).sessions[0]!.activity).toBe('waiting')
    frames.a = ['two']
    expect((await p.poll()).sessions[0]!.activity).toBe('waiting')
    // The frame has stopped changing — the repaint is over and the row never moved.
    expect((await p.poll()).sessions[0]!.activity).toBe('waiting')
  })

  it('a SUSTAINED change is real work, and reaches the row', async () => {
    // Two polls in a row that both moved. That is not a repaint, and it is what an assistant
    // drawing output actually looks like on a harness whose marker is off screen.
    const frames: Record<string, string[]> = { a: ['one'] }
    const p = poller({
      backend: fakeBackend({ sessions: [backendSession('a')], frames }),
      registry: [managed('a')],
    })
    expect((await p.poll()).sessions[0]!.activity).toBe('waiting')
    frames.a = ['two']
    expect((await p.poll()).sessions[0]!.activity).toBe('waiting')
    frames.a = ['three']
    expect((await p.poll()).sessions[0]!.activity).toBe('working')
    // …and going quiet still takes two polls to be believed, unchanged.
    expect((await p.poll()).sessions[0]!.activity).toBe('working')
    expect((await p.poll()).sessions[0]!.activity).toBe('waiting')
  })

  it('a harness with NO working marker still believes movement at once', async () => {
    // Codex draws an identical screen streaming and idle, so movement is the only signal it has.
    // Requiring corroboration there would mean it never reads as working at all.
    const frames: Record<string, string[]> = { a: ['one'] }
    const p = poller({
      backend: fakeBackend({ sessions: [backendSession('a')], frames }),
      registry: [managed('a', { harness: 'codex' })],
    })
    expect((await p.poll()).sessions[0]!.activity).toBe('waiting')
    frames.a = ['two']
    expect((await p.poll()).sessions[0]!.activity).toBe('working')
  })

  it('the harness saying so is believed at once', async () => {
    // `esc to interrupt` is claude's own statement that it is working — evidence, not a repaint.
    const frames: Record<string, string[]> = { a: ['idle'] }
    const p = poller({
      backend: fakeBackend({ sessions: [backendSession('a')], frames }),
      registry: [managed('a')],
    })
    expect((await p.poll()).sessions[0]!.activity).toBe('waiting')
    frames.a = ['esc to interrupt']
    expect((await p.poll()).sessions[0]!.activity).toBe('working')
  })

  it('a request the PROTOCOL states is carried as stated — its options, picked by number, with no keystroke spec asked (F2.1)', async () => {
    const backend: SessionBackend = {
      ...fakeBackend({ sessions: [backendSession('g')] }),
      activityOf: () => 'waiting-approval',
      dialogOf: () => ['Allow for this session', 'Allow', 'Reject'],
    }
    const p = poller({ backend, registry: [managed('g', { harness: 'gemini' })] })
    const row = (await p.poll()).sessions[0]!
    expect(row.activity).toBe('waiting-approval')
    expect(row.dialogOptions?.map(o => o.label)).toEqual(['Allow for this session', 'Allow', 'Reject'])
    expect(row.dialogSelect).toBe('numbered')
    expect(row.dialogStated).toBe(true)
  })

  it('a dialog read off a SCREEN is not marked stated', async () => {
    const p = poller({
      backend: fakeBackend({ sessions: [backendSession('c')], frames: { c: ['Do you want to proceed?', ' ❯ 1. Yes', '   2. No', 'Esc to cancel · Tab to amend'] } }),
      registry: [managed('c')],
    })
    expect((await p.poll()).sessions[0]!.dialogStated).toBeUndefined()
  })

  it('never captures a dead pane', async () => {
    const captured: string[] = []
    const p = poller({
      backend: fakeBackend({
        sessions: [backendSession('a', { alive: false })],
        onCapture: id => captured.push(id),
      }),
      registry: [managed('a')],
    })
    expect((await p.poll()).sessions[0]!.activity).toBe('exited')
    expect(captured).toEqual([])
  })

  it('rings once on the transition into waiting, not on every poll', async () => {
    const frames: Record<string, string[]> = { a: ['· Working… (3s · ↓ 12 tokens)'] }
    const p = poller({
      backend: fakeBackend({ sessions: [backendSession('a')], frames }),
      registry: [managed('a')],
    })
    expect((await p.poll()).rang).toEqual([])

    // The turn ends. The poll that OBSERVES the ending sees a frame that changed since the last
    // one, which is movement — so the session still reads `working` for this one interval. That is
    // not a defect to design around: the alternative is to stop trusting movement, which is the
    // only working signal codex has at all. The bell is therefore at most one interval late, and
    // never early, which is the right way round for a signal a person acts on.
    frames.a = ['done']
    expect((await p.poll()).sessions[0]!.activity).toBe('working')

    // Next poll: the frame is unchanged, so the RAW reading is `waiting` — but it has been seen only
    // once, so the fleet still shows `working` and the bell does NOT ring. The bell fires on the
    // CONFIRMED transition, never on a single frame: that is what stops a one-frame quiet ringing a
    // person for a session that is still working.
    const held = await p.poll()
    expect(held.sessions[0]!.activity).toBe('working')
    expect(held.rang).toEqual([])

    // The poll after that confirms the quiet — waiting is now believed, and the bell rings once.
    const settled = await p.poll()
    expect(settled.sessions[0]!.activity).toBe('waiting')
    expect(settled.rang).toEqual(['a'])

    // And it does not ring again while it stays there.
    expect((await p.poll()).rang).toEqual([])
  })

  it('reports the backend own reason instead of an empty list', async () => {
    const p = poller({ backend: fakeBackend({ sessions: [], unavailable: 'tmux is not installed' }) })
    const snap = await p.poll()
    expect(snap.unavailable).toBe('tmux is not installed')
    expect(snap.sessions).toEqual([])
  })

  it('keeps the previous snapshot when a poll throws, rather than reporting zero', async () => {
    let fail = false
    const backend = fakeBackend({ sessions: [backendSession('a')], frames: { a: ['x'] } })
    const broken: SessionBackend = {
      ...backend,
      async list() {
        if (fail) throw new Error('boom')
        return [backendSession('a')]
      },
    }
    const p = poller({ backend: broken, registry: [managed('a')] })
    await p.poll()
    fail = true
    const snap = await p.poll()
    expect(snap.sessions).toHaveLength(1)
    expect(snap.unavailable).toContain('boom')
  })

  it('includes external processes the backend does not host', async () => {
    const p = poller({
      backend: fakeBackend({ sessions: [] }),
      processes: [{ harness: 'codex', cwd: '/repo/z', startedMs: NOW - 1000 }],
    })
    const snap = await p.poll()
    expect(snap.sessions).toHaveLength(1)
    expect(snap.sessions[0]!.status).toBe('external')
    expect(snap.attention).toBe(0)
  })
})

describe('the heartbeat', () => {
  it('stamps every ALIVE session on the first poll, so a fleet already up is on record', () => {
    // `-Infinity` as the initial mark is what makes this true. A control center opened onto a fleet
    // that was already running would otherwise carry no evidence of life until a minute in, and
    // would sit out a fall that happened in that minute.
    const calls: Array<{ ids: readonly string[]; atMs: number }> = []
    const p = poller({
      backend: fakeBackend({
        sessions: [backendSession('a'), backendSession('dead', { alive: false })],
      }),
      registry: [managed('a'), managed('dead')],
      touchSessions: async (ids, atMs) => { calls.push({ ids, atMs }) },
    })
    return p.poll().then(() => {
      expect(calls).toHaveLength(1)
      // A dead pane is not alive. Stamping it would put a session that ended on its own into the
      // same cluster as the ones a reboot took.
      expect(calls[0]!.ids).toEqual(['a'])
      expect(calls[0]!.atMs).toBe(NOW)
    })
  })

  it('does not write on every poll — the poll runs every five seconds', async () => {
    let n = 0
    let clock = NOW
    const p = poller({
      backend: fakeBackend({ sessions: [backendSession('a')] }),
      registry: [managed('a')],
      touchSessions: async () => { n++ },
      now: () => clock,
      heartbeatMs: 60_000,
    })
    await p.poll()
    expect(n).toBe(1)
    clock += 5_000
    await p.poll()
    clock += 5_000
    await p.poll()
    expect(n).toBe(1)
    clock += 60_000
    await p.poll()
    expect(n).toBe(2)
  })

  it('keeps polling when the registry cannot be written', async () => {
    // A registry that cannot be written costs the crash group, not the fleet on screen.
    const p = poller({
      backend: fakeBackend({ sessions: [backendSession('a')], frames: { a: ['x'] } }),
      registry: [managed('a')],
      touchSessions: async () => { throw new Error('read-only filesystem') },
    })
    const snap = await p.poll()
    expect(snap.unavailable).toBeUndefined()
    expect(snap.sessions).toHaveLength(1)
  })
})

describe('the sessions that fell together', () => {
  it('marks the rows and reports the group when the backend has lost them', async () => {
    const p = poller({
      backend: fakeBackend({ sessions: [] }),
      registry: [
        managed('a', { lastSeenMs: NOW - 10_000 }),
        managed('b', { lastSeenMs: NOW - 10_000 }),
      ],
    })
    const snap = await p.poll()
    expect(snap.fell?.entries.map(e => e.id)).toEqual(['a', 'b'])
    expect(snap.sessions.every(v => v.fell === true)).toBe(true)
  })

  it('says nothing when there is nothing to say', async () => {
    const p = poller({
      backend: fakeBackend({ sessions: [backendSession('a')], frames: { a: ['x'] } }),
      registry: [managed('a', { lastSeenMs: NOW })],
    })
    const snap = await p.poll()
    expect(snap.fell).toBeUndefined()
    expect(snap.sessions[0]!.fell).toBeUndefined()
  })

  it('keeps the group when a poll fails, alongside the sessions it describes', async () => {
    let fail = false
    const backend = fakeBackend({ sessions: [] })
    const broken: SessionBackend = {
      ...backend,
      async list() {
        if (fail) throw new Error('boom')
        return []
      },
    }
    const p = poller({ backend: broken, registry: [managed('a', { lastSeenMs: NOW })] })
    await p.poll()
    fail = true
    const snap = await p.poll()
    expect(snap.fell?.entries.map(e => e.id)).toEqual(['a'])
    expect(snap.unavailable).toContain('boom')
  })
})

describe('the dialog a blocked session is showing', () => {
  const DIALOG = [
    '● running the migration',
    '│ Do you want to proceed?  │',
    '│ ❯ 1. Yes                 │',
    '│ Enter to confirm · Esc to cancel │',
  ]

  it('carries the bottom of the screen, verbatim, only while it is asking', async () => {
    const p = poller({
      backend: fakeBackend({ sessions: [backendSession('a')], frames: { a: DIALOG } }),
      registry: [managed('a')],
    })
    const snap = await p.poll()
    expect(snap.sessions[0]!.activity).toBe('waiting-approval')
    // The options and the highlight, which nothing else on the screen carries: `lastLines` cuts at
    // the last rule and would hand back the conversation above the dialog.
    expect(snap.sessions[0]!.approvalLines?.join('\n')).toContain('❯ 1. Yes')
  })

  it('carries nothing on a session that is not blocked', async () => {
    const p = poller({
      backend: fakeBackend({ sessions: [backendSession('a')], frames: { a: ['❯ '] } }),
      registry: [managed('a')],
    })
    expect((await p.poll()).sessions[0]!.approvalLines).toBeUndefined()
  })
})

describe('persisting the harness /rename name', () => {
  const index = (byManagedId: Record<string, Record<string, unknown>>) => async () => ({
    byManagedId: new Map(Object.entries(byManagedId)),
    byPid: new Map(), byConversation: new Map(),
  } as never)

  it('persists a name a person typed, exactly once, and only when it CHANGES', async () => {
    const calls: { id: string; name: string; since?: number }[] = []
    const p = createSessionsPoller({
      backend: fakeBackend({ sessions: [backendSession('m1')], frames: { m1: ['x'] } }),
      readRegistry: async () => [managed('m1')],
      scanProcesses: async () => ({ procs: [] }),
      now: () => NOW,
      loadHarnessSessions: index({ m1: { name: 'MAIN', nameSince: 7, tmux: 'agentop-m1:@0.%0' } }),
      recordHarnessName: async (id, name, since) => { calls.push({ id, name, ...(since !== undefined ? { since } : {}) }) },
    })
    await p.poll()
    expect(calls).toEqual([{ id: 'm1', name: 'MAIN', since: 7 }])

    // Registry now already holds the name — the next poll must not write again.
    calls.length = 0
    const p2 = createSessionsPoller({
      backend: fakeBackend({ sessions: [backendSession('m1')], frames: { m1: ['x'] } }),
      readRegistry: async () => [managed('m1', { harnessName: 'MAIN', harnessNameSince: 7 })],
      scanProcesses: async () => ({ procs: [] }),
      now: () => NOW,
      loadHarnessSessions: index({ m1: { name: 'MAIN', nameSince: 7, tmux: 'agentop-m1:@0.%0' } }),
      recordHarnessName: async (id, name, since) => { calls.push({ id, name, ...(since !== undefined ? { since } : {}) }) },
    })
    await p2.poll()
    expect(calls).toEqual([])
  })

  it('never persists a name the harness invented for itself', async () => {
    const calls: unknown[] = []
    const p = createSessionsPoller({
      backend: fakeBackend({ sessions: [backendSession('m1')], frames: { m1: ['x'] } }),
      readRegistry: async () => [managed('m1')],
      scanProcesses: async () => ({ procs: [] }),
      now: () => NOW,
      loadHarnessSessions: index({ m1: { name: 'agentistics-77', nameSource: 'derived', tmux: 'agentop-m1:@0.%0' } }),
      recordHarnessName: async (...a) => { calls.push(a) },
    })
    await p.poll()
    expect(calls).toEqual([])
  })
})

describe('first-sighting claims', () => {
  const conv = (sessionId: string, over: Record<string, unknown> = {}) => ({
    sessionId, harness: 'codex' as const, cwd: '/repo/a', title: sessionId,
    lastActivityMs: NOW, startedMs: NOW - 60_000, resumable: true, firstPrompt: '',
    ...over,
  })

  it('records the claim once, through recordConversation, marked observed', async () => {
    const calls: Array<[string, string, string]> = []
    const p = createSessionsPoller({
      backend: fakeBackend({ sessions: [backendSession('m1')], frames: { m1: ['x'] } }),
      // Spawned BEFORE the conversation began, which is what makes it claimable.
      readRegistry: async () => [managed('m1', {
        harness: 'codex', cwd: '/repo/a', createdAt: new Date(NOW - 120_000).toISOString(),
      })],
      scanProcesses: async () => ({ procs: [] }),
      now: () => NOW,
      loadConversations: async () => [conv('c1')] as never,
      recordConversation: async (id, cid, link) => { calls.push([id, cid, link]) },
    })
    await p.poll()
    expect(calls).toEqual([['m1', 'c1', 'observed']])
  })

  it('writes nothing when the claim is refused', async () => {
    // Two unclaimed rows of one harness in one directory — what `session batch` produces. Coming
    // out empty is correct; coming out swapped is the bug this cannot survive.
    const calls: Array<[string, string, string]> = []
    const p = createSessionsPoller({
      backend: fakeBackend({
        sessions: [backendSession('m1'), backendSession('m2')],
        frames: { m1: ['x'], m2: ['x'] },
      }),
      readRegistry: async () => [
        managed('m1', { harness: 'codex', cwd: '/repo/a', createdAt: new Date(NOW - 120_000).toISOString() }),
        managed('m2', { harness: 'codex', cwd: '/repo/a', createdAt: new Date(NOW - 120_000).toISOString() }),
      ],
      scanProcesses: async () => ({ procs: [] }),
      now: () => NOW,
      loadConversations: async () => [conv('c1')] as never,
      recordConversation: async (id, cid, link) => { calls.push([id, cid, link]) },
    })
    await p.poll()
    expect(calls).toEqual([])
  })

  it('does not re-write a row that already carries a link', async () => {
    // A claim is never revised. Re-deriving it later is how a row silently changes what it measured.
    const calls: Array<[string, string, string]> = []
    const p = createSessionsPoller({
      backend: fakeBackend({ sessions: [backendSession('m1')], frames: { m1: ['x'] } }),
      readRegistry: async () => [managed('m1', {
        harness: 'codex', cwd: '/repo/a',
        createdAt: new Date(NOW - 120_000).toISOString(),
        conversationId: 'already',
      })],
      scanProcesses: async () => ({ procs: [] }),
      now: () => NOW,
      loadConversations: async () => [conv('c1')] as never,
      recordConversation: async (id, cid, link) => { calls.push([id, cid, link]) },
    })
    await p.poll()
    expect(calls).toEqual([])
  })
})

describe('linkProcessConversation', () => {
  const args = (over: Partial<{
    id: string
    harness: HarnessId
    pid: number
    knownLog: { file: string; holder: number } | null
    readProcessConversation: (harness: HarnessId, pid: number, knownLog?: { file: string; holder: number } | null) => Promise<string | null>
    recordConversation: (id: string, conversationId: string, link: 'assigned') => Promise<unknown>
  }> = {}) => ({
    id: 'm1',
    harness: 'antigravity' as HarnessId,
    pid: 4242,
    readProcessConversation: async () => 'conv-1',
    recordConversation: async () => undefined,
    ...over,
  })

  it('records the id the process log names, as an exact (assigned) link', async () => {
    const calls: Array<[string, string, string]> = []
    const linked = await linkProcessConversation(args({
      recordConversation: async (id, cid, link) => { calls.push([id, cid, link]); return undefined },
    }))
    expect(linked).toBe(true)
    expect(calls).toEqual([['m1', 'conv-1', 'assigned']])
  })

  it('writes nothing for a harness with no process-log source', async () => {
    const calls: unknown[] = []
    const linked = await linkProcessConversation(args({
      harness: 'claude',
      recordConversation: async (...a) => { calls.push(a) },
    }))
    expect(linked).toBe(false)
    expect(calls).toEqual([])
  })

  it('writes nothing when the log names no conversation yet', async () => {
    const calls: unknown[] = []
    const linked = await linkProcessConversation(args({
      readProcessConversation: async () => null,
      recordConversation: async (...a) => { calls.push(a) },
    }))
    expect(linked).toBe(false)
    expect(calls).toEqual([])
  })

  it('writes nothing when the log read throws', async () => {
    const calls: unknown[] = []
    const linked = await linkProcessConversation(args({
      readProcessConversation: async () => { throw new Error('/proc gone') },
      recordConversation: async (...a) => { calls.push(a) },
    }))
    expect(linked).toBe(false)
    expect(calls).toEqual([])
  })

  /**
   * `patchSession` runs inside the registry's own cross-process file lock and can genuinely
   * reject — this is the exact race `registry.ts` documents at length. A `true` return here is
   * TERMINAL in `linkProcessConversationSoon`'s retry loop (`if (linked) return`), so reporting
   * success on a failed write would silently spend the session's one dedicated retry window on
   * nothing, falling back entirely to the ordinary 5s poll.
   */
  it('reports FALSE, not true, when the registry write itself fails', async () => {
    const linked = await linkProcessConversation(args({
      recordConversation: async () => { throw new Error('registry write lock timed out') },
    }))
    expect(linked).toBe(false)
  })

  it('trusts a pre-resolved log instead of asking `readProcessConversation` to resolve it again', async () => {
    const seen: Array<string | null | undefined> = []
    await linkProcessConversation(args({
      knownLog: { file: '/some/cli-20260917_120000.log', holder: 4242 },
      readProcessConversation: async (_h, _pid, knownLog) => { seen.push(knownLog?.file); return 'conv-1' },
    }))
    expect(seen).toEqual(['/some/cli-20260917_120000.log'])
  })
})

describe('poll: process-log conversation link', () => {
  it('records the exact link once a row has a pid and a process-owned conversation', async () => {
    const calls: Array<[string, string, string]> = []
    const p = createSessionsPoller({
      backend: fakeBackend({
        sessions: [backendSession('m1')],
        frames: { m1: ['x'] },
        panePids: { m1: 777 },
      }),
      readRegistry: async () => [managed('m1', { harness: 'antigravity' })],
      scanProcesses: async () => ({ procs: [] }),
      now: () => NOW,
      readProcessConversation: async (_harness, pid) => (pid === 777 ? 'agy-conv' : null),
      recordConversation: async (id, cid, link) => { calls.push([id, cid, link]) },
    })
    await p.poll()
    expect(calls).toEqual([['m1', 'agy-conv', 'assigned']])
  })

  it('never asks for a row that already carries a link', async () => {
    const reads: number[] = []
    const p = createSessionsPoller({
      backend: fakeBackend({
        sessions: [backendSession('m1')],
        frames: { m1: ['x'] },
        panePids: { m1: 777 },
      }),
      readRegistry: async () => [managed('m1', { harness: 'antigravity', conversationId: 'already' })],
      scanProcesses: async () => ({ procs: [] }),
      now: () => NOW,
      readProcessConversation: async (_harness, pid) => { reads.push(pid); return 'agy-conv' },
      recordConversation: async () => undefined,
    })
    await p.poll()
    expect(reads).toEqual([])
  })

  it('writes nothing when the pane pid is not yet known to the backend', async () => {
    // The exact reproduction: a row spawned this instant, before `tmux list-panes` has anything to
    // say about it. Absence of a pid must never be treated as "nothing to link" forever — see
    // `linkProcessConversationSoon` in cli-start.ts, which retries this on its own schedule.
    const calls: unknown[] = []
    const p = createSessionsPoller({
      backend: fakeBackend({ sessions: [backendSession('m1')], frames: { m1: ['x'] } }),
      readRegistry: async () => [managed('m1', { harness: 'antigravity' })],
      scanProcesses: async () => ({ procs: [] }),
      now: () => NOW,
      readProcessConversation: async () => 'agy-conv',
      recordConversation: async (...a) => { calls.push(a) },
    })
    await p.poll()
    expect(calls).toEqual([])
  })
})

describe('poll: the same-second log collision', () => {
  /**
   * THE REPRODUCED BUG. agy names its log by SECOND, so two processes started together open the
   * SAME file — measured live 2026-09-17, and the file's content is not reliably preserved for
   * both writers (of two processes that each completed a turn, only one `Created conversation`
   * line survived at all). So the two rows here must NEITHER be linked, even though
   * `readProcessConversation` is (deliberately, to prove the guard and not the read, is what
   * refuses) willing to answer for both.
   */
  it('links NEITHER of two rows whose pids resolve to the identical log', async () => {
    const calls: Array<[string, string, string]> = []
    const p = createSessionsPoller({
      backend: fakeBackend({
        sessions: [backendSession('m1'), backendSession('m2')],
        frames: { m1: ['x'], m2: ['x'] },
        panePids: { m1: 111, m2: 222 },
      }),
      readRegistry: async () => [
        managed('m1', { harness: 'antigravity' }),
        managed('m2', { harness: 'antigravity' }),
      ],
      scanProcesses: async () => ({ procs: [] }),
      now: () => NOW,
      resolveProcessLog: async (_h, pid) => ({ file: 'cli-20260917_203310.log', holder: pid }), // the SAME log for both pids
      readProcessConversation: async (_h, pid) => `conv-of-${pid}`,
      recordConversation: async (id, cid, link) => { calls.push([id, cid, link]) },
    })
    await p.poll()
    expect(calls).toEqual([])
  })

  it('links a row normally when its pid is the ONLY one on its log', async () => {
    const calls: Array<[string, string, string]> = []
    const p = createSessionsPoller({
      backend: fakeBackend({
        sessions: [backendSession('m1'), backendSession('m2')],
        frames: { m1: ['x'], m2: ['x'] },
        panePids: { m1: 111, m2: 222 },
      }),
      readRegistry: async () => [
        managed('m1', { harness: 'antigravity' }),
        managed('m2', { harness: 'antigravity' }),
      ],
      scanProcesses: async () => ({ procs: [] }),
      now: () => NOW,
      resolveProcessLog: async (_h, pid) => ({ file: `cli-log-for-${pid}.log`, holder: pid }), // DIFFERENT logs
      readProcessConversation: async (_h, pid) => `conv-of-${pid}`,
      recordConversation: async (id, cid, link) => { calls.push([id, cid, link]) },
    })
    await p.poll()
    expect(calls.sort()).toEqual([['m1', 'conv-of-111', 'assigned'], ['m2', 'conv-of-222', 'assigned']])
  })

  /**
   * The collision must be checked machine-wide, not only among OUR unlinked rows — the process
   * sharing the log need not be one agentop started or even know about as a managed row. Modeled
   * here via `scanProcesses`, which the poller already reads for reasons unrelated to this row.
   */
  it('refuses a row whose log is shared with a LIVE process agentop never registered', async () => {
    const calls: Array<[string, string, string]> = []
    const p = createSessionsPoller({
      backend: fakeBackend({
        sessions: [backendSession('m1')],
        frames: { m1: ['x'] },
        panePids: { m1: 111 },
      }),
      readRegistry: async () => [managed('m1', { harness: 'antigravity' })],
      // An UNMANAGED antigravity process (pid 999) this machine can see but has no registry row for.
      scanProcesses: async () => ({
        procs: [{ harness: 'antigravity' as const, cwd: '/elsewhere', pid: 999 }],
      }),
      now: () => NOW,
      resolveProcessLog: async (_h, pid) => ({ file: 'cli-20260917_203310.log', holder: pid }), // same log as the unmanaged one
      readProcessConversation: async () => 'agy-conv',
      recordConversation: async (id, cid, link) => { calls.push([id, cid, link]) },
    })
    await p.poll()
    expect(calls).toEqual([])
  })

  it('recovers on the NEXT poll once the collision clears (one process ended)', async () => {
    const calls: Array<[string, string, string]> = []
    const p = createSessionsPoller({
      backend: fakeBackend({
        sessions: [backendSession('m1')],
        frames: { m1: ['x'] },
        panePids: { m1: 111 },
      }),
      readRegistry: async () => [managed('m1', { harness: 'antigravity' })],
      scanProcesses: async () => ({
        procs: [{ harness: 'antigravity' as const, cwd: '/elsewhere', pid: 999 }],
      }),
      now: () => NOW,
      resolveProcessLog: async (_h, pid) => ({ file: 'cli-20260917_203310.log', holder: pid }),
      readProcessConversation: async () => 'agy-conv',
      recordConversation: async (id, cid, link) => { calls.push([id, cid, link]) },
    })
    await p.poll()
    expect(calls).toEqual([]) // still colliding

    // The other process is gone: `scanProcesses` no longer reports pid 999.
    const p2 = createSessionsPoller({
      backend: fakeBackend({
        sessions: [backendSession('m1')],
        frames: { m1: ['x'] },
        panePids: { m1: 111 },
      }),
      readRegistry: async () => [managed('m1', { harness: 'antigravity' })],
      scanProcesses: async () => ({ procs: [] }),
      now: () => NOW,
      resolveProcessLog: async (_h, pid) => ({ file: 'cli-20260917_203310.log', holder: pid }),
      readProcessConversation: async () => 'agy-conv',
      recordConversation: async (id, cid, link) => { calls.push([id, cid, link]) },
    })
    await p2.poll()
    expect(calls).toEqual([['m1', 'agy-conv', 'assigned']])
  })
})

describe('the post-mortem conversation link', () => {
  const dead = (over: Record<string, unknown> = {}) => managed('m1', {
    harness: 'antigravity', cwd: '/home/padawan/ads-next',
    createdAt: new Date(NOW - 180_000).toISOString(),
    endedAt: new Date(NOW - 60_000).toISOString(),
    ...over,
  })
  const run = async (o: {
    rows: ReturnType<typeof managed>[]
    read: (a: { cwd: string; spawnedMs: number; rivalSpawnsMs?: readonly number[]; taken?: ReadonlySet<string> }) => Promise<string | null>
    record?: (id: string, cid: string, link: string) => Promise<unknown>
    polls?: number
  }) => {
    const calls: Array<[string, string, string]> = []
    const asked: string[] = []
    const p = createSessionsPoller({
      backend: fakeBackend({ sessions: [], frames: {} }),
      readRegistry: async () => o.rows,
      scanProcesses: async () => ({ procs: [] }),
      now: () => NOW,
      loadConversations: async () => [] as never,
      recordConversation: o.record ?? (async (id, cid, link) => { calls.push([id, cid, link]) }),
      readSpawnWindowConversation: async a => { asked.push(a.cwd); return o.read(a) },
    })
    for (let i = 0; i < (o.polls ?? 1); i++) await p.poll()
    return { calls, asked }
  }

  it('links a row whose process ended before anything read its log, as an exact (assigned) link', async () => {
    const { calls } = await run({ rows: [dead()], read: async () => 'conv-from-log' })
    expect(calls).toEqual([['m1', 'conv-from-log', 'assigned']])
  })

  it('hands the reader the row\'s spawn time, folder and the conversations already taken', async () => {
    let seen: { cwd: string; spawnedMs: number; taken?: ReadonlySet<string> } | undefined
    await run({
      rows: [dead(), managed('m2', { harness: 'antigravity', cwd: '/x', conversationId: 'held' })],
      read: async a => { seen = a; return null },
    })
    expect(seen?.cwd).toBe('/home/padawan/ads-next')
    expect(seen?.spawnedMs).toBe(NOW - 180_000)
    expect(seen?.taken?.has('held')).toBe(true)
  })

  it('tells the reader about every OTHER antigravity row spawned in the same folder', async () => {
    let rivals: readonly number[] | undefined
    await run({
      rows: [
        dead(),
        managed('m2', { harness: 'antigravity', cwd: '/home/padawan/ads-next', createdAt: new Date(NOW - 179_500).toISOString() }),
        managed('m3', { harness: 'antigravity', cwd: '/elsewhere', createdAt: new Date(NOW - 179_800).toISOString() }),
      ],
      read: async a => { if (a.spawnedMs === NOW - 180_000) rivals = a.rivalSpawnsMs; return null },
    })
    expect(rivals).toEqual([NOW - 179_500])
  })

  it('writes nothing when the log names no conversation', async () => {
    const { calls } = await run({ rows: [dead()], read: async () => null })
    expect(calls).toEqual([])
  })

  it('never touches a row that already has a link, or a harness with no process log', async () => {
    const { calls, asked } = await run({
      rows: [dead({ conversationId: 'already' }), managed('m9', { harness: 'claude' })],
      read: async () => 'conv-from-log',
    })
    expect(calls).toEqual([])
    expect(asked).toEqual([])
  })

  it('reads a dead row ONCE — its log is final — and does not repeat the directory scan every poll', async () => {
    const { asked } = await run({ rows: [dead()], read: async () => null, polls: 3 })
    expect(asked).toHaveLength(1)
  })

  it('retries when the registry WRITE failed, not when the read found nothing', async () => {
    let writes = 0
    const { asked } = await run({
      rows: [dead()],
      read: async () => 'conv-from-log',
      record: async () => { writes++; throw new Error('registry write lock timed out') },
      polls: 2,
    })
    expect(asked).toHaveLength(2)
    expect(writes).toBe(2)
  })

  it('a throwing reader costs the link, never the poll', async () => {
    const { calls } = await run({ rows: [dead()], read: async () => { throw new Error('EACCES') } })
    expect(calls).toEqual([])
  })
})

describe('a process-log link follows the conversation the process moves to', () => {
  const run = async (managedOver: Record<string, unknown>, seen: string | null) => {
    const calls: Array<[string, string, string]> = []
    const p = createSessionsPoller({
      backend: fakeBackend({ sessions: [backendSession('m1')], frames: { m1: ['x'] }, panePids: { m1: 777 } }),
      readRegistry: async () => [managed('m1', { harness: 'antigravity', ...managedOver })],
      scanProcesses: async () => ({ procs: [] }),
      now: () => NOW,
      readProcessConversation: async () => seen,
      recordConversation: async (id, cid, link) => { calls.push([id, cid, link]) },
    })
    await p.poll()
    return calls
  }
  it('REPRODUCTION: linked via the log, the process now names ANOTHER conversation -> re-linked', async () => {
    expect(await run({ conversationId: 'old', conversationLinkVia: 'process-log' }, 'new')).toEqual([['m1', 'new', 'assigned']])
  })
  it('the same conversation again writes nothing', async () => {
    expect(await run({ conversationId: 'old', conversationLinkVia: 'process-log' }, 'old')).toEqual([])
  })
  it('a link that was not produced by the log (spawn-assigned) is never replaced', async () => {
    expect(await run({ conversationId: 'old', conversationLinkVia: 'assigned-id' }, 'new')).toEqual([])
  })
  it('no conversation named yet changes nothing', async () => {
    expect(await run({ conversationId: 'old', conversationLinkVia: 'first-sighting' }, null)).toEqual([])
  })
})

describe('exclusive managed agy log', () => {
  it('links three same-folder/same-second rows without a live pid, then follows a new conversation', async () => {
    const rows = ['0123456789', 'abcdef0123', 'fedcba9876'].map(id => managed(id, { harness: 'antigravity' }))
    const logs = new Map(rows.map((r, i) => [r.id, `conversation-${i}`]))
    const writes: unknown[] = []
    const p = createSessionsPoller({
      backend: fakeBackend({ sessions: [] }), readRegistry: async () => rows,
      scanProcesses: async () => ({ procs: [] }), now: () => NOW,
      readManagedConversation: async (_h, id) => logs.get(id) ?? null,
      recordConversation: async (id, conv, link, via) => { writes.push([id, conv, link, via]) },
    })
    await p.poll()
    expect(writes).toEqual(rows.map((r, i) => [r.id, `conversation-${i}`, 'assigned', 'process-log']))
    writes.length = 0
    await p.poll()
    expect(writes).toEqual([])
    logs.set(rows[0]!.id, 'new-conversation')
    await p.poll()
    expect(writes).toEqual([[rows[0]!.id, 'new-conversation', 'assigned', 'process-log']])
  })
  it('preserves a reopened link and never asks another harness for a managed log', async () => {
    const reads: string[] = []
    const p = createSessionsPoller({
      backend: fakeBackend({ sessions: [] }),
      readRegistry: async () => [managed('0123456789', { harness: 'antigravity', conversationId: 'resumed', conversationLinkVia: 'resumed-id' }), managed('abcdef0123', { harness: 'codex' })],
      scanProcesses: async () => ({ procs: [] }), now: () => NOW,
      readManagedConversation: async (_h, id) => { reads.push(id); return 'other' },
      recordConversation: async () => { throw new Error('must not write') },
    })
    await p.poll()
    expect(reads).toEqual([])
  })
  it('keeps the process route when the managed log is absent or unreadable', async () => {
    const writes: string[] = []
    const p = createSessionsPoller({
      backend: fakeBackend({ sessions: [backendSession('0123456789')], panePids: { '0123456789': 777 } }),
      readRegistry: async () => [managed('0123456789', { harness: 'antigravity' })],
      scanProcesses: async () => ({ procs: [] }), now: () => NOW,
      readManagedConversation: async () => { throw new Error('unreadable') },
      readProcessConversation: async () => 'from-db-or-old-log',
      recordConversation: async (_id, conv) => { writes.push(conv) },
    })
    await p.poll()
    expect(writes).toEqual(['from-db-or-old-log'])
  })
})

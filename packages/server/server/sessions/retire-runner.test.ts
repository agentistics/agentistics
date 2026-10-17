import { describe, expect, it } from 'bun:test'
import { HARNESS_ORDER } from '@agentistics/core'
import { BG_TASKS_APPLICABLE, readRetireBgTasks, SUCCESSOR_GRACE_MS, PREDECESSOR_GRACE_MS, RETIRE_TRANSCRIPT_MAX_BYTES, createRetireRunner, MCP_COMMAND_SOURCES, type RetireRunnerDeps } from './retire-runner'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readChatWindow } from './chat-tail'
import { HARNESS_TRANSCRIPTS } from './harness-transcript'
import type { SessionSnapshot } from './sessions-host'
import type { SessionView } from './session-view'
import type { ManagedSession, RetireRequest, SessionActivity } from './types'
import type { SessionPatch } from './registry'

const T0 = Date.parse('2026-10-16T10:00:00.000Z')

function world(retire: RetireRequest, extra: ManagedSession[] = []) {
  let now = T0
  const rows: ManagedSession[] = [
    { id: 'p1', harness: 'claude', cwd: '/w', createdAt: new Date(T0).toISOString(), taskId: 't1', conversationId: 'c1', retire },
    ...extra,
  ]
  const calls = { kill: [] as string[], ended: [] as string[], filed: [] as string[], comments: [] as string[], notes: [] as string[], codes: [] as string[], meta: [] as Record<string, unknown>[], refresh: 0, probes: 0 }
  let bg: number | null = 0
  let latest: SessionSnapshot
  let fresh: SessionSnapshot | undefined
  const deps: RetireRunnerDeps = {
    readRegistry: async () => rows.map(r => ({ ...r })),
    async patch(id: string, p: SessionPatch) {
      const i = rows.findIndex(r => r.id === id)
      if (i < 0) return false
      const next = { ...rows[i]!, ...p } as Record<string, unknown>
      for (const [k, v] of Object.entries(p)) if (v === null) delete next[k]
      rows[i] = next as unknown as ManagedSession
      return true
    },
    readFresh: async () => fresh ?? latest,
    async kill(id) { calls.kill.push(id); return true },
    async markEnded(id) { calls.ended.push(id); await deps.patch(id, { endedAt: new Date(now).toISOString() }) },
    async fileInFolder(f, row) { calls.filed.push(`${f}:${row.id}`); return true },
    async bgTasks() { calls.probes++; return bg },
    async children() { return { checked: true, children: [] } },
    async comment(_t, body) { calls.comments.push(body) },
    notify(_l, title, _message, code, meta) { calls.notes.push(title); calls.codes.push(code); calls.meta.push(meta) },
    refresh() { calls.refresh++ },
    now: () => now,
  }
  const view = (id: string, activity: SessionActivity, status: SessionView['status'] = 'running'): SessionView =>
    ({ id, cwd: '/w', status, activity, attached: false, approvalDetection: true, searchFields: {} as SessionView['searchFields'] })
  const snap = (views: SessionView[], unavailable?: string): SessionSnapshot =>
    (latest = { sessions: views, attention: 0, rang: [], polledAtMs: now, ...(unavailable ? { unavailable } : {}) })
  return {
    rows, calls, deps, view, snap,
    advance(ms: number) { now += ms },
    setFresh(s: SessionSnapshot) { fresh = s },
    setBg(n: number | null) { bg = n },
  }
}

const req = (over: Partial<RetireRequest> = {}): RetireRequest => ({
  requestedAt: new Date(T0).toISOString(), by: 'p1', quietForMs: 10_000,
  deadlineAt: new Date(T0 + 60_000).toISOString(), folderId: 'fin', ...over,
})

describe('retire runner on the hub', () => {
  it('a working session is killed only after it is confirmed idle for quietFor — exactly once', async () => {
    const w = world(req())
    const r = createRetireRunner(w.deps)
    await r.consume(w.snap([w.view('p1', 'working')]))
    w.advance(5000)
    await r.consume(w.snap([w.view('p1', 'working')]))
    expect(w.calls.kill).toEqual([])
    // Goes idle: first poll is not confirmation; the probes do not run yet.
    w.advance(5000)
    await r.consume(w.snap([w.view('p1', 'waiting')]))
    w.advance(5000)
    await r.consume(w.snap([w.view('p1', 'waiting')]))
    expect(w.calls.kill).toEqual([])
    expect(w.calls.probes).toBe(0)
    w.advance(5000)
    const s = w.snap([w.view('p1', 'waiting')])
    // The same snapshot delivered twice, concurrently: one kill.
    await Promise.all([r.consume(s), r.consume(s)])
    w.advance(5000)
    await r.consume(w.snap([w.view('p1', 'waiting')]))
    expect(w.calls.kill).toEqual(['p1'])
    expect(w.calls.ended).toEqual(['p1'])
    expect(w.calls.filed).toEqual(['fin:p1'])
    expect(w.calls.comments).toHaveLength(1)
    expect(w.calls.refresh).toBe(1)
    expect(w.calls.codes).toEqual(['retire.done'])
    expect('retire' in w.rows[0]!).toBe(false)
  })

  it('a busy session past the deadline is NOT killed: the request expires with the reason', async () => {
    const w = world(req())
    const r = createRetireRunner(w.deps)
    for (let i = 0; i < 13; i++) { await r.consume(w.snap([w.view('p1', 'working')])); w.advance(5000) }
    expect(w.calls.kill).toEqual([])
    expect(w.rows[0]!.retire?.expiredAt).toBeDefined()
    expect(w.rows[0]!.retire?.expiredReason).toBe('still working')
    expect(w.calls.notes).toEqual(['Retire expired'])
    expect(w.calls.codes).toEqual(['retire.expired'])
    expect(w.calls.meta[0]?.reason).toBe('working')
    expect(w.calls.meta[0]?.reasons).toEqual(['working'])
    // Expired is final: going idle later kills nothing.
    for (let i = 0; i < 5; i++) { await r.consume(w.snap([w.view('p1', 'waiting')])); w.advance(5000) }
    expect(w.calls.kill).toEqual([])
  })

  it('a running background task holds the kill; waiting-approval breaks the streak', async () => {
    const w = world(req({ quietForMs: 0 }))
    const r = createRetireRunner(w.deps)
    w.setBg(1)
    await r.consume(w.snap([w.view('p1', 'waiting')])); w.advance(10_000)
    await r.consume(w.snap([w.view('p1', 'waiting')])); w.advance(10_000)
    expect(w.calls.kill).toEqual([])
    w.setBg(0)
    await r.consume(w.snap([w.view('p1', 'waiting-approval')])); w.advance(10_000)
    await r.consume(w.snap([w.view('p1', 'waiting')])); w.advance(10_000)
    expect(w.calls.kill).toEqual([])
    await r.consume(w.snap([w.view('p1', 'waiting')]))
    expect(w.calls.kill).toEqual(['p1'])
  })

  it('a stale (unavailable) snapshot advances nothing', async () => {
    const w = world(req({ quietForMs: 0 }))
    const r = createRetireRunner(w.deps)
    await r.consume(w.snap([w.view('p1', 'waiting')])); w.advance(10_000)
    await r.consume(w.snap([w.view('p1', 'waiting')], 'poll failed'))
    expect(w.calls.kill).toEqual([])
  })

  it('a dead successor cancels the request and kills nothing', async () => {
    const succ: ManagedSession = { id: 's1', harness: 'codex', cwd: '/w', createdAt: new Date(T0).toISOString() }
    const w = world(req({ successorId: 's1' }), [succ])
    const r = createRetireRunner(w.deps)
    await r.consume(w.snap([w.view('p1', 'working'), w.view('s1', 'working')]))
    expect('retire' in w.rows[0]!).toBe(true)
    w.advance(5000)
    await r.consume(w.snap([w.view('p1', 'waiting'), w.view('s1', 'exited', 'exited')]))
    expect('retire' in w.rows[0]!).toBe(false)
    expect(w.calls.kill).toEqual([])
    expect(w.calls.notes).toEqual(['Retire cancelled'])
    expect(w.calls.codes).toEqual(['retire.cancelled'])
  })

  it('a row that already stopped is filed without a kill', async () => {
    const w = world(req())
    const r = createRetireRunner(w.deps)
    await r.consume(w.snap([w.view('p1', 'exited', 'exited')]))
    expect(w.calls.kill).toEqual([])
    expect(w.calls.ended).toEqual(['p1'])
  })

  it('a request cancelled after the snapshot was read is not carried out', async () => {
    const w = world(req({ quietForMs: 0 }))
    const r = createRetireRunner(w.deps)
    await r.consume(w.snap([w.view('p1', 'waiting')])); w.advance(10_000)
    const real = w.deps.readRegistry
    let n = 0
    w.deps.readRegistry = async () => (++n === 2 ? (await real()).map(x => ({ ...x, retire: undefined })) : real())
    await r.consume(w.snap([w.view('p1', 'waiting')]))
    expect(w.calls.kill).toEqual([])
  })
})

describe('MCP_COMMAND_SOURCES', () => {
  it('decides every harness', () => {
    for (const h of HARNESS_ORDER) expect(h in MCP_COMMAND_SOURCES).toBe(true)
  })
})

describe('retire QA regressions', () => {
  it('a transcript exceeding the byte read limit stays unknown and blocks retirement', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'retire-bg-'))
    try {
      const file = join(dir, 'chat.jsonl')
      const lines = [
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'bg1', name: 'Bash', input: { command: 'sleep 600', run_in_background: true } }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'bg1', content: 'Command running in background with ID: shell1' }] } },
        ...Array.from({ length: 401 }, (_, i) => ({ type: 'user', message: { role: 'user', content: `turn ${i}` } })),
      ]
      await writeFile(file, lines.map(x => JSON.stringify(x)).join('\n') + '\n')
      expect((await readChatWindow(file, 1000)).turns.some(t => t.task?.running)).toBe(true)
      const row = world(req()).rows[0]!
      expect(await readRetireBgTasks(row, { ...HARNESS_TRANSCRIPTS, claude: {
        resolve: async () => file, read: (p, max, opts) => readChatWindow(p, max, { ...opts, maxBytes: 128 }), readRecent: async () => { throw new Error('must use window') },
      } })).toBeNull()
      const w = world(req())
      w.setBg(null)
      const r = createRetireRunner(w.deps)
      await r.consume(w.snap([w.view('p1', 'waiting')]))
      w.advance(10_000)
      await r.consume(w.snap([w.view('p1', 'waiting')]))
      expect(w.calls.kill).toEqual([])
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('every harness without background tasks retires without a conversation or reader', async () => {
    for (const harness of HARNESS_ORDER) {
      expect(harness in BG_TASKS_APPLICABLE).toBe(true)
      if (BG_TASKS_APPLICABLE[harness]) continue
      const w = world(req())
      w.rows[0]!.harness = harness
      delete w.rows[0]!.conversationId
      w.deps.bgTasks = row => readRetireBgTasks(row, { ...HARNESS_TRANSCRIPTS, [harness]: null })
      const r = createRetireRunner(w.deps)
      await r.consume(w.snap([w.view('p1', 'waiting')]))
      w.advance(10_000)
      await r.consume(w.snap([w.view('p1', 'waiting')]))
      expect(w.calls.kill).toEqual(['p1'])
    }
  })

  it('a missing newborn successor waits, and an unregistered successor is alive', async () => {
    const w = world(req({ successorId: 's1' }), [{ id: 's1', harness: 'codex', cwd: '/w', createdAt: new Date(T0).toISOString() }])
    const r = createRetireRunner(w.deps)
    await r.consume(w.snap([w.view('p1', 'waiting')]))
    w.advance(10_000)
    await r.consume(w.snap([w.view('p1', 'waiting')]))
    expect(w.rows[0]!.retire).toBeDefined()
    expect(w.calls.kill).toEqual([])
    await r.consume(w.snap([w.view('p1', 'waiting'), w.view('s1', 'working', 'unregistered')]))
    expect(w.calls.kill).toEqual(['p1'])
  })

  it('only two distinct missing-successor polls after birth grace cancel', async () => {
    const w = world(req({ successorId: 's1' }))
    const r = createRetireRunner(w.deps)
    w.advance(SUCCESSOR_GRACE_MS + 1)
    const s = w.snap([w.view('p1', 'working')])
    await r.consume(s)
    await r.consume(s)
    expect(w.rows[0]!.retire).toBeDefined()
    w.advance(5000)
    await r.consume(w.snap([w.view('p1', 'working')]))
    expect(w.rows[0]!.retire).toBeUndefined()
    expect(w.calls.kill).toEqual([])
  })

  for (const activity of ['working', 'waiting-approval'] as const) {
    it(`fresh ${activity} after probes prevents the kill and resets quiet`, async () => {
      const w = world(req())
      const r = createRetireRunner(w.deps)
      await r.consume(w.snap([w.view('p1', 'waiting')]))
      w.advance(10_000)
      w.setFresh(w.snap([w.view('p1', activity)]))
      await r.consume(w.snap([w.view('p1', 'waiting')]))
      expect(w.calls.probes).toBe(1)
      expect(w.calls.kill).toEqual([])
      w.advance(5000)
      w.setFresh(w.snap([w.view('p1', 'waiting')]))
      await r.consume(w.snap([w.view('p1', 'waiting')]))
      expect(w.calls.kill).toEqual([])
    })
  }

  it('stored zero quietFor still needs the minimum quiet period', async () => {
    const w = world(req({ quietForMs: 0 }))
    const r = createRetireRunner(w.deps)
    await r.consume(w.snap([w.view('p1', 'waiting')]))
    w.advance(5000)
    await r.consume(w.snap([w.view('p1', 'waiting')]))
    expect(w.calls.kill).toEqual([])
    w.advance(5000)
    await r.consume(w.snap([w.view('p1', 'waiting')]))
    expect(w.calls.kill).toEqual(['p1'])
  })

  it('missing or transiently lost predecessor is not marked ended', async () => {
    const w = world(req())
    const r = createRetireRunner(w.deps)
    await r.consume(w.snap([]))
    w.advance(5000)
    const lost = w.snap([w.view('p1', 'exited', 'lost')])
    await r.consume(lost)
    await r.consume(lost)
    expect(w.calls.ended).toEqual([])
    w.advance(5000)
    await r.consume(w.snap([w.view('p1', 'working')]))
    w.advance(5000)
    await r.consume(w.snap([w.view('p1', 'exited', 'lost')]))
    expect(w.calls.ended).toEqual([])
    w.advance(5000)
    await r.consume(w.snap([w.view('p1', 'exited', 'lost')]))
    expect(w.calls.ended).toEqual(['p1'])
    expect(w.calls.kill).toEqual([])
  })

  it('a trusted harness whose children probe throws waits', async () => {
    const w = world(req())
    w.deps.children = async () => { throw new Error('proc unavailable') }
    const r = createRetireRunner(w.deps)
    await r.consume(w.snap([w.view('p1', 'waiting')]))
    w.advance(10_000)
    await r.consume(w.snap([w.view('p1', 'waiting')]))
    expect(w.calls.kill).toEqual([])
  })
})

describe('retire final activity poll failures', () => {
  it('an unavailable final poll blocks the kill', async () => {
    const w = world(req())
    const r = createRetireRunner(w.deps)
    await r.consume(w.snap([w.view('p1', 'waiting')]))
    w.advance(10_000)
    w.setFresh(w.snap([w.view('p1', 'waiting')], 'backend unavailable'))
    await r.consume(w.snap([w.view('p1', 'waiting')]))
    expect(w.calls.kill).toEqual([])
    expect(w.rows[0]!.retire).toBeDefined()
  })
  it('a deadline reached while refreshing activity never kills', async () => {
    const w = world(req())
    const r = createRetireRunner(w.deps)
    await r.consume(w.snap([w.view('p1', 'waiting')]))
    w.advance(10_000)
    w.deps.readFresh = async () => {
      w.advance(50_000)
      return w.snap([w.view('p1', 'waiting')])
    }
    await r.consume(w.snap([w.view('p1', 'waiting')]))
    expect(w.calls.kill).toEqual([])
    expect(w.calls.ended).toEqual([])
  })
})

describe('retire stopped-row confirmation', () => {
  it('a terminal row whose fresh poll is running is not filed ended', async () => {
    const w = world(req())
    w.setFresh(w.snap([w.view('p1', 'working')]))
    const r = createRetireRunner(w.deps)
    await r.consume(w.snap([w.view('p1', 'exited', 'exited')]))
    expect(w.calls.ended).toEqual([])
    expect(w.rows[0]!.retire).toBeDefined()
  })
  it('a successor that dies during the final activity refresh prevents a kill', async () => {
    const w = world(req({ successorId: 's1' }))
    const r = createRetireRunner(w.deps)
    await r.consume(w.snap([w.view('p1', 'waiting'), w.view('s1', 'working')]))
    w.advance(10_000)
    w.setFresh(w.snap([w.view('p1', 'waiting'), w.view('s1', 'exited', 'exited')]))
    await r.consume(w.snap([w.view('p1', 'waiting'), w.view('s1', 'working')]))
    expect(w.calls.kill).toEqual([])
    expect(w.calls.ended).toEqual([])
  })
})


describe('retire full transcript probe', () => {
  for (const outstanding of [false, true]) {
    it(`900 turns with ${outstanding ? 'one old outstanding task returns 1' : 'no outstanding task returns 0'}`, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'retire-full-bg-'))
      try {
        const file = join(dir, 'chat.jsonl')
        const lines: unknown[] = outstanding ? [
          { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'old-bg', name: 'Bash', input: { command: 'sleep 600', run_in_background: true } }] } },
          { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'old-bg', content: 'Command running in background with ID: old-shell' }] } },
        ] : []
        lines.push(...Array.from({ length: 900 }, (_, i) => ({ type: 'user', message: { role: 'user', content: `turn ${i}` } })))
        await writeFile(file, lines.map(line => JSON.stringify(line)).join('\n') + '\n')
        expect((await readChatWindow(file, 400)).older).toBe(true)
        const row = world(req()).rows[0]!
        const count = await readRetireBgTasks(row, { ...HARNESS_TRANSCRIPTS, claude: {
          resolve: async () => file,
          read: (p, max, opts) => {
            expect(opts?.maxBytes).toBe(RETIRE_TRANSCRIPT_MAX_BYTES)
            return readChatWindow(p, max, opts)
          },
          readRecent: async () => { throw new Error('must read complete history') },
        } })
        expect(count).toBe(outstanding ? 1 : 0)
      } finally { await rm(dir, { recursive: true, force: true }) }
    })
  }

  it('a real read failure remains unknown rather than reporting zero', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'retire-unreadable-'))
    try {
      expect(await readRetireBgTasks(world(req()).rows[0]!, { ...HARNESS_TRANSCRIPTS, claude: {
        resolve: async () => join(dir, 'missing.jsonl'), read: readChatWindow,
        readRecent: async () => { throw new Error('must read complete history') },
      } })).toBeNull()
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})

describe('retire absent predecessor confirmation', () => {
  for (const harness of HARNESS_ORDER) {
    it(`${harness}: only two distinct missing polls past grace mark ended without a kill`, async () => {
      const w = world(req())
      w.rows[0]!.harness = harness
      const r = createRetireRunner(w.deps)
      await r.consume(w.snap([]))
      w.advance(5000)
      await r.consume(w.snap([]))
      expect(w.calls.ended).toEqual([]) // two misses inside grace are still unknown
      w.advance(PREDECESSOR_GRACE_MS)
      const first = w.snap([])
      await r.consume(first)
      await r.consume(first)
      expect(w.calls.ended).toEqual([]) // one distinct missing poll still waits
      expect(w.rows[0]!.retire).toBeDefined()
      w.advance(5000)
      await r.consume(w.snap([]))
      expect(w.calls.ended).toEqual(['p1'])
      expect(w.calls.kill).toEqual([])
      expect(w.calls.filed).toEqual(['fin:p1'])
      expect(w.rows[0]!.retire).toBeUndefined()
    })
  }

  it('a reappearing predecessor breaks the missing streak', async () => {
    const w = world(req())
    const r = createRetireRunner(w.deps)
    w.advance(PREDECESSOR_GRACE_MS + 1)
    await r.consume(w.snap([]))
    w.advance(5000)
    await r.consume(w.snap([w.view('p1', 'working')]))
    w.advance(5000)
    await r.consume(w.snap([]))
    expect(w.calls.ended).toEqual([])
    expect(w.calls.kill).toEqual([])
  })

  for (const unavailable of [false, true]) {
    it(`a final ${unavailable ? 'unavailable' : 'running'} snapshot blocks ending an absent row`, async () => {
      const w = world(req())
      const r = createRetireRunner(w.deps)
      w.advance(PREDECESSOR_GRACE_MS + 1)
      await r.consume(w.snap([]))
      w.advance(5000)
      w.setFresh(w.snap(unavailable ? [] : [w.view('p1', 'working')], unavailable ? 'failed' : undefined))
      await r.consume(w.snap([]))
      expect(w.calls.ended).toEqual([])
      expect(w.calls.kill).toEqual([])
      expect(w.rows[0]!.retire).toBeDefined()
    })
  }
})

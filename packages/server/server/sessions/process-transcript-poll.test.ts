/**
 * The process-transcript link through the POLL and the dense SAMPLER, for codex and kimi — with the
 * real table rules (`HARNESS_PROCESS_TRANSCRIPTS`) and the real `readProcessConversation`, and only
 * the `/proc` walk faked. These are the shapes P-17 is about: several rows of one harness in ONE
 * folder (where first sighting refuses), a codex whose shim and native binary are both reported as
 * processes, and two processes on one conversation.
 */
import { describe, expect, it } from 'bun:test'
import type { HarnessId } from '@agentistics/core'
import type { HarnessProcess } from '../live-sessions'
import { readProcessConversation, type ProcessTranscriptFile } from './process-conversation'
import { createSessionsPoller, sampleProcessLinks } from './sessions-host'
import type { BackendSession, ManagedSession, SessionBackend } from './types'

const NOW = 1_786_600_000_000
const C1 = '01a11e81-0c02-7cf3-a018-28fb54626ec3'
const C2 = '01a11e79-2f13-7930-8c58-5f46d81bb68c'
const C3 = '01a11e4f-3fd6-7442-a59a-274a6216964c'
const K1 = 'aeab20b9-e2c1-43ae-b9df-273b92a61eb8'
const K2 = 'c91522ee-e891-41bf-95d6-a9ac674f5107'
const rollout = (id: string) => `/home/u/.codex/sessions/2026/10/08/rollout-2026-10-08T23-32-16-${id}.jsonl`
const lock = (id: string) => `/home/u/.codex/thread-writer-locks/${id}.lock`
const wire = (id: string) => `/home/u/.kimi-code/sessions/wd_proj_75aa5a88acd1/session_${id}/agents/main/wire.jsonl`

const managed = (id: string, harness: HarnessId, over: Partial<ManagedSession> = {}): ManagedSession => ({
  id, harness, cwd: '/repo/one-folder', createdAt: new Date(NOW - 60_000).toISOString(), ...over,
})
const backendSession = (id: string): BackendSession => ({
  id, createdMs: NOW - 60_000, attached: false, alive: true, lastActivityMs: NOW - 30_000,
})
function backend(ids: string[], panePids: Record<string, number>): SessionBackend {
  return {
    id: 'tmux',
    async unavailable() { return undefined },
    async spawn() {},
    async list() { return ids.map(backendSession) },
    async capture() { return ['x'] },
    async captureTerminal() { return { lines: ['x'], info: { cols: 80, rows: 1, cursorX: 0, cursorY: 0, alive: true, historySize: 0 } } },
    async kill() { return true },
    attachCommand(id) { return ['tmux', 'attach', id] },
    async detachHint() { return 'Ctrl-b then d' },
    async sendText() { return true },
    async sendTextRaw() { return true },
    async sendKey() { return true },
    async sendPaste() { return true },
    async listPanePids() { return new Map(Object.entries(panePids)) },
  }
}

async function pollOnce(o: {
  rows: ManagedSession[]
  panePids: Record<string, number>
  procs?: HarnessProcess[]
  /** The faked `/proc` walk: asked pid -> the file its holder has open. */
  resolve: (harness: HarnessId, pid: number) => ProcessTranscriptFile | null
}): Promise<Array<[string, string, string, string | undefined]>> {
  const calls: Array<[string, string, string, string | undefined]> = []
  const p = createSessionsPoller({
    backend: backend(o.rows.map(r => r.id), o.panePids),
    readRegistry: async () => o.rows,
    scanProcesses: async () => ({ procs: o.procs ?? [] }),
    now: () => NOW,
    resolveProcessLog: async (h, pid) => o.resolve(h, pid),
    readProcessConversation,
    recordConversation: async (id, cid, link, via) => { calls.push([id, cid, link, via]) },
  })
  await p.poll()
  return calls.sort()
}

describe('poll: codex rows linked by the file their own process holds', () => {
  it('links THREE codex rows in ONE folder, each to its own thread — where first sighting refuses', async () => {
    const files: Record<number, ProcessTranscriptFile> = {
      101: { file: rollout(C1), holder: 1101 },
      102: { file: lock(C2), holder: 1102 }, // no first message yet: only the lock exists
      103: { file: rollout(C3), holder: 1103 },
    }
    const calls = await pollOnce({
      rows: [managed('a', 'codex'), managed('b', 'codex'), managed('c', 'codex')],
      panePids: { a: 101, b: 102, c: 103 },
      resolve: (_h, pid) => files[pid] ?? null,
    })
    expect(calls).toEqual([
      ['a', C1, 'assigned', 'process-log'],
      ['b', C2, 'assigned', 'process-log'],
      ['c', C3, 'assigned', 'process-log'],
    ])
  })

  it('is not fooled by the shim and the native binary both being reported — one holder, one link', async () => {
    // `scanProcesses` reports the node shim (the pane pid, 101) AND the native codex (1101); both
    // walk to the same holder. Keyed by the asked pid this was a self-collision that never linked.
    const calls = await pollOnce({
      rows: [managed('a', 'codex')],
      panePids: { a: 101 },
      procs: [
        { harness: 'codex', cwd: '/repo/one-folder', pid: 101 },
        { harness: 'codex', cwd: '/repo/one-folder', pid: 1101 },
      ],
      resolve: () => ({ file: rollout(C1), holder: 1101 }),
    })
    expect(calls).toEqual([['a', C1, 'assigned', 'process-log']])
  })

  it('links NEITHER of two rows whose processes hold one thread (`codex resume` twice)', async () => {
    const calls = await pollOnce({
      rows: [managed('a', 'codex'), managed('b', 'codex')],
      panePids: { a: 101, b: 102 },
      // Different holders; one holds the lock, the other the rollout — the same conversation.
      resolve: (_h, pid) => (pid === 101 ? { file: rollout(C1), holder: 1101 } : { file: lock(C1), holder: 1102 }),
    })
    expect(calls).toEqual([])
  })

  it('refuses a row whose thread is also held by a codex agentop never started', async () => {
    const calls = await pollOnce({
      rows: [managed('a', 'codex')],
      panePids: { a: 101 },
      procs: [{ harness: 'codex', cwd: '/elsewhere', pid: 999 }],
      resolve: (_h, pid) => ({ file: rollout(C1), holder: pid === 999 ? 999 : 1101 }),
    })
    expect(calls).toEqual([])
  })

  it('re-links a process-linked row when its process moves to a NEW thread (/new)', async () => {
    const calls = await pollOnce({
      rows: [managed('a', 'codex', { conversationId: C1, conversationLinkVia: 'process-log' })],
      panePids: { a: 101 },
      resolve: () => ({ file: rollout(C2), holder: 1101 }),
    })
    expect(calls).toEqual([['a', C2, 'assigned', 'process-log']])
  })

  it('AGY.RELINK: a row REOPENED by id follows its own process to the new thread (/new)', async () => {
    const calls = await pollOnce({
      rows: [managed('a', 'codex', { conversationId: C1, conversationLinkVia: 'resumed-id' })],
      panePids: { a: 101 },
      resolve: () => ({ file: rollout(C2), holder: 1101 }),
    })
    expect(calls).toEqual([['a', C2, 'assigned', 'process-log']])
  })

  it('a reopened row whose process still holds the reopened thread writes nothing', async () => {
    const calls = await pollOnce({
      rows: [managed('a', 'codex', { conversationId: C1, conversationLinkVia: 'resumed-id' })],
      panePids: { a: 101 },
      resolve: () => ({ file: rollout(C1), holder: 1101 }),
    })
    expect(calls).toEqual([])
  })

  it('a reopened row is NOT moved while its process holds two threads (the /resume picker reading)', async () => {
    const calls = await pollOnce({
      rows: [managed('a', 'codex', { conversationId: C1, conversationLinkVia: 'resumed-id' })],
      panePids: { a: 101 },
      // `fileFromFds` refuses two threads, so the resolved file is null.
      resolve: () => null,
    })
    expect(calls).toEqual([])
  })

  it('COLLISION: a reopened row is not moved onto a thread another LIVE row drives', async () => {
    const calls = await pollOnce({
      rows: [
        managed('a', 'codex', { conversationId: C1, conversationLinkVia: 'resumed-id' }),
        managed('b', 'codex', { conversationId: C2, conversationLinkVia: 'process-log' }),
      ],
      panePids: { a: 101, b: 102 },
      // b's process is between writes on its thread; a's process now holds b's thread.
      resolve: (_h, pid) => (pid === 101 ? { file: rollout(C2), holder: 1101 } : null),
    })
    expect(calls).toEqual([])
  })

  it('COLLISION: two holders on the new thread -> the reopened row does not move', async () => {
    const calls = await pollOnce({
      rows: [managed('a', 'codex', { conversationId: C1, conversationLinkVia: 'resumed-id' })],
      panePids: { a: 101 },
      procs: [{ harness: 'codex', cwd: '/elsewhere', pid: 999 }],
      resolve: (_h, pid) => ({ file: rollout(C2), holder: pid === 999 ? 999 : 1101 }),
    })
    expect(calls).toEqual([])
  })
})

describe('poll: kimi rows', () => {
  it('links a kimi row the moment a poll catches its process writing', async () => {
    const calls = await pollOnce({
      rows: [managed('k', 'kimi')],
      panePids: { k: 201 },
      resolve: () => ({ file: wire(K1), holder: 201 }),
    })
    expect(calls).toEqual([['k', K1, 'assigned', 'process-log']])
  })

  it('AGY.RELINK: a reopened kimi row a poll catches writing a NEW session is re-linked', async () => {
    const calls = await pollOnce({
      rows: [managed('k', 'kimi', { conversationId: K1, conversationLinkVia: 'resumed-id' })],
      panePids: { k: 201 },
      resolve: () => ({ file: wire(K2), holder: 201 }),
    })
    expect(calls).toEqual([['k', K2, 'assigned', 'process-log']])
  })

  it('writes nothing for gemini or opencode, which have no process-transcript route', async () => {
    const calls = await pollOnce({
      rows: [managed('g', 'gemini'), managed('o', 'opencode')],
      panePids: { g: 301, o: 302 },
      resolve: () => ({ file: wire(K1), holder: 9 }),
    })
    expect(calls).toEqual([])
  })
})

describe('sampleProcessLinks — the dense sampler for a harness that holds its file only while writing', () => {
  /** A fake clock the sampler's own sleep advances. */
  function clock() {
    let t = NOW
    return { now: () => t, sleep: async (ms: number) => { t += ms } }
  }

  it('links three kimi rows in one folder as each one is caught writing, then stops', async () => {
    const c = clock()
    let registry = [managed('k1', 'kimi'), managed('k2', 'kimi'), managed('k3', 'kimi')]
    const pids: Record<string, number> = { k1: 201, k2: 202, k3: 203 }
    // Each process opens its wire for a single tick at a different moment — 10–300 ms in reality.
    const openAt: Record<number, [number, string]> = { 201: [300, K1], 202: [700, K2], 203: [1500, C3] }
    const calls: Array<[string, string]> = []
    const writes = await sampleProcessLinks({
      harness: 'kimi',
      readRegistry: async () => registry,
      listPanePids: async () => new Map(Object.entries(pids)),
      resolveProcessLog: async (_h, pid) => {
        const [at, id] = openAt[pid]!
        return c.now() - NOW === at ? { file: wire(id), holder: pid } : null
      },
      readProcessConversation,
      recordConversation: async (id, cid) => {
        calls.push([id, cid])
        registry = registry.map(r => (r.id === id ? { ...r, conversationId: cid } : r))
      },
      deadline: () => NOW + 10_000,
      intervalMs: 100,
      refreshMs: 0,
      now: c.now,
      sleep: c.sleep,
    })
    expect(writes).toBe(3)
    expect(calls).toEqual([['k1', K1], ['k2', K2], ['k3', C3]])
    // It stopped as soon as nothing was left to link, long before the deadline.
    expect(c.now() - NOW).toBeLessThan(2_000)
  })

  it('refuses while two holders are seen on one session, and stops at the deadline', async () => {
    const c = clock()
    const calls: unknown[] = []
    const writes = await sampleProcessLinks({
      harness: 'kimi',
      readRegistry: async () => [managed('k1', 'kimi')],
      listPanePids: async () => new Map([['k1', 201]]),
      otherPids: [999], // a kimi resumed by hand on the same session
      resolveProcessLog: async (_h, pid) => ({ file: wire(K1), holder: pid }),
      readProcessConversation,
      recordConversation: async (...a) => { calls.push(a) },
      deadline: () => NOW + 1_000,
      intervalMs: 100,
      now: c.now,
      sleep: c.sleep,
    })
    expect(writes).toBe(0)
    expect(calls).toEqual([])
    expect(c.now() - NOW).toBeGreaterThanOrEqual(1_000)
  })

  it('does nothing at all when no row of the harness is waiting for a link', async () => {
    const c = clock()
    let asked = 0
    const writes = await sampleProcessLinks({
      harness: 'kimi',
      readRegistry: async () => [managed('k1', 'kimi', { conversationId: K1 }), managed('c1', 'codex')],
      listPanePids: async () => new Map([['k1', 201], ['c1', 101]]),
      resolveProcessLog: async () => { asked++; return null },
      readProcessConversation,
      recordConversation: async () => undefined,
      deadline: () => NOW + 5_000,
      intervalMs: 100,
      now: c.now,
      sleep: c.sleep,
    })
    expect(writes).toBe(0)
    expect(asked).toBe(0)
  })

  it('asks only the rows it was given when `onlyIds` is set (a freshly spawned row)', async () => {
    const c = clock()
    const asked = new Set<number>()
    await sampleProcessLinks({
      harness: 'kimi',
      readRegistry: async () => [managed('k1', 'kimi'), managed('k2', 'kimi')],
      listPanePids: async () => new Map([['k1', 201], ['k2', 202]]),
      resolveProcessLog: async (_h, pid) => { asked.add(pid); return null },
      readProcessConversation,
      recordConversation: async () => undefined,
      deadline: () => NOW + 300,
      intervalMs: 100,
      onlyIds: new Set(['k2']),
      now: c.now,
      sleep: c.sleep,
    })
    expect([...asked]).toEqual([202])
  })

  it('AGY.RELINK: with `follow`, a REOPENED kimi row is caught writing its new session and moved', async () => {
    const c = clock()
    let registry = [managed('k1', 'kimi', { conversationId: K1, conversationLinkVia: 'resumed-id' })]
    const calls: Array<[string, string]> = []
    const writes = await sampleProcessLinks({
      harness: 'kimi',
      readRegistry: async () => registry,
      listPanePids: async () => new Map([['k1', 201]]),
      // Writes its OLD session first (no move), then the /new one for a single tick.
      resolveProcessLog: async (_h, pid) => {
        const t = c.now() - NOW
        return t === 200 ? { file: wire(K1), holder: pid } : t === 600 ? { file: wire(K2), holder: pid } : null
      },
      readProcessConversation,
      recordConversation: async (id, cid) => {
        calls.push([id, cid])
        registry = registry.map(r => (r.id === id ? { ...r, conversationId: cid, conversationLinkVia: 'process-log' } : r))
      },
      deadline: () => NOW + 1_000,
      intervalMs: 100,
      refreshMs: 0,
      follow: true,
      now: c.now,
      sleep: c.sleep,
    })
    expect(writes).toBe(1)
    expect(calls).toEqual([['k1', K2]])
  })

  it('without `follow` (a spawn\'s own run) a linked row is not asked at all', async () => {
    const c = clock()
    let asked = 0
    await sampleProcessLinks({
      harness: 'kimi',
      readRegistry: async () => [managed('k1', 'kimi', { conversationId: K1, conversationLinkVia: 'resumed-id' })],
      listPanePids: async () => new Map([['k1', 201]]),
      resolveProcessLog: async () => { asked++; return null },
      readProcessConversation,
      recordConversation: async () => undefined,
      deadline: () => NOW + 1_000,
      intervalMs: 100,
      now: c.now,
      sleep: c.sleep,
    })
    expect(asked).toBe(0)
  })

  it('with `follow`, COLLISION: a reopened kimi row is not moved onto a session another live row drives', async () => {
    const c = clock()
    const calls: unknown[] = []
    await sampleProcessLinks({
      harness: 'kimi',
      readRegistry: async () => [
        managed('k1', 'kimi', { conversationId: K1, conversationLinkVia: 'resumed-id' }),
        managed('k2', 'kimi', { conversationId: K2, conversationLinkVia: 'process-log' }),
      ],
      listPanePids: async () => new Map([['k1', 201], ['k2', 202]]),
      resolveProcessLog: async (_h, pid) => (pid === 201 ? { file: wire(K2), holder: pid } : null),
      readProcessConversation,
      recordConversation: async (...a) => { calls.push(a) },
      deadline: () => NOW + 500,
      intervalMs: 100,
      follow: true,
      now: c.now,
      sleep: c.sleep,
    })
    expect(calls).toEqual([])
  })
})

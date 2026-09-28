import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decideLeaseAcquire, MAX_MESSAGES_WINDOW, type LeaseHolder, type SessionRecord, type SessionStore } from './types.ts'
import { openSqliteSessionStore } from './sqlite-store.ts'

let dir: string
let store: SessionStore

function fixtureSession(sessionId: string, createdAt: string): SessionRecord {
  return {
    sessionId,
    createdAt,
    updatedAt: createdAt,
    status: 'open',
    workspaceRoot: '/ws',
    cwd: '/ws',
    provider: 'anthropic',
    model: 'claude-test',
    credential: { provider: 'anthropic', id: 'cred_1' },
    messageCount: 0,
    lastSeq: 0,
    runCount: 0,
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agt-b4-store-'))
  store = openSqliteSessionStore(join(dir, 'sessions.db'))
})

afterEach(async () => {
  store.close()
  await rm(dir, { recursive: true, force: true })
})

describe('session store — sessions', () => {
  test('create, get, update round trip', async () => {
    await store.createSession(fixtureSession('ses_a', '2026-09-27T00:00:00.000Z'))
    const got = await store.getSession('ses_a')
    expect(got?.status).toBe('open')
    expect(got?.credential).toEqual({ provider: 'anthropic', id: 'cred_1' })

    await store.updateSession('ses_a', { status: 'ended', title: 'Renamed' })
    const after = await store.getSession('ses_a')
    expect(after?.status).toBe('ended')
    expect(after?.title).toBe('Renamed')
  })

  test('getSession on an unknown id is null, never a throw', async () => {
    expect(await store.getSession('ses_missing')).toBeNull()
  })

  test('listSessions is paged, newest first, and the cursor never repeats or skips a row', async () => {
    for (let i = 0; i < 5; i++) {
      await store.createSession(fixtureSession(`ses_${i}`, `2026-09-27T00:00:0${i}.000Z`))
    }
    const page1 = await store.listSessions({ limit: 2 })
    expect(page1.sessions.map(s => s.sessionId)).toEqual(['ses_4', 'ses_3'])
    expect(page1.nextBefore).toBeDefined()

    const page2 = await store.listSessions({ limit: 2, before: page1.nextBefore })
    expect(page2.sessions.map(s => s.sessionId)).toEqual(['ses_2', 'ses_1'])
    expect(page2.nextBefore).toBeDefined()

    const page3 = await store.listSessions({ limit: 2, before: page2.nextBefore })
    expect(page3.sessions.map(s => s.sessionId)).toEqual(['ses_0'])
    expect(page3.nextBefore).toBeUndefined()
  })
})

describe('session store — messages: window, cursor, clamp', () => {
  beforeEach(async () => {
    await store.createSession(fixtureSession('ses_w', '2026-09-27T00:00:00.000Z'))
  })

  test('appendMessage assigns a dense, 1-based seq and bumps the session counters', async () => {
    const m1 = await store.appendMessage({ sessionId: 'ses_w', runId: 'run_1', role: 'user', content: { sha256: 'a'.repeat(64), bytes: 3 }, createdAt: '2026-09-27T00:00:01.000Z' })
    expect(m1.seq).toBe(1)
    const m2 = await store.appendMessage({ sessionId: 'ses_w', runId: 'run_1', role: 'assistant', content: { sha256: 'b'.repeat(64), bytes: 4 }, createdAt: '2026-09-27T00:00:02.000Z' })
    expect(m2.seq).toBe(2)
    const session = await store.getSession('ses_w')
    expect(session?.lastSeq).toBe(2)
    expect(session?.messageCount).toBe(2)
  })

  test('dense seq holds under several appends fired without awaiting each other', async () => {
    const N = 20
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        store.appendMessage({
          sessionId: 'ses_w', runId: 'run_1', role: i % 2 === 0 ? 'user' : 'assistant',
          content: { sha256: i.toString().padStart(64, '0'), bytes: 1 }, createdAt: '2026-09-27T00:00:01.000Z',
        })),
    )
    const seqs = results.map(r => r.seq).sort((a, b) => a - b)
    expect(seqs).toEqual(Array.from({ length: N }, (_, i) => i + 1))
    const session = await store.getSession('ses_w')
    expect(session?.lastSeq).toBe(N)
    expect(session?.messageCount).toBe(N)
  })

  test('listMessages returns the newest window, ascending, with a cursor for the rest', async () => {
    for (let i = 1; i <= 5; i++) {
      await store.appendMessage({ sessionId: 'ses_w', runId: 'run_1', role: 'user', content: { sha256: i.toString().padStart(64, '0'), bytes: 1 }, createdAt: '2026-09-27T00:00:00.000Z' })
    }
    const page1 = await store.listMessages('ses_w', { limit: 2 })
    expect(page1.messages.map(m => m.seq)).toEqual([4, 5])
    expect(page1.nextBefore).toBe(4)

    const page2 = await store.listMessages('ses_w', { before: page1.nextBefore, limit: 2 })
    expect(page2.messages.map(m => m.seq)).toEqual([2, 3])
    expect(page2.nextBefore).toBe(2)

    const page3 = await store.listMessages('ses_w', { before: page2.nextBefore, limit: 2 })
    expect(page3.messages.map(m => m.seq)).toEqual([1])
    expect(page3.nextBefore).toBeUndefined()
  })

  test('limit is clamped to MAX_MESSAGES_WINDOW, never unbounded', async () => {
    for (let i = 1; i <= 3; i++) {
      await store.appendMessage({ sessionId: 'ses_w', runId: 'run_1', role: 'user', content: { sha256: i.toString().padStart(64, '0'), bytes: 1 }, createdAt: '2026-09-27T00:00:00.000Z' })
    }
    const page = await store.listMessages('ses_w', { limit: MAX_MESSAGES_WINDOW * 10 })
    expect(page.messages).toHaveLength(3)
    // A non-positive or absent limit reads as the default, never zero and never everything.
    const withZero = await store.listMessages('ses_w', { limit: 0 })
    expect(withZero.messages.length).toBeGreaterThan(0)
  })

  test('there is no method that returns a whole history', () => {
    // Structural: `SessionStore` has exactly the windowed reads.
    expect(typeof (store as unknown as { listAllMessages?: unknown }).listAllMessages).toBe('undefined')
  })
})

describe('session store — runs and tool calls', () => {
  beforeEach(async () => {
    await store.createSession(fixtureSession('ses_r', '2026-09-27T00:00:00.000Z'))
  })

  test('createRun bumps the session run count and lastRunId', async () => {
    await store.createRun({ runId: 'run_1', sessionId: 'ses_r', startedAt: '2026-09-27T00:00:01.000Z', status: 'running', turns: 0, toolCalls: 0 })
    const session = await store.getSession('ses_r')
    expect(session?.runCount).toBe(1)
    expect(session?.lastRunId).toBe('run_1')

    await store.updateRun('run_1', { status: 'completed', stop: 'end-turn', sentence: 'done', turns: 3, toolCalls: 1, endedAt: '2026-09-27T00:01:00.000Z' })
    const run = await store.getRun('run_1')
    expect(run?.status).toBe('completed')
    expect(run?.stop).toBe('end-turn')
    expect(run?.endedAt).toBe('2026-09-27T00:01:00.000Z')

    const latest = await store.latestRun('ses_r')
    expect(latest?.runId).toBe('run_1')
  })

  test('a tool call is upserted by (runId, toolExecutionId): started, then settled, never two rows', async () => {
    await store.createRun({ runId: 'run_tc', sessionId: 'ses_r', startedAt: '2026-09-27T00:00:01.000Z', status: 'running', turns: 0, toolCalls: 0 })
    await store.recordToolCall({ runId: 'run_tc', toolExecutionId: 'tx_1', toolUseId: 'tu_1', name: 'file__read', state: 'started' })
    let calls = await store.listToolCalls('run_tc')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.state).toBe('started')
    expect(calls[0]?.result).toBeUndefined()

    await store.recordToolCall({
      runId: 'run_tc', toolExecutionId: 'tx_1', toolUseId: 'tu_1', name: 'file__read', state: 'settled',
      result: { sha256: 'c'.repeat(64), bytes: 9 }, isError: false,
    })
    calls = await store.listToolCalls('run_tc')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.state).toBe('settled')
    expect(calls[0]?.result).toEqual({ sha256: 'c'.repeat(64), bytes: 9 })
    expect(calls[0]?.isError).toBe(false)
  })
})

describe('session store — attachments', () => {
  test('round trip', async () => {
    await store.createSession(fixtureSession('ses_at', '2026-09-27T00:00:00.000Z'))
    await store.addAttachment({ sessionId: 'ses_at', storageId: 'st_1', mime: 'image/png', size: 100, sha256: 'd'.repeat(64), createdAt: '2026-09-27T00:00:01.000Z' })
    const all = await store.listAttachments('ses_at')
    expect(all).toHaveLength(1)
    expect(all[0]?.storageId).toBe('st_1')
  })
})

describe('session store — leases', () => {
  const holderA: LeaseHolder = { pid: 111, token: 'tok-a' }
  const holderB: LeaseHolder = { pid: 222, token: 'tok-b' }

  beforeEach(async () => {
    await store.createSession(fixtureSession('ses_l', '2026-09-27T00:00:00.000Z'))
  })

  test('a free session is acquired; a second, different, LIVE holder is refused and named', async () => {
    const first = await store.acquireLease('ses_l', holderA, 60_000)
    expect(first.ok).toBe(true)

    const second = await store.acquireLease('ses_l', holderB, 60_000)
    expect(second.ok).toBe(false)
    if (!second.ok) {
      expect(second.reason).toBe('held')
      expect(second.holder).toEqual(holderA)
      expect(second.sentence).toContain('111')
    }
  })

  test('the same holder may re-acquire (a refresh), extending its own lease', async () => {
    const first = await store.acquireLease('ses_l', holderA, 1000)
    expect(first.ok).toBe(true)
    const refreshed = await store.refreshLease('ses_l', holderA, 60_000)
    expect(refreshed.ok).toBe(true)
    if (refreshed.ok) expect(Date.parse(refreshed.lease.expiresAt)).toBeGreaterThan(Date.now() + 30_000)
  })

  test('a STALE holder — expired, or whose pid is not alive — is taken over', async () => {
    await store.acquireLease('ses_l', holderA, -1) // already expired the instant it is written
    const takeover = await store.acquireLease('ses_l', holderB, 60_000)
    expect(takeover.ok).toBe(true)
    if (takeover.ok) expect(takeover.lease.holder).toEqual(holderB)
  })

  test('a dead holder (isAlive says no) is taken over even before its lease expires', async () => {
    const dead = openSqliteSessionStore(join(dir, 'dead.db'), { isAlive: pid => pid !== 111 })
    try {
      await dead.createSession(fixtureSession('ses_dead', '2026-09-27T00:00:00.000Z'))
      const first = await dead.acquireLease('ses_dead', holderA, 60_000)
      expect(first.ok).toBe(true)
      const takeover = await dead.acquireLease('ses_dead', holderB, 60_000)
      expect(takeover.ok).toBe(true)
    } finally {
      dead.close()
    }
  })

  test('releasing frees the lease only for its own holder — a stranger cannot release it', async () => {
    await store.acquireLease('ses_l', holderA, 60_000)
    await store.releaseLease('ses_l', holderB) // not the holder: a no-op
    expect((await store.getLease('ses_l'))?.holder).toEqual(holderA)

    await store.releaseLease('ses_l', holderA)
    expect(await store.getLease('ses_l')).toBeNull()
    const acquired = await store.acquireLease('ses_l', holderB, 60_000)
    expect(acquired.ok).toBe(true)
  })
})

describe('decideLeaseAcquire — pure', () => {
  test('no current lease: always free', () => {
    const r = decideLeaseAcquire('s', null, { pid: 1, token: 't' }, 0, 1000, () => true)
    expect(r.ok).toBe(true)
  })

  test('held by a live, unexpired, different holder: refused, naming the holder', () => {
    const current = { sessionId: 's', holder: { pid: 1, token: 't1' }, expiresAt: new Date(1000).toISOString() }
    const r = decideLeaseAcquire('s', current, { pid: 2, token: 't2' }, 0, 1000, () => true)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.holder).toEqual({ pid: 1, token: 't1' })
  })

  test('expired: free regardless of isAlive', () => {
    const current = { sessionId: 's', holder: { pid: 1, token: 't1' }, expiresAt: new Date(0).toISOString() }
    const r = decideLeaseAcquire('s', current, { pid: 2, token: 't2' }, 500, 1000, () => true)
    expect(r.ok).toBe(true)
  })

  test('same holder asking again (a refresh): free even before expiry', () => {
    const current = { sessionId: 's', holder: { pid: 1, token: 't1' }, expiresAt: new Date(10_000).toISOString() }
    const r = decideLeaseAcquire('s', current, { pid: 1, token: 't1' }, 0, 1000, () => true)
    expect(r.ok).toBe(true)
  })

  test('not expired but the holder is dead: free', () => {
    const current = { sessionId: 's', holder: { pid: 1, token: 't1' }, expiresAt: new Date(10_000).toISOString() }
    const r = decideLeaseAcquire('s', current, { pid: 2, token: 't2' }, 0, 1000, pid => pid !== 1)
    expect(r.ok).toBe(true)
  })
})

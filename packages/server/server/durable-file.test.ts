import { describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { __setAlertSinkForTest, __setDurableOpsForTest, alertQuarantined, bakPath, durableWrite, hasQuarantine, refreshLastGood } from './durable-file'
import { createTaskStore } from './sessions/task-store'
import { createSessionRegistry } from './sessions/registry'
import { ensureLegacyTasks } from './sessions/task-source'
import { accountOfConversation } from './sessions/spawn-account-io'

const dir = () => mkdtemp(join(tmpdir(), 'agentop-durable-'))
const NUL = (n: number) => Buffer.alloc(n, 0)
const task = (id: string) => ({ id, title: id, status: 'todo', createdAt: '2026-11-22T00:00:00.000Z', updatedAt: '2026-11-22T00:00:00.000Z' }) as never

describe('durableWrite / last good copy', () => {
  it('writes, leaves no temp file, and refreshes the .bak only when stale', async () => {
    const d = await dir(); const f = join(d, 'x.json')
    await durableWrite(f, '{"a":1}')
    expect(await refreshLastGood(f, '{"a":1}')).toBe(true)
    expect(await refreshLastGood(f, '{"a":2}')).toBe(false) // fresh: not doubled again
    await utimes(bakPath(f), new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000))
    expect(await refreshLastGood(f, '{"a":2}')).toBe(true)
    expect(await readFile(bakPath(f), 'utf8')).toBe('{"a":2}')
    expect((await readdir(d)).filter(n => n.includes('.tmp.'))).toEqual([])
  })
})

describe('board survives a zero-filled tasks.json', () => {
  it('loads the last good copy, quarantines the bytes, and keeps legacy import off', async () => {
    const d = await dir(); const f = join(d, 'tasks.json')
    const s = createTaskStore(f)
    await s.upsertTask(task('t1'))
    await writeFile(f, NUL(4096)) // the disk fault: original size, all NUL
    const s2 = createTaskStore(f)
    expect((await s2.read()).tasks.map(t => t.id)).toEqual(['t1'])
    await s2.upsertTask(task('t2'))
    expect((await readdir(d)).some(n => n.startsWith('tasks.json.corrupt-'))).toBe(true)
    expect((await createTaskStore(f).read()).tasks.map(t => t.id).sort()).toEqual(['t1', 't2'])
    expect(await s2.wasQuarantined()).toBe(true)
    expect(await hasQuarantine(join(await dir(), 'tasks.json'))).toBe(false)
  })
  it('falls back to empty only when no good copy parses', async () => {
    const d = await dir(); const f = join(d, 'tasks.json')
    await writeFile(f, NUL(64)); await writeFile(bakPath(f), NUL(64))
    expect((await createTaskStore(f).read()).tasks).toEqual([])
  })
})

describe('registry survives a zero-filled managed-sessions.json', () => {
  it('loads the last good copy', async () => {
    const d = await dir(); const f = join(d, 'managed-sessions.json')
    const reg = createSessionRegistry(f)
    await reg.add({ id: 'abc', harness: 'claude', cwd: '/w', createdAt: '2026-11-22T00:00:00.000Z', label: 'keep me' } as never)
    await writeFile(f, NUL(2048))
    const rows = await createSessionRegistry(f).read()
    expect(rows.map(r => r.id)).toEqual(['abc'])
    expect(rows[0]!.label).toBe('keep me')
  })
})

describe('reopen across account roots', () => {
  it('finds the account whose root holds the transcript when the row lost it', async () => {
    const file = { accounts: [{ id: 'acc2', harness: 'claude', root: '/r/two' }, { id: 'acc3', harness: 'claude', root: '/r/three' }] } as never
    const resolve = async (_c: string, _i: string, dir?: string) => (dir === '/r/three/projects' ? '/r/three/projects/x/id.jsonl' : null)
    expect(await accountOfConversation('claude', '/w', 'id', { file, resolve })).toBe('acc3')
    expect(await accountOfConversation('claude', '/w', 'id', { file, resolve: async (_c, _i, d) => (d ? null : '/home/.claude/x') })).toBeUndefined()
    expect(await accountOfConversation('codex', '/w', 'id', { file, resolve })).toBeUndefined()
  })
})

describe('legacy import only on a genuinely fresh install', () => {
  const rows = [{ id: 'm1', harness: 'claude', cwd: '/w', createdAt: '2026-11-22T00:00:00.000Z', task: 'Old Work' }] as never
  it('a quarantined board is NOT refilled with legacy-* items', async () => {
    const d = await dir(); const f = join(d, 'tasks.json')
    await writeFile(`${f}.corrupt-1`, 'x')
    const s = createTaskStore(f)
    expect(await ensureLegacyTasks(s, rows, await s.read())).toBe(false)
    expect((await s.read()).tasks).toEqual([])
  })
  it('a fresh install still imports them', async () => {
    const d = await dir(); const f = join(d, 'tasks.json')
    const s = createTaskStore(f)
    expect(await ensureLegacyTasks(s, rows, await s.read())).toBe(true)
    expect((await s.read()).tasks.some(t => t.id.startsWith('legacy-'))).toBe(true)
  })
})

describe('a quarantine that cannot be set aside aborts the write (board and registry alike)', () => {
  /** Block the `.corrupt-<now>` name with a non-empty directory so the rename onto it fails. */
  async function blocked(f: string, run: () => Promise<unknown>): Promise<void> {
    const realNow = Date.now; const fixed = 1_800_000_000_000
    await mkdir(join(`${f}.corrupt-${fixed}`, 'in'), { recursive: true })
    Date.now = () => fixed
    try { await run() } finally { Date.now = realNow }
  }
  it('board: the bad bytes stay put and the write throws', async () => {
    const d = await dir(); const f = join(d, 'tasks.json')
    await writeFile(f, NUL(64))
    const s = createTaskStore(f)
    await s.read() // marks it corrupt
    await blocked(f, async () => { await expect(s.upsertTask(task('t1'))).rejects.toThrow() })
    expect((await readFile(f)).equals(NUL(64))).toBe(true)
  })
  it('registry: same rule', async () => {
    const d = await dir(); const f = join(d, 'managed-sessions.json')
    await writeFile(f, NUL(64))
    const reg = createSessionRegistry(f)
    await reg.read()
    await blocked(f, async () => { await expect(reg.add({ id: 'a', harness: 'claude', cwd: '/w', createdAt: '2026-11-22T00:00:00.000Z' } as never)).rejects.toThrow() })
    expect((await readFile(f)).equals(NUL(64))).toBe(true)
  })
})

describe('durableWrite order (spied)', () => {
  it('fsyncs the file BEFORE the rename and the directory AFTER it', async () => {
    const d = await dir(); const f = join(d, 's.json'); const log: string[] = []
    const fsp = await import('node:fs/promises')
    __setDurableOpsForTest({
      open: (async (path: string, flags: string) => {
        const fh = await fsp.open(path, flags)
        const sync = fh.sync.bind(fh)
        fh.sync = async () => { log.push(path === d ? 'fsync:dir' : 'fsync:file'); return sync() }
        return fh
      }) as never,
      rename: (async (a: string, b: string) => { log.push('rename'); return fsp.rename(a, b) }) as never,
    })
    try { await durableWrite(f, '{}') } finally { __setDurableOpsForTest(null) }
    expect(log).toEqual(['fsync:file', 'rename', 'fsync:dir'])
  })
})

describe('quarantine alert', () => {
  it('warning when restored, error when not, once per file per process', async () => {
    const seen: Array<{ type: string; message: string }> = []
    __setAlertSinkForTest(n => { seen.push(n) })
    try {
      await alertQuarantined('/x/a.json', true)
      await alertQuarantined('/x/a.json', true)
      await alertQuarantined('/x/b.json', false)
      expect(seen.map(n => n.type)).toEqual(['warning', 'error'])
      expect(seen[0]!.message).toContain('a.json')
      expect(seen[1]!.message).toContain('No good copy')
    } finally { __setAlertSinkForTest(null) }
  })
})

describe('reopen: the NEWEST copy of a conversation wins', () => {
  const file = { accounts: [
    { id: 'B', harness: 'claude', root: '/r/b' }, { id: 'C', harness: 'claude', root: '/r/c' }, { id: 'R', harness: 'claude', root: '/r/r', retired: true },
  ] } as never
  const at: Record<string, number> = {}
  const resolve = async (_c: string, _i: string, d?: string) => { const k = d ?? 'default'; return k in at ? `${k}/x.jsonl` : null }
  const mtime = async (p: string) => at[p.replace('/x.jsonl', '')]!
  const run = (m: Record<string, number>) => { for (const k of Object.keys(at)) delete at[k]; Object.assign(at, m); return accountOfConversation('claude', '/w', 'id', { file, resolve, mtime }) }
  it('id in two roots: the newer one', async () => {
    expect(await run({ '/r/b/projects': 1, '/r/c/projects': 2 })).toBe('C')
    expect(await run({ '/r/b/projects': 3, '/r/c/projects': 2 })).toBe('B')
  })
  it('id in default + account: the switched (newer) copy wins; an older account copy loses to default', async () => {
    expect(await run({ default: 1, '/r/b/projects': 2 })).toBe('B')
    expect(await run({ default: 5, '/r/b/projects': 2 })).toBeUndefined()
  })
  it('id in three roots; a retired account is skipped even when newest', async () => {
    expect(await run({ default: 1, '/r/b/projects': 2, '/r/c/projects': 3 })).toBe('C')
    expect(await run({ '/r/b/projects': 2, '/r/r/projects': 99 })).toBe('B')
  })
})

describe('CLI reopen doors resolve the account through accountForReopen', () => {
  it('both cli-session.ts reopen paths (row reopen, restart) fall back to the transcript root', async () => {
    const src = (await readFile(join(import.meta.dir, 'sessions/cli-session.ts'), 'utf8')).replace(/\/\/.*$/gm, '')
    expect(src).toContain('accountForReopen(m.accountId, m.harness, m.cwd, row.resumeId)')
    expect(src).toContain('accountForReopen(previous?.accountId, live.harness, live.cwd, live.sessionId)')
    expect(src).not.toMatch(/recordedSpawnAccount\(\s*(m|previous\?)\.accountId/)
  })
})

describe('a vanished state file is a loss, not a fresh install', () => {
  const sink: { title: string }[] = []
  const withSink = () => { sink.length = 0; __setAlertSinkForTest(n => { sink.push(n) }) }
  it('registry: 0-byte file with a .bak restores, alerts, quarantines', async () => {
    withSink()
    const d = await dir(); const f = join(d, 'managed-sessions.json')
    await createSessionRegistry(f).add({ id: 'abc', harness: 'claude', cwd: '/w', createdAt: '2026-11-22T00:00:00.000Z', label: 'keep' } as never)
    await writeFile(f, '')
    const reg = createSessionRegistry(f)
    expect((await reg.read()).map(r => r.id)).toEqual(['abc'])
    await reg.add({ id: 'two', harness: 'claude', cwd: '/w', createdAt: '2026-11-22T00:00:00.000Z' } as never)
    expect(await hasQuarantine(f)).toBe(true)
    expect(sink.length).toBe(1)
    expect((await createSessionRegistry(f).read()).map(r => r.id).sort()).toEqual(['abc', 'two'])
  })
  it('registry: MISSING file with a .bak restores and alerts, and the write does not abort', async () => {
    withSink()
    const d = await dir(); const f = join(d, 'managed-sessions.json')
    await createSessionRegistry(f).add({ id: 'abc', harness: 'claude', cwd: '/w', createdAt: '2026-11-22T00:00:00.000Z' } as never)
    await rm(f)
    const reg = createSessionRegistry(f)
    expect((await reg.read()).map(r => r.id)).toEqual(['abc'])
    await reg.add({ id: 'two', harness: 'claude', cwd: '/w', createdAt: '2026-11-22T00:00:00.000Z' } as never)
    expect(sink.length).toBe(1)
  })
  it('registry: fresh install (no file, no .bak) stays empty with no alert', async () => {
    withSink()
    const d = await dir()
    expect(await createSessionRegistry(join(d, 'managed-sessions.json')).read()).toEqual([])
    expect(sink.length).toBe(0)
  })
  it('task board: 0-byte and missing both restore from the .bak; fresh stays silent', async () => {
    withSink()
    const fresh = createTaskStore(join(await dir(), 'tasks.json'))
    expect((await fresh.read()).tasks).toEqual([])
    expect(sink.length).toBe(0)
    for (const vanish of ['empty', 'missing'] as const) {
      withSink()
      const d = await dir(); const f = join(d, 'tasks.json')
      await createTaskStore(f).upsertTask(task('t1'))
      if (vanish === 'empty') await writeFile(f, ''); else await rm(f)
      const s = createTaskStore(f)
      expect((await s.read()).tasks.map(t => t.id)).toEqual(['t1'])
      await s.upsertTask(task('t2'))
      expect(sink.length).toBe(1)
      expect((await createTaskStore(f).read()).tasks.map(t => t.id).sort()).toEqual(['t1', 't2'])
      if (vanish === 'empty') expect(await hasQuarantine(f)).toBe(true)
    }
  })
  it('the .bak is never rotated from an EMPTY state while it holds data', async () => {
    const d = await dir(); const f = join(d, 'x.json')
    await durableWrite(bakPath(f), JSON.stringify([{ a: 1 }, { a: 2 }, { a: 3 }]))
    await utimes(bakPath(f), new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000))
    expect(await refreshLastGood(f, '[]', Date.now(), undefined, true)).toBe(false)
    expect(await readFile(bakPath(f), 'utf8')).toContain('"a": 3'.replace(' ', '')) // data kept
    expect(await refreshLastGood(f, '[1,2,3,4,5,6,7,8]', Date.now(), undefined, false)).toBe(true)
  })
})

describe('stale durable temps are swept', () => {
  it('removes old temps of other pids, keeps ours and fresh ones', async () => {
    const { sweepStaleDurableTmps } = await import('./durable-file')
    const d = await dir()
    const old = new Date(Date.now() - 3_600_000)
    for (const n of ['tasks.json.tmp.999999.1', `tasks.json.tmp.${process.pid}.2`, 'x.json.tmp.999999.3', 'tasks.json']) await writeFile(join(d, n), 'x')
    await utimes(join(d, 'tasks.json.tmp.999999.1'), old, old)
    await utimes(join(d, `tasks.json.tmp.${process.pid}.2`), old, old)
    expect(await sweepStaleDurableTmps(d)).toBe(1)
    expect((await readdir(d)).sort()).toEqual(['tasks.json', `tasks.json.tmp.${process.pid}.2`, 'x.json.tmp.999999.3'].sort())
  })
})

describe('role document temp sweep matches durableWrite names', () => {
  it('removes session-roles.json.tmp.<pid>.<n> and the old forms', async () => {
    const { cleanStaleRoleTmps } = await import('./sessions/session-roles')
    const d = await dir(); const old = new Date(Date.now() - 7_200_000)
    for (const n of ['session-roles.json.tmp.4242.1', 'session-roles.json.4242.tmp', 'session-roles.json']) await writeFile(join(d, n), 'x')
    for (const n of ['session-roles.json.tmp.4242.1', 'session-roles.json.4242.tmp']) await utimes(join(d, n), old, old)
    expect(await cleanStaleRoleTmps(d)).toBe(2)
  })
})

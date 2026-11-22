import { describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readdir, readFile, utimes, writeFile } from 'node:fs/promises'
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

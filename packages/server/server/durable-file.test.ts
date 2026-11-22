import { describe, expect, it } from 'bun:test'
import { mkdtemp, readdir, readFile, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bakPath, durableWrite, hasQuarantine, refreshLastGood } from './durable-file'
import { createTaskStore } from './sessions/task-store'
import { createSessionRegistry } from './sessions/registry'
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

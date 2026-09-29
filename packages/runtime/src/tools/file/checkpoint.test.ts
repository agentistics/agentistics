import { describe, expect, test } from 'bun:test'
import { createCheckpoint, planRestore, type CheckpointEntry, type DiskAccess } from './checkpoint.ts'

function fakeDisk(initial: Record<string, string> = {}): DiskAccess & { files: Map<string, string> } {
  const files = new Map(Object.entries(initial))
  return {
    files,
    async read(path) {
      return files.has(path) ? files.get(path)! : null
    },
    async write(path, content) {
      files.set(path, content)
    },
    async remove(path) {
      files.delete(path)
    },
  }
}

describe('planRestore (pure)', () => {
  test('a single entry per path restores trivially', () => {
    const entries: CheckpointEntry[] = [{ path: '/a', before: 'old', after: 'new', toolExecutionId: 'tx1', at: 't1' }]
    expect(planRestore(entries)).toEqual([{ path: '/a', before: 'old', after: 'new' }])
  })

  test('several entries for one path collapse to first.before / last.after', () => {
    const entries: CheckpointEntry[] = [
      { path: '/a', before: 'v0', after: 'v1', toolExecutionId: 'tx1', at: 't1' },
      { path: '/a', before: 'v1', after: 'v2', toolExecutionId: 'tx2', at: 't2' },
      { path: '/a', before: 'v2', after: 'v3', toolExecutionId: 'tx3', at: 't3' },
    ]
    expect(planRestore(entries)).toEqual([{ path: '/a', before: 'v0', after: 'v3' }])
  })

  test('a rename composes into "recreate the old path, remove the new one"', () => {
    const entries: CheckpointEntry[] = [
      { path: '/old', before: 'content', after: null, toolExecutionId: 'tx1', at: 't1' },
      { path: '/new', before: null, after: 'content', toolExecutionId: 'tx1', at: 't1' },
    ]
    const plan = planRestore(entries)
    expect(plan).toContainEqual({ path: '/old', before: 'content', after: null })
    expect(plan).toContainEqual({ path: '/new', before: null, after: 'content' })
  })
})

describe('Checkpoint.restore', () => {
  test('restores a plain edit back to its previous content', async () => {
    const cp = createCheckpoint()
    await cp.record({ path: '/a', before: 'old', after: 'new', toolExecutionId: 'tx1' })
    const disk = fakeDisk({ '/a': 'new' })
    const out = await cp.restore('tx1', disk)
    expect(out).toEqual({ restored: ['/a'], skipped: [] })
    expect(disk.files.get('/a')).toBe('old')
  })

  test('undoes a creation by deleting the file', async () => {
    const cp = createCheckpoint()
    await cp.record({ path: '/a', before: null, after: 'created', toolExecutionId: 'tx1' })
    const disk = fakeDisk({ '/a': 'created' })
    const out = await cp.restore('tx1', disk)
    expect(out.restored).toEqual(['/a'])
    expect(disk.files.has('/a')).toBe(false)
  })

  test('undoes a deletion by recreating the file', async () => {
    const cp = createCheckpoint()
    await cp.record({ path: '/a', before: 'gone-but-was', after: null, toolExecutionId: 'tx1' })
    const disk = fakeDisk({})
    const out = await cp.restore('tx1', disk)
    expect(out.restored).toEqual(['/a'])
    expect(disk.files.get('/a')).toBe('gone-but-was')
  })

  test('undoes a rename: old path comes back, new path is removed', async () => {
    const cp = createCheckpoint()
    await cp.record({ path: '/old', before: 'content', after: null, toolExecutionId: 'tx1' })
    await cp.record({ path: '/new', before: null, after: 'content', toolExecutionId: 'tx1' })
    const disk = fakeDisk({ '/new': 'content' })
    const out = await cp.restore('tx1', disk)
    expect(out.restored.sort()).toEqual(['/new', '/old'])
    expect(disk.files.has('/new')).toBe(false)
    expect(disk.files.get('/old')).toBe('content')
  })

  test('refuses a file changed since the editor wrote it, and skips it by name, in words', async () => {
    const cp = createCheckpoint()
    await cp.record({ path: '/a', before: 'old', after: 'new', toolExecutionId: 'tx1' })
    const disk = fakeDisk({ '/a': 'someone else edited this' })
    const out = await cp.restore('tx1', disk)
    expect(out.restored).toEqual([])
    expect(out.skipped).toEqual([{ path: '/a', reason: 'the file changed since the editor wrote it' }])
    expect(disk.files.get('/a')).toBe('someone else edited this')
  })

  test('"all" restores across every toolExecutionId, collapsing a path to its very first state', async () => {
    const cp = createCheckpoint()
    await cp.record({ path: '/a', before: 'v0', after: 'v1', toolExecutionId: 'tx1' })
    await cp.record({ path: '/a', before: 'v1', after: 'v2', toolExecutionId: 'tx2' })
    const disk = fakeDisk({ '/a': 'v2' })
    const out = await cp.restore('all', disk)
    expect(out.restored).toEqual(['/a'])
    expect(disk.files.get('/a')).toBe('v0')
  })

  test('a scoped restore ignores entries from a different toolExecutionId', async () => {
    const cp = createCheckpoint()
    await cp.record({ path: '/a', before: 'v0', after: 'v1', toolExecutionId: 'tx1' })
    await cp.record({ path: '/b', before: 'w0', after: 'w1', toolExecutionId: 'tx2' })
    const disk = fakeDisk({ '/a': 'v1', '/b': 'w1' })
    const out = await cp.restore('tx1', disk)
    expect(out.restored).toEqual(['/a'])
    expect(disk.files.get('/b')).toBe('w1') // untouched
  })
})

import { test, expect } from 'bun:test'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises'
import { createLocalTagStore } from './tags-local-store'

// A machine persists tags to ~/.agentistics/tags.json, so the file IS the behaviour under test — it runs against a real
// temp dir, never a mocked filesystem.

function tmpFile(): string {
  return join(tmpdir(), `agentistics-tags-${crypto.randomUUID()}`, 'tags.json')
}

test('starts empty when the file does not exist', async () => {
  const store = createLocalTagStore(tmpFile())
  expect(await store.listAllTags()).toEqual([])
  expect(await store.getTag('nope')).toBeNull()
})

test('create then read round-trips through the file', async () => {
  const file = tmpFile()
  const store = createLocalTagStore(file)
  const doc = await store.createTag({
    name: 'Client X', color: '#f59e0b',
    sources: [{ type: 'repo', value: 'github.com/org/repo' }],
  })
  expect(doc._id).toMatch(/^[0-9a-f]{24}$/)

  // A SECOND store over the same path sees it — proof it went to disk, not just memory.
  const reopened = createLocalTagStore(file)
  const all = await reopened.listAllTags()
  expect(all).toHaveLength(1)
  expect(all[0]!.name).toBe('Client X')
  expect(all[0]!.sources).toEqual([{ type: 'repo', value: 'github.com/org/repo' }])
})

test('update patches only the given fields and bumps updatedAt', async () => {
  const store = createLocalTagStore(tmpFile())
  const doc = await store.createTag({
    name: 'A', color: '#ef4444', sources: [],
  })
  expect(await store.updateTag(doc._id, { name: 'B' })).toBe(true)
  const after = await store.getTag(doc._id)
  expect(after!.name).toBe('B')
  expect(after!.color).toBe('#ef4444')
  expect(after!.createdAt.getTime()).toBe(doc.createdAt.getTime())
  expect(after!.updatedAt.getTime()).toBeGreaterThanOrEqual(doc.updatedAt.getTime())
})

test('update of an unknown id reports false and changes nothing', async () => {
  const store = createLocalTagStore(tmpFile())
  await store.createTag({ name: 'A', sources: [] })
  expect(await store.updateTag('missing', { name: 'B' })).toBe(false)
  expect((await store.listAllTags())[0]!.name).toBe('A')
})

test('delete removes the tag and is idempotent', async () => {
  const file = tmpFile()
  const store = createLocalTagStore(file)
  const doc = await store.createTag({ name: 'A', sources: [] })
  expect(await store.deleteTag(doc._id)).toBe(true)
  expect(await store.deleteTag(doc._id)).toBe(false)
  expect(await createLocalTagStore(file).listAllTags()).toEqual([])
})

test('concurrent creates are serialised — none is lost', async () => {
  const file = tmpFile()
  const store = createLocalTagStore(file)
  await Promise.all(['a', 'b', 'c', 'd', 'e'].map(n =>
    store.createTag({ name: n, sources: [] })))
  const all = await createLocalTagStore(file).listAllTags()
  expect(all.map(t => t.name)).toEqual(['a', 'b', 'c', 'd', 'e'])
})

test('a corrupt file reads as empty instead of throwing, and stays recoverable', async () => {
  const file = tmpFile()
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, '{ this is not json')
  const store = createLocalTagStore(file)
  expect(await store.listAllTags()).toEqual([])
  // The bad bytes are still on disk until something is written, so nothing is silently destroyed.
  expect(await readFile(file, 'utf8')).toBe('{ this is not json')
})

// Regression: reading a corrupt file empty and then writing over it destroyed every tag that was
// still in there. "Create a tag, see an empty list, create another" is exactly that path, so the
// first write after a parse failure must move the original bytes aside rather than replace them.
test('the first write after a parse failure preserves the corrupt bytes in a backup', async () => {
  const file = tmpFile()
  const dir = join(file, '..')
  await mkdir(dir, { recursive: true })
  await writeFile(file, '{ "version": 1, "tags": [ TRUNCATED')

  const store = createLocalTagStore(file)
  expect(await store.listAllTags()).toEqual([])
  await store.createTag({ name: 'New', sources: [] })

  // The new tag landed...
  expect((await createLocalTagStore(file).listAllTags()).map(t => t.name)).toEqual(['New'])
  // ...and the unreadable original survives beside it, byte for byte.
  const backups = (await readdir(dir)).filter(f => f.startsWith('tags.json.corrupt-'))
  expect(backups).toHaveLength(1)
  expect(await readFile(join(dir, backups[0]!), 'utf8')).toBe('{ "version": 1, "tags": [ TRUNCATED')
})

// Regression: a mutation that matched nothing still rewrote the file, which on a corrupt store meant
// a no-op could destroy data. An unknown id must not touch the file at all.
test('update/delete of an unknown id does not rewrite the file', async () => {
  const file = tmpFile()
  const store = createLocalTagStore(file)
  await store.createTag({ name: 'A', sources: [] })

  const before = await stat(file)
  // mtime has 1ms resolution at best; wait so a real write would be visible.
  await new Promise(r => setTimeout(r, 20))
  expect(await store.updateTag('missing', { name: 'B' })).toBe(false)
  expect(await store.deleteTag('missing')).toBe(false)

  const after = await stat(file)
  expect(after.mtimeMs).toBe(before.mtimeMs)
  expect((await createLocalTagStore(file).listAllTags()).map(t => t.name)).toEqual(['A'])
})

// A file that parses but whose `tags` is not a list is unrecognisable too — same protection.
test('a non-array tags field is treated as corrupt and backed up, not overwritten', async () => {
  const file = tmpFile()
  const dir = join(file, '..')
  await mkdir(dir, { recursive: true })
  await writeFile(file, '{"version":1,"tags":"oops"}')

  const store = createLocalTagStore(file)
  expect(await store.listAllTags()).toEqual([])
  await store.createTag({ name: 'New', sources: [] })

  const backups = (await readdir(dir)).filter(f => f.startsWith('tags.json.corrupt-'))
  expect(backups).toHaveLength(1)
  expect(await readFile(join(dir, backups[0]!), 'utf8')).toBe('{"version":1,"tags":"oops"}')
})

// The quarantine must fire once, not on every subsequent write.
test('later writes after a recovery do not keep making backups', async () => {
  const file = tmpFile()
  const dir = join(file, '..')
  await mkdir(dir, { recursive: true })
  await writeFile(file, 'not json at all')

  const store = createLocalTagStore(file)
  await store.createTag({ name: 'A', sources: [] })
  await store.createTag({ name: 'B', sources: [] })
  await store.createTag({ name: 'C', sources: [] })

  expect((await readdir(dir)).filter(f => f.startsWith('tags.json.corrupt-'))).toHaveLength(1)
  expect((await createLocalTagStore(file).listAllTags()).map(t => t.name)).toEqual(['A', 'B', 'C'])
})

test('an empty file reads as empty', async () => {
  const file = tmpFile()
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, '')
  expect(await createLocalTagStore(file).listAllTags()).toEqual([])
})

test('garbage entries are dropped, valid ones survive', async () => {
  const file = tmpFile()
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, JSON.stringify({
    version: 1,
    tags: [
      null,
      { name: 'no id' },
      { _id: 'x', name: 'Good', sources: [{ type: 'project', value: '/p' }, 'junk'], createdAt: 'c', updatedAt: 'u' },
    ],
  }))
  const all = await createLocalTagStore(file).listAllTags()
  expect(all).toHaveLength(1)
  expect(all[0]!.sources).toEqual([{ type: 'project', value: '/p' }])
})

// --- the tag's period -------------------------------------------------------------------------

test('the period round-trips, is patchable, and is CLEARED rather than emptied', async () => {
  const file = tmpFile()
  const store = createLocalTagStore(file)
  const doc = await store.createTag({
    name: 'Experiment', sources: [{ type: 'repo', value: 'github.com/org/repo' }],
    window: { start: '2026-07-04', end: '2026-07-18' },
  })
  expect(doc.window).toEqual({ start: '2026-07-04', end: '2026-07-18' })
  expect((await createLocalTagStore(file).getTag(doc._id))?.window)
    .toEqual({ start: '2026-07-04', end: '2026-07-18' })

  // Narrowing one end only.
  expect(await store.updateTag(doc._id, { window: { start: '2026-07-06' } })).toBe(true)
  expect((await createLocalTagStore(file).getTag(doc._id))?.window).toEqual({ start: '2026-07-06' })

  // `undefined` must LEAVE IT ALONE — otherwise editing a tag's name silently drops its period.
  expect(await store.updateTag(doc._id, { name: 'Renamed' })).toBe(true)
  const kept = await createLocalTagStore(file).getTag(doc._id)
  expect(kept?.name).toBe('Renamed')
  expect(kept?.window).toEqual({ start: '2026-07-06' })

  // `null` removes the key entirely: a leftover `{}` would read as "has a period" downstream.
  expect(await store.updateTag(doc._id, { window: null })).toBe(true)
  const cleared = await createLocalTagStore(file).getTag(doc._id)
  expect(cleared?.window).toBeUndefined()
  expect(JSON.parse(await readFile(file, 'utf8')).tags[0]).not.toHaveProperty('window')
})

test('a hand-edited period survives only when it is well-formed and ordered', async () => {
  const file = tmpFile()
  await mkdir(join(file, '..'), { recursive: true })
  const doc = (window: unknown) => ({
    _id: 'a'.repeat(24), name: 'T', sources: [],
    createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z', window,
  })
  const read = async (window: unknown) => {
    await writeFile(file, JSON.stringify({ version: 1, tags: [doc(window)] }))
    return (await createLocalTagStore(file).listAllTags())[0]?.window
  }
  expect(await read({ start: '2026-07-04', end: '2026-07-18' })).toEqual({ start: '2026-07-04', end: '2026-07-18' })
  expect(await read({ start: '2026-07-04' })).toEqual({ start: '2026-07-04' })
  // Anything malformed drops the whole period: a half-read window would shift the tag's numbers,
  // which is worse than the tag falling back to all-time.
  expect(await read({ start: 'yesterday' })).toBeUndefined()
  expect(await read({ start: '2026-07-18', end: '2026-07-04' })).toBeUndefined()
  expect(await read({})).toBeUndefined()
  expect(await read('2026-07-04')).toBeUndefined()
  expect(await read(null)).toBeUndefined()
})

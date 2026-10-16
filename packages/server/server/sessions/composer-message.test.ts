import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createComposerMessageStore, normalizeComposerText } from './composer-message'

const prose = 'Here is the long message I typed.\n> A quoted line\nPlease review each detail.\n'.repeat(25).trim()
const wrapped = (text: string) => `<pasted_content id="abc">\n${text}\n</pasted_content id="abc">`

describe('durable composer message fingerprints', () => {
  let directory: string
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'composer-message-')) })
  afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

  test('a typed long message still matches after restart and beyond the former ten-minute TTL', async () => {
    const now = spyOn(Date, 'now').mockReturnValue(1_000)
    try {
      await createComposerMessageStore(directory).record('session-1', prose)
      now.mockReturnValue(24 * 60 * 60_000)
      const matches = await createComposerMessageStore(directory).read(['session-1'])
      expect(matches(wrapped(prose))).toBe(true)
    } finally { now.mockRestore() }
  })

  test('matches a wrapper around just part of a typed message', async () => {
    const store = createComposerMessageStore(directory)
    await store.record('session-1', 'before\n> quoted\nafter')
    const matches = await store.read(['session-1'])
    expect(matches('before\n<pasted_content id="abc">\n> quoted\n</pasted_content id="abc">\nafter')).toBe(true)
  })

  test('the first send survives more than fifty later sends', async () => {
    const store = createComposerMessageStore(directory)
    await store.record('session-1', prose)
    for (let i = 0; i < 60; i++) await store.record('session-1', `Later message ${i}`)
    expect((await store.read(['session-1']))(wrapped(prose))).toBe(true)
  })

  test('image paths and transcript markers identify the same message after restart', async () => {
    await createComposerMessageStore(directory).record('session-1', `/uploads/first.png\n/uploads/second.jpg\n${prose}`)
    const matches = await createComposerMessageStore(directory).read(['session-1'])
    expect(matches(`[Image #26] [Image #27]${wrapped(prose)}`)).toBe(true)
    expect(matches(wrapped(`[Image #26] [Image #27]${prose}`))).toBe(true)
    expect(matches(`/uploads/first.png\n/uploads/second.jpg\n${wrapped(prose)}`)).toBe(true)
    expect(matches(wrapped(prose))).toBe(false)
    expect(matches(`[Image #26]${wrapped(prose)}`)).toBe(false)
    expect(matches(`[Image #26] [Image #27]${wrapped('Different typed words')}`)).toBe(false)
  })

  test('text-only messages do not claim image messages with the same prose', async () => {
    const store = createComposerMessageStore(directory)
    await store.record('session-1', prose)
    expect((await store.read(['session-1']))(`[Image #1]${wrapped(prose)}`)).toBe(false)
  })

  test('a marker inside prose is preserved as part of the message', async () => {
    const store = createComposerMessageStore(directory)
    await store.record('session-1', 'Please explain [Image #1] in this sentence')
    const matches = await store.read(['session-1'])
    expect(matches(wrapped('Please explain [Image #1] in this sentence'))).toBe(true)
    expect(matches(wrapped('Please explain in this sentence'))).toBe(false)
  })

  test('unrecorded external pastes and other sessions do not acquire composer provenance', async () => {
    const store = createComposerMessageStore(directory)
    await store.record('session-1', prose)
    expect((await store.read(['session-2']))(wrapped(prose))).toBe(false)
    expect((await store.read(['session-1']))(wrapped('An external paste'))).toBe(false)
  })

  test('a send before linking follows its conversation after reopening under a new row', async () => {
    await createComposerMessageStore(directory).record('original-row', prose)
    const linked = await createComposerMessageStore(directory).read(['original-row'], 'conversation-1')
    expect(linked(wrapped(prose))).toBe(true)
    const reopened = await createComposerMessageStore(directory).read(['new-row'], 'conversation-1')
    expect(reopened(wrapped(prose))).toBe(true)
    expect((await createComposerMessageStore(directory).read(['other-row'], 'conversation-2'))(wrapped(prose))).toBe(false)
  })

  test('only hashes are stored, including in filenames, and malformed lines are ignored', async () => {
    const store = createComposerMessageStore(directory)
    await store.record('../../session/private-id', prose)
    const files = (await readdir(directory)).filter(name => name !== '.salt')
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^[a-f0-9]{64}\.log$/)
    const path = join(directory, files[0]!)
    const raw = await readFile(path, 'utf8')
    expect(raw).toMatch(/^[a-f0-9]{64}\n$/)
    expect(raw).not.toContain(prose)
    await appendFile(path, 'partial\n{"broken":true}\n')
    expect((await store.read(['../../session/private-id']))(wrapped(prose))).toBe(true)
  })

  test('empty sends and keys write nothing; a missing store matches nothing', async () => {
    const store = createComposerMessageStore(directory)
    await store.record('', prose)
    await store.record('session-1', '  \n ')
    expect(await readdir(directory)).toEqual([])
    expect((await store.read(['session-1']))(wrapped(prose))).toBe(false)
  })

  test('an unwritable metadata location does not turn delivery into a failure', async () => {
    const store = createComposerMessageStore('/dev/null/composer-messages')
    await expect(store.record('session-1', prose)).resolves.toBeUndefined()
    expect((await store.read(['session-1']))(wrapped(prose))).toBe(false)
  })

  test('normalization handles transcript tags and CRLF', () => {
    expect(normalizeComposerText('  one\r\n\n two  ')).toBe('one\n two')
  })

  test('a short message is not stored as a bare hash of its text', async () => {
    const store = createComposerMessageStore(directory)
    await store.record('session-1', 'ok')
    const file = (await readdir(directory)).find(name => name.endsWith('.log'))!
    const line = (await readFile(join(directory, file), 'utf8')).trim()
    const unsalted = createHash('sha256').update('0\0ok').digest('hex')
    expect(line).not.toBe(unsalted)
    expect((await store.read(['session-1']))('ok')).toBe(true)
    // The salt is per install, so two installs disagree about the same text.
    const other = await mkdtemp(join(tmpdir(), 'composer-message-'))
    try {
      await createComposerMessageStore(other).record('session-1', 'ok')
      const f2 = (await readdir(other)).find(name => name.endsWith('.log'))!
      expect((await readFile(join(other, f2), 'utf8')).trim()).not.toBe(line)
    } finally { await rm(other, { recursive: true, force: true }) }
  })

  test('lines written before the salt existed still match', async () => {
    await mkdir(directory, { recursive: true })
    const legacy = createHash('sha256').update('0\0Hello there').digest('hex')
    await writeFile(join(directory, `${createHash('sha256').update('session-1').digest('hex')}.log`), `${legacy}\n`)
    expect((await createComposerMessageStore(directory).read(['session-1']))('Hello there')).toBe(true)
  })

  test('repeated reads of an unchanged file do not hit the disk again', async () => {
    const store = createComposerMessageStore(directory)
    await store.record('session-1', prose)
    await store.read(['session-1'])
    const file = join(directory, (await readdir(directory)).find(name => name.endsWith('.log'))!)
    // Replace the content behind the cache with a same-signature-impossible edit is not needed:
    // an in-place edit changes size, so the cache must notice it.
    await appendFile(file, `${'a'.repeat(64)}\n`)
    expect((await store.read(['session-1']))(wrapped(prose))).toBe(true)
    const fsp = await import('node:fs/promises')
    const spy = spyOn(fsp, 'readFile')
    try {
      // Positive control: an external append invalidates the signature, so this read MUST hit the spy.
      await appendFile(file, `${'b'.repeat(64)}\n`)
      await store.read(['session-1'])
      const logReads = () => spy.mock.calls.filter(call => String(call[0]).endsWith('.log')).length
      expect(logReads()).toBe(1)
      await store.read(['session-1']); await store.read(['session-1'])
      expect(logReads()).toBe(1)
    } finally { spy.mockRestore() }
  })

  test('promotion is not duplicated by concurrent reads', async () => {
    const store = createComposerMessageStore(directory)
    await store.record('row-1', prose)
    await Promise.all([store.read(['row-1'], 'conv-1'), store.read(['row-1'], 'conv-1'), store.read(['row-1'], 'conv-1')])
    const conv = (await readdir(directory)).map(name => name).filter(name => name.endsWith('.log'))
    const lines = await Promise.all(conv.map(async name => (await readFile(join(directory, name), 'utf8')).split('\n').filter(Boolean)))
    expect(lines.map(l => l.length).sort()).toEqual([1, 1])
  })

  test('a file is capped to its most recent 2000 fingerprints', async () => {
    const path = join(directory, `${createHash('sha256').update('session-1').digest('hex')}.log`)
    await mkdir(directory, { recursive: true })
    const all = Array.from({ length: 2100 }, (_, i) => createHash('sha256').update(String(i)).digest('hex'))
    await writeFile(path, `${all.join('\n')}\n`)
    await createComposerMessageStore(directory).read(['session-1'])
    const kept = (await readFile(path, 'utf8')).split('\n').filter(Boolean)
    expect(kept).toHaveLength(2000)
    expect(kept[0]).toBe(all[100])
  })

  test('appends keep the 2000-line cap', async () => {
    const path = join(directory, `${createHash('sha256').update('session-1').digest('hex')}.log`)
    await mkdir(directory, { recursive: true })
    const all = Array.from({ length: 2000 }, (_, i) => createHash('sha256').update(String(i)).digest('hex'))
    await writeFile(path, `${all.join('\n')}\n`)
    const store = createComposerMessageStore(directory)
    await store.record('session-1', prose)
    const kept = (await readFile(path, 'utf8')).split('\n').filter(Boolean)
    expect(kept).toHaveLength(2000)
    expect(kept[0]).toBe(all[1])
    expect((await store.read(['session-1']))(prose)).toBe(true)
  })

  test('the cap counts physical lines, so duplicate lines cannot grow the file past it', async () => {
    const path = join(directory, `${createHash('sha256').update('session-1').digest('hex')}.log`)
    await mkdir(directory, { recursive: true })
    const unique = Array.from({ length: 1000 }, (_, i) => createHash('sha256').update(`d${i}`).digest('hex'))
    await writeFile(path, `${[...unique, ...unique].join('\n')}\n`) // 2000 physical lines, 1000 unique
    const store = createComposerMessageStore(directory)
    await store.record('session-1', prose)
    const kept = (await readFile(path, 'utf8')).split('\n').filter(Boolean)
    expect(kept.length).toBeLessThanOrEqual(2000)
    expect((await store.read(['session-1']))(prose)).toBe(true)
  })
})

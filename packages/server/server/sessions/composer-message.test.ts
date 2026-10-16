import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { appendFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
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
    const files = await readdir(directory)
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
})

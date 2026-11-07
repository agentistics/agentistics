import { afterEach, describe, expect, test } from 'bun:test'
import { publishedAmong, releaseTagsIdle, resetReleaseTagsForTest, tagContains } from './release-tags'

afterEach(async () => { await resetReleaseTagsForTest() })

describe('release-tags (the cached tag lookup the Live asks, never per request)', () => {
  test('unknown commits resolve in the background; the next ask knows them', async () => {
    let calls = 0
    const ask = async (sha: string) => { calls++; return sha === 'aaaaaaa1' }
    expect([...publishedAmong(['aaaaaaa1', 'bbbbbbb2'], 1000, ask)]).toEqual([])
    await releaseTagsIdle()
    expect([...publishedAmong(['aaaaaaa1', 'bbbbbbb2'], 2000, ask)]).toEqual(['aaaaaaa1'])
    expect(calls).toBe(2)
    // positive stays forever, negative is not asked again inside its TTL
    publishedAmong(['aaaaaaa1', 'bbbbbbb2'], 3000, ask)
    await releaseTagsIdle()
    expect(calls).toBe(2)
  })
  test('a negative answer expires, so a tag published later is found', async () => {
    let published = false
    const ask = async () => published
    publishedAmong(['ccccccc3'], 0, ask)
    await releaseTagsIdle()
    published = true
    publishedAmong(['ccccccc3'], 60_000, ask)
    await releaseTagsIdle()
    expect(publishedAmong(['ccccccc3'], 61_000, ask).has('ccccccc3')).toBe(false)
    publishedAmong(['ccccccc3'], 11 * 60_000, ask)
    await releaseTagsIdle()
    expect(publishedAmong(['ccccccc3'], 11 * 60_000 + 1, ask).has('ccccccc3')).toBe(true)
  })
  test('a non-hex argument is never passed to git', async () => {
    expect(await tagContains('--all')).toBe(false)
    expect(await tagContains('zzzzzzzz')).toBe(false)
  })
})

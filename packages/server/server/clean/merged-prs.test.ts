import { describe, expect, test } from 'bun:test'
import { createMergedPrReader, parseMergedPrs, PR_CACHE_MS, type MergedPrCache } from './merged-prs'

const JSON_OUT = JSON.stringify([{ headRefName: 'feat/a', headRefOid: 'aaa' }, { headRefName: 'feat/b', headRefOid: 'bbb' }, { headRefName: 'x' }])

describe('parseMergedPrs', () => {
  test('keeps rows with a branch and a head commit', () => {
    expect(parseMergedPrs(JSON_OUT)).toEqual([{ branch: 'feat/a', oid: 'aaa' }, { branch: 'feat/b', oid: 'bbb' }])
  })
  test('anything that is not a JSON array is unknown, never an empty list', () => {
    expect(parseMergedPrs('nope')).toBeNull()
    expect(parseMergedPrs('{}')).toBeNull()
    expect(parseMergedPrs('[]')).toEqual([])
  })
})

describe('createMergedPrReader', () => {
  const store = () => {
    let cache: MergedPrCache = {}
    return { load: async () => cache, save: async (c: MergedPrCache) => { cache = c } }
  }

  test('asks gh once per repository per run and caches a good answer for a day', async () => {
    const file = store()
    let calls = 0, now = 1_000
    const o = { ...file, run: async () => { calls++; return JSON_OUT }, now: () => now }
    const read = createMergedPrReader(o)
    expect((await read('/r'))?.length).toBe(2)
    await read('/r')
    expect(calls).toBe(1)
    // A new process reads the same cache and does not ask again within a day.
    await createMergedPrReader(o)('/r')
    expect(calls).toBe(1)
    now += PR_CACHE_MS + 1
    await createMergedPrReader(o)('/r')
    expect(calls).toBe(2)
  })

  test('no gh / not authenticated is unknown, remembered for this run only', async () => {
    const o = { ...store(), run: async () => { calls++; return null } }
    let calls = 0
    const read = createMergedPrReader(o)
    expect(await read('/r')).toBeNull()
    expect(await read('/r')).toBeNull()
    expect(calls).toBe(1)
    await createMergedPrReader(o)('/r')
    expect(calls).toBe(2)
  })
})

import { beforeEach, describe, expect, test } from 'bun:test'
import {
  bootLivePeriod, isLivePath, resetBootPrefetch, startBootLivePrefetch, takeBootLivePrefetch,
} from './liveBootPrefetch'

const store = (v: string | null) => ({ getItem: () => v })
const reply = { deliveries: [] } as never

beforeEach(() => resetBootPrefetch())

describe('which route starts the early read', () => {
  test('only the Live route', () => {
    expect(isLivePath('/tasks/live')).toBe(true)
    expect(isLivePath('/tasks/live/')).toBe(true)
    expect(isLivePath('/tasks')).toBe(false)
    expect(isLivePath('/tasks/live-x')).toBe(false)
    expect(isLivePath('/sessions')).toBe(false)
  })
})

describe('the period it asks for is the one the screen will ask for', () => {
  test('stored choice wins when valid', () => {
    expect(bootLivePeriod(store(JSON.stringify({ period: '7d' })))).toBe('7d')
  })
  test('junk, missing or unreadable falls back to the default the screen uses', () => {
    const dflt = bootLivePeriod(store(null))
    expect(bootLivePeriod(store('{not json'))).toBe(dflt)
    expect(bootLivePeriod(store(JSON.stringify({ period: 'forever' })))).toBe(dflt)
    expect(bootLivePeriod(null)).toBe(dflt)
  })
})

describe('the early read is handed to the screen once', () => {
  test('on the Live route it fetches the same URL the screen would, with the period', async () => {
    const urls: string[] = []
    startBootLivePrefetch('/tasks/live', store(JSON.stringify({ period: '30d' })), (async (u: string) => { urls.push(u); return { ok: true, json: async () => reply } }) as never)
    const got = await takeBootLivePrefetch('30d')
    expect(urls).toEqual(['/api/tasks/live?tab=all&period=30d'])
    expect(got).toBe(reply)
  })
  test('elsewhere nothing is fetched', () => {
    let called = 0
    startBootLivePrefetch('/sessions', store(null), (async () => { called++; return { ok: true, json: async () => reply } }) as never)
    expect(called).toBe(0)
    expect(takeBootLivePrefetch('24h')).toBeNull()
  })
  test('a different period is not served from it, and taking twice is not possible', async () => {
    startBootLivePrefetch('/tasks/live', store(JSON.stringify({ period: '7d' })), (async () => ({ ok: true, json: async () => reply })) as never)
    expect(takeBootLivePrefetch('24h')).toBeNull()
    expect(await takeBootLivePrefetch('7d')).toBe(reply)
    expect(takeBootLivePrefetch('7d')).toBeNull()
  })
  test('a failed read resolves to null so the screen falls back to its own fetch', async () => {
    startBootLivePrefetch('/tasks/live', store(null), (async () => { throw new Error('down') }) as never)
    const p = takeBootLivePrefetch(bootLivePeriod(store(null)))
    expect(await p).toBeNull()
    startBootLivePrefetch('/tasks/live', store(null), (async () => ({ ok: false, status: 503, json: async () => ({}) })) as never)
    expect(await takeBootLivePrefetch(bootLivePeriod(store(null)))).toBeNull()
  })
})

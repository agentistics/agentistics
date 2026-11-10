import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AGENTISTICS_DATA_DIR } from '../config'
import { FORECAST_METHOD_VERSION } from './task-live'

const file = join(AGENTISTICS_DATA_DIR, 'forecast-anchors.json')

// The module memoizes its first read, so every case loads a fresh copy of it.
let n = 0
const fresh = () => import(`./task-forecast-cache?case=${++n}`) as Promise<typeof import('./task-forecast-cache')>

afterEach(() => rm(file, { force: true }))

describe('forecast anchors cache', () => {
  test('a missing file reads as empty and a read never creates it', async () => {
    await rm(file, { force: true })
    const cache = await fresh()
    expect((await cache.readForecastAnchors()).size).toBe(0)
    expect(existsSync(file)).toBe(false)
  })

  test.each(['{not json', 'null', '[]', '"x"', '{"methodVersion":"old","anchors":{"a":1}}', ''])(
    'unreadable or foreign content %p reads as empty without throwing',
    async raw => {
      await mkdir(AGENTISTICS_DATA_DIR, { recursive: true })
      await writeFile(file, raw)
      const cache = await fresh()
      expect((await cache.readForecastAnchors()).size).toBe(0)
      expect(await readFile(file, 'utf8')).toBe(raw)
    },
  )

  test('only finite positive numbers survive', async () => {
    await mkdir(AGENTISTICS_DATA_DIR, { recursive: true })
    await writeFile(file, JSON.stringify({ methodVersion: FORECAST_METHOD_VERSION,
      anchors: { ok: 5, zero: 0, neg: -1, text: 'x', nul: null } }))
    const cache = await fresh()
    expect([...await cache.readForecastAnchors()]).toEqual([['ok', 5]])
  })

  test('saving over a corrupt file replaces it with a valid one', async () => {
    await mkdir(AGENTISTICS_DATA_DIR, { recursive: true })
    await writeFile(file, '{broken')
    const cache = await fresh()
    await cache.saveForecastAnchors([])
    // Nothing to anchor and nothing remembered: no write, the broken file is left for the next real anchor.
    expect(await readFile(file, 'utf8')).toBe('{broken')
  })
})

import { describe, expect, test, beforeEach } from 'bun:test'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { forgetRepoFacts, repoFacts, repoFactsCacheSize, REPO_FACTS_CACHE_MAX, GIT_CONCURRENCY } from './repo-facts'

// RES.1: one cockpit poll asked for 780 rows over 237 directories at once and forked ~2.300 gits.
describe('repoFacts is bounded', () => {
  beforeEach(() => forgetRepoFacts())

  test('concurrent asks for one directory share ONE lookup', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'res1-rf-'))
    let peak = 0
    const sampler = setInterval(() => { peak = Math.max(peak, repoFactsCacheSize().inFlight) }, 0)
    const answers = await Promise.all(Array.from({ length: 50 }, () => repoFacts(dir)))
    clearInterval(sampler)
    expect(peak).toBeLessThanOrEqual(1)
    expect(new Set(answers.map(a => JSON.stringify(a))).size).toBe(1)
    expect(repoFactsCacheSize()).toEqual({ cached: 1, inFlight: 0 })
  })

  test('many directories never hold more than one lookup each in flight', async () => {
    const root = mkdtempSync(join(tmpdir(), 'res1-rf-'))
    const dirs = Array.from({ length: 30 }, (_, i) => { const d = join(root, `d${i}`); mkdirSync(d); return d })
    let peak = 0
    const sampler = setInterval(() => { peak = Math.max(peak, repoFactsCacheSize().inFlight) }, 0)
    await Promise.all(dirs.flatMap(d => [repoFacts(d), repoFacts(d), repoFacts(d)]))
    clearInterval(sampler)
    // Never more than one lookup per DISTINCT directory, however many rows asked.
    expect(peak).toBeLessThanOrEqual(dirs.length)
    expect(repoFactsCacheSize()).toEqual({ cached: dirs.length, inFlight: 0 })
  })

  test('the limits are what the measurement asked for', () => {
    expect(GIT_CONCURRENCY).toBeLessThanOrEqual(8)
    expect(REPO_FACTS_CACHE_MAX).toBeGreaterThan(237)
  })
})

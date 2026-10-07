import { describe, expect, test } from 'bun:test'
import {
  parseRebuildFlags,
  rebuildFlags,
  composeRebuildCommands,
} from './rebuild-flags'

describe('parseRebuildFlags', () => {
  test('answers nothing when nothing was asked', () => {
    const r = parseRebuildFlags([])
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('unreachable')
    expect(r.flags).toEqual({})
    expect(r.rest).toEqual([])
  })

  test('reads the cache choice in both directions', () => {
    const fresh = parseRebuildFlags(['--no-cache'])
    const reuse = parseRebuildFlags(['--cache'])
    expect(fresh.ok && fresh.flags.cache).toBe('fresh')
    expect(reuse.ok && reuse.flags.cache).toBe('reuse')
  })

  test('repeating the SAME answer is not a conflict', () => {
    const r = parseRebuildFlags(['--cache', '--cache'])
    expect(r.ok && r.flags.cache).toBe('reuse')
  })

  test('--cache and --no-cache together is a user error, naming both', () => {
    const r = parseRebuildFlags(['--cache', '--no-cache'])
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.conflict).toEqual(['--cache', '--no-cache'])
  })

  test('anything else is passed through, in order', () => {
    const r = parseRebuildFlags(['--email', 'a@b.c', '--cache', 'extra'])
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('unreachable')
    expect(r.rest).toEqual(['--email', 'a@b.c', 'extra'])
    expect(r.flags.cache).toBe('reuse')
  })
})

describe('rebuildFlags', () => {
  test('a rebuild defaults to a cacheless build', () => {
    expect(rebuildFlags({}).cache).toBe('fresh')
  })

  test('an explicit --cache survives the default', () => {
    expect(rebuildFlags({ cache: 'reuse' }).cache).toBe('reuse')
  })
})

describe('composeRebuildCommands', () => {
  test('a cacheless rebuild builds first, then recreates', () => {
    expect(composeRebuildCommands('/x/dc.yml', { cache: 'fresh' })).toEqual([
      ['docker', 'compose', '-f', '/x/dc.yml', 'build', '--no-cache'],
      ['docker', 'compose', '-f', '/x/dc.yml', 'up', '-d', '--force-recreate'],
    ])
  })

  test('reusing the cache stays the single up --build it always was', () => {
    expect(composeRebuildCommands('/x/dc.yml', { cache: 'reuse' })).toEqual([
      ['docker', 'compose', '-f', '/x/dc.yml', 'up', '-d', '--build'],
    ])
  })

  test('unspecified means fresh — a rebuild is a rebuild', () => {
    expect(composeRebuildCommands('/x/dc.yml', {})).toEqual(
      composeRebuildCommands('/x/dc.yml', { cache: 'fresh' }),
    )
  })
})

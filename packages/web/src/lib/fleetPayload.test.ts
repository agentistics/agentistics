import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeFleetPayload, type FleetPayload } from './fleet'

/**
 * Reported on v2.65.0: the Sessions page threw `TypeError: Cannot read properties of undefined
 * (reading 'includes')` because `/api/fleet` omitted `finishedTasks` when it was empty and the page
 * read it as a list. Both halves are pinned here.
 */
describe('the fleet answer the page reads', () => {
  test('an answer with no finishedTasks (an older server) reads as an empty list', () => {
    const raw = { sessions: [], rows: [], attention: 2, tasks: ['a'] } as unknown as FleetPayload
    const out = normalizeFleetPayload(raw)
    expect(out.finishedTasks).toEqual([])
    expect(out.tasks).toEqual(['a'])
    expect(out.attention).toBe(2)
    expect(() => out.finishedTasks.includes('x')).not.toThrow()
  })

  test('every list the page iterates is a list, whatever arrived', () => {
    const out = normalizeFleetPayload({ finishedTasks: null, tasks: 'x' } as unknown as FleetPayload)
    expect(out.sessions).toEqual([])
    expect(out.rows).toEqual([])
    expect(out.tasks).toEqual([])
    expect(out.finishedTasks).toEqual([])
    expect(out.attention).toBe(0)
  })

  test('a present list and every other field pass through untouched', () => {
    const raw = { sessions: [], rows: [], attention: 0, tasks: [], finishedTasks: ['done'], fell: { count: 1, atMs: 5 } } as FleetPayload
    expect(normalizeFleetPayload(raw)).toEqual(raw)
  })

  test('the server always sends finishedTasks, never only when non-empty', () => {
    const src = readFileSync(join(import.meta.dir, '../../../server/server/sessions/fleet-web.ts'), 'utf8')
    expect(src).not.toMatch(/finishedTasks\.length\s*>\s*0\s*\?\s*\{\s*finishedTasks/)
    expect(src).toMatch(/^\s*finishedTasks: string\[\]$/m)
    expect(src).toContain('finishedTasks: [...finishedTasks],')
  })

  test('the compact one-list wire answer supplies local rows and derives search fields', () => {
    const out = normalizeFleetPayload({
      sessions: [{ id: 'a', title: 'Fix parser', cwd: '/w/repo', harness: 'claude', task: 'parser' }],
      attention: 0, tasks: [], finishedTasks: [],
    } as unknown as FleetPayload)
    expect(out.rows as unknown).toBe(out.sessions as unknown)
    expect((out.rows[0] as unknown as { searchFields: Record<string, string> }).searchFields).toEqual({
      name: 'Fix parser', folder: '/w/repo', harness: 'claude', note: '', task: 'parser', prompt: '',
    })
  })
})

describe('search index on every row', () => {
  const wireRow = { id: 'a1', title: 'Fix login', cwd: '/x/y', harness: 'claude', firstPrompt: 'hello' }

  test('a non-empty `rows` list also gets searchFields (the wire strips them)', () => {
    const out = normalizeFleetPayload({ sessions: [wireRow], rows: [wireRow], tasks: [], finishedTasks: [] } as unknown as FleetPayload)
    expect(out.rows[0].searchFields.name).toBe('Fix login')
    expect(out.rows[0].searchFields.prompt).toBe('hello')
  })

  test('matchesQuery never throws on a row without searchFields', async () => {
    const { matchesQuery } = await import('../../../tui/src/control/search-scope')
    expect(() => matchesQuery(undefined as never, 'abc')).not.toThrow()
  })
})

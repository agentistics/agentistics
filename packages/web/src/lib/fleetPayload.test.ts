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
})

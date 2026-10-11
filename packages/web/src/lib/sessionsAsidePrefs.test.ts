import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  DEFAULT_ASIDE_GROUP_PREFS, collapseKey, parseAsideGroupPrefs, readAsideGroupPrefs, readSessionSort, writeAsideGroupPrefs,
} from './sessionsAsidePrefs'

/** A minimal localStorage, so the module runs outside a browser — same pattern
 *  `sessionNotifications.test.ts` uses. */
function installStorage(): void {
  const store = new Map<string, string>()
  const g = globalThis as Record<string, unknown>
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
  }
}

/**
 * The store reads its browser copy ONCE (it is server-backed since 2026-10-01 — see
 * `sessionsAsidePrefs.ts`), so a test that plants a stored document reads it back through the pure
 * parser, exactly as the store does with whatever it holds; round trips go through the store.
 */
let seeded: string | null = null
const seed = (raw: string): void => { seeded = raw }
const read = () => {
  if (seeded === null) return readAsideGroupPrefs()
  try { return parseAsideGroupPrefs(JSON.parse(seeded)) } catch { return parseAsideGroupPrefs(null) }
}

beforeEach(() => {
  installStorage(); seeded = null
  // The preference document is a module-level store; reset the fields that a preceding test may
  // have changed before each test gets its fresh browser-storage stub.
  writeAsideGroupPrefs({ ...DEFAULT_ASIDE_GROUP_PREFS })
})
afterEach(() => { delete (globalThis as Record<string, unknown>).localStorage })

describe('readAsideGroupPrefs', () => {
  test('nothing stored yields the defaults', () => {
    expect(read()).toEqual(DEFAULT_ASIDE_GROUP_PREFS)
  })

  test('corrupt JSON falls back to the defaults rather than throwing', () => {
    seed('{not json')
    expect(read()).toEqual(DEFAULT_ASIDE_GROUP_PREFS)
  })

  test('an unrecognised groupBy falls back rather than rendering as-is', () => {
    seed(JSON.stringify({ groupBy: 'repo' }))
    expect(read().groupBy).toBe('project')
  })

  test('an unrecognised cardColor falls back rather than rendering as-is', () => {
    seed(JSON.stringify({ cardColor: 'rainbow' }))
    expect(read().cardColor).toBe('wash')
  })

  test('order keeps only known dimensions and string arrays', () => {
    seed(JSON.stringify({
      order: { status: ['working', 'lost'], repo: ['x'], task: 'not-an-array' },
    }))
    expect(read().order).toEqual({ status: ['working', 'lost'] })
  })

  test('collapsed drops non-string entries', () => {
    seed(JSON.stringify({
      collapsed: ['active:project:agentistics', 42, null],
    }))
    expect(read().collapsed).toEqual(['active:project:agentistics'])
  })

  test('collapsedUserGroups drops non-string entries', () => {
    seed(JSON.stringify({
      collapsedUserGroups: ['g1', 42, null],
    }))
    expect(read().collapsedUserGroups).toEqual(['g1'])
  })

  test('missing collapsedUserGroups defaults to empty', () => {
    seed(JSON.stringify({ groupBy: 'task' }))
    expect(read().collapsedUserGroups).toEqual([])
  })
})

describe('writeAsideGroupPrefs', () => {
  test('round-trips a full write', () => {
    writeAsideGroupPrefs({
      groupBy: 'status',
      order: { status: ['working', 'waiting'] },
      collapsed: ['active:status:working'],
      cardColor: 'neutral',
      collapsedUserGroups: ['g1'],
      sort: { by: 'recent', dir: 'asc' },
      hiddenUserGroups: ['g2'],
    })
    expect(read()).toEqual({
      groupBy: 'status',
      order: { status: ['working', 'waiting'] },
      collapsed: ['active:status:working'],
      cardColor: 'neutral',
      collapsedUserGroups: ['g1'],
      sort: { by: 'recent', dir: 'asc' },
      hiddenUserGroups: ['g2'],
      foldedPinned: false,
      foldedGroupsSection: false,
    })
  })

  test('a partial write merges over what is already stored', () => {
    writeAsideGroupPrefs({ groupBy: 'task' })
    writeAsideGroupPrefs({ cardColor: 'stripe' })
    const out = read()
    expect(out.groupBy).toBe('task')
    expect(out.cardColor).toBe('stripe')
  })
})

describe('collapseKey', () => {
  test('bands the same key/dimension apart, so one band folding never folds the other', () => {
    expect(collapseKey('active', 'project', 'agentistics'))
      .not.toBe(collapseKey('inactive', 'project', 'agentistics'))
  })

  test('is stable and readable', () => {
    expect(collapseKey('active', 'status', 'working')).toBe('active:status:working')
  })
})

describe('the sort preference', () => {
  test('a stored preference from before sorting existed reads as the default order', () => {
    seed(JSON.stringify({ groupBy: 'task' }))
    expect(read().sort).toEqual({ by: 'state', dir: 'desc' })
  })

  test('readSessionSort is total: an unknown key or direction falls back to the default field by field', () => {
    expect(readSessionSort({ by: 'name', dir: 'asc' })).toEqual({ by: 'name', dir: 'asc' })
    expect(readSessionSort({ by: 'nonsense', dir: 'asc' })).toEqual({ by: 'state', dir: 'asc' })
    expect(readSessionSort({ by: 'usage', dir: 'sideways' })).toEqual({ by: 'usage', dir: 'desc' })
    expect(readSessionSort(null)).toEqual({ by: 'state', dir: 'desc' })
    expect(readSessionSort('recent')).toEqual({ by: 'state', dir: 'desc' })
  })
})

test('hiddenUserGroups: absent reads as none hidden, and junk entries are dropped', () => {
  seed(JSON.stringify({ groupBy: 'task' }))
  expect(read().hiddenUserGroups).toEqual([])
  seed(JSON.stringify({ hiddenUserGroups: ['a', 3, null, 'b'] }))
  expect(read().hiddenUserGroups).toEqual(['a', 'b'])
})

describe('foldedPinned / foldedGroupsSection', () => {
  test('absent reads as not folded — a legacy document opens exactly as it always did', () => {
    seed(JSON.stringify({ groupBy: 'task' }))
    expect(read().foldedPinned).toBe(false)
    expect(read().foldedGroupsSection).toBe(false)
  })

  test('round-trips true', () => {
    writeAsideGroupPrefs({ foldedPinned: true, foldedGroupsSection: true })
    expect(read().foldedPinned).toBe(true)
    expect(read().foldedGroupsSection).toBe(true)
  })

  test('anything other than a literal true reads as false', () => {
    seed(JSON.stringify({ foldedPinned: 'yes', foldedGroupsSection: 1 }))
    expect(read().foldedPinned).toBe(false)
    expect(read().foldedGroupsSection).toBe(false)
  })
})

import { bandCollapseKey, collapseKey as groupCollapseKey } from './sessionsAsidePrefs'

describe('bandCollapseKey', () => {
  test('a band has its own fold key, distinct from every sub-group key', () => {
    expect(bandCollapseKey('active')).not.toBe(bandCollapseKey('inactive'))
    for (const by of ['project', 'task', 'status'] as const) {
      expect(groupCollapseKey('active', by, 'band')).not.toBe(bandCollapseKey('active'))
    }
  })
})

import { arrangeChangedCount, DEFAULT_ASIDE_GROUP_PREFS as D } from './sessionsAsidePrefs'

describe('arrangeChangedCount', () => {
  const base = { groupBy: D.groupBy, sort: D.sort, cardColor: D.cardColor, order: [] as string[], hiddenFolders: 0 }
  test('the default arrangement has nothing changed (no badge)', () => {
    expect(arrangeChangedCount(base)).toBe(0)
  })
  test('one per option, never per value', () => {
    expect(arrangeChangedCount({ ...base, groupBy: 'status' })).toBe(1)
    expect(arrangeChangedCount({ ...base, sort: { by: D.sort.by, dir: D.sort.dir === 'asc' ? 'desc' : 'asc' } })).toBe(1)
    expect(arrangeChangedCount({ ...base, order: ['a', 'b', 'c'] })).toBe(1)
    expect(arrangeChangedCount({ ...base, cardColor: 'stripe' })).toBe(1)
    expect(arrangeChangedCount({ ...base, hiddenFolders: 4 })).toBe(1)
    expect(arrangeChangedCount({ groupBy: 'task', sort: { by: 'name', dir: 'asc' }, cardColor: 'neutral', order: ['x'], hiddenFolders: 2 })).toBe(5)
  })
})

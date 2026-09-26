import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  DEFAULT_ASIDE_GROUP_PREFS, collapseKey, readAsideGroupPrefs, readSessionSort, writeAsideGroupPrefs,
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

beforeEach(installStorage)
afterEach(() => { delete (globalThis as Record<string, unknown>).localStorage })

describe('readAsideGroupPrefs', () => {
  test('nothing stored yields the defaults', () => {
    expect(readAsideGroupPrefs()).toEqual(DEFAULT_ASIDE_GROUP_PREFS)
  })

  test('corrupt JSON falls back to the defaults rather than throwing', () => {
    localStorage.setItem('agentistics-sessions-aside-v1', '{not json')
    expect(readAsideGroupPrefs()).toEqual(DEFAULT_ASIDE_GROUP_PREFS)
  })

  test('an unrecognised groupBy falls back rather than rendering as-is', () => {
    localStorage.setItem('agentistics-sessions-aside-v1', JSON.stringify({ groupBy: 'repo' }))
    expect(readAsideGroupPrefs().groupBy).toBe('project')
  })

  test('an unrecognised cardColor falls back rather than rendering as-is', () => {
    localStorage.setItem('agentistics-sessions-aside-v1', JSON.stringify({ cardColor: 'rainbow' }))
    expect(readAsideGroupPrefs().cardColor).toBe('wash')
  })

  test('order keeps only known dimensions and string arrays', () => {
    localStorage.setItem('agentistics-sessions-aside-v1', JSON.stringify({
      order: { status: ['working', 'lost'], repo: ['x'], task: 'not-an-array' },
    }))
    expect(readAsideGroupPrefs().order).toEqual({ status: ['working', 'lost'] })
  })

  test('collapsed drops non-string entries', () => {
    localStorage.setItem('agentistics-sessions-aside-v1', JSON.stringify({
      collapsed: ['active:project:agentistics', 42, null],
    }))
    expect(readAsideGroupPrefs().collapsed).toEqual(['active:project:agentistics'])
  })

  test('collapsedUserGroups drops non-string entries', () => {
    localStorage.setItem('agentistics-sessions-aside-v1', JSON.stringify({
      collapsedUserGroups: ['g1', 42, null],
    }))
    expect(readAsideGroupPrefs().collapsedUserGroups).toEqual(['g1'])
  })

  test('missing collapsedUserGroups defaults to empty', () => {
    localStorage.setItem('agentistics-sessions-aside-v1', JSON.stringify({ groupBy: 'task' }))
    expect(readAsideGroupPrefs().collapsedUserGroups).toEqual([])
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
    expect(readAsideGroupPrefs()).toEqual({
      groupBy: 'status',
      order: { status: ['working', 'waiting'] },
      collapsed: ['active:status:working'],
      cardColor: 'neutral',
      collapsedUserGroups: ['g1'],
      sort: { by: 'recent', dir: 'asc' },
      hiddenUserGroups: ['g2'],
    })
  })

  test('a partial write merges over what is already stored', () => {
    writeAsideGroupPrefs({ groupBy: 'task' })
    writeAsideGroupPrefs({ cardColor: 'stripe' })
    const out = readAsideGroupPrefs()
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
    localStorage.setItem('agentistics-sessions-aside-v1', JSON.stringify({ groupBy: 'task' }))
    expect(readAsideGroupPrefs().sort).toEqual({ by: 'state', dir: 'desc' })
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
  localStorage.setItem('agentistics-sessions-aside-v1', JSON.stringify({ groupBy: 'task' }))
  expect(readAsideGroupPrefs().hiddenUserGroups).toEqual([])
  localStorage.setItem('agentistics-sessions-aside-v1', JSON.stringify({ hiddenUserGroups: ['a', 3, null, 'b'] }))
  expect(readAsideGroupPrefs().hiddenUserGroups).toEqual(['a', 'b'])
})

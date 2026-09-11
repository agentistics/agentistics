import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  DEFAULT_ASIDE_GROUP_PREFS, collapseKey, readAsideGroupPrefs, writeAsideGroupPrefs,
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
})

describe('writeAsideGroupPrefs', () => {
  test('round-trips a full write', () => {
    writeAsideGroupPrefs({
      groupBy: 'status',
      order: { status: ['working', 'waiting'] },
      collapsed: ['active:status:working'],
      cardColor: 'neutral',
    })
    expect(readAsideGroupPrefs()).toEqual({
      groupBy: 'status',
      order: { status: ['working', 'waiting'] },
      collapsed: ['active:status:working'],
      cardColor: 'neutral',
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

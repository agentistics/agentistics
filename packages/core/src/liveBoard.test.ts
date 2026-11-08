import { describe, expect, test } from 'bun:test'
import { LIVE_FLOW_DEFAULTS, LIVE_SORT_DEFAULT, liveComparator, parseLiveSort, priorityRank, stageVisible, type LiveBoardStage } from './liveBoard'

describe('stageVisible — the two switches of the filter bar', () => {
  const STAGES: LiveBoardStage[] = ['queue', 'blocked', 'running', 'qa', 'adjust', 'leader', 'merge', 'ci', 'published']
  const shown = (f: { onlyActive: boolean; showQueue: boolean }) => STAGES.filter(s => stageVisible(s, f))
  test('both on (the default) shows every column of the flow', () => {
    expect(LIVE_FLOW_DEFAULTS).toEqual({ onlyActive: true, showQueue: true })
    expect(shown(LIVE_FLOW_DEFAULTS)).toEqual(STAGES)
  })
  test('"apenas ativas" is every column AFTER the queue; "exibir itens na fila" is the queue', () => {
    expect(shown({ onlyActive: true, showQueue: false })).toEqual(STAGES.slice(1))
    expect(shown({ onlyActive: false, showQueue: true })).toEqual(['queue'])
    expect(shown({ onlyActive: false, showQueue: false })).toEqual([])
  })
})

describe('priority and order', () => {
  test('an absent priority, the legacy none and a typo all rank as low', () => {
    expect(priorityRank('urgent')).toBe(0)
    expect(priorityRank('high')).toBe(1)
    expect(priorityRank('medium')).toBe(2)
    for (const p of ['low', 'none', undefined, null, 'whatever']) expect(priorityRank(p)).toBe(3)
  })
  const d = (key: string, priority: string | undefined, since: number | null) => ({ key, priority, stageSinceMs: since })
  test('DEFAULT is highest priority first; a tie goes to the card that has been in the stage longer; the key ends ties', () => {
    expect(LIVE_SORT_DEFAULT).toBe('priority')
    const list = [d('c', 'high', 50), d('a', 'urgent', 90), d('b', 'high', 5), d('z', 'low', 1), d('y', undefined, 1)]
    expect([...list].sort(liveComparator('priority')).map(x => x.key)).toEqual(['a', 'b', 'c', 'y', 'z'])
  })
  test('time-in-stage: longest first; no stamp last. recent: newest first', () => {
    const list = [d('a', 'low', 30), d('b', 'low', 10), d('c', 'low', null), d('d', 'low', 20)]
    expect([...list].sort(liveComparator('time-in-stage')).map(x => x.key)).toEqual(['b', 'd', 'a', 'c'])
    expect([...list].sort(liveComparator('recent')).map(x => x.key)).toEqual(['a', 'd', 'b', 'c'])
  })
  test('parseLiveSort accepts the three ids and falls back to the default', () => {
    expect(parseLiveSort('recent')).toBe('recent')
    expect(parseLiveSort('time-in-stage')).toBe('time-in-stage')
    expect(parseLiveSort('nope')).toBe('priority')
    expect(parseLiveSort(undefined)).toBe('priority')
  })
})

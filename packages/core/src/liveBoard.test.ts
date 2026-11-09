import { describe, expect, test } from 'bun:test'
import {
  LIVE_PERIOD_DEFAULT, LIVE_SORT_DEFAULT, LIVE_TAB_DEFAULT, inPublishedPeriod, liveComparator, liveTabCounts, liveTabMatches, parseLivePeriod, parseLiveSort,
  parseLiveTab, priorityRank, type LiveTabbable,
} from './liveBoard'

describe('the tabs and the Publicado period (filtros v2)', () => {
  const H = 3600_000, NOW = 1000 * H
  const c = (stage: LiveTabbable['stage'], over: Partial<LiveTabbable> = {}): LiveTabbable => ({ stage, liveState: 'none', ...over })
  test('defaults and parsing: the screen opens on Em andamento over 24 h; junk falls back', () => {
    expect([LIVE_TAB_DEFAULT, LIVE_PERIOD_DEFAULT]).toEqual(['active', '24h'])
    expect(parseLiveTab('queue')).toBe('queue')
    expect(parseLiveTab('history')).toBe('active')
    expect(parseLivePeriod('30d')).toBe('30d')
    expect(parseLivePeriod('1y')).toBe('24h')
  })
  test('r9: Concluído follows the period like Publicado, so "Tudo" does not draw every completed card by default', () => {
    expect(liveTabMatches('all', c('completed', { deliveredAtMs: NOW - 2 * H }), '24h', NOW)).toBe(true)
    expect(liveTabMatches('all', c('completed', { deliveredAtMs: NOW - 90 * H }), '24h', NOW)).toBe(false)
    expect(liveTabMatches('all', c('completed'), '24h', NOW)).toBe(false)
    expect(liveTabMatches('all', c('completed'), 'all', NOW)).toBe(true)
  })
  test('Em andamento = every stage except queue, published, completed and old; nobody has to be on it', () => {
    const t = (x: LiveTabbable) => liveTabMatches('active', x, '24h', NOW)
    expect(t(c('running', { liveState: 'working' }))).toBe(true)
    expect(t(c('qa', { liveState: 'waiting' }))).toBe(true)
    expect(t(c('leader', { liveState: 'needs-you' }))).toBe(true)
    expect(t(c('running', { liveState: 'down' }))).toBe(true)
    expect(t(c('blocked'))).toBe(true)
    expect(t(c('adjust'))).toBe(true)
    expect(t(c('leader'))).toBe(true)
    expect(t(c('completed', { deliveredAtMs: NOW }))).toBe(false)
    expect(t(c('queue', { liveState: 'working' }))).toBe(false)
    expect(t(c('leader', { liveState: 'working', old: true }))).toBe(false)
    expect(t(c('published', { liveState: 'working', deliveredAtMs: NOW }))).toBe(false)
  })
  test('Publicado honours its period at the edges; an undated piece is only in "all"', () => {
    expect(inPublishedPeriod(NOW - 24 * H, '24h', NOW)).toBe(true)
    expect(inPublishedPeriod(NOW - 24 * H - 1, '24h', NOW)).toBe(false)
    expect(inPublishedPeriod(NOW - 7 * 24 * H, '7d', NOW)).toBe(true)
    expect(inPublishedPeriod(NOW - 31 * 24 * H, '30d', NOW)).toBe(false)
    expect(inPublishedPeriod(NOW - 900 * 24 * H, 'all', NOW)).toBe(true)
    expect(inPublishedPeriod(null, '30d', NOW)).toBe(false)
    expect(inPublishedPeriod(null, 'all', NOW)).toBe(true)
  })
  test('counts: Tudo keeps the real column of everything, published only inside the period', () => {
    const list = [
      c('queue'), c('running', { liveState: 'working' }), c('leader', { old: true }), c('blocked'),
      c('published', { deliveredAtMs: NOW - H }), c('published', { deliveredAtMs: NOW - 50 * H }),
    ]
    expect(liveTabCounts(list, '24h', NOW)).toEqual({ active: 2, queue: 1, published: 1, all: 5 })
    expect(liveTabCounts(list, '7d', NOW)).toEqual({ active: 2, queue: 1, published: 2, all: 6 })
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

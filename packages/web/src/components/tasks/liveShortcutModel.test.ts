import { expect, test } from 'bun:test'
import type { FleetRow } from '../../lib/fleet'
import { HOVER_OPEN_MS, liveActivity, popoverClickGoes, shortcutLabel } from './liveShortcutModel'
import { LIVE_DEFAULTS, cardPills, isQueued, queuePosition, type LiveCard } from './liveDeliveryModel'

const row = (state: string) => ({ id: state, state }) as unknown as FleetRow
const card = (key: string, stage: string, since: number | null, agents: LiveCard['agents'] = [], harnesses: string[] = [], models: string[] = []): LiveCard =>
  ({ d: { key, stage, stageSinceMs: since, harnesses, models } as never, agents, liveState: 'none', alert: false })

test('activity counts working agents and sessions waiting on the owner', () => {
  expect(liveActivity([row('working'), row('working'), row('waiting-approval'), row('waiting'), row('exited')])).toEqual({ working: 2, waiting: 1 })
  expect(shortcutLabel({ working: 2, waiting: 1 }, false)).toContain('1 waiting on you')
  expect(HOVER_OPEN_MS).toBeGreaterThanOrEqual(250)
})

test('a click on the popover surface goes; on a card or control it does not', () => {
  const t = (hit: boolean) => ({ closest: () => (hit ? {} : null) })
  expect(popoverClickGoes(t(false))).toBe(true)
  expect(popoverClickGoes(t(true))).toBe(false)
})

test('Live opens with both switches ON, all tasks, all steps, highest priority first', () => {
  expect(LIVE_DEFAULTS).toEqual({ taskIds: [], onlyActive: true, showQueue: true, stage: 'all', sort: 'priority' })
})

test('queued cards are recognised and numbered oldest first', () => {
  const a = card('a', 'queue', 100), b = card('b', 'queue', 50), r = card('r', 'running', 10)
  expect(isQueued(a)).toBe(true); expect(isQueued(r)).toBe(false)
  expect(queuePosition([a, b, r], b)).toBe(1)
  expect(queuePosition([a, b, r], a)).toBe(2)
  expect(queuePosition([a, b, r], r)).toBeNull()
})

test('pills: runtime with effort only when reported, account on its own line', () => {
  const ag = (effort: string | null) => [{ id: 's', harness: 'claude', model: 'claude-opus-5-5', effort, accountId: 'x', state: 'working', stateLabel: '' }] as never
  const acc = () => 'Principal'
  expect(cardPills(card('k', 'running', 1, ag('high')), acc, 'account')).toEqual({ runtime: 'claude · Opus 5.5 · high', account: 'account · Principal' })
  expect(cardPills(card('k', 'running', 1, ag(null)), acc, 'account').runtime).toBe('claude · Opus 5.5')
  expect(cardPills(card('k', 'queue', 1, [], ['codex'], ['gpt']), () => null, 'account')).toEqual({ runtime: 'codex · gpt', account: null })
})

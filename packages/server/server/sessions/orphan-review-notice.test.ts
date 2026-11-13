import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ORPHAN_INDIVIDUAL_CAP, orphanHours, planOrphanNotices, sweepOrphanReviews, type OrphanCard } from './orphan-review-notice'

const NOW = Date.parse('2026-11-13T15:00:00.000Z')
const H = 3600_000
const card = (key: string, o: Partial<OrphanCard> = {}): OrphanCard =>
  ({ key, title: `Piece ${key}`, stage: 'leader', stageSinceMs: NOW - 30 * H, leaderAvailability: 'absent', ...o })

test('a card without a leader for over 24 h gets ONE notice carrying its title and the action', () => {
  const plan = planOrphanNotices({ cards: [card('t/a')], nowMs: NOW, said: new Set(), leaderLive: false })
  expect(plan.notices).toHaveLength(1)
  expect(plan.notices[0]).toMatchObject({ code: 'delivery.orphan-review', meta: { title: 'Piece t/a', hours: 24, to: 'user', action: 'review-or-abandon' } })
  expect(plan.mark).toEqual(['t/a|leader'])
})

test('the notice goes to the live leader when one exists, else to the user', () => {
  expect(planOrphanNotices({ cards: [card('t/a')], nowMs: NOW, said: new Set(), leaderLive: true }).notices[0]!.meta).toMatchObject({ to: 'leader' })
})

test('under the threshold, with a leader, or in another stage: silent', () => {
  const cards = [card('t/young', { stageSinceMs: NOW - 2 * H }), card('t/led', { leaderAvailability: 'available' }), card('t/run', { stage: 'running' }), card('t/unknown', { leaderAvailability: 'unknown' })]
  expect(planOrphanNotices({ cards, nowMs: NOW, said: new Set(), leaderLive: false }).notices).toHaveLength(0)
})

test('a piece already said is never said again (dedupe by piece + phase)', () => {
  expect(planOrphanNotices({ cards: [card('t/a')], nowMs: NOW, said: new Set(['t/a|leader']), leaderLive: false }).notices).toHaveLength(0)
})

test('the threshold is configurable', () => {
  const c = [card('t/a', { stageSinceMs: NOW - 5 * H })]
  expect(planOrphanNotices({ cards: c, nowMs: NOW, said: new Set(), leaderLive: false, hours: 4 }).notices).toHaveLength(1)
  expect(planOrphanNotices({ cards: c, nowMs: NOW, said: new Set(), leaderLive: false, hours: 6 }).notices).toHaveLength(0)
  expect(orphanHours(undefined)).toBe(24); expect(orphanHours('6')).toBe(6); expect(orphanHours('abc')).toBe(24); expect(orphanHours('-1')).toBe(24)
})

test('the old pile is ONE summary notice, and every piece is still settled in the ledger', () => {
  const old = Array.from({ length: 142 }, (_, i) => card(`t/old${i}`, { old: true }))
  const plan = planOrphanNotices({ cards: [card('t/new'), ...old], nowMs: NOW, said: new Set(), leaderLive: false })
  expect(plan.notices.map(n => n.code)).toEqual(['delivery.orphan-review', 'delivery.orphan-review-many'])
  expect(plan.notices[1]!.meta).toMatchObject({ count: 142 })
  expect(plan.mark).toHaveLength(143)
})

test('more fresh pieces than the cap spill into the summary', () => {
  const many = Array.from({ length: ORPHAN_INDIVIDUAL_CAP + 3 }, (_, i) => card(`t/n${i}`))
  const plan = planOrphanNotices({ cards: many, nowMs: NOW, said: new Set(), leaderLive: false })
  expect(plan.notices.filter(n => n.code === 'delivery.orphan-review')).toHaveLength(ORPHAN_INDIVIDUAL_CAP)
  expect(plan.notices.at(-1)!.meta).toMatchObject({ count: 3 })
})

test('the ledger survives a restart: a second sweep over the same cards delivers nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orphan-'))
  const sent: unknown[] = []
  const deliver = async (n: unknown) => { sent.push(n) }
  const run = () => sweepOrphanReviews({ cards: [card('t/a')], nowMs: NOW, dataDir: dir, leaderLive: false, deliver })
  await run(); await run()
  expect(sent).toHaveLength(1)
  expect(JSON.parse(readFileSync(join(dir, 'orphan-notices.json'), 'utf8')).said).toEqual(['t/a|leader'])
})

test('a failed delivery is not recorded, so the next sweep tries again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orphan-'))
  const failing = async () => { throw new Error('bell down') }
  expect(await sweepOrphanReviews({ cards: [card('t/a')], nowMs: NOW, dataDir: dir, leaderLive: false, deliver: failing })).toBeNull()
  const sent: unknown[] = []
  await sweepOrphanReviews({ cards: [card('t/a')], nowMs: NOW, dataDir: dir, leaderLive: false, deliver: async n => { sent.push(n) } })
  expect(sent).toHaveLength(1)
})

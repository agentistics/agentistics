import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PlanLimits } from '@agentistics/core'
import { PlanSessionBlock, PlanLimitBars, PlanLimitMeter, PlanUsageCard } from './PlanLimitMeter'

const H = 3_600_000
const now = Date.parse('2026-10-16T12:00:00')
const limits: PlanLimits = {
  harness: 'claude', source: 'claude-stream', updatedAt: now - H,
  windows: [{ kind: '5h', usedPct: 80, resetsAt: now - H }],
} as unknown as PlanLimits

test('a renewed window keeps the "no reading since" wording and adds the estimated reset (EN)', () => {
  const html = renderToStaticMarkup(<PlanSessionBlock limits={limits} now={now} lang="en" />)
  expect(html).toContain('renewed — no reading since')
  expect(html).toContain('estimated reset')
  expect(html).not.toContain('0% used')
  expect(html).not.toContain('100% left')
})

test('a renewed window says it in Portuguese and shows a dash, not 0%', () => {
  const html = renderToStaticMarkup(<PlanSessionBlock limits={limits} now={now} lang="pt" />)
  expect(html).toContain('renovado — sem leitura desde então')
  expect(html).toContain('renovação estimada')
  expect(html).not.toContain('0% usado')
  expect(html).not.toContain('restam 100%')
})

test('meter and compact bars show the dash for a renewed window', () => {
  const m = renderToStaticMarkup(<PlanLimitMeter window={limits.windows[0]!} now={now} lang="en" />)
  expect(m).toContain('–')
  expect(m).toContain('renewed — no reading since')
  const b = renderToStaticMarkup(<PlanLimitBars limits={limits} now={now} lang="en" />)
  expect(b).toContain('estimated reset')
})

test('a live window is unchanged', () => {
  const live = { ...limits, windows: [{ kind: '5h', usedPct: 80, resetsAt: now + H }] } as unknown as PlanLimits
  const html = renderToStaticMarkup(<PlanSessionBlock limits={live} now={now} lang="en" />)
  expect(html).toContain('80%')
  expect(html).toContain('20% left')
  expect(html).not.toContain('estimated reset')
})

test('compact values stay on one line and renewed explanations span the whole meter', () => {
  const mixed = { ...limits, windows: [limits.windows[0]!, { kind: 'week', usedPct: 77, resetsAt: now + 3 * 24 * H }] } as PlanLimits
  const h = renderToStaticMarkup(<PlanLimitBars limits={mixed} now={now} lang="pt" />)
  expect(h).toContain('data-plan-renewal="true" style="grid-column:1 / -1')
  expect(h).toMatch(/data-plan-window="week" style="[^"]*white-space:nowrap[^"]*">77% · /)
  expect(h).not.toContain('overflow-wrap:anywhere')
  expect(h).not.toContain('break-all')
})

test('a long window title wraps inside its card instead of overflowing', () => {
  const l: PlanLimits = { harness: 'antigravity', account: 'a', source: 'antigravity-quota-api', updatedAt: 1, windows: [{ kind: 'week', usedPct: 4, resetsAt: 9e12, scope: { id: 'x', label: 'Claude and GPT models', models: [], providers: [] } }] } as PlanLimits
  const h = renderToStaticMarkup(<PlanUsageCard limits={l} now={2} lang="pt" />)
  const b = h.slice(h.lastIndexOf('<b ', h.indexOf('4% usado')), h.indexOf('4% usado'))
  expect(b).toContain('white-space:normal')
  expect(b).not.toContain('white-space:nowrap')
})

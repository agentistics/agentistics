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

test('Go provider refusal shows the block with no invented percentage or reset', () => {
  const go: PlanLimits = { harness: 'opencode', account: 'default', source: 'opencode-cost-estimate', updatedAt: now,
    sourcePlan: 'OpenCode Go', windows: [], unmeasuredReason: 'Go usage limit exceeded. On hold; reset unknown.' }
  for (const html of [
    renderToStaticMarkup(<PlanSessionBlock limits={go} now={now} lang="pt" />),
    renderToStaticMarkup(<PlanUsageCard limits={go} now={now} lang="pt" />),
  ]) {
    expect(html).toContain('Go bloqueado pelo limite do provedor')
    expect(html).toContain('Renovação desconhecida')
    expect(html).not.toContain('49.8')
    expect(html).not.toContain('zera ')
    expect(html).not.toContain('com folga')
  }
})

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
  expect(html).toContain('>80<')
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
  const at = h.indexOf('Semana · ')
  const b = h.slice(h.lastIndexOf('<b ', at), at)
  expect(b).toContain('white-space:normal')
  expect(b).not.toContain('white-space:nowrap')
  expect(h).not.toMatch(/Semana · [^<]*% usado/)
})

import { ringResetPhrase } from '../lib/planLimits'
import { PlanUsageSummary } from './PlanLimitMeter'
import { fmtWhen } from '../lib/planLimits'
import { PlanUsageIndicator } from './PlanLimitMeter'

test('compact indicator maps 5h to the upper arc and week to the lower arc independently', () => {
  const html = renderToStaticMarkup(<PlanUsageIndicator limits={{ ...live, windows: [{ kind: 'week', usedPct: 95, resetsAt: now + 3 * day }, { kind: '5h', usedPct: 1, resetsAt: now + H }] }} now={now} lang="pt" />)
  expect(html).toMatch(/data-plan-indicator-arc="5h" data-position="top"[\s\S]*?stroke-dasharray="1 100"/)
  expect(html).toMatch(/data-plan-indicator-arc="week" data-position="bottom"[\s\S]*?stroke-dasharray="95 100"/)
  expect(html).toContain('tabindex="0"')
  expect(html).toContain('Semana 95%')
  expect(html).toContain('5 h 1%')
})

test('compact indicator: both arcs start on the same (left) side and fill toward the right', () => {
  const html = renderToStaticMarkup(<PlanUsageIndicator limits={{ ...live, windows: [{ kind: 'week', usedPct: 40, resetsAt: now + 3 * day }, { kind: '5h', usedPct: 20, resetsAt: now + H }] }} now={now} lang="pt" />)
  const start = (kind: string) => {
    const g = html.match(new RegExp(`data-plan-indicator-arc="${kind}"[\\s\\S]*?d="M ([\\d.]+) [\\d.]+ A [\\d.]+ [\\d.]+ 0 0 [01] ([\\d.]+) [\\d.]+"`))
    if (!g) throw new Error(`no arc path for ${kind}`)
    return { from: Number(g[1]), to: Number(g[2]) }
  }
  const fiveHour = start('5h')
  const week = start('week')
  // The dash fill is drawn from the path's first point: the same starting x means the same side.
  expect(week.from).toBe(fiveHour.from)
  expect(fiveHour.from).toBeLessThan(fiveHour.to)
  expect(week.from).toBeLessThan(week.to)
})

test('compact indicator preserves scoped readings and unknown windows', () => {
  const html = renderToStaticMarkup(<PlanUsageIndicator limits={{ ...live, windows: [{ kind: 'week', usedPct: 80, resetsAt: now + day, scope: { id: 'a', label: 'Group A', models: [], providers: [] } }, { kind: 'week', usedPct: 20, resetsAt: now + day, scope: { id: 'b', label: 'Group B', models: [], providers: [] } }] }} now={now} lang="en" />)
  expect(html).toContain('Group A')
  expect(html).toContain('Group B')
  expect(html).toContain('stroke-dasharray="80 100"')
  expect(html).not.toContain('5 h 0%')
})

// POPUP.USO-RESET — a tiny "zera <local time>" under each ring, nothing when the reset is unknown.
const day = 24 * H
const live: PlanLimits = {
  harness: 'claude', source: 'claude-usage-api', updatedAt: now - 60_000, plan: 'Claude Max 5x',
  windows: [
    { kind: '5h', usedPct: 40, resetsAt: now + 2 * H },
    { kind: 'week', usedPct: 20, resetsAt: now + 3 * day },
  ],
} as unknown as PlanLimits

test('ring reset: today reads "zera HH:MM", a later day names the weekday, in both languages', () => {
  const five = live.windows[0]!, week = live.windows[1]!
  expect(ringResetPhrase(five, now, 'pt')).toBe(`zera ${fmtWhen(five.resetsAt, now, 'pt')}`)
  expect(ringResetPhrase(five, now, 'pt')).toMatch(/^zera \d{2}:\d{2}$/)
  expect(ringResetPhrase(week, now, 'pt')).toMatch(/^zera [^\d\s]+ \d{2}:\d{2}$/)
  expect(ringResetPhrase(five, now, 'en')).toMatch(/^resets /)
})

test('ring reset: nothing when unknown — a renewed window, a past or missing time', () => {
  expect(ringResetPhrase({ kind: '5h', usedPct: 80, resetsAt: now - H } as never, now, 'pt')).toBeNull()
  expect(ringResetPhrase({ kind: '5h', usedPct: 10, resetsAt: Number.NaN } as never, now, 'pt')).toBeNull()
  expect(ringResetPhrase({ kind: '5h', usedPct: 10 } as never, now, 'pt')).toBeNull()
})

test('the usage popup draws the line under each ring, and only where a reset is known', () => {
  const html = renderToStaticMarkup(<PlanUsageSummary limits={[live]} now={now} lang="pt" />)
  expect(html.match(/data-plan-ring-reset/g)?.length).toBe(2)
  expect(html).toMatch(/zera \d{2}:\d{2}/)
  const none = renderToStaticMarkup(<PlanUsageSummary limits={[{ ...live, windows: [{ kind: '5h', usedPct: 80, resetsAt: now - H }] } as unknown as PlanLimits]} now={now} lang="pt" />)
  expect(none).not.toContain('data-plan-ring-reset')
})

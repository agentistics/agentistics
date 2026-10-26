import { expect, spyOn, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PlanLimits } from '@agentistics/core'
import { PlanLimitBars, PlanLimitsBlock, PlanUsageCard } from '../components/PlanLimitMeter'
import { SOURCE_LABEL, limitNoticeMeta, limitNoticeText, windowLabel, windowShortLabel } from './planLimits'

const NOW = Date.parse('2026-10-28T12:00:00Z')
const gemini = { id: 'google', label: 'Gemini models', models: ['gemini-3.1-pro'], providers: ['google'] }
const claudeGpt = { id: 'anthropic+openai', label: 'Claude and GPT models', models: ['claude-sonnet-4-6'], providers: ['anthropic', 'openai'] }
const agy: PlanLimits = {
  harness: 'antigravity', account: 'default', updatedAt: NOW, source: 'antigravity-quota-api', plan: 'Google AI Plus',
  windows: [
    { kind: 'week', usedPct: 4, resetsAt: NOW + 3 * 86_400_000, scope: gemini },
    { kind: 'week', usedPct: 0, resetsAt: NOW + 3 * 86_400_000 + 840_000, scope: claudeGpt },
  ],
}

test('scoped labels: group name beside the window, short form is the group alone', () => {
  expect(windowLabel('week', 'pt', gemini)).toBe('Semana · Modelos Gemini')
  expect(windowLabel('week', 'en', claudeGpt)).toBe('Week · Claude and GPT models')
  expect(windowLabel('week', 'pt', claudeGpt)).toBe('Semana · Modelos Claude e GPT')
  expect(windowLabel('week', 'en', { id: 'xai', label: 'Xai models' })).toBe('Week · Xai models')
  expect(windowShortLabel('week', 'pt', gemini)).toBe('Gemini')
  expect(windowShortLabel('week', 'pt', claudeGpt)).toBe('Claude e GPT')
  expect(windowLabel('week', 'pt')).toBe('Semana')
})

test('the source has its label', () => {
  expect(SOURCE_LABEL['antigravity-quota-api']).toEqual({ pt: 'cota do Antigravity', en: 'Antigravity quota' })
})

test('two scoped windows render two meters with distinct keys and no React key warning', () => {
  const err = spyOn(console, 'error').mockImplementation(() => {})
  try {
    for (const html of [
      renderToStaticMarkup(<PlanLimitsBlock limits={agy} now={NOW} lang="pt" />),
      renderToStaticMarkup(<PlanLimitBars limits={agy} now={NOW} lang="en" />),
      renderToStaticMarkup(<PlanUsageCard limits={agy} now={NOW} lang="pt" />),
    ]) {
      expect((html.match(/data-plan-window="week:(google|anthropic\+openai)"/g) ?? []).length).toBeGreaterThanOrEqual(2)
    }
    expect(renderToStaticMarkup(<PlanLimitsBlock limits={agy} now={NOW} lang="pt" />)).toContain('Semana · Modelos Gemini')
    expect(renderToStaticMarkup(<PlanLimitBars limits={agy} now={NOW} lang="en" />)).toContain('Claude and GPT')
    const dup = err.mock.calls.filter(c => String(c[0]).includes('same key'))
    expect(dup).toEqual([])
  } finally { err.mockRestore() }
})

test('unscoped rendering is unchanged', () => {
  const claude: PlanLimits = { harness: 'claude', account: 'default', updatedAt: NOW, source: 'claude-stream', windows: [{ kind: '5h', usedPct: 10, resetsAt: NOW + 3_600_000 }, { kind: 'week', usedPct: 20, resetsAt: NOW + 86_400_000 }] }
  const html = renderToStaticMarkup(<PlanLimitsBlock limits={claude} now={NOW} lang="pt" />)
  expect(html).toContain('Sessão 5 h')
  expect(html).not.toContain('·  Modelos')
  expect(html).not.toContain('Modelos')
})

test('a scoped notice names the group', () => {
  const m = limitNoticeMeta({ harness: 'antigravity', window: 'week', threshold: 85, pct: 86, resetsAt: NOW + 86_400_000, scopeId: 'google', scopeLabel: 'Gemini models' })!
  expect(m.scope?.id).toBe('google')
  expect(limitNoticeText(m, 'pt', NOW).title).toBe('Antigravity · Modelos Gemini: 86% da semana usada')
  expect(limitNoticeText(m, 'en', NOW).title).toBe('Antigravity · Gemini models: 86% of the week used')
  // each fact once: the body carries only the renewal
  expect(limitNoticeText(m, 'pt', NOW).message).toMatch(/^Renova .* \(em .*\)\.$/)
  expect(limitNoticeText(m, 'pt', NOW).message).not.toMatch(/Modelos|86|semana/i)
  expect(limitNoticeText(m, 'en', NOW).message).not.toMatch(/Gemini|86|week/i)
  expect(limitNoticeMeta({ harness: 'claude', window: '5h', threshold: 85, pct: 86, resetsAt: NOW })?.scope).toBeUndefined()
})

test('seriesName shows the harness only when the account label lacks it', async () => {
  const { seriesName } = await import('./planLimits')
  expect(seriesName('Antigravity', 'Antigravity #1')).toBe('Antigravity #1')
  expect(seriesName('Claude Code', 'Claude Code')).toBe('Claude Code')
  expect(seriesName('Claude Code', 'claude code #2')).toBe('claude code #2')
  expect(seriesName('Codex CLI', 'Work')).toBe('Codex CLI · Work')
  expect(seriesName('Codex CLI', '')).toBe('Codex CLI')
})

test('PT render: every meter surface names the scoped groups in Portuguese', () => {
  const bars = renderToStaticMarkup(<PlanLimitBars limits={agy} now={NOW} lang="pt" />)
  const card = renderToStaticMarkup(<PlanUsageCard limits={agy} now={NOW} lang="pt" />)
  for (const html of [bars, card]) {
    expect(html).toMatch(/Gemini/)
    expect(html).toMatch(/Claude e GPT/)
    expect(html).not.toMatch(/Claude and GPT/)
  }
})

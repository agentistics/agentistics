import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CleanScanState } from '@agentistics/core'
import { CleanScanView } from './CleanDialog'
import { TabSelect } from '../pages/settings/primitives'
import { readFileSync } from 'node:fs'
const scan: CleanScanState = { id: 'scan', state: 'scanning', step: 2, label: 'measuring', progress: .46, etaMs: 40_000, startedAt: 1000, elapsedMs: 10_000,
  foundBytes: 1.5 * 1024 ** 3, itemCount: 37, projectCount: 2, projectTotal: 5, background: false,
  log: [{ at: 1000, state: 'done', name: 'completed-name', bytes: 1024 }, { at: 1100, state: 'running', name: 'running-name' }, { at: 1200, state: 'queued', name: 'queued-project' }] }
test('live scan shows localized bytes, counters, step, ETA, progress and all three log states', () => {
  const html = renderToStaticMarkup(<CleanScanView scan={scan} lang="pt" />)
  for (const label of ['Encontrado até agora', '1,5 GB', 'Etapa', '46%', 'cerca de 40 s', 'O que está acontecendo', 'completed-name', 'medindo ', 'na fila: ', 'role="log"', 'value="0.46"']) expect(html).toContain(label)
})
test('the same state is readable in English, and first render has no stale progress', () => {
  const html = renderToStaticMarkup(<CleanScanView scan={scan} lang="en" />)
  for (const label of ['Found so far', '1.5 GB', 'Step', 'about 40 s', 'queued: ']) expect(html).toContain(label)
  const initial = renderToStaticMarkup(<CleanScanView scan={null} lang="en" />)
  expect(initial).toContain('0 B')
  expect(initial).toContain('estimating time')
  expect(initial).not.toContain('completed-name')
})
test('unknown scan labels show a localized generic checking step', () => {
  for (const lang of ['pt', 'en'] as const) {
    const html = renderToStaticMarkup(<CleanScanView scan={{ ...scan, label: 'unexpected-step' as CleanScanState['label'] }} lang={lang} />)
    expect(html).toContain(lang === 'pt' ? 'Verificando' : 'Checking')
    expect(html).toContain('46%')
  }
})
test('mini-log shows seconds and only completed rows have measured sizes', () => {
  const html = renderToStaticMarkup(<CleanScanView scan={{ ...scan, log: [{ at: 1000, state: 'running', name: 'pending', bytes: 0 }, { at: 2000, state: 'done', name: 'measured', bytes: 1024 }] }} lang="pt" />)
  expect(html).toMatch(/\d{2}:\d{2}:\d{2}/)
  expect(html).not.toContain('0 B')
  expect(html).toContain('1 KB')
})

test('wrapping chips keep all four borders, including the last option', () => {
  const options = [{ value: 'all', label: 'Todos 21' }, { value: 'idle', label: 'Parados há +7 dias 15' }]
  const chips = renderToStaticMarkup(<TabSelect wrap options={options} value="all" onChange={() => {}} />)
  expect(chips).toContain('flex-wrap:wrap')
  expect(chips).not.toContain('border-right:')
  expect(chips.match(/border:1px solid/g)).toHaveLength(2)
  const segmented = renderToStaticMarkup(<TabSelect options={options} value="all" onChange={() => {}} />)
  expect(segmented).toContain('border-right:none')
})
test('project, folder and scan-log names wrap without CSS truncation', () => {
  const css = readFileSync(new URL('./CleanDialog.css', import.meta.url), 'utf8')
  expect(css).not.toContain('text-overflow: ellipsis')
  for (const selector of ['.clean-log-name', '.clean-card-name, .clean-card-subtitle', '.clean-table th, .clean-table td']) {
    const rule = css.slice(css.indexOf('\n' + selector + ' {')).split('}')[0]!
    expect(rule).toContain('white-space: normal')
    expect(rule).toContain('overflow-wrap: anywhere')
  }
})

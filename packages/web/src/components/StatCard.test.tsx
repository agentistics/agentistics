import { readFileSync } from 'node:fs'
import { TokenStatCard } from './TokenStatCard'
import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { StatCard } from './StatCard'

test('all KPI headers place the label above controls on the same baseline', () => {
  const root = globalThis as { window?: unknown }
  const previous = root.window
  root.window = { innerWidth: 1440 }
  try {
    for (const label of ['Est. cost', 'Custo est.']) {
      const html = renderToStaticMarkup(<StatCard label={label} value="USD 0.00" icon={<span>icon</span>} info={{ source: 'API pricing' }} action={<span>USD</span>} />)
      expect(html).toContain(label)
      expect(html).toContain('white-space:nowrap')
      expect(html).toContain('flex-wrap:wrap')
      expect(html).toContain('align-items:flex-start;flex-direction:column;gap:6px;min-height:54px')
      expect(html).not.toContain('text-overflow:ellipsis')
    }
  } finally { if (previous === undefined) delete root.window; else root.window = previous }
})

test('longest-session sub-line stays complete and wraps in the shared card', () => {
  const root = globalThis as { window?: unknown }
  const previous = root.window
  root.window = { innerWidth: 390 }
  try {
  const sub = 'ativo · 1h 48m decorrido · 123 msgs · a-very-long-project-folder'
  const html = renderToStaticMarkup(<StatCard label="Longest session" value="53m" sub={sub} icon={<span />} />)
  expect(html).toContain(sub)
  expect(html).toContain('white-space:pre-line;overflow-wrap:anywhere')
  expect(html).not.toContain('text-overflow:ellipsis')
  } finally { if (previous === undefined) delete root.window; else root.window = previous }
})

test('shared KPI touch rule reaches info, currency and other supplied action buttons', () => {
  const root = globalThis as { window?: unknown }
  const previous = root.window
  root.window = { innerWidth: 390 }
  try {
    const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8')
    const rule = css.slice(css.indexOf('.ag-stat-card button {'))
    expect(rule).toContain('min-width: 44px')
    expect(rule).toContain('min-height: 44px')
    for (const lang of ['pt', 'en'] as const) {
      const html = renderToStaticMarkup(<StatCard label="Cost" lang={lang} value="0" icon={<span />} info={{ source: 'API' }} action={<button>BRL</button>} />)
      expect(html).toContain('class="ag-stat-card"')
      expect(html).toContain('<button>BRL</button>')
      expect(html).toContain(lang === 'pt' ? 'aria-label="Sobre Cost"' : 'aria-label="About Cost"')
      const tokens = renderToStaticMarkup(<TokenStatCard tokens={{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }} lang={lang} info={{ source: 'API' }} onInfoClick={() => {}} />)
      expect(tokens).toContain('class="ag-stat-card"')
      expect(tokens).toContain(lang === 'pt' ? 'Sobre este número' : 'About this number')
    }
  } finally { if (previous === undefined) delete root.window; else root.window = previous }
})

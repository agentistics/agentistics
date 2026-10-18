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

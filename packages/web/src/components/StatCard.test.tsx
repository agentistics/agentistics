import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { StatCard } from './StatCard'

test('narrow KPI headers keep complete cost labels and wrap the controls', () => {
  const root = globalThis as { window?: unknown }
  const previous = root.window
  root.window = { innerWidth: 1440 }
  try {
    for (const label of ['Est. cost', 'Custo est.']) {
      const html = renderToStaticMarkup(<StatCard label={label} value="USD 0.00" icon={<span>icon</span>} info={{ source: 'API pricing' }} action={<span>USD</span>} />)
      expect(html).toContain(label)
      expect(html).toContain('white-space:nowrap')
      expect(html).toContain('flex-wrap:wrap')
      expect(html).not.toContain('text-overflow:ellipsis')
    }
  } finally { if (previous === undefined) delete root.window; else root.window = previous }
})

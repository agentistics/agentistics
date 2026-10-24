import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ToolActivity, type ToolActivityVariant } from './ToolActivity'
import { SystemEventRow } from './ChatBubble'
import { stepsOfTurn, type StepStatus } from '../../lib/toolActivity'

const g = globalThis as Record<string, unknown>
g.window ??= { innerWidth: 1280, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {} }

for (const width of [1280, 390]) {
  for (const variant of ['divider', 'inline', 'live'] as ToolActivityVariant[]) {
    test(`${variant} at ${width}: contextual icon precedes text, same icon/gap as system events`, () => {
      const original = window.innerWidth
      Object.assign(window, { innerWidth: width })
      try {
        const steps = stepsOfTurn({ role: 'assistant', text: '', tools: [{ name: 'Bash' }] })
        for (const status of ['done', 'running', 'error', 'unfinished'] as StepStatus[]) {
          steps[0]!.status = status
          const html = renderToStaticMarkup(<ToolActivity group={{ key: 'test', steps, running: status === 'running' }} lang="pt" variant={variant} now={0} />)
          const system = renderToStaticMarkup(<SystemEventRow event={{ kind: 'handback', body: 'ok' }} pt />)
          expect(html).toMatch(/aria-expanded="false"[^>]*gap:5px/)
          expect(system).toMatch(/aria-expanded="false"[^>]*gap:5px/)
          expect(html).toMatch(/data-activity-icon="run"[^>]*width:14px;height:14px/)
          expect(html.indexOf('data-activity-icon')).toBeLessThan(html.indexOf('<span title='))
          expect(html).not.toContain('padding-left:36px')
          if (width === 390) expect(html).toContain('min-height:44px')
        }
      } finally { Object.assign(window, { innerWidth: original }) }
    })
  }
}

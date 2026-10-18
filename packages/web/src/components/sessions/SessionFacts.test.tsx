import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ControlSession } from '@agentistics/tui/control/session-fleet'
import { SessionFacts } from './SessionFacts'

for (const lang of ['pt', 'en'] as const) test(`stacked session facts keep title, harness and model readable in ${lang}`, () => {
  const session = {
    id: 'leader', title: 'A long session title with all the context that must remain visible',
    task: 'A long task name that wraps inside a narrow dock row', harness: 'claude',
    model: 'claude-sonnet-5-with-a-long-model-suffix', state: 'waiting', stateLabel: 'Needs you',
  } as ControlSession
  const html = renderToStaticMarkup(<SessionFacts session={session} lang={lang} />)
  for (const text of [session.title, session.task!, session.model!, 'Claude Code']) expect(html).toContain(text)
  expect(html).toContain('white-space:normal;overflow-wrap:anywhere')
  expect(html).toContain('flex-wrap:wrap')
  expect(html).not.toContain('text-overflow:ellipsis')
  expect(html).not.toContain('white-space:nowrap')
})

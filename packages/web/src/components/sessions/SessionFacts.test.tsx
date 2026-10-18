import React from 'react'
import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ControlSession } from '@agentistics/tui/control/session-fleet'
import { SessionFacts } from './SessionFacts'
import { RailFolderFacts } from '../nav/SessionsRail'

const session = { id: 'live', title: 'Live work', harness: 'claude', state: 'waiting', stateLabel: 'precisa de você', model: 'claude-opus-5-5', effort: 'high' } as ControlSession

test('card and rail metadata keep every fact without separators that can wrap alone', () => {
  for (const model of [undefined, session.model]) {
    for (const withEffort of [false, true]) {
      const html = renderToStaticMarkup(<SessionFacts session={{ ...session, model }} withEffort={withEffort} />)
      expect(html).not.toContain('·')
      expect(html).toContain('precisa de você')
      expect(html).toContain('Claude Code')
      if (model) expect(html).toContain(model)
      if (withEffort) expect(html).toContain('high')
      expect(html).toContain('flex-wrap:wrap')
      expect(html).toContain('column-gap:10px')
      expect(html).not.toContain('white-space:nowrap')
    }
  }
})


test('rail folder facts wrap as units and leave out zero counts in PT and EN', () => {
  for (const pt of [true, false]) {
    const html = renderToStaticMarkup(<RailFolderFacts counts={{ folders: 2, waiting: 3, active: 1, ended: 0 }} pt={pt} />)
    expect(html).not.toContain('·')
    expect(html).toContain(`<span>2 ${pt ? 'pastas' : 'folders'}</span>`)
    expect(html).toContain(`<span>3 ${pt ? 'aguardando' : 'waiting'}</span>`)
    expect(html).not.toContain(pt ? 'encerradas' : 'ended')
  }
})

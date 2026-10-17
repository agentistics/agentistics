import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { CheckinModalView } from './CheckinModal'
import type { CheckinRound } from '../../lib/checkin'

const round: CheckinRound = {
  state: 'needs_you', summary: 's', headline: 'Two releases ready', at: 1,
  needs: [{ subject: 'Release 2.1', text: 'approve the publish' }],
  delivered: [{ text: 'Modal redesign', ref: '#12' }],
  inProgress: [{ item: 'CHECKIN.MODAL', stage: 'QA', release: '17c' }],
  next: [{ text: 'Cut release', when: 'tonight' }],
  health: [{ label: 'Fleet', value: '5 up', state: 'ok' }, { label: 'Limits', value: '85%', state: 'warn' }],
}

test.each([false, true])('modal shows needs first, then sections, chip and timeline (mobile=%s)', isMobile => {
  const html = renderToStaticMarkup(<CheckinModalView round={round} history={[{ id: 'e1', at: '2026-10-17T10:00:00Z', headline: 'Earlier round', state: 'ok' } as never]} pt={false} isMobile={isMobile} onClose={() => {}} />)
  expect(html).toContain('data-testid="checkin-modal"')
  expect(html).toContain('aria-modal="true"')
  expect(html.indexOf('Needs you')).toBeLessThan(html.indexOf('Delivered'))
  for (const t of ['In progress', 'Next steps', 'Health', 'Earlier rounds', 'Earlier round', 'release 17c']) expect(html).toContain(t)
  expect(html).toContain(isMobile ? 'border-radius:0' : 'max-width:720px')
  // past rounds start collapsed: their body is not rendered
  expect(html).toContain('aria-expanded="false"')
})

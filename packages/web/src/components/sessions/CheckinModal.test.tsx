import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { CheckinModalView, roundWhen, roundWithTime } from './CheckinModal'
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
  expect(html).toContain(isMobile ? 'border-radius:0' : 'max-width:960px')
  // past rounds start collapsed: their body is not rendered
  expect(html).toContain('aria-expanded="false"')
})

test('state chip is dropped when the needs box is present, shown otherwise', () => {
  const withBox = renderToStaticMarkup(<CheckinModalView round={round} history={[]} pt isMobile={false} onClose={() => {}} />)
  expect(withBox.match(/precisa de você/g)).toBeNull()
  expect(withBox).toContain('Precisa de você')
  const ok = renderToStaticMarkup(<CheckinModalView round={{ ...round, state: 'ok', needs: [] }} history={[]} pt isMobile={false} onClose={() => {}} />)
  expect(ok).toContain('tudo certo')
})

test('title uses the same time format as the rounds', () => {
  const html = renderToStaticMarkup(<CheckinModalView round={{ ...round, at: Date.now() }} history={[]} pt isMobile={false} onClose={() => {}} />)
  expect(html).not.toMatch(/Check-in · \d\dh\d\d/)
  expect(html).toMatch(/Check-in · \d\d:\d\d/)
})

test('round times: today, yesterday, older', () => {
  const now = new Date(2026, 9, 17, 12, 0).getTime()
  expect(roundWhen(new Date(2026, 9, 17, 11, 43).getTime(), true, now)).toBe('11:43')
  expect(roundWhen(new Date(2026, 9, 16, 18, 2).getTime(), true, now)).toBe('ontem 18:02')
  expect(roundWhen(new Date(2026, 9, 15, 18, 2).getTime(), true, now)).toBe('15/10 18:02')
})

test('a round stored without its own time takes the run time, so the title has one', () => {
  const stored = { last: { state: 'ok' as const, summary: 's' }, lastRunAt: Date.now() }
  expect(roundWithTime(stored)?.at).toBe(stored.lastRunAt)
  expect(roundWithTime({ last: null, lastRunAt: 5 })).toBeNull()
  expect(roundWithTime({ last: { state: 'ok', summary: 's', at: 7 }, lastRunAt: 5 })?.at).toBe(7)
})

test('close button has a 44px hit area on mobile only', () => {
  const m = renderToStaticMarkup(<CheckinModalView round={round} history={[]} pt isMobile onClose={() => {}} />)
  expect(m).toMatch(/width:44px;height:44px/)
  const d = renderToStaticMarkup(<CheckinModalView round={round} history={[]} pt isMobile={false} onClose={() => {}} />)
  expect(d).not.toMatch(/width:44px;height:44px/)
})

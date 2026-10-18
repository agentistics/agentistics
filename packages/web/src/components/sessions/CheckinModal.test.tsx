import { expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { CheckinModalView, roundWhen, roundWithTime } from './CheckinModal'
import type { CheckinRound } from '../../lib/checkin'

const round: CheckinRound = {
  state: 'needs_you', summary: 's', headline: 'Two releases ready', at: 1,
  needs: [{ subject: 'Release 2.1', text: 'approve the publish' }],
  delivered: [{ text: 'Modal redesign', ref: '#12' }],
  inProgress: [{ item: 'CHECKIN.MODAL', stage: 'Em andamento', release: '17c' }],
  next: [{ text: 'Cut release', when: 'tonight' }],
  health: [{ label: 'Fleet', value: '5 up', state: 'ok' }, { label: 'Limits', value: '85%', state: 'warn' }],
}

test.each([false, true])('modal shows needs first, then sections, chip and timeline (mobile=%s)', isMobile => {
  const html = renderToStaticMarkup(<CheckinModalView round={round} history={[{ id: 'e1', at: '2026-10-17T10:00:00Z', headline: 'Earlier round', state: 'ok' } as never]} pt={false} isMobile={isMobile} onClose={() => {}} />)
  expect(html).toContain('data-testid="checkin-modal"')
  expect(html).toContain('aria-modal="true"')
  const order = ['Two releases ready', 'Needs you', 'Delivered', 'In progress', 'Next steps', 'Health', 'Earlier rounds']
  for (let i = 1; i < order.length; i++) expect(html.indexOf(order[i - 1]!)).toBeLessThan(html.indexOf(order[i]!))
  expect(html).not.toContain('1.5fr')
  expect(html).not.toContain('ellipsis')
  expect(html).not.toContain('line-clamp')
  expect(html).toContain('white-space:nowrap') // stages stay intact within their pills
  expect(html).not.toContain('truncate')
  expect(html).toContain('data-testid="checkin-health-list"')
  expect(html.match(/class="ag-checkin-health-row"/g)).toHaveLength(2)
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

test('close button has a 32px desktop and 44px mobile hit area', () => {
  const m = renderToStaticMarkup(<CheckinModalView round={round} history={[]} pt isMobile onClose={() => {}} />)
  expect(m).toMatch(/width:44px;height:44px/)
  const d = renderToStaticMarkup(<CheckinModalView round={round} history={[]} pt isMobile={false} onClose={() => {}} />)
  expect(d).toMatch(/width:32px;height:32px/)
})


test('health wraps below its label on small screens and earlier rounds expand downward in place', async () => {
  const originalAct = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
  GlobalRegistrator.register({ width: 1280, height: 900 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const { createRoot } = await import('react-dom/client')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const fullText = 'The full health explanation stays visible, including its final sentence.'
  const oldBody = 'Earlier delivered item with a long explanation that must remain in this round.'
  const history = [{ id: 'older', at: '2026-10-17T10:00:00Z', headline: 'Earlier headline with enough words to wrap without an ellipsis',
    state: 'ok', delivered: [{ text: oldBody }] } as never]
  try {
    for (const width of [1280, 390]) {
      ;(window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport({ width, height: 900 })
      act(() => root.render(<CheckinModalView round={{ ...round, health: [{ label: 'Ligações dos assistentes com o agentistics', value: fullText, state: 'warn' }] }} history={history} pt={false} isMobile={width < 768} onClose={() => {}} />))
      const health = host.querySelector<HTMLElement>('.ag-checkin-health-row')!
      expect(health.textContent).toContain(fullText)
      expect(health.children[1]!.textContent).toBe('Ligações dos assistentes com o agentistics')
      const pill = host.querySelector<HTMLElement>('[data-checkin-progress] > span')!
      expect(pill.textContent).toBe('Em andamento')
      expect(getComputedStyle(pill).whiteSpace).toBe('nowrap')
      expect(getComputedStyle(pill).flexShrink).toBe('0')
      expect(getComputedStyle(health).gridTemplateColumns).toBe(width <= 480 ? '8px minmax(0, 1fr)' : '8px fit-content(40%) minmax(0, 1fr)')
      expect(getComputedStyle(health.querySelector('.ag-checkin-health-value')!).gridColumn).toBe(width <= 480 ? '2' : '')
      const timeline = host.querySelector('[data-testid="checkin-timeline"]')!
      const button = timeline.querySelector<HTMLButtonElement>('button')!
      expect(button.getAttribute('aria-expanded')).toBe('false')
      expect(timeline.textContent).not.toContain(oldBody)
      act(() => button.click())
      expect(button.getAttribute('aria-expanded')).toBe('true')
      expect(button.nextElementSibling?.textContent).toContain(oldBody)
      expect(button.querySelector('svg')!.style.transform).toBe('rotate(90deg)')
      expect(timeline.parentElement?.textContent).toContain(oldBody)
      expect(button.nextElementSibling?.querySelector('[data-testid="checkin-round-body"]')).not.toBeNull()
      act(() => button.click())
      expect(button.getAttribute('aria-expanded')).toBe('false')
      expect(timeline.textContent).not.toContain(oldBody)
    }
  } finally {
    await act(async () => root.unmount())
    host.remove()
    // Drain the scheduler while the DOM still exists, as in the other DOM suites.
    await new Promise(resolve => setTimeout(resolve, 50))
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originalAct
    await GlobalRegistrator.unregister()
  }
})

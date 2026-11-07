import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { NotificationRowBody } from './NotificationBell'

const base = { pt: false, title: 'T', message: 'MSG', isJournalFailed: false, isClean: false, onRetryJournal: () => {}, onClean: () => {} }

test('journal retry and cleanup actions both render after the message', () => {
  const html = renderToStaticMarkup(<NotificationRowBody {...base} isJournalFailed isClean />)
  const msg = html.indexOf('bell-message')
  for (const id of ['bell-journal-retry', 'bell-clean-action']) {
    expect(html.indexOf(id)).toBeGreaterThan(msg)
  }
})
test('no actions without flags', () => {
  const html = renderToStaticMarkup(<NotificationRowBody {...base} />)
  expect(html).not.toContain('bell-clean-action')
})

test('pinned cleanup uses the existing row body with live accessible progress and a completion action', () => {
  const html = renderToStaticMarkup(<NotificationRowBody {...base} isClean cleanReady progress={0.46} />)
  expect(html).toContain('bell-clean-progress')
  expect(html).toContain('value="0.46"')
  expect(html).toContain('max="1"')
  expect(html.indexOf('bell-clean-progress')).toBeGreaterThan(html.indexOf('bell-message'))
  expect(html).toContain('Review and clean')
})

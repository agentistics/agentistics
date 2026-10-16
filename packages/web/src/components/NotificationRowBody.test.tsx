import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { NotificationRowBody } from './NotificationBell'

const base = { pt: false, title: 'T', message: 'MSG', isJournalFailed: false, isClean: false, isAwayDigest: false, digestBusy: false, onAnswer: () => {}, onRetryJournal: () => {}, onClean: () => {} }

test('digest, journal retry and cleanup actions all render after the message', () => {
  const html = renderToStaticMarkup(<NotificationRowBody {...base} isJournalFailed isClean isAwayDigest />)
  const msg = html.indexOf('bell-message')
  for (const id of ['bell-journal-retry', 'bell-clean-action', 'away-digest-actions']) {
    expect(html.indexOf(id)).toBeGreaterThan(msg)
  }
})
test('no actions without flags', () => {
  const html = renderToStaticMarkup(<NotificationRowBody {...base} />)
  expect(html).not.toContain('bell-clean-action')
})

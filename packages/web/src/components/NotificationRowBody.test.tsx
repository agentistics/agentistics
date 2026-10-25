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

test('pinned cleanup uses the existing row body with live accessible progress and a completion action', () => {
  const html = renderToStaticMarkup(<NotificationRowBody {...base} isClean cleanReady progress={0.46} />)
  expect(html).toContain('bell-clean-progress')
  expect(html).toContain('value="0.46"')
  expect(html).toContain('max="1"')
  expect(html.indexOf('bell-clean-progress')).toBeGreaterThan(html.indexOf('bell-message'))
  expect(html).toContain('Review and clean')
})

test('a digest being built shows the server steps instead of the buttons: done ticked, current named, rest dim', () => {
  const html = renderToStaticMarkup(<NotificationRowBody {...base} pt isAwayDigest digestBusy digestPhase="send" />)
  expect(html).toContain('away-digest-progress')
  expect(html).not.toContain('away-digest-actions')
  expect(html.match(/data-state="done"/g)?.length).toBe(2)
  expect(html).toContain('data-state="now"')
  expect(html).toContain('Enviando para a Nay…')
  expect(html.match(/data-state="next"/g)?.length).toBe(1)
})

test('before the first step arrives the buttons stay (disabled), never a fake first step', () => {
  const html = renderToStaticMarkup(<NotificationRowBody {...base} isAwayDigest digestBusy digestPhase={null} />)
  expect(html).toContain('away-digest-actions')
  expect(html).not.toContain('away-digest-progress')
})

test('the active step is a visible loader (>=18px) with its label in the primary colour; done ticked, next dimmed', () => {
  const html = renderToStaticMarkup(<NotificationRowBody {...base} isAwayDigest digestBusy digestPhase="prepare" />)
  const now = html.slice(html.indexOf('data-state="now"'))
  expect(Number(/<svg[^>]* width="(\d+)"/.exec(now)?.[1])).toBeGreaterThanOrEqual(18)
  expect(now.slice(0, now.indexOf('</li>'))).toContain('var(--text-primary)')
  expect(html.match(/data-state="done"/g)?.length).toBe(1)
  expect(html).toMatch(/data-state="next"[^>]*opacity:0\.55/)
})

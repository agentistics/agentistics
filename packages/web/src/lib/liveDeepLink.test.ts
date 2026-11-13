import { expect, test } from 'bun:test'
import { liveDeepLink, parseLiveDeepLink } from './liveDeepLink'
import { notificationLink } from './notifications'
import { BLOCK_WORD } from '../components/tasks/liveCardModel'

test('an individual orphan notice links to its own card on the Live', () => {
  const link = notificationLink({ code: 'delivery.orphan-review', meta: { key: 't-1/s-2', title: 'X' } })
  expect(link).toBe(liveDeepLink({ card: 't-1/s-2' }))
  expect(parseLiveDeepLink(new URL(link!, 'http://x').search)).toEqual({ kind: 'card', key: 't-1/s-2', taskId: 't-1' })
})

test('the summary notice links to the Live filtered on the orphan pieces', () => {
  const link = notificationLink({ code: 'delivery.orphan-review-many', meta: { count: 144 } })
  expect(link).toBe(liveDeepLink({ orphans: true }))
  expect(parseLiveDeepLink(new URL(link!, 'http://x').search)).toEqual({ kind: 'orphans' })
})

test('a notice with no card key has nowhere to lead (never a dead link)', () => {
  expect(notificationLink({ code: 'delivery.orphan-review', meta: {} })).toBeNull()
})

test('no params, or junk, is no deep link', () => {
  expect(parseLiveDeepLink('')).toBeNull()
  expect(parseLiveDeepLink('?card=')).toBeNull()
  expect(parseLiveDeepLink('?x=1')).toBeNull()
})

test('a task-level piece key (no subtask) still resolves its task', () => {
  expect(parseLiveDeepLink('?card=t-9')).toEqual({ kind: 'card', key: 't-9', taskId: 't-9' })
})

test('the owner decision is shown to the user as waiting on them', () => {
  expect(BLOCK_WORD.decisao_do_dono).toEqual({ pt: 'aguardando você', en: 'waiting on you' })
})

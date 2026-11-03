import { expect, test } from 'bun:test'
import { deadlineOf } from './taskDeadlineNotice'

test('a deadline notification becomes a Nay card payload', () => {
  expect(deadlineOf('task.deadline.today', { title: 'Pay rent', task: 'Pay rent', due: '2026-12-23', taskId: 't-1' }))
    .toEqual({ threshold: 'today', title: 'Pay rent', task: 'Pay rent', due: '2026-12-23', taskId: 't-1' })
})

test('other codes, unknown thresholds and metas without a task are not deadline cards', () => {
  expect(deadlineOf('limits.threshold', { taskId: 't' })).toBeNull()
  expect(deadlineOf('task.deadline.never', { taskId: 't' })).toBeNull()
  expect(deadlineOf('task.deadline.soon', { title: 'x' })).toBeNull()
  expect(deadlineOf('task.deadline.soon', undefined)).toBeNull()
  expect(deadlineOf(undefined, { taskId: 't' })).toBeNull()
})

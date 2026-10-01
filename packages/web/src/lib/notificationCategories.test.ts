import { describe, expect, test } from 'bun:test'
import { categoryOf, notificationMuted, NOTIFICATION_CATEGORIES } from './notificationCategories'
import { readNotificationSettings } from './sessionNotifications'

describe('what kind of thing a bell notification is about', () => {
  test('codes map to their category by prefix', () => {
    expect(categoryOf('app.update_available')).toBe('updates')
    expect(categoryOf('sessions.idle')).toBe('idle')
    expect(categoryOf('tasks.fire_filing_blocked')).toBe('tasks')
    expect(categoryOf('backup.failed')).toBe('backup')
    expect(categoryOf('member.unreachable')).toBe('team')
    expect(categoryOf('central.connect_failed')).toBe('team')
    expect(categoryOf('machine.renamed')).toBe('team')
    expect(categoryOf('iam.reset_requested')).toBe('accounts')
    expect(categoryOf('hardware.pressure')).toBe('hardware')
  })
  test('session events are not a category here — they have their own switches', () => {
    expect(categoryOf('session.turn_ended')).toBeNull()
  })
  test('a code nobody claims is never muted, even with everything off', () => {
    const all = new Set(NOTIFICATION_CATEGORIES.map(c => c.id))
    expect(notificationMuted('something.new', all)).toBe(false)
    expect(notificationMuted(undefined, all)).toBe(false)
    expect(notificationMuted('backup.failed', all)).toBe(true)
    expect(notificationMuted('backup.failed', new Set())).toBe(false)
  })
  test('the stored list keeps only known categories', () => {
    expect(readNotificationSettings({ mutedCategories: ['backup', 'nope', 3] }).mutedCategories).toEqual(['backup'])
    expect(readNotificationSettings({}).mutedCategories).toEqual([])
  })
})

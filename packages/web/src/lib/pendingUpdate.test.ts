import { describe, expect, test } from 'bun:test'
import { readPendingUpdate, setPendingUpdate } from './pendingUpdate'
import { clearNotifications, readNotifications } from './notifications'

describe('pending update store', () => {
  test('survives "clear all" and goes away only when set to null', () => {
    setPendingUpdate({ current: '1.0.0', latest: '1.1.0', critical: false })
    clearNotifications()
    expect(readNotifications()).toEqual([])
    expect(readPendingUpdate()?.latest).toBe('1.1.0')
    setPendingUpdate(null)
    expect(readPendingUpdate()).toBeNull()
  })
})

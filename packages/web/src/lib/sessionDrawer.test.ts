import { describe, expect, test } from 'bun:test'
import { drawerEntryOnTop, sessionDrawerDot, SESSION_DRAWER_STATE } from './sessionDrawer'

describe('sessionDrawerDot', () => {
  test('a session waiting on a person, or unread inbox news, lights the dot', () => {
    expect(sessionDrawerDot({ state: 'waiting-approval', unread: 0 })).toBe(true)
    expect(sessionDrawerDot({ state: 'working', unread: 2 })).toBe(true)
  })
  test('the end of an ordinary turn does not — it would be a dot on every session', () => {
    expect(sessionDrawerDot({ state: 'waiting', unread: 0 })).toBe(false)
    expect(sessionDrawerDot({ state: 'working', unread: 0 })).toBe(false)
  })
})

describe('drawerEntryOnTop', () => {
  test('recognises only the entry the panel pushed', () => {
    expect(drawerEntryOnTop({ [SESSION_DRAWER_STATE]: true, idx: 3 })).toBe(true)
    expect(drawerEntryOnTop({ idx: 3 })).toBe(false)
    expect(drawerEntryOnTop(null)).toBe(false)
  })
})

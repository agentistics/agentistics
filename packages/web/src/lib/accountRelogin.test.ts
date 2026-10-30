import { describe, expect, test } from 'bun:test'
import { authBar, type SessionAuth } from './accountRelogin'

const auth: SessionAuth = { accountId: 'nay', state: 'expired', relogin: true, pending: 'faça X' }

describe('authBar', () => {
  test('blocked while the session\'s own account cannot work', () => {
    expect(authBar({ auth, currentAccountId: 'nay', renewed: null })).toEqual({ kind: 'blocked', auth })
  })
  test('nothing once the session moved to another account', () => {
    expect(authBar({ auth, currentAccountId: 'main', renewed: null }).kind).toBe('none')
  })
  test('nothing when the account works', () => {
    expect(authBar({ auth: null, currentAccountId: 'nay', renewed: null }).kind).toBe('none')
  })
  test('after signing in again here: offers the refused message, even before the server catches up', () => {
    expect(authBar({ auth, currentAccountId: 'nay', renewed: { accountId: 'nay', pending: 'faça X' } })).toEqual({ kind: 'renewed', accountId: 'nay', pending: 'faça X' })
    expect(authBar({ auth: null, currentAccountId: 'nay', renewed: { accountId: 'nay', pending: 'faça X' } }).kind).toBe('renewed')
    expect(authBar({ auth: null, currentAccountId: 'nay', renewed: { accountId: 'nay' } }).kind).toBe('none')
  })
})

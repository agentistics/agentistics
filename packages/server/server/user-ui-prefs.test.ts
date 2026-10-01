import { describe, expect, test } from 'bun:test'
import { parseUserUiPut, readUserUiPrefs, USER_UI_PREF_KEYS } from './user-ui-prefs'
import { resolveA11yStore } from './a11y-prefs'

describe('readUserUiPrefs', () => {
  test('keeps only known keys holding plain objects', () => {
    expect(readUserUiPrefs({ taskBoard: { view: 'table' }, other: { x: 1 } }))
      .toEqual({ taskBoard: { view: 'table' } })
  })

  test('junk yields an empty document instead of throwing', () => {
    expect(readUserUiPrefs(undefined)).toEqual({})
    expect(readUserUiPrefs(null)).toEqual({})
    expect(readUserUiPrefs('x')).toEqual({})
    expect(readUserUiPrefs([{ taskBoard: {} }])).toEqual({})
    expect(readUserUiPrefs({ taskBoard: ['status'] })).toEqual({})
    expect(readUserUiPrefs({ taskBoard: 'table' })).toEqual({})
  })
})

describe('parseUserUiPut', () => {
  test('a known key with an object value is a patch of that key alone', () => {
    expect(parseUserUiPut({ taskBoard: { subtaskColumns: ['model', 'status'] } }))
      .toEqual({ ok: true, patch: { taskBoard: { subtaskColumns: ['model', 'status'] } } })
  })

  test('an empty body is a valid no-op patch', () => {
    expect(parseUserUiPut({})).toEqual({ ok: true, patch: {} })
  })

  test('an unknown key is REFUSED, never silently dropped', () => {
    expect(parseUserUiPut({ taskBoard: {}, team: { mode: 'central' } }))
      .toEqual({ ok: false, error: 'unknown_key', key: 'team' })
  })

  test('a non-object value or body is refused', () => {
    expect(parseUserUiPut({ taskBoard: null })).toEqual({ ok: false, error: 'bad_value', key: 'taskBoard' })
    expect(parseUserUiPut({ taskBoard: [] })).toEqual({ ok: false, error: 'bad_value', key: 'taskBoard' })
    expect(parseUserUiPut([])).toEqual({ ok: false, error: 'not_an_object' })
    expect(parseUserUiPut('x')).toEqual({ ok: false, error: 'not_an_object' })
  })

  test('the closed list is exactly what the web stores use', () => {
    expect([...USER_UI_PREF_KEYS]).toEqual(['taskBoard'])
  })
})

describe('where /api/user-prefs stores — the a11y resolution, reused', () => {
  test('a central never falls back to the machine file', () => {
    expect(resolveA11yStore(true, null)).toEqual({ kind: 'anonymous' })
    expect(resolveA11yStore(true, 'acct-1')).toEqual({ kind: 'account', accountId: 'acct-1' })
    expect(resolveA11yStore(false, 'acct-1')).toEqual({ kind: 'machine' })
  })
})

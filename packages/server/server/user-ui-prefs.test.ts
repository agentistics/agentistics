import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  machineHome, machineUiPatch, parseUserUiPut, readMachineUiPrefs, readUserUiPrefs,
  USER_UI_PREF_KEYS, USER_UI_PREF_REGISTRY,
} from './user-ui-prefs'
import { resolveA11yStore } from './a11y-prefs'

/** The top-level fields `Preferences` declares — read off the interface's own source, so a key
 *  cannot be "legacy" in the registry without actually being a field the server already has. */
function declaredTopLevelFields(): Set<string> {
  const src = readFileSync(join(import.meta.dir, 'preferences.ts'), 'utf8')
  const start = src.indexOf('export interface Preferences {')
  let depth = 0
  let end = start
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) { end = i; break }
  }
  const body = src.slice(start, end)
  // Only depth-1 fields: two-space indent, a name, optional `?`, a colon.
  return new Set([...body.matchAll(/^ {2}([A-Za-z]\w*)\??:/gm)].map(m => m[1]!))
}

describe('the registry — one place says where each key lives on a machine', () => {
  test('every LEGACY top-level key stays top-level (no data migration, no broken server reader)', () => {
    const legacy = [
      'theme', 'lang', 'currency', 'cardOrder', 'cardPrecision', 'monthlyBudgetUSD',
      'chatModel', 'chatHarness', 'chatEffort', 'chatSoundEnabled', 'chatSoundId', 'nayMotion',
      'pinnedSessions', 'mutedSessions', 'sessionGroups', 'idleSessions', 'dismissedHealth', 'notificationSettings',
      'tagsLayout', 'galleryView', 'galleryScope', 'skillFormat', 'pricingGroupBy',
    ] as const
    for (const k of legacy) expect(`${k}:${machineHome(k)}`).toBe(`${k}:top`)
  })

  test('a key maps to `top` exactly when Preferences already declares it as a field', () => {
    const declared = declaredTopLevelFields()
    expect(declared.has('theme')).toBe(true)          // the reader itself works
    for (const k of USER_UI_PREF_KEYS) {
      expect(`${k}:${machineHome(k)}`).toBe(`${k}:${declared.has(k) ? 'top' : 'ui'}`)
    }
  })

  test('no machine gate is a personal preference', () => {
    for (const gate of ['chatEnabled', 'shellEnabled', 'editorEnabled', 'archiveMode', 'team', 'billing', 'ui', 'accessibility']) {
      expect(USER_UI_PREF_KEYS as readonly string[]).not.toContain(gate)
    }
  })
})

describe('reading', () => {
  test('a machine reads each key from its own home', () => {
    const prefs = { theme: 'light', pinnedSessions: ['a'], ui: { taskBoard: { view: 'table' }, theme: 'dark' }, team: { mode: 'solo' } }
    expect(readMachineUiPrefs(prefs)).toEqual({ theme: 'light', pinnedSessions: ['a'], taskBoard: { view: 'table' } })
  })

  test('a top-level field with the name of a ui key is NOT read as it', () => {
    expect(readMachineUiPrefs({ taskBoard: { view: 'board' } })).toEqual({})
  })

  test('an account document keeps known keys with any JSON value', () => {
    expect(readUserUiPrefs({ theme: 'light', fleetOpen: false, centralMachine: null, cardOrder: ['a'], other: 1 }))
      .toEqual({ theme: 'light', fleetOpen: false, centralMachine: null, cardOrder: ['a'] })
  })

  test('junk yields an empty document instead of throwing', () => {
    expect(readUserUiPrefs(undefined)).toEqual({})
    expect(readUserUiPrefs('x')).toEqual({})
    expect(readMachineUiPrefs({ ui: 'x' })).toEqual({})
  })
})

describe('writing on a machine', () => {
  test('top keys become fields, ui keys merge into the existing ui object', () => {
    const current = { ui: { taskBoard: { view: 'table' } }, theme: 'dark' }
    expect(machineUiPatch(current, { theme: 'light', sessionsAside: { groupBy: 'task' } }))
      .toEqual({ theme: 'light', ui: { taskBoard: { view: 'table' }, sessionsAside: { groupBy: 'task' } } })
  })

  test('a patch of top keys alone does not touch ui', () => {
    expect(machineUiPatch({ ui: { taskBoard: {} } }, { lang: 'pt' })).toEqual({ lang: 'pt' })
  })
})

describe('parseUserUiPut', () => {
  test('any JSON value is accepted for a known key', () => {
    expect(parseUserUiPut({ theme: 'light', fleetOpen: true, monthlyBudgetUSD: null, cardOrder: ['x'], taskBoard: { view: 'table' } }).ok).toBe(true)
  })

  test('an empty body is a valid no-op patch', () => {
    expect(parseUserUiPut({})).toEqual({ ok: true, patch: {} })
  })

  test('an unknown key is REFUSED, never silently dropped', () => {
    expect(parseUserUiPut({ taskBoard: {}, team: { mode: 'central' } }))
      .toEqual({ ok: false, error: 'unknown_key', key: 'team' })
  })

  test('a value over its key\'s byte cap is refused', () => {
    const big = 'x'.repeat(USER_UI_PREF_REGISTRY.theme.maxBytes)
    expect(parseUserUiPut({ theme: big })).toEqual({ ok: false, error: 'too_large', key: 'theme' })
  })

  test('a non-object body is refused', () => {
    expect(parseUserUiPut([])).toEqual({ ok: false, error: 'not_an_object' })
    expect(parseUserUiPut('x')).toEqual({ ok: false, error: 'not_an_object' })
  })
})

describe('where /api/user-prefs stores — the a11y resolution, reused', () => {
  test('a central never falls back to the machine file', () => {
    expect(resolveA11yStore(true, null)).toEqual({ kind: 'anonymous' })
    expect(resolveA11yStore(true, 'acct-1')).toEqual({ kind: 'account', accountId: 'acct-1' })
    expect(resolveA11yStore(false, 'acct-1')).toEqual({ kind: 'machine' })
  })
})

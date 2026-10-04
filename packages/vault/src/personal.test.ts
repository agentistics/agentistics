import { describe, expect, test } from 'bun:test'
import {
  GROUP_ID, ITEM_ID, KIND_FIELDS, newPersonalId, parseDotEnv, parseVersionFile, recordName, revealAsks, trashExpired,
  validateInput, versionTag, versionsToPrune,
  needsConfirm,
} from './personal'
import { scopeOfPurpose } from './format'

describe('ids, names, versions', () => {
  test('opaque ids, and the purpose belongs to the HUMAN scope only', () => {
    expect(newPersonalId('it')).toMatch(ITEM_ID)
    expect(newPersonalId('gr')).toMatch(GROUP_ID)
    expect(newPersonalId('it')).not.toBe(newPersonalId('it'))
    expect(scopeOfPurpose('vault/personal')).toBe('human')
  })
  test('version files sort in order and parse back; the sealed name binds id + version + part', () => {
    expect(versionTag(7)).toBe('v000007')
    expect(parseVersionFile('v000007.meta.sealed')).toEqual({ version: 7, part: 'meta' })
    expect(parseVersionFile('v7.meta.sealed')).toBeNull()
    expect(recordName('it_x', 3, 'value')).toBe('it_x/v000003/value')
  })
  test('the newest 10 are kept', () => {
    expect(versionsToPrune([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])).toEqual([1])
    expect(versionsToPrune([3, 1, 2])).toEqual([])
    expect(versionsToPrune(Array.from({ length: 13 }, (_, i) => i + 1))).toEqual([1, 2, 3])
  })
  test('the trash keeps 30 days', () => {
    const now = Date.parse('2026-11-02T00:00:00Z')
    expect(trashExpired('2026-10-03T00:00:00Z', now)).toBe(true)
    expect(trashExpired('2026-10-04T00:00:00Z', now)).toBe(false)
    expect(trashExpired(null, now)).toBe(false)
  })
})

describe('validateInput — strict and total', () => {
  test('a login carries two fields; only the password is required', () => {
    expect(KIND_FIELDS.login).toEqual(['login', 'password'])
    expect(validateInput({ kind: 'login', name: 'Banco', fields: { password: 'x' } }, { requireFields: true }).ok).toBe(true)
    expect(validateInput({ kind: 'login', name: 'Banco', fields: { login: 'a@b' } }, { requireFields: true })).toMatchObject({ ok: false, field: 'fields.password' })
  })
  test('refuses an unknown kind, a field that kind does not have, a bad group, oversize values', () => {
    expect(validateInput({ kind: 'card', name: 'x' }, { requireFields: false })).toMatchObject({ field: 'kind' })
    expect(validateInput({ kind: 'password', name: 'x', fields: { login: 'a' } }, { requireFields: false })).toMatchObject({ field: 'fields.login' })
    expect(validateInput({ kind: 'note', name: 'x', groupId: '../etc' }, { requireFields: false })).toMatchObject({ field: 'groupId' })
    expect(validateInput({ kind: 'note', name: 'x'.repeat(121) }, { requireFields: false })).toMatchObject({ field: 'name', reason: 'too-long' })
    expect(validateInput({ kind: 'note', name: '  ' }, { requireFields: false })).toMatchObject({ field: 'name', reason: 'required' })
  })
  test('tags are trimmed and deduplicated', () => {
    const r = validateInput({ kind: 'note', name: 'x', tags: [' a', 'a', '', 'b'] }, { requireFields: false })
    expect(r.ok && r.value.tags).toEqual(['a', 'b'])
  })
})

describe('parseDotEnv', () => {
  test('comments, export, quotes, escapes, inline comments, multi-line, repeats', () => {
    const r = parseDotEnv([
      '# comment', '', 'export API_KEY=abc123', 'PLAIN = hello world # trailing', "SINGLE='a #not comment $x'",
      'DOUBLE="line1\\nline2 \\"q\\""', 'MULTI="first', 'second"', 'EMPTY=', 'not a pair', 'API_KEY=override',
      "PEM='-----BEGIN-----", 'abc', "-----END-----'",
    ].join('\r\n'))
    const m = Object.fromEntries(r.pairs.map(p => [p.key, p.value]))
    expect(m).toEqual({
      PLAIN: 'hello world', SINGLE: 'a #not comment $x', DOUBLE: 'line1\nline2 "q"', MULTI: 'first\nsecond', EMPTY: '',
      API_KEY: 'override', PEM: '-----BEGIN-----\nabc\n-----END-----',
    })
    expect(r.skipped).toBe(1)
  })
  test('an unterminated quote is skipped, not swallowed into the next keys', () => {
    const r = parseDotEnv('A="open\nB=1')
    expect(r.pairs).toEqual([{ key: 'B', value: '1' }])
    expect(r.skipped).toBe(1)
  })
})

describe('revealAsks — spec §3', () => {
  test('gesture every time; code on "always"; code alone without presence; never nothing', () => {
    expect(revealAsks({ hasPresence: true, hasAuthenticator: true, unlockMode: 'daily' })).toEqual({ code: false, gesture: true, blocked: false })
    expect(revealAsks({ hasPresence: true, hasAuthenticator: true, unlockMode: 'always' })).toEqual({ code: true, gesture: true, blocked: false })
    expect(revealAsks({ hasPresence: false, hasAuthenticator: true, unlockMode: 'daily' })).toEqual({ code: true, gesture: false, blocked: false })
    expect(revealAsks({ hasPresence: false, hasAuthenticator: false, unlockMode: 'daily' }).blocked).toBe(true)
  })
})

describe('needsConfirm — "Sempre confirmar" absent reads as ON', () => {
  test('only an explicit false goes without the prompt', () => {
    expect(needsConfirm({})).toBe(true)
    expect(needsConfirm({ confirmEach: true })).toBe(true)
    expect(needsConfirm({ confirmEach: false })).toBe(false)
  })
  test('validateInput accepts a boolean and refuses anything else', () => {
    const base = { kind: 'note', name: 'n', fields: { value: 'x' } }
    expect(validateInput({ ...base, confirmEach: false }, { requireFields: true })).toMatchObject({ ok: true, value: { confirmEach: false } })
    expect(validateInput({ ...base, confirmEach: 'no' }, { requireFields: true })).toMatchObject({ ok: false, field: 'confirmEach' })
  })
})

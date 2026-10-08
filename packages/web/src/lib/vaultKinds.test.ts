import { describe, expect, test } from 'bun:test'
import {
  MAX_TYPES, NEW_TYPE, choiceValue, kindChoices, kindName, newTypeId, parseVaultKinds, removeType, renameType, resolveChoice, typeNameProblem, withType,
  type VaultType,
} from './vaultKinds'
import { allKind, filterPersonal, setAllKind, type PersonalMeta } from './vaultPersonal'

const label = (k: string) => ({ 'api-key': 'API key', env: '.env', password: 'Password', login: 'Login', note: 'Note' } as Record<string, string>)[k]!
const mongo: VaultType = { id: 'kt_mongo1', name: 'Token do Mongo', base: 'api-key' }
const m = (o: Partial<PersonalMeta>): PersonalMeta => ({ id: 'it_x', kind: 'api-key', name: 'x', groupId: null, tags: [], notes: '', url: '', fields: ['value'], createdAt: '', updatedAt: '', version: 1, deletedAt: null, ...o })

describe('custom vault types are labels over a base kind', () => {
  test('a type is created once, with a usable unique name; the list is bounded', () => {
    const a = withType([], '  Token do Mongo ', 'api-key', 'kt_mongo1')
    expect(a.created).toEqual(mongo)
    expect(withType(a.types, 'token DO mongo', 'env').created).toBeNull() // taken, case-insensitive
    expect(withType(a.types, '   ', 'env').created).toBeNull()
    expect(typeNameProblem('x'.repeat(41), [])).toBe('long')
    const full = Array.from({ length: MAX_TYPES }, (_, i) => ({ id: `kt_full${i}x`, name: `T${i}`, base: 'note' as const }))
    expect(withType(full, 'one more', 'note').created).toBeNull()
  })
  test('rename keeps the id and base; remove drops only the definition', () => {
    expect(renameType([mongo], mongo.id, 'Mongo Atlas')).toEqual([{ ...mongo, name: 'Mongo Atlas' }])
    expect(renameType([mongo, { id: 'kt_other1', name: 'Outro', base: 'env' }], 'kt_other1', 'token do mongo')[1]!.name).toBe('Outro')
    expect(removeType([mongo], mongo.id)).toEqual([])
  })
  test('a secret reads as its type name while the definition exists, else as its base kind', () => {
    expect(kindName(m({ typeId: mongo.id }), [mongo], label)).toBe('Token do Mongo')
    expect(kindName(m({ typeId: mongo.id }), [], label)).toBe('API key') // definition gone
    expect(kindName(m({}), [mongo], label)).toBe('API key')
  })
  test('the selector offers every base kind, then the types, then "Criar tipo…"; picking maps back to kind + label', () => {
    const opts = kindChoices([mongo], label, 'Criar tipo…')
    expect(opts.map(o => o.value)).toEqual(['login', 'password', 'api-key', 'env', 'note', 'kt_mongo1', NEW_TYPE])
    expect(opts.find(o => o.value === 'kt_mongo1')!.label).toBe('Token do Mongo · API key')
    expect(resolveChoice('kt_mongo1', [mongo])).toEqual({ kind: 'api-key', typeId: 'kt_mongo1' })
    expect(resolveChoice('note', [mongo])).toEqual({ kind: 'note', typeId: null })
    expect(resolveChoice(NEW_TYPE, [mongo])).toBeNull()
    expect(choiceValue({ kind: 'api-key', typeId: 'kt_mongo1' }, [mongo])).toBe('kt_mongo1')
    expect(choiceValue({ kind: 'api-key', typeId: 'kt_gone' }, [mongo])).toBe('api-key')
  })
  test('the stored document is parsed totally: junk is dropped, never thrown', () => {
    expect(parseVaultKinds(undefined)).toEqual({ types: [] })
    expect(parseVaultKinds('x')).toBeNull()
    expect(parseVaultKinds({ types: [mongo, mongo, { id: 'bad', name: 'x', base: 'env' }, { id: 'kt_abcd1', name: 'y', base: 'nope' }] })).toEqual({ types: [mongo] })
    expect(newTypeId(() => 0.5)).toMatch(/^kt_[a-z0-9]{10}$/)
  })
  test('the kind filter and the search both understand a type; "mark all as API key" drops any label', () => {
    const items = [m({ id: 'it_a', name: 'A', typeId: mongo.id }), m({ id: 'it_b', name: 'B' }), m({ id: 'it_c', name: 'C', kind: 'env' })]
    const f = (kind: string, q = '') => filterPersonal(items, [], { q, kind, groupId: 'all', trash: false }, label, x => kindName(x, [mongo], label)).map(x => x.name)
    expect(f(mongo.id)).toEqual(['A'])
    expect(f('api-key')).toEqual(['A', 'B'])
    expect(f('all', 'mongo')).toEqual(['A'])
    const marked = setAllKind([{ key: 'K', action: 'import', kind: 'note', typeId: mongo.id }], 'api-key')
    expect(marked[0]).toEqual({ key: 'K', action: 'import', kind: 'api-key' })
    expect(allKind([{ key: 'K', action: 'import', kind: 'api-key', typeId: mongo.id }], 'api-key')).toBe(false)
  })
})

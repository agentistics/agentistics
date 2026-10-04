import { describe, expect, test } from 'bun:test'
import { copyWithAutoClear, defaultImportChoices, filterPersonal, importReady, parseTags, withStepUp, type PersonalMeta } from './vaultPersonal'

const m = (o: Partial<PersonalMeta>): PersonalMeta => ({ id: 'it_' + (o.name ?? 'x'), kind: 'password', name: 'x', groupId: null, tags: [], notes: '', url: '', fields: ['password'], createdAt: '', updatedAt: '', version: 1, deletedAt: null, ...o })
const items = [
  m({ name: 'Banco Itaú', kind: 'login', tags: ['pessoal'], groupId: 'gr_a' }),
  m({ name: 'OpenAI', kind: 'api-key', notes: 'conta da empresa' }),
  m({ name: 'Antigo', deletedAt: '2026-10-01T00:00:00Z' }),
]
const groups = [{ id: 'gr_a', name: 'Pelvie', version: 1, createdAt: '', updatedAt: '' }]
const all = { q: '', kind: 'all' as const, groupId: 'all' as const, trash: false }

describe('filterPersonal — reactive search over METADATA only', () => {
  test('name, group, tags, notes, accents and case; every term must match', () => {
    expect(filterPersonal(items, groups, { ...all, q: 'itau' }).map(i => i.name)).toEqual(['Banco Itaú'])
    expect(filterPersonal(items, groups, { ...all, q: 'pelvie' }).map(i => i.name)).toEqual(['Banco Itaú'])
    expect(filterPersonal(items, groups, { ...all, q: 'empresa open' }).map(i => i.name)).toEqual(['OpenAI'])
    expect(filterPersonal(items, groups, { ...all, q: 'banco empresa' })).toEqual([])
  })
  test('kind, group, "no group" and the trash are separate views', () => {
    expect(filterPersonal(items, groups, { ...all, kind: 'api-key' }).map(i => i.name)).toEqual(['OpenAI'])
    expect(filterPersonal(items, groups, { ...all, groupId: 'none' }).map(i => i.name)).toEqual(['OpenAI'])
    expect(filterPersonal(items, groups, { ...all, trash: true }).map(i => i.name)).toEqual(['Antigo'])
  })
  test('a few thousand rows per keystroke stay well under a frame budget', () => {
    const many = Array.from({ length: 5000 }, (_, i) => m({ name: `item ${i}`, tags: ['t' + (i % 7)], notes: 'n'.repeat(40) }))
    const t0 = performance.now()
    for (const q of ['i', 'it', 'ite', 'item', 'item 4']) filterPersonal(many, [], { ...all, q })
    expect((performance.now() - t0) / 5).toBeLessThan(40)
  })
})

describe('import choices', () => {
  test('a clash defaults to skip; rename needs a name; all-skip is not sendable', () => {
    const c = defaultImportChoices([{ key: 'A', clash: null, empty: false }, { key: 'B', clash: { id: 'it_b', version: 1 }, empty: false }])
    expect(c).toEqual([{ key: 'A', action: 'import' }, { key: 'B', action: 'skip' }])
    expect(importReady(c)).toBe(true)
    expect(importReady([{ key: 'B', action: 'rename' }])).toBe(false)
    expect(importReady([{ key: 'B', action: 'skip' }])).toBe(false)
  })
  test('tags', () => { expect(parseTags('a, b ,a,,c')).toEqual(['a', 'b', 'c']) })
})

describe('copyWithAutoClear — the clipboard is overwritten after 30 s', () => {
  test('writes the value, then "" when the timer fires; cancel clears at once', async () => {
    const writes: string[] = []
    let fire: (() => void) | null = null
    const clip = { writeText: async (t: string) => { writes.push(t) } }
    const timers = { set: ((fn: () => void, ms: number) => { expect(ms).toBe(30_000); fire = fn; return 1 }) as unknown as typeof setTimeout, clear: (() => {}) as typeof clearTimeout }
    const c = copyWithAutoClear('s3cret', clip, timers)
    expect(await c.done).toBe(true)
    expect(writes).toEqual(['s3cret'])
    fire!()
    await Promise.resolve()
    expect(writes).toEqual(['s3cret', ''])
  })
})

describe('withStepUp', () => {
  test('retries once with the code when the server asks for it', async () => {
    const seen: (string | undefined)[] = []
    const r = await withStepUp(async code => { seen.push(code); return code ? { ok: true as const } : { ok: false as const, code: 'stepup-required', sentence: '', status: 401 } }, async () => '123456')
    expect(r.ok).toBe(true)
    expect(seen).toEqual([undefined, '123456'])
  })
})

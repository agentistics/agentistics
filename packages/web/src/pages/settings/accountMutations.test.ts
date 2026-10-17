import { describe, expect, test } from 'bun:test'
import { createAccountMutator, reconcileNickname } from './accountMutations'

type A = { id: string; nickname?: string; available: boolean }
const deferred = () => { let res!: (v: A) => void; const p = new Promise<A>(r => { res = r }); return { p, res } }

describe('createAccountMutator', () => {
  test('a second PATCH for an account in flight is refused, not raced; the first lands intact', async () => {
    const d = deferred()
    let sent = 0
    const m = createAccountMutator<A>(async () => { sent++; return { ok: true, json: async () => ({ account: await d.p }) } })
    const first = m.patch('a1', { nickname: 'Work' })
    expect(m.has('a1')).toBe(true)
    expect(await m.patch('a1', { available: false })).toEqual({ status: 'busy' })
    d.res({ id: 'a1', nickname: 'Work', available: true })
    expect(await first).toEqual({ status: 'ok', account: { id: 'a1', nickname: 'Work', available: true } })
    expect(sent).toBe(1)
    expect(m.has('a1')).toBe(false)
  })
  test('different accounts run concurrently', async () => {
    const m = createAccountMutator<A>(async id => ({ ok: true, json: async () => ({ account: { id, available: true } }) }))
    const [x, y] = await Promise.all([m.patch('a', {}), m.patch('b', {})])
    expect([x.status, y.status]).toEqual(['ok', 'ok'])
  })
  test('HTTP failure and network failure both report failed and free the account', async () => {
    const bad = createAccountMutator<A>(async () => ({ ok: false, json: async () => ({ account: { id: 'a', available: true } }) }))
    expect(await bad.patch('a', {})).toEqual({ status: 'failed' })
    expect(bad.has('a')).toBe(false)
    const boom = createAccountMutator<A>(async () => { throw new Error('net') })
    expect(await boom.patch('a', {})).toEqual({ status: 'failed' })
    expect(boom.has('a')).toBe(false)
  })
  test('an unidentified account is never sent', async () => {
    let sent = 0
    const m = createAccountMutator<A>(async () => { sent++; return { ok: true, json: async () => ({ account: { id: '', available: true } }) } })
    expect(await m.patch('', { available: false })).toEqual({ status: 'unsupported' })
    expect(sent).toBe(0)
  })
})

describe('reconcileNickname', () => {
  test('a successful PATCH replaces the unchanged raw draft with the sanitized server nickname', async () => {
    const d = deferred()
    let draft = ' Work\tLaptop '
    const rawSubmittedDraft = draft
    const m = createAccountMutator<A>(async (_id, body) => {
      expect(body.nickname).toBe('Work\tLaptop')
      return { ok: true, json: async () => ({ account: await d.p }) }
    })
    const pending = m.patch('a1', { nickname: rawSubmittedDraft.trim() })
    d.res({ id: 'a1', nickname: 'Work Laptop', available: true })
    const result = await pending
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') throw new Error('PATCH failed')
    draft = reconcileNickname(draft, rawSubmittedDraft, result.account.nickname)
    expect(draft).toBe('Work Laptop')
    expect(draft.trim()).toBe(result.account.nickname!)
  })
  test('typing while the PATCH is pending survives the sanitized response', async () => {
    const d = deferred()
    let draft = ' Work\tLaptop '
    const rawSubmittedDraft = draft
    const m = createAccountMutator<A>(async () => ({ ok: true, json: async () => ({ account: await d.p }) }))
    const pending = m.patch('a1', { nickname: rawSubmittedDraft.trim() })
    draft = ' Work\tLaptop 2 '
    d.res({ id: 'a1', nickname: 'Work Laptop', available: true })
    const result = await pending
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') throw new Error('PATCH failed')
    expect(reconcileNickname(draft, rawSubmittedDraft, result.account.nickname)).toBe(' Work\tLaptop 2 ')
  })
  test('the normalized server value replaces the submitted draft; newer typing is kept', () => {
    expect(reconcileNickname('Work', 'Work', 'Work')).toBe('Work')
    expect(reconcileNickname('Work', 'Work', undefined)).toBe('')
    expect(reconcileNickname('Work 2', 'Work', 'Work')).toBe('Work 2')
  })
})

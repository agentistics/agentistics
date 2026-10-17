import { describe, expect, test } from 'bun:test'
import type { BillingSettings } from '@agentistics/core'
import { createBillingSaver } from './billingSaver'

const withAcc = (cur: BillingSettings, id: string): BillingSettings => ({
  ...cur, accountProfiles: { ...(cur.accountProfiles ?? {}), [id]: { periods: [{ id: `p_${id}`, mode: 'unknown', from: '2026-10-01' }] } },
})
const deferred = () => { let go!: () => void; const p = new Promise<void>(r => { go = r }); return { p, go } }

describe('billingSaver', () => {
  test('two quick answers merge, and the slow first write cannot land after (and erase) the second', async () => {
    const stored: BillingSettings[] = []
    const gate = deferred()
    let n = 0
    const saver = createBillingSaver({
      initial: { profiles: {} },
      put: async b => { if (n++ === 0) await gate.p; stored.push(b); return { ok: true } },
      onChange: () => {},
    })
    const a = saver.save(cur => withAcc(cur, 'a'))
    const b = saver.save(cur => withAcc(cur, 'b'))
    gate.go()
    await Promise.all([a, b])
    expect(Object.keys(stored.at(-1)!.accountProfiles ?? {}).sort()).toEqual(['a', 'b'])
    expect(Object.keys(saver.current().accountProfiles ?? {}).sort()).toEqual(['a', 'b'])
  })

  test('a refused write rejects and puts the last stored settings back (the answer is not kept)', async () => {
    const seen: BillingSettings[] = []
    const saver = createBillingSaver({ initial: { profiles: {} }, put: async () => ({ ok: false }), onChange: b => seen.push(b) })
    await expect(saver.save(cur => withAcc(cur, 'a'))).rejects.toThrow()
    expect(saver.current().accountProfiles).toBeUndefined()
    expect(seen.at(-1)?.accountProfiles).toBeUndefined()
  })

  test('a rejected fetch rolls back too, and a later save still works', async () => {
    let fail = true
    const saver = createBillingSaver({
      initial: { profiles: {} },
      put: async () => { if (fail) throw new Error('offline'); return { ok: true } },
      onChange: () => {},
    })
    await expect(saver.save(cur => withAcc(cur, 'a'))).rejects.toThrow('offline')
    fail = false
    await saver.save(cur => withAcc(cur, 'a'))
    expect(saver.current().accountProfiles?.a).toBeDefined()
  })

  test('R5: A fails while B is queued; B stores A+B, and onStored lets the caller settle A', async () => {
    const gate = deferred()
    let n = 0
    const stored: BillingSettings[] = []
    const saver = createBillingSaver({
      initial: { profiles: {} },
      put: async b => { if (n++ === 0) { await gate.p; return { ok: false } } return { ok: true } },
      onChange: () => {},
      onStored: b => stored.push(b),
    })
    const a = saver.save(cur => withAcc(cur, 'a'))
    await Promise.resolve() // A's PUT is now in flight, alone
    const b = saver.save(cur => withAcc(cur, 'b'))
    gate.go()
    await expect(a).rejects.toThrow()
    await b
    expect(stored).toHaveLength(1)
    expect(Object.keys(stored[0]!.accountProfiles ?? {}).sort()).toEqual(['a', 'b'])
    expect(Object.keys(saver.current().accountProfiles ?? {}).sort()).toEqual(['a', 'b'])
  })
})

import { beforeEach, describe, expect, test } from 'bun:test'
import type { BillingSettings } from '@agentistics/core'
import { billingNotices } from './billingNotices'
import { createBillingSaver } from './billingSaver'

const withAcc = (cur: BillingSettings, id: string): BillingSettings => ({
  ...cur, accountProfiles: { ...(cur.accountProfiles ?? {}), [id]: { periods: [{ id: `p_${id}`, mode: 'unknown', from: '2026-10-01' }] } },
})
beforeEach(() => billingNotices.reset())

describe('billingNotices', () => {
  test('R2: the pending state outlives the component that started the write (module-level, not state)', () => {
    billingNotices.mark('a', 'saving')
    // a "remounted" reader sees it
    expect(billingNotices.get()).toEqual({ a: 'saving' })
  })

  test('R5: a failed answer clears once a later queued write persists it', async () => {
    let n = 0
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const saver = createBillingSaver({
      initial: { profiles: {} },
      put: async () => { if (n++ === 0) { await gate; return { ok: false } } return { ok: true } },
      onChange: () => {},
      onStored: b => billingNotices.reconcile(b),
    })
    billingNotices.mark('a', 'saving')
    const a = saver.save(cur => withAcc(cur, 'a'))
    await Promise.resolve()
    billingNotices.mark('b', 'saving')
    const b = saver.save(cur => withAcc(cur, 'b'))
    release()
    await a.catch(() => billingNotices.mark('a', 'failed'))
    await b
    expect(billingNotices.get()).toEqual({})
  })

  test('a failed answer that nothing persisted stays failed', () => {
    billingNotices.mark('a', 'failed')
    billingNotices.reconcile({ profiles: {}, accountProfiles: { other: { periods: [] } } })
    expect(billingNotices.get()).toEqual({ a: 'failed' })
  })
})

describe('L2 prune', () => {
  test('a failed notice is cleared once the account no longer needs a plan; saving stays', () => {
    billingNotices.reset()
    billingNotices.mark('a', 'failed'); billingNotices.mark('b', 'failed'); billingNotices.mark('c', 'saving')
    billingNotices.prune(new Set(['b']))
    expect(billingNotices.get()).toEqual({ b: 'failed', c: 'saving' })
    billingNotices.reset()
  })
})

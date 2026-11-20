import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { HOVER_DEDUPE_MS, TAKE_MAX_AGE_MS, resetUsageWarmup, takeWarmAccounts, takeWarmAccountsBody, usageIntentProps, warmUsageAccounts } from './usageWarmup'

let calls = 0
const realFetch = globalThis.fetch
const g = globalThis as { document?: { hidden: boolean } }
const realDoc = g.document

beforeEach(() => {
  calls = 0
  resetUsageWarmup()
  g.document = { hidden: false }
  ;(globalThis as { fetch: unknown }).fetch = () => { calls++; return Promise.resolve(new Response('{"accounts":[{"id":"a"}]}')) }
})
afterEach(() => { globalThis.fetch = realFetch; g.document = realDoc })

describe('Usage accounts warm-up', () => {
  test('hovering 10 times in 60 s asks for the list at most twice, and never polls', () => {
    for (let i = 0; i < 10; i++) warmUsageAccounts('hover', i * 6000)
    expect(calls).toBe(2)
  })
  test('pointer enter, focus and press are the three intents, and only the Usage entry has them', () => {
    const p = usageIntentProps(true)
    p.onPointerEnter!(); p.onFocus!(); p.onPointerDown!()
    expect(calls).toBe(1)
    expect(usageIntentProps(false)).toEqual({})
  })
  test('the page taking the answer spends it: opening after a hover is ONE request, and the next read asks itself', () => {
    warmUsageAccounts('hover', 0)
    warmUsageAccounts('open', 100)
    expect(calls).toBe(1)
    expect(takeWarmAccounts(150)).not.toBeNull()
    expect(takeWarmAccounts(TAKE_MAX_AGE_MS + 1)).toBeNull()
  })
  test('r3c: a hand-over serves EVERY consumer of the same open (hover → open → remount = ONE request)', async () => {
    warmUsageAccounts('hover', 0)
    warmUsageAccounts('open', 800)
    await new Promise(r => setTimeout(r, 5))
    expect(takeWarmAccountsBody(1000)).toEqual({ accounts: [{ id: 'a' }] })
    expect(takeWarmAccountsBody(1500)).toEqual({ accounts: [{ id: 'a' }] }) // the remount
    expect(takeWarmAccounts(1600)).not.toBeNull()
    warmUsageAccounts('open', 1700) // a re-render / remount asking to warm again
    expect(calls).toBe(1)
  })
  test('r3c: an in-flight warm request is joined, never duplicated', () => {
    warmUsageAccounts('hover', 0)
    warmUsageAccounts('open', 5)
    warmUsageAccounts('open', 6)
    expect(takeWarmAccounts(7)).not.toBeNull()
    expect(takeWarmAccounts(8)).not.toBeNull()
    expect(calls).toBe(1)
  })
  test('a stale answer is never handed over, and opening then fetches a fresh one', () => {
    warmUsageAccounts('hover', 0)
    expect(takeWarmAccounts(TAKE_MAX_AGE_MS + 1)).toBeNull()
    warmUsageAccounts('hover', 0 + 1)
    expect(calls).toBe(1)
    warmUsageAccounts('open', TAKE_MAX_AGE_MS + 1)
    expect(calls).toBe(2)
    expect(HOVER_DEDUPE_MS).toBeGreaterThan(TAKE_MAX_AGE_MS)
  })
  test('a hidden tab requests nothing', () => {
    g.document = { hidden: true }
    warmUsageAccounts('hover', 0); warmUsageAccounts('open', 1)
    expect(calls).toBe(0)
    expect(takeWarmAccounts(2)).toBeNull()
  })
  test('an answer that already arrived is handed over parsed (the page draws it in its first commit), once, and only while fresh', async () => {
    expect(takeWarmAccountsBody(0)).toBeUndefined()
    warmUsageAccounts('hover', 0)
    expect(takeWarmAccountsBody(1)).toBeUndefined() // not arrived yet: the promise path stays
    await new Promise(r => setTimeout(r, 5))
    expect(takeWarmAccountsBody(TAKE_MAX_AGE_MS + 1)).toBeUndefined()
    warmUsageAccounts('open', TAKE_MAX_AGE_MS + 2)
    await new Promise(r => setTimeout(r, 5))
    expect(takeWarmAccountsBody(TAKE_MAX_AGE_MS + 3)).toEqual({ accounts: [{ id: 'a' }] })
    expect(takeWarmAccountsBody(TAKE_MAX_AGE_MS * 2 + 4)).toBeUndefined()
    expect(calls).toBe(2)
  })
})

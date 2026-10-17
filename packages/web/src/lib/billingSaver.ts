/**
 * billingSaver — PURE-ish: the one write path for `preferences.billing`.
 *
 * `/api/preferences` is a shallow merge, so every write carries the COMPLETE settings. Two rules keep
 * concurrent edits (two accounts answered back to back, an availability change, a period edit) from
 * losing each other:
 *  - writes are SERIALIZED: a second one waits for the first, so a slow earlier PUT can never land
 *    after a newer one and replace it;
 *  - an edit is a function of the CURRENT settings, so the second edit builds on the first.
 * A refused or failed write rejects and — when nothing newer is queued — puts the last STORED settings
 * back, so the screen never keeps an answer that was not saved.
 */
import type { BillingSettings } from '@agentistics/core'

export type BillingChange = BillingSettings | ((cur: BillingSettings) => BillingSettings)

export interface BillingSaver {
  save: (change: BillingChange) => Promise<void>
  /** The settings were loaded from the server: they are both current and stored. */
  reset: (b: BillingSettings) => void
  current: () => BillingSettings
}

export function createBillingSaver(opts: {
  initial: BillingSettings
  put: (b: BillingSettings) => Promise<{ ok: boolean }>
  onChange: (b: BillingSettings) => void
  /** A write was acknowledged: `b` is exactly what is now stored (it may carry several queued edits). */
  onStored?: (b: BillingSettings) => void
}): BillingSaver {
  let current = opts.initial
  let stored = opts.initial
  let seq = 0
  let chain: Promise<unknown> = Promise.resolve()
  const set = (b: BillingSettings) => { current = b; opts.onChange(b) }
  return {
    current: () => current,
    reset(b) { current = b; stored = b; opts.onChange(b) },
    save(change) {
      set(typeof change === 'function' ? change(current) : change)
      const mine = ++seq
      const run = async () => {
        const sent = current // the newest settings, not this call's snapshot
        try {
          const res = await opts.put(sent)
          if (!res.ok) throw new Error('billing save refused')
          stored = sent
          opts.onStored?.(sent)
        } catch (e) {
          if (mine === seq) set(stored)
          throw e
        }
      }
      const result = chain.then(run, run)
      chain = result.catch(() => undefined)
      return result
    },
  }
}

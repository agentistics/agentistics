import { useEffect, useMemo, useState } from 'react'
import type { BillingSettings, HarnessId, PlanAccountRef } from '@agentistics/core'

interface ApiAccount { id: string; harness: HarnessId; retired?: boolean }

/** The identified, still-signed-in accounts the plan arithmetic prices — `undefined` until the list
 *  has been read, so a failed read leaves every harness on its single timeline. Refetched when the
 *  billing settings change, which is when a newly detected account may have been answered. */
export function useBillingAccounts(billing: BillingSettings): readonly PlanAccountRef[] | undefined {
  const [accounts, setAccounts] = useState<ApiAccount[] | undefined>(undefined)
  useEffect(() => {
    let cancelled = false
    fetch('/api/accounts')
      .then(r => (r.ok ? r.json() : null))
      .then((b: { accounts?: ApiAccount[] } | null) => { if (!cancelled && b?.accounts) setAccounts(b.accounts) })
      .catch(() => { /* single-timeline pricing stands */ })
    return () => { cancelled = true }
  }, [billing])
  return useMemo(
    () => accounts?.filter(a => a.id !== '' && !a.retired).map(a => ({ id: a.id, harness: a.harness })),
    [accounts],
  )
}

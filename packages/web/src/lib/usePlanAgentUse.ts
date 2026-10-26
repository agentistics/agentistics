import { useEffect, useRef, useState } from 'react'
import type { HarnessId } from '@agentistics/core'
import { subscribeEvent } from './eventStream'
import { pushLocalNotification } from './notifications'
import { createAccountMutator } from '../pages/settings/accountMutations'

type PlanAccount = { id: string; harness: HarnessId; available: boolean; retired?: boolean }

/** Availability comes from the registry, including accounts with no meter or hidden budgets. */
export function usePlanAgentUse(enabled: boolean, lang: 'pt' | 'en') {
  const [accounts, setAccounts] = useState<PlanAccount[]>([])
  const [optimistic, setOptimistic] = useState<Record<string, boolean>>({})
  const mutator = useRef(createAccountMutator<PlanAccount>((id, body) => fetch(`/api/accounts/${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }))).current
  // Ignore a GET started before a save; it must not restore the old availability afterwards.
  const revision = useRef(0)
  useEffect(() => {
    if (!enabled) return
    let active = true
    const reload = async () => {
      const version = revision.current
      try {
        const r = await fetch('/api/accounts', { cache: 'no-store' })
        if (!r.ok) return
        const body = await r.json() as { accounts?: PlanAccount[] }
        if (active && version === revision.current) setAccounts(prev => (body.accounts ?? []).map(a =>
          mutator.has(a.id) ? prev.find(p => p.id === a.id) ?? a : a))
      } catch { /* Without the registry, meters remain visible but cannot be switched. */ }
    }
    void reload()
    const off = subscribeEvent('plan-limits', () => { void reload() })
    const connected = subscribeEvent('connected', () => { void reload() })
    return () => { active = false; off(); connected() }
  }, [enabled, mutator])

  return (harness: HarnessId, id?: string) => {
    const account = accounts.find(a => a.id && a.id === id && a.harness === harness && !a.retired)
    if (!enabled || !account) return undefined
    return {
      on: optimistic[account.id] ?? account.available,
      pending: Object.hasOwn(optimistic, account.id),
      onToggle: async () => {
        if (mutator.has(account.id)) return
        revision.current++
        const available = !account.available
        setOptimistic(prev => ({ ...prev, [account.id]: available }))
        const result = await mutator.patch(account.id, { available })
        revision.current++
        if (result.status === 'ok') {
          setAccounts(prev => prev.map(a => a.id === account.id ? result.account : a))
        } else if (result.status === 'failed') {
          setAccounts(prev => prev.map(a => a.id === account.id ? account : a))
          pushLocalNotification({ type: 'error', title: lang === 'pt' ? 'Não foi possível alterar o uso por agentes' : 'Could not change agent use',
            message: lang === 'pt' ? 'A escolha anterior foi mantida. Tente novamente.' : 'Your previous choice was kept. Try again.' })
        }
        setOptimistic(prev => { const next = { ...prev }; delete next[account.id]; return next })
      },
    }
  }
}

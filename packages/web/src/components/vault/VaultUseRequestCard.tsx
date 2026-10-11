import { useEffect, useState } from 'react'
import { ConfirmModal } from '../../pages/settings/primitives'
import { decideVaultUse, pendingVaultUseRequests, type VaultUseRequest } from '../../lib/vaultApi'

/** Uses the app's shared confirmation card; one card/gesture is deliberately shown at a time. */
export function VaultUseRequestCard({ lang }: { lang: 'pt' | 'en' }) {
  const [requests, setRequests] = useState<VaultUseRequest[]>([])
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let alive = true
    const load = () => { void pendingVaultUseRequests().then(r => { if (alive && r.ok) setRequests(r.requests ?? []) }) }
    load(); const timer = window.setInterval(load, 2_000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [])
  const request = requests[0]
  if (!request) return null
  const pt = lang === 'pt'
  const command = request.command ? `\n\n${request.command}` : ''
  const decide = async (approve: boolean) => {
    setBusy(true)
    await decideVaultUse(request.id, approve)
    setBusy(false)
    setRequests(current => current.filter(r => r.id !== request.id))
  }
  return <ConfirmModal open title={pt ? 'Um agente quer usar um segredo' : 'An agent wants to use a secret'}
    message={`${request.sessionTitle} (${request.harness}) — ${request.name} · ${request.field}${command}${request.flags.length ? `\n\n${pt ? 'Pode guardar o segredo.' : 'This command may keep the secret.'}` : ''}`}
    confirmLabel={busy ? (pt ? 'Confirmando…' : 'Confirming…') : (pt ? 'Aprovar' : 'Approve')}
    cancelLabel={pt ? 'Negar' : 'Deny'} onConfirm={() => { void decide(true) }} onCancel={() => { void decide(false) }} />
}

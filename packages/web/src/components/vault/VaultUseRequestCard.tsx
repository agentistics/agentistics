import { useEffect, useState } from 'react'
import { ConfirmModal } from '../../pages/settings/primitives'
import { decideVaultUse, pendingVaultUseRequests, type VaultUseRequest } from '../../lib/vaultApi'
import { phoneGesture } from '../../lib/passkey'

/** The words of one request — pure, so the card can be read in both languages without a browser. */
export function useRequestWords(request: VaultUseRequest, lang: 'pt' | 'en', busy = false) {
  const pt = lang === 'pt'
  const command = request.command ? `\n\n${request.command}` : ''
  return {
    title: pt ? 'Um agente quer usar um segredo' : 'An agent wants to use a secret',
    message: `${request.sessionTitle} (${request.harness}) — ${request.name} · ${request.field}${command}${request.flags.length ? `\n\n${pt ? 'Pode guardar o segredo.' : 'This command may keep the secret.'}` : ''}`,
    confirm: busy ? (pt ? 'Confirmando…' : 'Confirming…') : (pt ? 'Aprovar' : 'Approve'),
    cancel: pt ? 'Negar' : 'Deny',
  }
}

/** Uses the app's shared confirmation card. Deny never asks a gesture; Approve does (the server raises it). */
export function UseRequestDialog({ request, lang, busy, onDecide }: { request: VaultUseRequest; lang: 'pt' | 'en'; busy: boolean; onDecide: (approve: boolean) => void }) {
  const w = useRequestWords(request, lang, busy)
  return <ConfirmModal open title={w.title} message={w.message} confirmLabel={w.confirm} cancelLabel={w.cancel} onConfirm={() => onDecide(true)} onCancel={() => onDecide(false)} />
}

/** One card at a time. */
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
  const decide = async (approve: boolean) => {
    setBusy(true)
    const r = await decideVaultUse(request.id, approve, phoneGesture)
    setBusy(false)
    // A refused gesture leaves the request standing (it is still pending on the server); the poll redraws it.
    if (r.ok) setRequests(current => current.filter(x => x.id !== request.id))
  }
  return <UseRequestDialog request={request} lang={lang} busy={busy} onDecide={a => { void decide(a) }} />
}

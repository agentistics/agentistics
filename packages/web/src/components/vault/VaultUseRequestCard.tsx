import { useEffect, useState } from 'react'
import { ConfirmModal, DialogActions, dialogButtonStyle } from '../../pages/settings/primitives'
import { decideVaultUse, pendingVaultUseRequests, type VaultUseRequest } from '../../lib/vaultApi'
import { useIsMobile } from '../../hooks/useIsMobile'
import { phoneGesture } from '../../lib/passkey'
import { refreshVaultWatch, useVaultWatch } from '../../lib/vaultWatch'
import { pollVaultUseRequests } from '../../lib/vaultUsePolling'

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
export function UseRequestDialog({ request, lang, busy, onDecide, onClose }: { request: VaultUseRequest; lang: 'pt' | 'en'; busy: boolean; onDecide: (approve: boolean) => void; onClose: () => void }) {
  const w = useRequestWords(request, lang, busy)
  const isMobile = useIsMobile()
  // Esc / backdrop only CLOSE the card (the request stays pending); only the explicit Deny button revokes.
  const footer = (
    <DialogActions>
      <button type="button" disabled={busy} onClick={() => onDecide(false)} style={dialogButtonStyle('secondary', isMobile, busy)}>{w.cancel}</button>
      <button type="button" disabled={busy} onClick={() => onDecide(true)} style={dialogButtonStyle('primary', isMobile, busy)}>{w.confirm}</button>
    </DialogActions>
  )
  return <ConfirmModal open title={w.title} message={w.message} confirmLabel={w.confirm} cancelLabel={w.cancel} onConfirm={() => onDecide(true)} onCancel={onClose} footer={footer} tone="default" />
}

/** One card at a time. */
export function VaultUseRequestCard({ lang }: { lang: 'pt' | 'en' }) {
  const [requests, setRequests] = useState<VaultUseRequest[]>([])
  const [busy, setBusy] = useState(false)
  const { lock } = useVaultWatch(true)
  useEffect(() => pollVaultUseRequests({
    open: lock === 'open',
    load: pendingVaultUseRequests,
    onRequests: setRequests,
    onRefused: () => { void refreshVaultWatch() },
  }), [lock])
  const [hidden, setHidden] = useState<Record<string, number>>({})
  const request = requests.find(r => !((hidden[r.id] ?? 0) > Date.now()))
  if (lock !== 'open' || !request) return null
  const rid = request.id
  const decide = async (approve: boolean) => {
    setBusy(true)
    const r = await decideVaultUse(request.id, approve, phoneGesture)
    setBusy(false)
    // A refused gesture leaves the request standing (it is still pending on the server); the poll redraws it.
    if (r.ok) setRequests(current => current.filter(x => x.id !== request.id))
  }
  return <UseRequestDialog request={request} lang={lang} busy={busy} onDecide={a => { void decide(a) }} onClose={() => setHidden(h => ({ ...h, [rid]: Date.now() + 30_000 }))} />
}

/** Vault controls inside the shared Nay notice. Nothing runs without an explicit click. */
import { useLayoutEffect, useState } from 'react'
import { AgentisticsLoader } from '../AgentisticsLoader'
import { extendVaultOpen, lockVaultFromCard } from '../../lib/vaultApi'
import { refreshVaultWatch } from '../../lib/vaultWatch'
import { phoneGesture } from '../../lib/passkey'
import { helloErrored } from '../../lib/helloFallback'
import { confirmSentence, extendLabel, isLoopbackHost } from '../../lib/vaultExpiry'

export function VaultExpiryActions({ lang, isMobile, onDone, onLayout }: {
  lang: 'pt' | 'en'; isMobile: boolean; onDone: () => void; onLayout: () => void
}) {
  const pt = lang === 'pt'
  const [busy, setBusy] = useState<null | 'extend' | 'lock'>(null)
  const [phone, setPhone] = useState(() => typeof window !== 'undefined' && !isLoopbackHost(window.location.hostname))
  const [error, setError] = useState<string | null>(null)
  useLayoutEffect(() => { onLayout() }, [error, busy, phone]) // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (what: 'extend' | 'lock') => {
    setBusy(what); setError(null)
    let r = await (what === 'extend' ? extendVaultOpen() : lockVaultFromCard())
    if (!r.ok && what === 'extend' && r.code === 'mobile-gesture-required') {
      setPhone(true)
      const g = await phoneGesture('extend-open', '')
      r = g.ok ? await extendVaultOpen(g.gestureToken) : g
    }
    setBusy(null)
    if (r.ok) { onDone(); await refreshVaultWatch(); return }
    if (r.code === 'presence-cancelled' || r.code === 'passkey-cancelled') return
    setError(helloErrored(r.code) || r.code === 'presence-required'
      ? (pt ? 'Windows Hello não respondeu. Tente novamente.' : 'Windows Hello did not respond. Try again.')
      : r.sentence || (pt ? 'Não foi possível agora.' : 'Could not do that right now.'))
  }

  const btn: React.CSSProperties = { minHeight: isMobile ? 44 : 32, padding: '0 12px', minWidth: 112, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }
  return (
    <div role="group" aria-label={pt ? 'Cofre vai se trancar' : 'Vault is about to lock'} data-vault-expiry
      style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', minWidth: 0, gap: 10 }}>
      {busy === 'extend' && <div role="status" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
        {confirmSentence(phone, pt)}
      </div>}
      {error && <div role="status" style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>{error}</div>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" data-vault-extend disabled={busy !== null} onClick={() => { void run('extend') }}
          style={{ ...btn, minWidth: 150, background: 'var(--anthropic-orange)', borderColor: 'var(--anthropic-orange)', color: '#fff', fontWeight: 600 }}>
          {busy === 'extend' && <AgentisticsLoader size={14} accent="#fff" baseOpacity={0.5} />}{extendLabel(busy === 'extend', pt)}
        </button>
        <button type="button" data-vault-lock-now disabled={busy !== null} onClick={() => { void run('lock') }} style={btn}>
          {busy === 'lock' && <AgentisticsLoader size={14} />}{busy === 'lock' ? (pt ? 'Trancando…' : 'Locking…') : (pt ? 'Trancar agora' : 'Lock now')}
        </button>
      </div>
    </div>
  )
}

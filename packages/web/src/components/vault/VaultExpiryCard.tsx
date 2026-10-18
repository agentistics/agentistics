/**
 * "Seu cofre vai se trancar em 5 min. Manter aberto?" — the auto-lock warning, spoken by the Nay floating
 * chat (owner, 2026-10-04). Pure rule: `lib/vaultExpiry.ts` (once per window, re-armed by any extension).
 *
 * [Manter aberto] extends by ONE auto-lock window — a click, never the authenticator code (that is only
 * for unlocking a fully locked vault); [Trancar agora] locks. Nobody answers → it locks as
 * it always did. NEVER extends on its own. The same warning lands in Notificações, once.
 */
import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { AgentisticsLoader } from '../AgentisticsLoader'
import { pushNotification } from '../../lib/notifications'
import { WARN_INITIAL, nextWarn, type WarnState } from '../../lib/vaultExpiry'
import { extendVaultOpen, lockVaultFromCard } from '../../lib/vaultApi'
import { refreshVaultWatch, useVaultWatch } from '../../lib/vaultWatch'
import { VaultGlyph } from './VaultGlyph'


export function VaultExpiryCard({ lang, isMobile, zIndex, enabled = true }: { lang: 'pt' | 'en'; isMobile: boolean; zIndex: number; enabled?: boolean }) {
  const pt = lang === 'pt'
  const w = useVaultWatch(enabled)
  const warn = useRef<WarnState>(WARN_INITIAL)
  const [shown, setShown] = useState(false)
  const [busy, setBusy] = useState<null | 'extend' | 'lock'>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const r = nextWarn(warn.current, w.autoLockInMs)
    warn.current = r.state
    if (r.fire) {
      setShown(true)
      pushNotification({ type: 'warning', code: 'vault.autolock-soon',
        title: pt ? 'Seu cofre vai se trancar em 5 min' : 'Your vault locks in 5 min',
        message: pt ? 'Abra o chat da Nay para mantê-lo aberto ou trancar agora.' : 'Open the Nay chat to keep it open or lock it now.' })
    }
    if (w.autoLockInMs === null || w.autoLockInMs > 5 * 60_000) { setShown(false); setError(null) }
  }, [w.at, w.autoLockInMs, pt])

  if (!enabled || !shown) return null

  const run = async (what: 'extend' | 'lock') => {
    setBusy(what); setError(null)
    const r = await (what === 'extend' ? extendVaultOpen() : lockVaultFromCard())
    setBusy(null)
    if (r.ok) { setShown(false); await refreshVaultWatch(); return }
    // Never an authenticator-code prompt here: the code is only for unlocking a fully locked vault.
    setError(r.sentence || (pt ? 'Não foi possível agora.' : 'Could not do that right now.'))
  }

  const btn: React.CSSProperties = { minHeight: isMobile ? 44 : 32, padding: '0 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }
  return (
    <div role="alertdialog" aria-label={pt ? 'Cofre vai se trancar' : 'Vault is about to lock'} data-vault-expiry
      style={{ position: 'fixed', right: isMobile ? 12 : 24, bottom: isMobile ? 84 : 96, width: isMobile ? 'calc(100vw / var(--ui-zoom, 1) - 24px)' : 340, boxSizing: 'border-box', zIndex: Math.max(zIndex, 1100), padding: 14, borderRadius: 14, border: '1px solid var(--anthropic-orange)', background: 'var(--bg-elevated)', opacity: 1, boxShadow: '0 10px 30px rgba(0,0,0,.35)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span aria-hidden style={{ color: 'var(--anthropic-orange)', display: 'inline-flex' }}><VaultGlyph size={16} /></span>
        <strong style={{ flex: 1, fontSize: 13.5 }}>{pt ? 'Seu cofre vai se trancar em 5 min. Manter aberto?' : 'Your vault locks in 5 min. Keep it open?'}</strong>
        <button type="button" className="ag-tap-icon" aria-label={pt ? 'Dispensar' : 'Dismiss'} onClick={() => setShown(false)}
          style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: 4 }}><X size={15} /></button>
      </div>
      {error && <div role="status" style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>{error}</div>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" data-vault-extend disabled={busy !== null} onClick={() => { void run('extend') }}
          style={{ ...btn, background: 'var(--anthropic-orange)', borderColor: 'var(--anthropic-orange)', color: '#fff', fontWeight: 600 }}>
          {busy === 'extend' ? <AgentisticsLoader size={13} /> : (pt ? 'Manter aberto' : 'Keep open')}
        </button>
        <button type="button" data-vault-lock-now disabled={busy !== null} onClick={() => { void run('lock') }} style={btn}>
          {busy === 'lock' ? <AgentisticsLoader size={13} /> : (pt ? 'Trancar agora' : 'Lock now')}
        </button>
      </div>
    </div>
  )
}

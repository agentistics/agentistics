import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Clock3, Lock, LockOpen } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useCodeCountdown } from './VaultCodeClock'
import { vaultBadgeOf, vaultLockWord } from '../../lib/vaultGlyph'
import { useVaultWatch } from '../../lib/vaultWatch'
import { VaultGlyph } from './VaultGlyph'

/**
 * Cofre, in the fixed header's action group (owner, 2026-10-04): the safe icon wearing a STATE BADGE — a
 * red circle with a closed padlock while locked, a green one with an open padlock while open (owner,
 * 2026-10-05), at the top-right corner exactly where the bell wears its unread badge. The icon itself is
 * ALWAYS the header's neutral colour — never orange, not even on /vault (owner, 2026-10-05) — which follows the vault live (`useVaultWatch`). The tooltip names the state too, so the
 * colour never carries it alone. A click goes to /vault. Absent on a central, whose /api/vault is 404.
 *
 * VAULT.UX-R2: the hover tooltip is the app's themed one (the same card the collapsed sidebar uses), and
 * under the state it carries the code clock — "Código do autenticador pedido de novo em 5 h 12 min".
 */
export function VaultHeaderButton({ lang, buttonStyle, enabled = true }: { lang: 'pt' | 'en'; buttonStyle: React.CSSProperties; enabled?: boolean }) {
  const pt = lang === 'pt'
  const navigate = useNavigate()
  const lock = useVaultWatch(enabled).lock
  const clock = useCodeCountdown(lang, enabled)
  const ref = useRef<HTMLButtonElement>(null)
  const [tip, setTip] = useState<{ top: number; right: number } | null>(null)
  if (!enabled) return null
  const word = vaultLockWord(lock, pt)
  const label = `${pt ? 'Cofre' : 'Vault'} — ${word}`
  const badge = vaultBadgeOf(lock)
  return (
    <button ref={ref} type="button" data-vault-header data-lock={lock} className="ag-tap-icon" aria-label={clock ? `${label}. ${clock}` : label}
      onClick={() => { setTip(null); navigate('/vault') }}
      onMouseEnter={() => { const r = ref.current?.getBoundingClientRect(); if (r) setTip({ top: r.bottom + 8, right: Math.max(8, window.innerWidth - r.right) }) }}
      onMouseLeave={() => setTip(null)} onBlur={() => setTip(null)}
      style={{ ...buttonStyle, position: 'relative' }}>
      <VaultGlyph size={16} />
      {badge && (
        <span aria-hidden data-vault-badge={badge.shape} style={{
          // The bell's own badge position and size (NotificationBell.tsx): top-right, -5/-5, 16 px.
          position: 'absolute', top: -5, right: -5, width: 16, height: 16, borderRadius: '50%', display: 'grid', placeItems: 'center',
          background: badge.color, color: '#fff', boxSizing: 'border-box',
        }}>
          {badge.shape === 'open' ? <LockOpen size={9} strokeWidth={2.6} /> : <Lock size={9} strokeWidth={2.6} />}
        </span>
      )}
      {tip && createPortal(
        <div role="tooltip" data-vault-header-tip style={{
          position: 'fixed', top: tip.top, right: tip.right,
          background: 'var(--bg-card)', color: 'var(--text-primary)',
          border: '1px solid var(--border)', borderRadius: 7, padding: '6px 10px',
          fontSize: '0.75rem', fontWeight: 600, whiteSpace: 'nowrap', textAlign: 'left',
          boxShadow: '0 6px 20px rgba(0,0,0,0.35)', zIndex: 500, pointerEvents: 'none',
        }}>
          <div>{label}</div>
          {clock && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 3, fontWeight: 500, color: 'var(--text-secondary)' }}>
              <Clock3 size={12} aria-hidden /> {clock}
            </div>
          )}
        </div>,
        document.body,
      )}
    </button>
  )
}

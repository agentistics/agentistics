import { Lock, LockOpen } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { vaultBadgeOf, vaultLockWord } from '../../lib/vaultGlyph'
import { useVaultWatch } from '../../lib/vaultWatch'
import { VaultGlyph } from './VaultGlyph'

/**
 * Cofre, in the fixed header's action group (owner, 2026-10-04): the safe icon wearing a STATE BADGE — a
 * red circle with a closed padlock while locked, a green one with an open padlock while open (owner,
 * 2026-10-05), at the top-right corner exactly where the bell wears its unread badge. The icon itself is
 * ALWAYS the header's neutral colour — never orange, not even on /vault (owner, 2026-10-05) — which follows the vault live (`useVaultWatch`). The tooltip names the state too, so the
 * colour never carries it alone. A click goes to /vault. Absent on a central, whose /api/vault is 404.
 */
export function VaultHeaderButton({ lang, buttonStyle, enabled = true }: { lang: 'pt' | 'en'; buttonStyle: React.CSSProperties; enabled?: boolean }) {
  const pt = lang === 'pt'
  const navigate = useNavigate()
  const lock = useVaultWatch(enabled).lock
  if (!enabled) return null
  const word = vaultLockWord(lock, pt)
  const label = `${pt ? 'Cofre' : 'Vault'} — ${word}`
  const badge = vaultBadgeOf(lock)
  return (
    <button type="button" data-vault-header data-lock={lock} className="ag-tap-icon" title={label} aria-label={label}
      onClick={() => navigate('/vault')}
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
    </button>
  )
}

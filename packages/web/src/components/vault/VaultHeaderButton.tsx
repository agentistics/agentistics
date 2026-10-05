import { Lock, LockOpen } from 'lucide-react'
import { useNavigate, useLocation } from 'react-router-dom'
import { vaultBadgeOf, vaultLockWord } from '../../lib/vaultGlyph'
import { useVaultWatch } from '../../lib/vaultWatch'
import { VaultGlyph } from './VaultGlyph'

/**
 * Cofre, in the fixed header's action group (owner, 2026-10-04): the safe icon wearing a STATE BADGE — a
 * red circle with a closed padlock while locked, a green one with an open padlock while open (owner,
 * 2026-10-05) — which follows the vault live (`useVaultWatch`). The tooltip names the state too, so the
 * colour never carries it alone. A click goes to /vault. Absent on a central, whose /api/vault is 404.
 */
export function VaultHeaderButton({ lang, buttonStyle, enabled = true }: { lang: 'pt' | 'en'; buttonStyle: React.CSSProperties; enabled?: boolean }) {
  const pt = lang === 'pt'
  const navigate = useNavigate()
  const active = useLocation().pathname.startsWith('/vault')
  const lock = useVaultWatch(enabled).lock
  if (!enabled) return null
  const word = vaultLockWord(lock, pt)
  const label = `${pt ? 'Cofre' : 'Vault'} — ${word}`
  const badge = vaultBadgeOf(lock)
  return (
    <button type="button" data-vault-header data-lock={lock} className="ag-tap-icon" title={label} aria-label={label}
      onClick={() => navigate('/vault')}
      style={{ ...buttonStyle, position: 'relative', ...(active ? { color: 'var(--anthropic-orange)', borderColor: 'var(--anthropic-orange)' } : {}) }}>
      <VaultGlyph size={17} />
      {badge && (
        <span aria-hidden data-vault-badge={badge.shape} style={{
          position: 'absolute', right: -5, bottom: -5, width: 15, height: 15, borderRadius: '50%', display: 'grid', placeItems: 'center',
          background: badge.color, color: '#fff', boxShadow: '0 0 0 2px var(--bg-primary, #0d0d0d)',
        }}>
          {badge.shape === 'open' ? <LockOpen size={9} strokeWidth={2.6} /> : <Lock size={9} strokeWidth={2.6} />}
        </span>
      )}
    </button>
  )
}

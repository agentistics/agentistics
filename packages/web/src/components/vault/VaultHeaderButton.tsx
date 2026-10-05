import { useNavigate, useLocation } from 'react-router-dom'
import { vaultLockWord } from '../../lib/vaultGlyph'
import { useVaultWatch } from '../../lib/vaultWatch'
import { VaultGlyph } from './VaultGlyph'

/**
 * Cofre, in the fixed header's action group (owner, 2026-10-04): the lock state rides on the icon as
 * a dot, the tooltip names it, and a click goes to /vault. Absent on a central, whose /api/vault is 404.
 */
export function VaultHeaderButton({ lang, buttonStyle, enabled = true }: { lang: 'pt' | 'en'; buttonStyle: React.CSSProperties; enabled?: boolean }) {
  const pt = lang === 'pt'
  const navigate = useNavigate()
  const active = useLocation().pathname.startsWith('/vault')
  const lock = useVaultWatch(enabled).lock
  if (!enabled) return null
  const word = vaultLockWord(lock, pt)
  const label = `${pt ? 'Cofre' : 'Vault'} — ${word}`
  const dot = lock === 'open' ? '#22c55e' : lock === 'locked' ? '#f59e0b' : 'transparent'
  return (
    <button type="button" data-vault-header data-lock={lock} className="ag-tap-icon" title={label} aria-label={label}
      onClick={() => navigate('/vault')}
      style={{ ...buttonStyle, position: 'relative', ...(active ? { color: 'var(--anthropic-orange)', borderColor: 'var(--anthropic-orange)' } : {}) }}>
      <VaultGlyph size={15} />
      <span aria-hidden style={{ position: 'absolute', top: 5, right: 5, width: 7, height: 7, borderRadius: '50%', background: dot, boxShadow: '0 0 0 1.5px var(--bg-primary, #0d0d0d)' }} />
    </button>
  )
}

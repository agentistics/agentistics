/** Vault controls inside the shared Nay notice. Nothing runs without an explicit click. */
import { useLayoutEffect, useState } from 'react'
import { AgentisticsLoader } from '../AgentisticsLoader'
import { extendVaultOpen, lockVaultFromCard, stepUp } from '../../lib/vaultApi'
import { refreshVaultWatch } from '../../lib/vaultWatch'
import { CodeBoxes } from '../CodeBoxes'

export function VaultExpiryActions({ lang, isMobile, onDone, onLayout }: {
  lang: 'pt' | 'en'; isMobile: boolean; onDone: () => void; onLayout: () => void
}) {
  const pt = lang === 'pt'
  const [busy, setBusy] = useState<null | 'extend' | 'lock'>(null)
  const [needCode, setNeedCode] = useState<null | 'extend' | 'lock'>(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  useLayoutEffect(() => { onLayout() }, [needCode, error, busy]) // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (what: 'extend' | 'lock', withCode?: string) => {
    setBusy(what); setError(null)
    // Keep-open needs the page's read grant: with a code, take the step-up first (it hands the grant back), then extend.
    if (what === 'extend' && withCode) {
      const g = await stepUp(withCode)
      if (!g.ok) { setBusy(null); setError(g.sentence || (pt ? 'Não foi possível agora.' : 'Could not do that right now.')); if (g.code === 'stepup-wrong') setNeedCode('extend'); return }
    }
    const r = await (what === 'extend' ? extendVaultOpen() : lockVaultFromCard(withCode))
    setBusy(null)
    if (r.ok) { setNeedCode(null); setCode(''); onDone(); await refreshVaultWatch(); return }
    if (r.code === 'stepup-required' || r.code === 'stepup-wrong') { setNeedCode(what); setError(r.code === 'stepup-wrong' ? r.sentence : null); return }
    setError(r.sentence || (pt ? 'Não foi possível agora.' : 'Could not do that right now.'))
  }

  const btn: React.CSSProperties = { minHeight: isMobile ? 44 : 32, padding: '0 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }
  return (
    <div role="group" aria-label={pt ? 'Cofre vai se trancar' : 'Vault is about to lock'} data-vault-expiry
      style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', minWidth: 0, gap: 10 }}>
      {needCode && (
        <form onSubmit={e => { e.preventDefault(); if (busy === null && code.trim()) void run(needCode, code.trim()) }} style={{ minWidth: 0, marginBottom: 10 }}>
          <CodeBoxes value={code} onChange={setCode} label={pt ? 'Código do autenticador' : 'Authenticator code'} autoFocus disabled={busy !== null} onEnter={() => { if (busy === null && code.trim()) void run(needCode, code.trim()) }} error={!!error} errorKey={error} style={{ minWidth: 0, marginBottom: 0 }} />
        </form>
      )}
      {error && <div role="status" style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>{error}</div>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" data-vault-extend disabled={busy !== null} onClick={() => { void (needCode === 'extend' && code.trim() ? run('extend', code.trim()) : run('extend')) }}
          style={{ ...btn, background: 'var(--anthropic-orange)', borderColor: 'var(--anthropic-orange)', color: '#fff', fontWeight: 600 }}>
          {busy === 'extend' ? <AgentisticsLoader size={13} /> : (pt ? 'Manter aberto' : 'Keep open')}
        </button>
        <button type="button" data-vault-lock-now disabled={busy !== null} onClick={() => { void (needCode === 'lock' && code.trim() ? run('lock', code.trim()) : run('lock')) }} style={btn}>
          {busy === 'lock' ? <AgentisticsLoader size={13} /> : (pt ? 'Trancar agora' : 'Lock now')}
        </button>
      </div>
    </div>
  )
}

/**
 * Settings → Vault. What is sealed on this machine and in what state — METADATA ONLY. The route
 * (`GET /api/vault`) never carries a value, a fragment or a fingerprint, so this page has nothing
 * to hide; there is deliberately no "show secret" anywhere. The one action is "Lock now", which
 * only reduces what is open (the server runs it through `requireVaultStepUp`).
 */
import { useCallback, useEffect, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import type { AppContext } from '../../lib/app-context'
import { useIsMobile } from '../../hooks/useIsMobile'
import { SectionHeader, Divider, PrefRow } from './primitives'
import { itemStateKey, kindKey, orderItems, reasonKey, stateKey, vt, type VaultKey } from '../../lib/vaultText'

interface VaultItem {
  kind: string
  state: 'sealed' | 'pending' | 'unreadable'
  reason?: string
  sealedAt?: string
  file: string
  restoreWith?: string
}
interface VaultView {
  state: string
  protectorLabel: string | null
  kid: string | null
  createdAt: string | null
  sentence: string | null
  canLock: boolean
  items: VaultItem[]
}

const TONE: Record<VaultItem['state'], string> = {
  sealed: 'var(--accent-green, #22c55e)',
  pending: 'var(--accent-orange, #f59e0b)',
  unreadable: 'var(--accent-red, #ef4444)',
}

export default function VaultSettings() {
  const ctx = useOutletContext<AppContext>()
  const lang = ctx.lang === 'pt' ? 'pt' : 'en'
  const isMobile = useIsMobile()
  const t = (k: VaultKey) => vt(k, lang)

  const [view, setView] = useState<VaultView | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [lockError, setLockError] = useState(false)

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/vault')
      if (!r.ok) throw new Error(String(r.status))
      setView(await r.json() as VaultView)
      setFailed(false)
    } catch { setFailed(true) }
  }, [])
  useEffect(() => { void load() }, [load])

  const lock = async () => {
    setBusy(true); setLockError(false)
    try {
      const r = await fetch('/api/vault/lock', { method: 'POST' })
      if (!r.ok) throw new Error(String(r.status))
      await load()
    } catch { setLockError(true) } finally { setBusy(false) }
  }

  const fmt = (iso?: string | null) => {
    if (!iso) return t('unknown')
    const d = new Date(iso)
    return Number.isNaN(d.getTime()) ? t('unknown') : d.toLocaleString(lang === 'pt' ? 'pt-BR' : 'en-US')
  }

  if (failed) return <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{t('loadFailed')}</div>
  if (!view) return <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>{t('loading')}</div>

  const items = orderItems(view.items)
  const pending = items.filter(i => i.state === 'pending')
  const mono: React.CSSProperties = { fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 12, wordBreak: 'break-all' }

  return (
    <>
      <SectionHeader label={t('title')} />
      <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 18 }}>{t('intro')}</div>

      <SectionHeader label={t('stateHeader')} />
      <PrefRow label={t('state')}><strong style={{ fontSize: 13 }}>{t(stateKey(view.state))}</strong></PrefRow>
      <PrefRow label={t('protector')}><span style={{ fontSize: 13, textAlign: 'right', minWidth: 0 }}>{view.protectorLabel ?? t('none')}</span></PrefRow>
      <PrefRow label={t('keyId')}><span style={mono}>{view.kid ?? t('none')}</span></PrefRow>
      <PrefRow label={t('created')}><span style={{ fontSize: 13 }}>{view.createdAt ? fmt(view.createdAt) : t('none')}</span></PrefRow>
      {view.sentence && (
        <div role="status" style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 14 }}>{view.sentence}</div>
      )}
      <PrefRow label={t('lockNow')} sub={t('lockHint')}>
        <button
          type="button" onClick={() => { void lock() }} disabled={!view.canLock || busy}
          style={{
            padding: isMobile ? '10px 16px' : '6px 14px', minHeight: isMobile ? 44 : undefined, borderRadius: 8, fontSize: 13,
            border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-primary)',
            cursor: !view.canLock || busy ? 'not-allowed' : 'pointer', opacity: !view.canLock ? 0.5 : 1,
          }}
        >{busy ? t('locking') : t('lockNow')}</button>
      </PrefRow>
      {lockError && <div role="alert" style={{ fontSize: 12, color: 'var(--accent-red, #ef4444)', marginBottom: 10 }}>{t('lockFailed')}</div>}

      <Divider />

      {pending.length > 0 && (
        <div role="status" style={{
          border: '1px solid var(--accent-orange, #f59e0b)', borderRadius: 10, padding: '12px 14px', marginBottom: 18,
          background: 'color-mix(in srgb, var(--accent-orange, #f59e0b) 8%, transparent)',
        }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>{t('pendingTitle')} · {pending.length}</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6, marginTop: 4 }}>{t('pendingBody')}</div>
        </div>
      )}

      <SectionHeader label={t('secretsHeader')} />
      {items.length === 0 && <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>{t('secretsEmpty')}</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {items.map((i, n) => {
          const why = reasonKey(i.reason)
          return (
            <div key={`${i.file}-${n}`} style={{
              border: '1px solid ' + (i.state === 'sealed' ? 'var(--border)' : TONE[i.state]), borderRadius: 10, padding: '12px 14px',
              minWidth: 0,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'baseline' }}>
                <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-primary)' }}>{t(kindKey(i.kind))}</span>
                <span style={{ fontSize: 11.5, fontWeight: 700, color: TONE[i.state] }}>{t(itemStateKey(i.state))}</span>
              </div>
              <div style={{ ...mono, color: 'var(--text-tertiary)', marginTop: 4 }}>{i.file}</div>
              {i.sealedAt && <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>{t('sealedAt')}: {fmt(i.sealedAt)}</div>}
              {why && <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>{t(why)}</div>}
              {i.restoreWith && (
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
                  {t('howToReenter')}: <span style={mono}>{i.restoreWith}</span>
                </div>
              )}
            </div>
          )
        })}
      </div>

      <Divider />

      <details>
        <summary style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)', cursor: 'pointer', padding: isMobile ? '10px 0' : '4px 0' }}>
          {t('howTitle')}
        </summary>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 12 }}>
          {([['how_envelope_h', 'how_envelope'], ['how_holder_h', 'how_holder'], ['how_protects_h', 'how_protects'], ['how_not_h', 'how_not'], ['how_backup_h', 'how_backup']] as const).map(([h, b]) => (
            <div key={h}>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-primary)' }}>{t(h)}</div>
              <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.65, marginTop: 3 }}>{t(b)}</div>
            </div>
          ))}
        </div>
      </details>
    </>
  )
}

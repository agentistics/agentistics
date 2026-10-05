/**
 * The vault unlock, callable from anywhere (VAULT.PERSONAL §10).
 *
 * `ensureVaultOpen()` resolves `true` at once when the vault is open; otherwise it shows ONE modal with
 * the shared `VaultUnlock` (Hello + code here, the phone's own ways on a phone) and resolves `true` once
 * the vault opened — so the action that needed it carries on by itself — or `false` when the person
 * closes it. A module-level store with one mounted host (the notifications pattern), so a hook or a
 * plain async function can ask too, not only a component inside some provider.
 *
 * The host also shows, on THIS computer, the phones waiting for approval: a phone asking to be
 * registered must be visible wherever the person is, not only on the vault page.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import type React from 'react'
import { X } from 'lucide-react'
import { card, overlay } from '../MfaSetup'
import { loadVault, unlockFor } from '../../lib/vaultApi'
import { phoneFacts } from '../../lib/phoneVault'
import { PhoneRequests, VaultUnlock, usePhoneRequests } from './VaultUnlock'

type Ask = { resolve: (ok: boolean) => void }
let _ask: Ask | null = null
let _hosted = 0
const listeners = new Set<() => void>()
const emit = () => { for (const l of listeners) l() }
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }

/**
 * Open the vault if it is locked (asking the person), then resolve whether it is open. `forAction`
 * (`personal-grant:<sid>`) names the ONE action this unlock is for: its Hello then also covers that
 * action, for this page only (review H2) — never prompting twice for one act.
 */
export async function ensureVaultOpen(forAction?: string): Promise<boolean> {
  const v = await loadVault()
  // Only a LOCKED vault is asked about. Open is open; an uninitialized one creates itself on first
  // use, and anything else (unreachable, broken) is the action's own error to report, in its words.
  if (v.kind === 'failed' || v.view.state !== 'locked') return true
  if (_hosted === 0) return false
  unlockFor(forAction ?? null)
  if (_ask) { const prev = _ask; return new Promise<boolean>(res => { _ask = { resolve: ok => { prev.resolve(ok); res(ok) } }; emit() }) }
  return new Promise<boolean>(res => { _ask = { resolve: res }; emit() })
}
/**
 * For a failure whose cause is not named (a native send, say): `true` only when the vault WAS locked
 * and is open now — the one case where retrying can change the outcome. Open or not-a-vault-problem
 * answers `false`, so the caller reports its own error instead of retrying blindly.
 */
export async function unlockIfLocked(): Promise<boolean> {
  const v = await loadVault()
  if (v.kind === 'failed' || v.view.state !== 'locked') return false
  return ensureVaultOpen()
}
function answer(ok: boolean): void { const a = _ask; _ask = null; unlockFor(null); emit(); a?.resolve(ok) }

export function VaultUnlockHost({ lang, isMobile, enabled }: { lang: 'en' | 'pt'; isMobile: boolean; enabled: boolean }) {
  const ask = useSyncExternalStore(subscribe, () => _ask, () => null)
  const [loopback, setLoopback] = useState(false)
  useEffect(() => {
    if (!enabled) return
    _hosted++
    void phoneFacts().then(f => { if (f.ok) setLoopback(f.loopback) })
    return () => { _hosted--; if (_ask) answer(false) }
  }, [enabled])
  const { requests, refresh } = usePhoneRequests(enabled && loopback)
  useEffect(() => {
    if (!ask) return
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') answer(false) }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [ask])
  if (!enabled) return null

  const o: React.CSSProperties = isMobile ? { ...overlay, padding: 0, zIndex: 3200 } : { ...overlay, zIndex: 3200 }
  const c: React.CSSProperties = isMobile
    ? { ...card, maxWidth: 'none', width: '100%', height: '100dvh', maxHeight: '100dvh', borderRadius: 0, border: 'none', overflowY: 'auto', boxSizing: 'border-box' }
    : { ...card, maxWidth: 440, maxHeight: '92vh', overflowY: 'auto', boxSizing: 'border-box' }
  const title = lang === 'pt' ? 'Destrancar o cofre' : 'Unlock the vault'
  const why = lang === 'pt' ? 'Esta ação precisa do cofre aberto. Destranque aqui e ela continua sozinha.' : 'This needs the vault open. Unlock it here and it carries on by itself.'
  return (
    <>
      {ask && (
        <div style={o} role="dialog" aria-modal="true" aria-label={title} onClick={() => answer(false)}>
          <div style={c} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', flex: 1 }}>{title}</div>
              <button type="button" className="ag-tap-icon" aria-label={lang === 'pt' ? 'Fechar' : 'Close'} onClick={() => answer(false)}
                style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: 6 }}><X size={18} /></button>
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 14 }}>{why}</div>
            <VaultUnlock lang={lang} isMobile={isMobile} onOpened={() => answer(true)} />
          </div>
        </div>
      )}
      {requests.length > 0 && (
        <div style={{ position: 'fixed', right: isMobile ? 12 : 20, left: isMobile ? 12 : undefined, bottom: isMobile ? 84 : 20, zIndex: 3100, width: isMobile ? undefined : 380 }}>
          <PhoneRequests lang={lang} isMobile={isMobile} requests={requests} onChanged={refresh} />
        </div>
      )}
    </>
  )
}

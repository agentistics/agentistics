import { useCallback, useEffect, useRef, useState } from 'react'
import { AgentisticsLoader } from '../AgentisticsLoader'
import { VaultUnlock, CodeField } from './VaultUnlock'
import { VaultSafe, SAFE_OPEN_MS, SAFE_WIDTH_DESKTOP, SAFE_WIDTH_MOBILE, type SafePhase } from './VaultSafe'
import { VaultCodeClock } from './VaultCodeClock'
import { refreshVaultWatch } from '../../lib/vaultWatch'
import { codeComplete, type UiAction } from '../../lib/vaultApi'
import { Err } from '../MfaSetup'
import { dialogButtonStyle } from '../../pages/settings/primitives'

type Lang = 'pt' | 'en'

const WORDS = {
  lockedTitle: { en: 'Vault locked', pt: 'Cofre trancado' },
  lockedSub: { en: 'Your secrets are protected. Unlock with Windows Hello or your code.', pt: 'Seus segredos estão protegidos. Destrave com Windows Hello ou o código.' },
  unlockingTitle: { en: 'Unlocking…', pt: 'Destravando…' },
  unlockingSub: { en: 'Confirm on this computer, or enter the code.', pt: 'Confirme neste computador ou digite o código.' },
  openTitle: { en: 'Vault open', pt: 'Cofre aberto' },
  openSub: { en: 'Done. It locks by itself after a while without use.', pt: 'Pronto. Ele tranca sozinho depois de um tempo sem uso.' },
} as const

/** The panel's safe (the Nay dock's Cofre tab): the same drawing, scaled to a ~360px column. */
export const SAFE_WIDTH_PANEL = 82

/** Reduced motion: no waiting for an animation that is not going to play. */
function reducedMotion(): boolean {
  try { return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false }
}

/**
 * The vault page while it is LOCKED: the big safe, centred, with a state title, one sentence and the
 * unlock action under it (owner-approved, 2026-10-05). The dial turns like a combination lock while an
 * unlock is in progress; when it succeeds the safe opens (dial, bolts, door) and only THEN is `onOpened`
 * called — the page shows its content after the door has swung. `fromOpen` is a vault that just locked:
 * it mounts open and closes, short. No animation under `prefers-reduced-motion`: `onOpened` is immediate.
 */
export function VaultStage({ lang, isMobile, fromOpen, onOpened, compact, onAction, extra }: {
  lang: Lang; isMobile: boolean; fromOpen?: boolean; onOpened: () => void
  /** v2.98.1: the page control a refusal points at (recover / enroll / disable presence). */
  onAction?: (a: UiAction) => void
  /** One more way in under the unlock (the page's "Recover with the 24 words", on this computer). */
  extra?: React.ReactNode
  /** Drawn inside a panel (the Nay dock's Cofre tab): a smaller safe, and no viewport-tall block. */
  compact?: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [opening, setOpening] = useState(false)
  const done = useRef(onOpened)
  done.current = onOpened
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  const opened = useCallback(() => {
    void refreshVaultWatch() // the header badge and the code clock follow at once, not at the next poll
    if (reducedMotion()) { done.current(); return }
    setOpening(true)
    timer.current = setTimeout(() => done.current(), SAFE_OPEN_MS)
  }, [])
  const phase: SafePhase = opening ? 'opening' : busy ? 'unlocking' : 'locked'
  const w = (k: keyof typeof WORDS) => WORDS[k][lang]
  const title = opening ? w('openTitle') : busy ? w('unlockingTitle') : w('lockedTitle')
  const sub = opening ? w('openSub') : busy ? w('unlockingSub') : w('lockedSub')
  return (
    <StageFrame isMobile={isMobile} compact={compact} phase={phase} fromOpen={fromOpen} label={w('lockedTitle')} title={title} sub={sub}>
      {!opening && <VaultUnlock lang={lang} isMobile={isMobile} center onOpened={opened} onBusy={setBusy} {...(onAction ? { onAction } : {})} />}
      {!opening && !busy && <VaultCodeClock lang={lang} center style={{ marginTop: 12 }} />}
      {!opening && !busy && extra}
    </StageFrame>
  )
}

/**
 * The same centred safe when the vault is OPEN but the list still owes the authenticator code: the code
 * field lives inside the composition, styled like every other code field (`CodeField`), never as a bare
 * form. While the code is checked the dial turns; the door does not move — nothing is unlocked here.
 */
export function VaultCodeStage({ lang, isMobile, compact, title, sub, error, onSubmit }: {
  lang: Lang; isMobile: boolean; compact?: boolean; title: string; sub: string; error: string | null
  onSubmit: (code: string) => Promise<void>
}) {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = () => {
    if (!codeComplete(code) || busy) return
    setBusy(true)
    void onSubmit(code).finally(() => { setBusy(false); setCode('') })
  }
  return (
    <StageFrame isMobile={isMobile} compact={compact} phase={busy ? 'unlocking' : 'locked'} label={title} title={title} sub={sub}>
      <form onSubmit={e => { e.preventDefault(); submit() }} style={{ width: isMobile ? '100%' : 260, textAlign: 'left' }}>
        <CodeField value={code} onChange={setCode} label={lang === 'pt' ? 'Código do autenticador' : 'Authenticator code'} autoFocus={!isMobile} />
        {error && <Err text={error} />}
        <button type="submit" disabled={busy || !codeComplete(code)} style={{ ...dialogButtonStyle('primary', isMobile, busy || !codeComplete(code)), width: '100%' }}>
          {busy && <AgentisticsLoader size={14} />} {lang === 'pt' ? 'Confirmar' : 'Confirm'}
        </button>
      </form>
    </StageFrame>
  )
}

function StageFrame({ isMobile, compact, phase, fromOpen, label, title, sub, children }: {
  isMobile: boolean; compact?: boolean; phase: SafePhase; fromOpen?: boolean; label: string; title: string; sub: string; children: React.ReactNode
}) {
  const width = compact ? SAFE_WIDTH_PANEL : isMobile ? SAFE_WIDTH_MOBILE : SAFE_WIDTH_DESKTOP
  return (
    <div data-vault-stage={compact ? 'panel' : 'page'} style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', gap: compact ? 8 : 10,
      minHeight: compact ? '100%' : isMobile ? 'calc(100dvh - 230px)' : 'calc(100dvh - 190px)',
      padding: compact ? '18px 6px' : '12px 8px', boxSizing: 'border-box',
    }}>
      {/* A composed block, nothing huge: ~140 px tall on a desktop page, ~100 px at 390 px, ~88 px in a panel. */}
      <VaultSafe phase={phase} {...(fromOpen ? { from: 'open' as const } : {})} width={width} label={label} />
      <div style={{ fontWeight: 700, fontSize: compact ? 15.5 : 18, marginTop: compact ? 8 : 14 }} role="status">{title}</div>
      <div style={{ fontSize: compact ? 12.5 : 13, color: 'var(--text-secondary)', lineHeight: 1.55, maxWidth: 360, marginBottom: 4 }}>{sub}</div>
      <div style={{ marginTop: 6, width: isMobile || compact ? '100%' : undefined, maxWidth: 420, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>{children}</div>
    </div>
  )
}

import { useCallback, useEffect, useRef, useState } from 'react'
import { AgentisticsLoader } from '../AgentisticsLoader'
import { VaultUnlock } from './VaultUnlock'
import { VaultSafe, SAFE_OPEN_MS, SAFE_WIDTH_DESKTOP, SAFE_WIDTH_MOBILE, type SafePhase } from './VaultSafe'
import { refreshVaultWatch } from '../../lib/vaultWatch'
import { type UiAction } from '../../lib/vaultApi'
import { lockedSubKey, vt } from '../../lib/vaultText'
import { Err } from '../MfaSetup'
import { dialogButtonStyle } from '../../pages/settings/primitives'

type Lang = 'pt' | 'en'

const WORDS = {
  lockedTitle: { en: 'Vault locked', pt: 'Cofre trancado' },
  unlockingTitle: { en: 'Unlocking…', pt: 'Destravando…' },
  unlockingSub: { en: 'Confirm it is you.', pt: 'Confirme que é você.' },
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
  // Until the service has said which presence check this machine has, the sentence names none.
  const [wrappers, setWrappers] = useState<string[] | null>(null)
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
  const sub = opening ? w('openSub') : busy ? w('unlockingSub') : vt(lockedSubKey(wrappers), lang)
  return (
    <StageFrame isMobile={isMobile} compact={compact} phase={phase} fromOpen={fromOpen} label={w('lockedTitle')} title={title} sub={sub}>
      {!opening && <VaultUnlock lang={lang} isMobile={isMobile} center onOpened={opened} onBusy={setBusy} onWrappers={setWrappers} {...(onAction ? { onAction } : {})} />}
      {!opening && !busy && extra}
    </StageFrame>
  )
}

/**
 * The same centred safe when the vault is OPEN but the list still owes a proof (a page from another
 * device with no grant yet). COFRE.DESBLOQUEIO: one button — the vault's own confirmation (the service
 * raises the gesture, or the vault-password prompt asks). The door does not move: nothing is unlocked.
 */
export function VaultProofStage({ lang, isMobile, compact, title, sub, error, onSubmit }: {
  lang: Lang; isMobile: boolean; compact?: boolean; title: string; sub: string; error: string | null
  onSubmit: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const submit = () => {
    if (busy) return
    setBusy(true)
    void onSubmit().finally(() => setBusy(false))
  }
  return (
    <StageFrame isMobile={isMobile} compact={compact} phase={busy ? 'unlocking' : 'locked'} label={title} title={title} sub={sub}>
      <form onSubmit={e => { e.preventDefault(); submit() }} style={{ width: isMobile ? '100%' : 260, textAlign: 'left' }}>
        {error && <Err text={error} />}
        <button type="submit" disabled={busy} style={{ ...dialogButtonStyle('primary', isMobile, busy), width: '100%' }}>
          {busy && <AgentisticsLoader size={14} />} {lang === 'pt' ? 'Confirmar que sou eu' : 'Confirm it is me'}
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
      minHeight: compact ? '100%' : isMobile ? 'calc(100dvh / var(--ui-zoom, 1) - 230px)' : 'calc(100dvh / var(--ui-zoom, 1) - 190px)',
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

import { useCallback, useEffect, useRef, useState } from 'react'
import { VaultUnlock } from './VaultUnlock'
import { VaultSafe, SAFE_OPEN_MS, type SafePhase } from './VaultSafe'

type Lang = 'pt' | 'en'

const WORDS = {
  lockedTitle: { en: 'Vault locked', pt: 'Cofre trancado' },
  lockedSub: { en: 'Your secrets are protected. Unlock with Windows Hello or your code.', pt: 'Seus segredos estão protegidos. Destrave com Windows Hello ou o código.' },
  unlockingTitle: { en: 'Unlocking…', pt: 'Destravando…' },
  unlockingSub: { en: 'Confirm on this computer, or enter the code.', pt: 'Confirme neste computador ou digite o código.' },
  openTitle: { en: 'Vault open', pt: 'Cofre aberto' },
  openSub: { en: 'Done. It locks by itself after a while without use.', pt: 'Pronto. Ele tranca sozinho depois de um tempo sem uso.' },
} as const

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
export function VaultStage({ lang, isMobile, fromOpen, onOpened }: { lang: Lang; isMobile: boolean; fromOpen?: boolean; onOpened: () => void }) {
  const [busy, setBusy] = useState(false)
  const [opening, setOpening] = useState(false)
  const done = useRef(onOpened)
  done.current = onOpened
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  const opened = useCallback(() => {
    if (reducedMotion()) { done.current(); return }
    setOpening(true)
    timer.current = setTimeout(() => done.current(), SAFE_OPEN_MS)
  }, [])
  const phase: SafePhase = opening ? 'opening' : busy ? 'unlocking' : 'locked'
  const w = (k: keyof typeof WORDS) => WORDS[k][lang]
  const title = opening ? w('openTitle') : busy ? w('unlockingTitle') : w('lockedTitle')
  const sub = opening ? w('openSub') : busy ? w('unlockingSub') : w('lockedSub')
  return (
    <div data-vault-stage style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', gap: 10,
      minHeight: isMobile ? 'calc(100dvh - 210px)' : 'calc(100dvh - 170px)', padding: '12px 8px',
    }}>
      <VaultSafe phase={phase} {...(fromOpen ? { from: 'open' as const } : {})} width={isMobile ? 190 : 240} label={w('lockedTitle')} />
      <div style={{ fontWeight: 700, fontSize: 19, marginTop: 6 }} role="status">{title}</div>
      <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, maxWidth: 400 }}>{sub}</div>
      {!opening && <div style={{ marginTop: 6, width: isMobile ? '100%' : undefined, maxWidth: 420 }}><VaultUnlock lang={lang} isMobile={isMobile} center onOpened={opened} onBusy={setBusy} /></div>}
    </div>
  )
}

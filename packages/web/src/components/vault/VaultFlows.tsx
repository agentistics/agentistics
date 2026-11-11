/**
 * The vault's own FLOWS — the dialogs a control on `/vault` opens (VAULT v4, 2026-10-06). Moved verbatim
 * from the old Settings → Vault screen when that screen was folded into the vault page's tabs: the gated
 * action dialog, the setup wizard ("Protect your vault"), the 24-word recovery, and the small forms
 * (auto-lock, memory hardening). Nothing here decides what an action asks: the server's `gates` table
 * does, every route enforces it again, and these dialogs only collect what it owes.
 *
 * COFRE.DESBLOQUEIO (owner, 2026-11-07): there is no app code anywhere. The wizard is [confirm it is you]
 * → choose HOW the vault confirms (Touch ID or the Mac password, Windows Hello, a vault password of your
 * own; a security key only under "Advanced" and only where it works) → the 24 words.
 */
import { useEffect, useId, useState } from 'react'
import { FingerprintPattern, KeyRound, Lock, LockOpen, Printer } from 'lucide-react'
import { AgentisticsLoader } from '../AgentisticsLoader'
import { Err, card, codeBlock, dangerBtn, input, overlay, primaryBtn } from '../dialogStyles'
import { Disclosure } from '../Disclosure'
import { methodNameKey, presenceKey, vt, vtf, type VaultKey } from '../../lib/vaultText'
import { useEscapeOwner } from '../../lib/overlayStack'
import {
  gestureStep, presenceProgress, cleanSetupCode, setupCodeAccept, setupCodeComplete, clampAutoLock, gateFor,
  loadVault, lockNow, howStep2, setAuthPolicy, type ActionKind, type ProofChoice, parseAutoLockInput, presenceDisable, presenceEnrol, recoveryBegin,
  recoveryConfirm, setAutoLock, setConfirmEachUse, wordRows, AUTO_LOCK_MAX, AUTO_LOCK_MIN,
  howConfirms, howNow, wizardPlan,
  localProof, recoverWithWords, splitWords,
  type UiAction, type UnlockMethodId, type VaultView, type WizardPhaseStep, type WizardStep,
} from '../../lib/vaultApi'
import { VaultPasswordSetup } from './VaultPassword'

/** "How your vault works": locked → you confirm → open for N min, with where you are now lit up. */
export function HowStrip({ view, lang, isMobile, minutes, presWord }: { view: VaultView; lang: 'en' | 'pt'; isMobile: boolean; minutes: number; presWord: string }) {
  const now = howNow(view)
  const how = howConfirms(view)
  const s2 = howStep2(view)
  const confirmBody = vtf(s2.key, lang, { presence: presWord })
  const steps: { icons: React.ReactNode; title: string; body: string }[] = [
    { icons: <Lock size={16} />, title: vt('how1_t', lang), body: vt('how1_b', lang) },
    { icons: how === 'proof' ? <FingerprintPattern size={16} /> : <KeyRound size={16} />, title: vt('how2_t', lang), body: confirmBody },
    { icons: <LockOpen size={16} />, title: vtf('how3_t', lang, { n: minutes }), body: vt('how3_b', lang) },
  ]
  return (
    <div role="group" aria-label={vt('how_title', lang)} style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-tertiary)', letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: 8 }}>{vt('how_title', lang)}</div>
      <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
        {steps.map((st, i) => {
          const here = i === now
          return (
            <li key={i} aria-current={here ? 'step' : undefined} style={{
              border: '1px solid ' + (here ? 'var(--anthropic-orange)' : 'var(--border)'), borderRadius: 10, padding: '10px 12px', minWidth: 0,
              background: here ? 'var(--anthropic-orange-dim)' : 'transparent', opacity: here ? 1 : 0.8,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span aria-hidden style={{ display: 'inline-flex', gap: 3, alignItems: 'center', color: here ? 'var(--anthropic-orange)' : 'var(--text-secondary)' }}>{st.icons}</span>
                <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-primary)' }}>{i + 1}. {st.title}</span>
                {here && <span style={{ marginLeft: 'auto', fontSize: 10.5, fontWeight: 700, color: 'var(--anthropic-orange)' }}>{vt('how_here', lang)}</span>}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.55, marginTop: 4 }}>{st.body}</div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

// ── small pieces ─────────────────────────────────────────────────────────────────────────────

/** The proof an action asks, as an icon (👆 the vault's own confirmation) — with a name for assistive tech. */
export function Gate({ gesture, lang }: { code?: boolean; gesture: boolean; lang: 'en' | 'pt' }) {
  if (!gesture) return null
  return (
    <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', opacity: 0.85 }}>
      <span title={vt('gate_presence', lang)} aria-label={vt('gate_presence', lang)} role="img" style={{ display: 'inline-flex' }}><FingerprintPattern size={14} /></span>
    </span>
  )
}

/**
 * Mobile convention: a long dialog is FULL-SCREEN on a phone and sits above the bottom nav — a centred
 * card let the nav cover its last button (the 24-word recovery's "Open the vault", at 390px).
 */
const fullOnMobile = (isMobile: boolean, cardStyle: React.CSSProperties): { o: React.CSSProperties; c: React.CSSProperties } => isMobile
  ? { o: { ...overlay, padding: 0, zIndex: 3000 }, c: { ...cardStyle, maxWidth: 'none', width: '100%', height: 'calc(100dvh / var(--ui-zoom, 1))', maxHeight: 'calc(100dvh / var(--ui-zoom, 1))', borderRadius: 0, border: 'none', overflowY: 'auto', boxSizing: 'border-box' } }
  : { o: overlay, c: cardStyle }

/** v2.98.1: kinds this platform has but this build cannot offer yet, never already enrolled. */
export const soonKinds = (v: VaultView): string[] => (v.presenceSoon ?? []).filter(k => !v.wrappers.includes(k))

/** A refusal, and — when the server pointed at a page control — the button for it (v2.98.1). */
export function ActionErr({ text, action, lang, onAction }: { text: string; action?: UiAction | null; lang: 'en' | 'pt'; onAction?: (a: UiAction) => void }) {
  const label: Record<UiAction, VaultKey> = { recover: 'act_recover', unlock: 'act_unlock', enroll: 'act_enroll', 'disable-presence': 'act_disable' }
  return (
    <>
      <Err text={text} />
      {action && onAction && (
        <button type="button" onClick={() => onAction(action)} style={{ ...primaryBtn, width: 'auto', marginBottom: 10, color: 'var(--text-primary)', borderColor: 'var(--border)', background: 'transparent' }}>
          {vt(label[action], lang)}
        </button>
      )}
    </>
  )
}

export function Note({ children, tone }: { children: React.ReactNode; tone?: 'warn' | 'bad' }) {
  const color = tone === 'bad' ? 'var(--accent-red, #ef4444)' : tone === 'warn' ? 'var(--accent-orange, #f59e0b)' : 'var(--text-secondary)'
  return <div role={tone ? 'alert' : undefined} style={{ fontSize: 12, color, lineHeight: 1.6, marginBottom: 12 }}>{children}</div>
}

/** Review S2: the 8-digit setup code this machine's terminal shows (`agentop vault setup-code`). */
function SetupCodeField({ value, onChange, label, why }: { value: string; onChange: (v: string) => void; label: string; why: string }) {
  return (
    <label style={{ display: 'block', marginBottom: 10 }}>
      {why && <span style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>{why}</span>}
      <span style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>{label}</span>
      <input
        value={value} onChange={e => onChange(cleanSetupCode(e.target.value))} placeholder="1234 5678" style={{ ...input, marginBottom: 0 }}
        inputMode="numeric" autoComplete="off" autoFocus maxLength={9}
      />
    </label>
  )
}

export function AutoLockRow({ view, lang, isMobile, gate, tipText, btn, onSave }: {
  view: VaultView; lang: 'en' | 'pt'; isMobile: boolean; gate: { code: boolean; gesture: boolean }; tipText: string; btn: React.CSSProperties; onSave: (minutes: number) => void
}) {
  const [text, setText] = useState(String(view.autoLockMinutes))
  useEffect(() => { setText(String(view.autoLockMinutes)) }, [view.autoLockMinutes])
  const parsed = parseAutoLockInput(text)
  const valid = parsed !== null && parsed >= AUTO_LOCK_MIN && parsed <= AUTO_LOCK_MAX
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6, fontSize: 13, color: 'var(--text-secondary)' }}>
        <span>{vt('auto_before', lang)}</span>
        <input
          value={text} onChange={e => setText(e.target.value.replace(/\D/g, '').slice(0, 3))} inputMode="numeric" aria-label={`${vt('auto_before', lang)} … ${vt('auto_after', lang)}`}
          onBlur={() => { if (parsed !== null) setText(String(clampAutoLock(parsed))) }}
          style={{ ...input, width: 76, marginBottom: 0, letterSpacing: 'normal', textAlign: 'right', minHeight: isMobile ? 44 : undefined }}
        />
        <span>{vt('auto_after', lang)}</span>
        <button type="button" style={btn} disabled={!valid || parsed === view.autoLockMinutes} title={tipText} aria-label={`${vt('auto_save', lang)}. ${tipText}`}
          onClick={() => { if (parsed !== null) onSave(clampAutoLock(parsed)) }}>
          {vt('auto_save', lang)} <Gate gesture={gate.gesture} lang={lang} />
        </button>
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginBottom: 6 }}>{vt('auto_hint', lang)}</div>
      {!valid && text !== '' && <Note tone="warn">{vt('auto_invalid', lang)}</Note>}
    </>
  )
}

/** In plain words; the kernel detail (Yama, ptrace, core-dump limits) sits behind a small toggle. */
export function HardeningBlock({ view, lang }: { view: VaultView; lang: 'en' | 'pt' }) {
  const h = view.hardening
  if (!h) return <Note>{vt('hard_unknown', lang)}</Note>
  const solid = h.private === true && h.coreDumps === 'off'
  const broken = h.state === 'failed' || h.private === false || h.coreDumps === 'on'
  const ok = (text: string) => <div key={text} style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6 }}><span aria-hidden>✓</span> {text}</div>
  const tech: string[] = [
    ...(h.private !== null ? [vtf('hard_tech_private', lang, { v: h.private ? '✓' : '✗' })] : []),
    ...(h.coreDumps !== null ? [vtf('hard_tech_core', lang, { v: h.coreDumps })] : []),
    ...h.lines,
  ]
  return (
    <div style={{ marginBottom: 6 }}>
      {solid && <>{ok(vt('hard_plain1', lang))}{ok(vt('hard_plain2', lang))}</>}
      {broken && <div role="alert" style={{ fontSize: 12.5, color: 'var(--accent-red, #ef4444)', lineHeight: 1.6 }}><span aria-hidden>✗</span> {vt('hard_bad', lang)}</div>}
      {tech.length > 0 && (
        <details style={{ marginTop: 6 }}>
          <summary style={{ fontSize: 11.5, color: 'var(--text-tertiary)', cursor: 'pointer', padding: '4px 0' }}>{vt('hard_details', lang)}</summary>
          {tech.map(l => <div key={l} style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6, marginTop: 4 }}>{l}</div>)}
        </details>
      )}
    </div>
  )
}

// ── a gated action: the dialog says what will be asked; the service (or the password prompt) asks it ──

export type GateKind = 'lock' | 'autolock' | 'confirm-each-use' | 'presence-off' | 'auth-policy'
export const gateActionOf = (k: GateKind): string => k === 'lock' ? 'lock' : k === 'autolock' ? 'set-auto-lock' : k === 'confirm-each-use' ? 'set-confirm-each-use' : k === 'auth-policy' ? 'set-auth-policy' : 'disable-presence'
export const presWordOf = (v: VaultView, lang: 'en' | 'pt') => vt(presenceKey(v.wrappers), lang)

export function GateDialog({ lang, view, isMobile, kind, minutes, authPolicy, enabled, onCancel, onDone, onAction }: {
  lang: 'en' | 'pt'; view: VaultView; isMobile: boolean; kind: GateKind; minutes?: number
  authPolicy?: Partial<Record<ActionKind, ProofChoice>>; enabled?: boolean
  onCancel: () => void; onDone: () => void; onAction?: (a: UiAction) => void
}) {
  const action = gateActionOf(kind)
  const gate = gateFor(view, action)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errAction, setErrAction] = useState<UiAction | null>(null)
  // v2.98.1: the main machine's "turn off" also asks the 24 words — typed here, on a loopback page only.
  const wantsWords = kind === 'presence-off' && view.requirePresence && view.loopback === true
  const [words, setWords] = useState('')
  const title = kind === 'lock' ? vt('lockNow', lang) : kind === 'autolock' ? vt('sec_autolock', lang) : kind === 'confirm-each-use' ? vt('cfu_title', lang) : kind === 'auth-policy' ? vt('ap_title', lang) : vt('pres_offConfirm', lang)
  const submit = async () => {
    if (busy) return
    setBusy(true); setError(null)
    const w = wantsWords ? splitWords(words).join(' ') : undefined
    const r = kind === 'lock' ? await lockNow() : kind === 'autolock' ? await setAutoLock(minutes ?? 30)
      : kind === 'confirm-each-use' ? await setConfirmEachUse(enabled === true)
      : kind === 'auth-policy' ? await setAuthPolicy(authPolicy ?? {}) : await presenceDisable(w)
    setBusy(false)
    setWords('') // never kept past the request
    if (r.ok) { onDone(); return }
    setError(r.sentence || vt('network', lang))
    setErrAction(r.action && r.action !== 'disable-presence' ? r.action : null)
  }
  useEscape(onCancel)
  return (
    <div style={overlay} role="dialog" aria-modal="true" aria-label={title} onClick={onCancel}>
      <form onClick={e => e.stopPropagation()} onSubmit={e => { e.preventDefault(); void submit() }} style={card}>
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6 }}>{title}</div>
        {kind === 'presence-off' && <Note tone="warn">{vt('pres_offConsequence', lang)}</Note>}
        {wantsWords && (
          <label style={{ display: 'block', marginBottom: 10 }}>
            <span style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>{vt('pres_offWords', lang)}</span>
            <textarea value={words} onChange={e => setWords(e.target.value)} rows={3} autoComplete="off" autoCapitalize="none" spellCheck={false}
              style={{ ...input, marginBottom: 0, letterSpacing: 'normal', fontFamily: 'var(--font-mono, ui-monospace, monospace)', resize: 'vertical' }} />
          </label>
        )}
        {gate.gesture && <Note>{vtf('gate_dialog_presence', lang, { presence: vt(presenceKey(view.wrappers), lang) })}</Note>}
        {error && <ActionErr text={error} action={errAction} lang={lang} onAction={onAction} />}
        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
          <button type="button" onClick={onCancel} style={{ ...primaryBtn, color: 'var(--text-secondary)', borderColor: 'var(--border)', background: 'transparent', minHeight: isMobile ? 44 : undefined }}>{vt('cancel', lang)}</button>
          <button type="submit" disabled={busy || (wantsWords && splitWords(words).length !== 24)} style={{ ...(kind === 'presence-off' ? dangerBtn : primaryBtn), minHeight: isMobile ? 44 : undefined }}>
            {busy ? vt('working', lang) : vt('gate_continue', lang)}
          </button>
        </div>
      </form>
    </div>
  )
}

export function useEscape(onEsc: () => void) { useEscapeOwner(true, onEsc) }

// ── the setup wizard: [confirm it is you] → how the vault confirms → recovery key ─────────────────

type Phase = 'intro' | 'words' | 'confirm' | 'done'
type Offer = { id: UnlockMethodId; advanced: boolean; gestures: { enroll: number; unlock: number } }

/** PURE. The offers the wizard draws: from the server's list (or, from an older server, its presence kinds). */
export function wizardOffers(v: Pick<VaultView, 'unlockMethods' | 'presenceAvailable' | 'wrappers'>, fixedKind?: UnlockMethodId | null): Offer[] {
  const all: Offer[] = v.unlockMethods
    ?? v.presenceAvailable.map(id => ({ id: id as UnlockMethodId, advanced: id === 'fido2', gestures: { enroll: id === 'password' ? 0 : 2, unlock: id === 'password' ? 0 : 1 } }))
  const open = all.filter(m => !v.wrappers.includes(m.id))
  return fixedKind ? open.filter(m => m.id === fixedKind) : open
}

export function EnrolWizard({ lang, isMobile, initial, steps, onClose, fixedKind, onAction }: {
  lang: 'en' | 'pt'; isMobile: boolean; initial: VaultView; steps: WizardStep[]; onClose: () => void
  /** v2.98.1: "add another way" — the wizard enrols THIS kind and offers no other. */
  fixedKind?: UnlockMethodId | null
  onAction?: (a: UiAction) => void
}) {
  const [plan, setPlan] = useState<WizardPhaseStep[]>(() => wizardPlan(steps, initial.setupCode?.owed === true, initial.loopback === true && Boolean(initial.localProofKind)))
  const t = (k: VaultKey) => vt(k, lang)
  const [view, setView] = useState(initial)
  const [i, setI] = useState(0)
  const step = plan[i]
  const [phase, setPhase] = useState<Phase>('intro')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errAction, setErrAction] = useState<UiAction | null>(null)
  // The 24 words live in this state for exactly as long as they are on screen, and are dropped the
  // moment the person confirms or leaves — never persisted, never copied anywhere by this page.
  const [words, setWords] = useState<string[] | null>(null)
  const [positions, setPositions] = useState<number[]>([])
  const [typed, setTyped] = useState<string[]>(['', '', ''])
  const offers = wizardOffers(initial, fixedKind)
  const [kind, setKind] = useState<UnlockMethodId>(fixedKind ?? offers.find(m => !m.advanced)?.id ?? offers[0]?.id ?? 'password')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const advancedId = useId()
  // Review S2: the server answers `setup-code-required` for a page's FIRST enrolment; the code comes
  // from this machine's terminal (`agentop vault setup-code`).
  const [needSetup, setNeedSetup] = useState(false)
  const [setupCode, setSetupCode] = useState('')
  // Leader decision 2: a recovery key that already exists must follow the new data key — the page never
  // takes the 24 words, so it offers NEW words instead (the old ones stop working), or the terminal.
  const [needWords, setNeedWords] = useState(false)
  const [finished, setFinished] = useState(false)

  useEffect(() => () => { setWords(null) }, [])
  useEscape(() => { if (!busy) onClose() })

  // Live "confirmation i of n" while the service has a dialog up (owner 2026-10-02).
  const [gestureTotal, setGestureTotal] = useState(0)
  const [gestureNow, setGestureNow] = useState<{ i: number; n: number } | null>(null)
  useEffect(() => {
    if (gestureTotal === 0) { setGestureNow(null); return }
    let alive = true
    setGestureNow({ i: 1, n: gestureTotal })
    const tick = async () => {
      const r = await presenceProgress()
      const g = r.ok ? gestureStep(r.progress) : null
      if (alive && g) setGestureNow(g)
    }
    const id = setInterval(() => { void tick() }, 500)
    return () => { alive = false; clearInterval(id) }
  }, [gestureTotal])
  const offer = offers.find(m => m.id === kind)
  const enrolGestures = offer?.gestures.enroll ?? 0
  const gestureLine = gestureNow && (
    <div role="status" aria-live="polite" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 10 }}>
      <AgentisticsLoader size={14} /> {vtf('wiz_gesture_progress', lang, { i: gestureNow.i, n: gestureNow.n })}
    </div>
  )

  const refresh = async (): Promise<VaultView> => {
    const r = await loadVault()
    const v = r.kind === 'view' || r.kind === 'needs-stepup' ? r.view : view
    setView(v)
    return v
  }
  const next = async () => {
    await refresh()
    setError(null); setErrAction(null); setWords(null); setTyped(['', '', ''])
    if (i + 1 < plan.length) { setI(i + 1); setPhase('intro') } else { setFinished(true); setPhase('done') }
  }
  // A failure names the step it stopped at; reopening the wizard resumes from what is still missing.
  const fail = (s: string, action?: UiAction) => { setError(`${vtf('wiz_failedAt', lang, { step: t(`wiz_step_${step ?? 'presence'}` as VaultKey) })} ${s || t('network')}`); setErrAction(action && action !== 'enroll' ? action : null); setBusy(false) }

  const stepNo = Math.min(i + 1, plan.length)

  // ── setup code: spent FIRST, before any gesture; the server holds the proof for this session
  const acceptSetup = async () => {
    if (busy || !setupCodeComplete(setupCode)) return
    setBusy(true); setError(null)
    const r = await setupCodeAccept(setupCode)
    setSetupCode('')
    if (!r.ok) { setBusy(false); setError(r.sentence || t('network')); return }
    setBusy(false)
    await next()
  }

  // ── v2.98.1: ONE gesture on a loopback page stands for the setup code
  const proveLocal = async () => {
    if (busy) return
    setBusy(true); setError(null)
    setGestureTotal(1)
    const r = await localProof()
    setGestureTotal(0)
    if (!r.ok) {
      // Not loopback after all, or no device: fall back to the setup code, in the same place.
      if (r.code === 'not-loopback' || r.code === 'no-local-proof') setPlan(p => p.map(x => (x === 'local' ? 'setup' : x)))
      return fail(r.sentence, r.action)
    }
    setBusy(false)
    await next()
  }

  // ── recovery key
  const showWords = async () => {
    if (busy) return
    setBusy(true); setError(null)
    const r = await recoveryBegin(needSetup ? setupCode : undefined)
    setBusy(false)
    if (!r.ok) {
      if (r.code === 'setup-code-required') { setNeedSetup(true); setSetupCode('') }
      return fail(r.sentence, r.action)
    }
    setNeedSetup(false); setSetupCode('')
    setWords(r.words); setPositions(r.positions); setTyped(['', '', '']); setPhase('words')
  }
  const confirmWords = async () => {
    if (busy || typed.some(w => w.trim() === '')) return
    setBusy(true); setError(null)
    const r = await recoveryConfirm(typed.map(w => w.trim().toLowerCase()))
    if (!r.ok) { setTyped(['', '', '']); return fail(r.sentence, r.action) }
    setBusy(false); setWords(null)
    await next()
  }

  // ── how the vault confirms: a gesture the SERVICE raises, or the vault password chosen here
  const enrolPresence = async (password?: string) => {
    if (busy) return
    setBusy(true); setError(null)
    setGestureTotal(enrolGestures)
    const r = await presenceEnrol(kind, { ...(password !== undefined ? { password } : {}), ...(needWords ? { replaceRecovery: true } : {}), ...(needSetup && setupCodeComplete(setupCode) ? { setupCode } : {}) })
    setGestureTotal(0)
    if (!r.ok) {
      if (r.code === 'presence-needs-recovery-words') { setNeedWords(true); setBusy(false); setError(r.sentence); return }
      if (r.code === 'setup-code-required') { setNeedSetup(true); setSetupCode('') }
      return fail(r.sentence, r.action)
    }
    setBusy(false); setNeedWords(false); setNeedSetup(false); setSetupCode('')
    // The recovery key is owed now: it is the LAST step (append it when this wizard did not plan it).
    if (r.recoveryOwed && !plan.slice(i + 1).includes('recovery')) setPlan(p => [...p, 'recovery'])
    await next()
  }

  const rotating = Boolean(view.recoveryCreatedAt)
  const presenceNow = view.presence
  const doneText = presenceNow
    ? vtf('wiz_done_presence', lang, { presence: vt(presenceKey(view.wrappers), lang), n: view.autoLockMinutes })
    : vtf('wiz_done_plain', lang, { n: view.autoLockMinutes })
  const cta: React.CSSProperties = { ...primaryBtn, minHeight: isMobile ? 44 : undefined }
  const prog = plan.length > 1 && phase !== 'done'
  const localKey: VaultKey = view.localProofKind === 'fido2' ? 'wiz_local_go_fido2' : view.localProofKind === 'touchid' ? 'wiz_local_go_touchid' : 'wiz_local_go_hello'
  const methodNote = kind === 'hello' ? vtf('wiz_pres_enrolHello', lang, { n: enrolGestures }) : kind === 'touchid' ? t('wiz_pres_enrolTouchid') : kind === 'fido2' ? vtf('wiz_pres_enrolKey', lang, { n: enrolGestures }) : null
  const basic = offers.filter(m => !m.advanced)
  const advanced = offers.filter(m => m.advanced)
  const methodCard = (m: Offer, first: boolean) => {
    const on = kind === m.id
    return (
      <label key={m.id} data-method={m.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer', padding: isMobile ? '12px' : '10px 12px', minHeight: isMobile ? 44 : undefined, border: '1px solid ' + (on ? 'var(--anthropic-orange)' : 'var(--border)'), borderRadius: 10, background: on ? 'var(--anthropic-orange-dim)' : 'transparent' }}>
        <input type="radio" name="vault-method" checked={on} onChange={() => { setKind(m.id); setError(null) }} style={{ marginTop: 3 }} />
        <span style={{ minWidth: 0 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
            {t(methodNameKey(m.id))}
            {first && !m.advanced && <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--anthropic-orange)' }}>{t('wiz_method_recommended')}</span>}
          </span>
          <span style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{t(`wiz_method_${m.id}_d` as VaultKey)}</span>
        </span>
      </label>
    )
  }

  return (
    <div style={fullOnMobile(isMobile, card).o} role="dialog" aria-modal="true" aria-label={t('wiz_title')}>
      <div className="ag-vault-wizard" style={fullOnMobile(isMobile, { ...card, maxWidth: 480, maxHeight: 'calc(92vh / var(--ui-zoom, 1))', overflowY: 'auto', boxSizing: 'border-box' }).c}>
        <style>{PRINT_CSS}</style>
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>{t('wiz_title')}</div>
        {prog && <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', margin: '2px 0 10px' }}>{vtf('wiz_step', lang, { i: stepNo, n: plan.length })}</div>}
        {phase !== 'done' && <Note>{t('wiz_safe')}</Note>}
        {phase !== 'done' && view.legacyAppCode && <Note>{t('legacy_code_note')}</Note>}

        {phase === 'intro' && step === 'local' && (
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{t('wiz_local_title')}</div>
            {gestureLine}
            <Note>{t('wiz_local_intro')}</Note>
            {error && <ActionErr text={error} action={errAction} lang={lang} onAction={onAction} />}
            <button type="button" style={cta} disabled={busy} onClick={() => { void proveLocal() }}>
              {busy ? t('unlocking') : t(localKey)}
            </button>
          </div>
        )}
        {phase === 'intro' && step === 'setup' && (
          <form onSubmit={e => { e.preventDefault(); void acceptSetup() }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{t('wiz_setup_title')}</div>
            <Note>{t('wiz_setup_intro')}</Note>
            <Note>{t('wiz_setup_remote')}</Note>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>{t('wiz_setup_run')}</div>
            <code style={{ ...codeBlock, display: 'block', marginBottom: 6, overflowX: 'auto', whiteSpace: 'pre' }}>{view.setupCode?.command ?? 'agentop vault setup-code'}</code>
            {view.setupCode?.where && <Note>{view.setupCode.where}</Note>}
            <Note>{t('wiz_setup_valid')}</Note>
            <SetupCodeField value={setupCode} onChange={setSetupCode} label={t('wiz_setup_label')} why="" />
            {error && <ActionErr text={error} action={errAction} lang={lang} onAction={onAction} />}
            <button type="submit" style={cta} disabled={busy || !setupCodeComplete(setupCode)}>{busy ? t('working') : t('wiz_setup_go')}</button>
          </form>
        )}

        {phase === 'intro' && step === 'recovery' && (
          <form onSubmit={e => { e.preventDefault(); if (!busy && !(needSetup && !setupCodeComplete(setupCode))) void showWords() }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{t('wiz_rec_title')}</div>
            <Note>{t('wiz_rec_intro')}</Note>
            {rotating && <Note tone="warn">{t('wiz_rec_rotate')}</Note>}
            {needSetup && <SetupCodeField value={setupCode} onChange={setSetupCode} label={t('wiz_setup_label')} why={t('wiz_setup_why')} />}
            {rotating && gateFor(view, 'rotate-recovery').gesture && <Note>{vtf('gate_dialog_presence', lang, { presence: vt(presenceKey(view.wrappers), lang) })}</Note>}
            {error && <ActionErr text={error} action={errAction} lang={lang} onAction={onAction} />}
            <button type="submit" style={cta} disabled={busy || (needSetup && !setupCodeComplete(setupCode))}>{busy ? t('working') : t('wiz_rec_show')}</button>
          </form>
        )}
        {phase === 'words' && words && (
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{t('wiz_rec_title')}</div>
            <Note tone="warn">{t('wiz_rec_warn')}</Note>
            <div className="ag-vault-print" style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px', marginBottom: 10, userSelect: 'none' }}>
              <div className="ag-vault-print-title" style={{ display: 'none' }}>{t('wiz_rec_title')} — Agentistics</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: isMobile ? '6px 6px' : '8px 12px' }}>
                {wordRows(words).flat().map(w => (
                  <div key={w.n} style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: isMobile ? 11.5 : 13, minWidth: 0, overflowWrap: 'anywhere' }}>
                    <span style={{ color: 'var(--text-tertiary)' }}>{w.n}.</span> {w.word}
                  </div>
                ))}
              </div>
              <div className="ag-vault-print-warn" style={{ display: 'none' }}>{t('wiz_rec_warn')}</div>
            </div>
            <Note>{t('wiz_rec_once')}</Note>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" onClick={() => window.print()} style={{ ...primaryBtn, width: 'auto', color: 'var(--text-secondary)', borderColor: 'var(--border)', background: 'transparent', display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: isMobile ? 44 : undefined }}>
                <Printer size={14} /> {t('wiz_rec_print')}
              </button>
              <button type="button" style={{ ...cta, flex: 1 }} onClick={() => setPhase('confirm')}>{t('wiz_rec_written')}</button>
            </div>
          </div>
        )}
        {phase === 'confirm' && (
          <form onSubmit={e => { e.preventDefault(); void confirmWords() }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{t('wiz_rec_confirmTitle')}</div>
            <Note>{t('wiz_rec_confirmBody')}</Note>
            {positions.map((p, n) => (
              <label key={p} style={{ display: 'block', marginBottom: 10 }}>
                <span style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>{vtf('wiz_word', lang, { n: p })}</span>
                <input
                  value={typed[n]} onChange={e => setTyped(cur => cur.map((x, k) => (k === n ? e.target.value : x)))} autoFocus={n === 0}
                  autoComplete="off" autoCapitalize="none" spellCheck={false} style={{ ...input, marginBottom: 0, letterSpacing: 'normal' }}
                />
              </label>
            ))}
            {error && <ActionErr text={error} action={errAction} lang={lang} onAction={onAction} />}
            <button type="submit" style={cta} disabled={busy || typed.some(w => w.trim() === '')}>{busy ? t('working') : t('codeConfirm')}</button>
          </form>
        )}

        {phase === 'intro' && step === 'presence' && (
          <div data-wizard-step="presence">
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{t('wiz_pres_title')}</div>
            {gestureLine}
            <Note>{t('wiz_pres_intro')}</Note>
            {!fixedKind && (
              <div role="radiogroup" aria-label={t('wiz_pres_title')} style={{ display: 'grid', gap: 8, marginBottom: 12 }}>
                {basic.map((m, n) => methodCard(m, n === 0))}
                {advanced.length > 0 && (
                  <div style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
                    <Disclosure open={showAdvanced} onToggle={() => setShowAdvanced(s => !s)} panelId={advancedId} panelLabel={t('wiz_method_advanced')}
                      header={chevron => <>{chevron}<span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-secondary)' }}>{t('wiz_method_advanced')}</span></>}
                      panelStyle={{ padding: '0 10px 10px', display: 'grid', gap: 8 }}>
                      {advanced.map(m => methodCard(m, false))}
                    </Disclosure>
                  </div>
                )}
              </div>
            )}
            {view.wrappers.some(w => w !== 'hello' && w !== 'fido2' && w !== 'touchid' && w !== 'password' && w !== 'recovery' && w !== 'passphrase') && <Note>{t('wiz_pres_heldNote')}</Note>}
            {needWords && <Note tone="warn">{t('wiz_pres_newWords_warn')}</Note>}
            {kind === 'password' ? (
              <VaultPasswordSetup lang={lang} busy={busy} error={error} onSubmit={pw => { void enrolPresence(pw) }}
                blocked={needSetup && !setupCodeComplete(setupCode)}
                before={needSetup ? <SetupCodeField value={setupCode} onChange={setSetupCode} label={t('wiz_setup_label')} why={t('wiz_setup_why')} /> : null} />
            ) : (
              <form onSubmit={e => { e.preventDefault(); if (!busy) void enrolPresence() }}>
                {needSetup && <SetupCodeField value={setupCode} onChange={setSetupCode} label={t('wiz_setup_label')} why={t('wiz_setup_why')} />}
                {methodNote && <Note>{methodNote}</Note>}
                {error && <ActionErr text={error} action={errAction} lang={lang} onAction={onAction} />}
                <button type="submit" style={cta} disabled={busy || (needSetup && !setupCodeComplete(setupCode))}>
                  {busy ? t('unlocking') : needWords ? t('wiz_pres_newWords') : t('wiz_pres_go')}
                </button>
              </form>
            )}
          </div>
        )}

        {phase === 'done' && finished && (
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{t('wiz_done')}</div>
            <Note>{doneText}</Note>
            <button type="button" style={cta} onClick={onClose}>{t('close')}</button>
          </div>
        )}

        {phase !== 'done' && (
          <button type="button" onClick={onClose} disabled={busy} style={{ marginTop: 12, background: 'none', border: 'none', color: 'var(--text-tertiary)', fontSize: 12, cursor: 'pointer', padding: isMobile ? '12px 0' : '4px 0', fontFamily: 'inherit' }}>
            {t('cancel')}
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * v2.98.1 — recovery with the 24 words, ON this computer only. Typing and pasting are both allowed (a
 * paste into any box fills the boxes from there on); the words live in this component's state only
 * until the request returns, and are cleared on success, on failure and on close. Never logged.
 */
export function RecoverDialog({ lang, isMobile, loopback, onCancel, onRecovered }: {
  lang: 'en' | 'pt'; isMobile: boolean; loopback: boolean; onCancel: () => void; onRecovered: (todo: string[]) => void
}) {
  const t = (k: VaultKey) => vt(k, lang)
  const [w, setW] = useState<string[]>(() => Array(24).fill(''))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [todo, setTodo] = useState<string[] | null>(null)
  const clear = () => setW(Array(24).fill(''))
  useEffect(() => () => { clear() }, [])
  useEscape(() => { if (!busy) { clear(); onCancel() } })
  const filled = w.filter(x => x.trim() !== '').length
  const put = (i: number, value: string) => {
    const parts = splitWords(value)
    if (parts.length > 1) { setW(cur => cur.map((x, k) => (k >= i && k - i < parts.length ? parts[k - i]! : x))); return }
    setW(cur => cur.map((x, k) => (k === i ? value.trim().toLowerCase() : x)))
  }
  const submit = async () => {
    if (busy || filled !== 24) return
    setBusy(true); setError(null)
    const r = await recoverWithWords(w.join(' '))
    clear()
    setBusy(false)
    if (!r.ok) { setError(r.sentence || t('network')); return }
    setTodo(r.todo)
  }
  return (
    <div style={fullOnMobile(isMobile, card).o} role="dialog" aria-modal="true" aria-label={t('rec_recover_title')}>
      <form onSubmit={e => { e.preventDefault(); void submit() }} className="ag-vault-recover" style={fullOnMobile(isMobile, { ...card, maxWidth: 560, maxHeight: 'calc(92vh / var(--ui-zoom, 1))', overflowY: 'auto', boxSizing: 'border-box' }).c}>
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6 }}>{t('rec_recover_title')}</div>
        {todo ? (
          <>
            <Note>{t('rec_recover_after')}</Note>
            <button type="button" style={{ ...primaryBtn, minHeight: isMobile ? 44 : undefined }} onClick={() => onRecovered(todo)}>{t('rec_continue')}</button>
          </>
        ) : !loopback ? (
          <Note tone="warn">{t('rec_recover_local')}</Note>
        ) : (
          <>
            <Note>{t('rec_recover_intro')}</Note>
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(${isMobile ? 2 : 4}, minmax(0, 1fr))`, gap: 6, marginBottom: 8 }}>
              {w.map((x, i) => (
                <label key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
                  <span style={{ fontSize: 11, color: 'var(--text-tertiary)', width: 18, textAlign: 'right', flexShrink: 0 }}>{i + 1}.</span>
                  <input value={x} onChange={e => put(i, e.target.value)} autoFocus={i === 0} autoComplete="off" autoCapitalize="none" spellCheck={false}
                    aria-label={vtf('wiz_word', lang, { n: i + 1 })}
                    style={{ ...input, marginBottom: 0, letterSpacing: 'normal', padding: '6px 8px', minHeight: isMobile ? 44 : undefined, minWidth: 0, width: '100%', boxSizing: 'border-box' }} />
                </label>
              ))}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginBottom: 8 }}>{vtf('rec_recover_count', lang, { n: filled })}</div>
            {error && <Err text={error} />}
            <button type="submit" style={{ ...primaryBtn, minHeight: isMobile ? 44 : undefined }} disabled={busy || filled !== 24}>{busy ? t('working') : t('rec_recover_go')}</button>
          </>
        )}
        {!todo && (
          <button type="button" onClick={() => { clear(); onCancel() }} disabled={busy} style={{ marginTop: 12, background: 'none', border: 'none', color: 'var(--text-tertiary)', fontSize: 12, cursor: 'pointer', padding: isMobile ? '12px 0' : '4px 0', fontFamily: 'inherit' }}>
            {t('cancel')}
          </button>
        )}
      </form>
    </div>
  )
}

/** Print only the words (and their warning) — everything else on the page is hidden for the print dialog. */
const PRINT_CSS = `@media print {
  body * { visibility: hidden !important; }
  .ag-vault-print, .ag-vault-print * { visibility: visible !important; }
  .ag-vault-print { position: fixed; inset: 24px; border: none !important; }
  .ag-vault-print-title, .ag-vault-print-warn { display: block !important; margin: 8px 0; font-size: 14px; }
}`

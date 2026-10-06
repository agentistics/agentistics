/**
 * The vault's own FLOWS — the dialogs a control on `/vault` opens (VAULT v4, 2026-10-06). Moved verbatim
 * from the old Settings → Vault screen when that screen was folded into the vault page's tabs: the gated
 * action dialog (code + gesture), the enrolment wizard (§7.3: setup code → device check → authenticator
 * → presence → recovery key), the 24-word recovery, and the small forms (auto-lock, unlock policy,
 * memory hardening). Nothing here decides what an action asks: the server's `gates` table does, every
 * route enforces it again, and these dialogs only collect what it owes.
 */
import { useEffect, useState } from 'react'
import { FingerprintPattern, KeyRound, Lock, LockOpen, Printer, Smartphone } from 'lucide-react'
import { AgentisticsLoader } from '../AgentisticsLoader'
import { Err, Qr, card, codeBlock, dangerBtn, input, overlay, primaryBtn } from '../MfaSetup'
import { CodeField } from './VaultUnlock'
import { presenceKey, vt, vtf, type VaultKey } from '../../lib/vaultText'
import {
  authenticatorBegin, authenticatorConfirm, gestureStep, presenceProgress, cleanSetupCode, setupCodeAccept, setupCodeComplete, clampAutoLock, codeComplete, gateFor, grantAlive,
  loadVault, lockNow, howStep2, parseUnlockHours, setUnlockPolicy, setAuthPolicy, type ActionKind, type ProofChoice, UNLOCK_MODES, type UnlockMode, needsTypedCode, parseAutoLockInput, presenceDisable, presenceEnrol, recoveryBegin,
  recoveryConfirm, setAutoLock, wordRows, AUTO_LOCK_MAX, AUTO_LOCK_MIN,
  howConfirms, howNow, presenceProbe, wizardPlan,
  localProof, recoverWithWords, splitWords,
  type UiAction, type VaultView, type WizardPhaseStep, type WizardStep,
} from '../../lib/vaultApi'
/** "How your vault works": locked → you confirm → open for N min, with where you are now lit up. */
export function HowStrip({ view, lang, isMobile, minutes, presWord }: { view: VaultView; lang: 'en' | 'pt'; isMobile: boolean; minutes: number; presWord: string }) {
  const now = howNow(view)
  const how = howConfirms(view)
  const s2 = howStep2(view)
  const confirmBody = vtf(s2.key, lang, { presence: presWord, hours: s2.hours ?? 12 })
  const steps: { icons: React.ReactNode; title: string; body: string }[] = [
    { icons: <Lock size={16} />, title: vt('how1_t', lang), body: vt('how1_b', lang) },
    {
      icons: <>{how === 'both' && <FingerprintPattern size={16} />}{how !== 'nothing' && <Smartphone size={16} />}{how === 'nothing' && <KeyRound size={16} />}</>,
      title: vt('how2_t', lang), body: confirmBody,
    },
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

/** The two proofs an action asks, as icons (🔑 code, 👆 presence) — each with a name for assistive tech. */
export function Gate({ code, gesture, lang }: { code: boolean; gesture: boolean; lang: 'en' | 'pt' }) {
  if (!code && !gesture) return null
  return (
    <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', opacity: 0.85 }}>
      {code && <span title={vt('gate_code', lang)} aria-label={vt('gate_code', lang)} role="img" style={{ display: 'inline-flex' }}><KeyRound size={14} /></span>}
      {gesture && <span title={vt('gate_presence', lang)} aria-label={vt('gate_presence', lang)} role="img" style={{ display: 'inline-flex' }}><FingerprintPattern size={14} /></span>}
    </span>
  )
}

/**
 * Mobile convention: a long dialog is FULL-SCREEN on a phone and sits above the bottom nav — a centred
 * card let the nav cover its last button (the 24-word recovery's "Open the vault", at 390px).
 */
const fullOnMobile = (isMobile: boolean, cardStyle: React.CSSProperties): { o: React.CSSProperties; c: React.CSSProperties } => isMobile
  ? { o: { ...overlay, padding: 0, zIndex: 3000 }, c: { ...cardStyle, maxWidth: 'none', width: '100%', height: '100dvh', maxHeight: '100dvh', borderRadius: 0, border: 'none', overflowY: 'auto', boxSizing: 'border-box' } }
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
          {vt('auto_save', lang)} <Gate code={gate.code} gesture={gate.gesture} lang={lang} />
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

// ── a gated action: the dialog collects the code and warns about the gesture ─────────────────────

export type GateKind = 'lock' | 'autolock' | 'presence-off' | 'unlock-policy' | 'auth-policy'
export const gateActionOf = (k: GateKind): string => k === 'lock' ? 'lock' : k === 'autolock' ? 'set-auto-lock' : k === 'unlock-policy' ? 'set-unlock-policy' : k === 'auth-policy' ? 'set-auth-policy' : 'disable-presence'
export const presWordOf = (v: VaultView, lang: 'en' | 'pt') => vt(presenceKey(v.wrappers), lang)
export const unlockModeKey = (m: UnlockMode): VaultKey => m === 'always' ? 'unlock_always' : m === 'hello-only' ? 'unlock_helloOnly' : 'unlock_daily'

/** Owner decision 2026-10-02: the three unlock modes, the per-day window's hours, and what the NEXT unlock asks. */
export function UnlockPolicyRow({ view, lang, isMobile, gate, btn, onSave }: {
  view: VaultView; lang: 'en' | 'pt'; isMobile: boolean; gate: { code: boolean; gesture: boolean }; btn: React.CSSProperties
  onSave: (p: { mode: UnlockMode; hours: number }) => void
}) {
  const cur = view.unlockPolicy ?? { mode: 'daily' as const, hours: 24, chosen: false, codeNextUnlock: true, windowEndsAt: null }
  const pres = presWordOf(view, lang)
  const [mode, setMode] = useState<UnlockMode>(cur.mode)
  const [hoursText, setHoursText] = useState(String(cur.hours))
  useEffect(() => { setMode(cur.mode); setHoursText(String(cur.hours)) }, [cur.mode, cur.hours])
  const hours = parseUnlockHours(hoursText)
  const valid = mode !== 'daily' || hours !== null
  const changed = mode !== cur.mode || (mode === 'daily' && hours !== cur.hours)
  const save = () => { if (valid && changed) onSave({ mode, hours: mode === 'daily' ? hours! : cur.hours }) }
  const fmtTime = (iso: string) => { try { return new Date(iso).toLocaleTimeString(lang === 'pt' ? 'pt-BR' : 'en-US', { hour: '2-digit', minute: '2-digit' }) } catch { return iso } }
  return (
    <form onSubmit={e => { e.preventDefault(); save() }}>
      <div role="radiogroup" aria-label={vt('sec_unlock', lang)} style={{ display: 'grid', gap: 8, marginBottom: 10 }}>
        {UNLOCK_MODES.map(m => (
          <label key={m} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer', padding: isMobile ? '10px 12px' : '8px 10px', minHeight: isMobile ? 44 : undefined, border: '1px solid ' + (mode === m ? 'var(--anthropic-orange)' : 'var(--border)'), borderRadius: 10 }}>
            <input type="radio" name="unlock-mode" checked={mode === m} onChange={() => setMode(m)} style={{ marginTop: 3 }} />
            <span style={{ minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{vt(unlockModeKey(m), lang).replace('{presence}', pres)}</span>
              <span style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{vt(`${unlockModeKey(m)}_d` as VaultKey, lang).replace(/\{presence\}/g, pres)}</span>
            </span>
          </label>
        ))}
      </div>
      {mode === 'daily' && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 13, color: 'var(--text-secondary)', marginBottom: 8 }}>
          <span>{vt('unlock_hours', lang)}</span>
          <input value={hoursText} onChange={e => setHoursText(e.target.value.replace(/\D/g, '').slice(0, 2))} inputMode="numeric"
            style={{ ...input, width: 64, marginBottom: 0, letterSpacing: 'normal', textAlign: 'right', minHeight: isMobile ? 44 : undefined }} />
        </label>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
        <button type="submit" style={btn} disabled={!valid || !changed}>{vt('unlock_save', lang)} <Gate code={gate.code} gesture={gate.gesture} lang={lang} /></button>
        <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
          {cur.windowEndsAt && !cur.codeNextUnlock ? vtf('unlock_now_window', lang, { time: fmtTime(cur.windowEndsAt), presence: pres }) : cur.codeNextUnlock && cur.mode !== 'hello-only' ? vt('unlock_now_code', lang) : ''}
        </span>
      </div>
      {cur.mode === 'daily' && <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginBottom: 6 }}>{vt('unlock_reset', lang)}</div>}
    </form>
  )
}

export function GateDialog({ lang, view, isMobile, kind, minutes, policy, authPolicy, onCancel, onDone, onAction }: {
  lang: 'en' | 'pt'; view: VaultView; isMobile: boolean; kind: GateKind; minutes?: number; policy?: { mode: UnlockMode; hours: number }
  authPolicy?: Partial<Record<ActionKind, ProofChoice>>
  onCancel: () => void; onDone: () => void; onAction?: (a: UiAction) => void
}) {
  const action = gateActionOf(kind)
  const gate = gateFor(view, action)
  const wantsCode = needsTypedCode(gate, grantAlive())
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errAction, setErrAction] = useState<UiAction | null>(null)
  // v2.98.1: the main machine's "turn off" also asks the 24 words — typed here, on a loopback page only.
  const wantsWords = kind === 'presence-off' && view.requirePresence && view.loopback === true
  const [words, setWords] = useState('')
  const title = kind === 'lock' ? vt('lockNow', lang) : kind === 'autolock' ? vt('sec_autolock', lang) : kind === 'unlock-policy' ? vt('sec_unlock', lang) : kind === 'auth-policy' ? vt('ap_title', lang) : vt('pres_offConfirm', lang)
  const submit = async () => {
    if (busy || (wantsCode && !codeComplete(code))) return
    setBusy(true); setError(null)
    const c = wantsCode ? code : undefined
    const w = wantsWords ? splitWords(words).join(' ') : undefined
    const r = kind === 'lock' ? await lockNow(c) : kind === 'autolock' ? await setAutoLock(minutes ?? 30, c)
      : kind === 'unlock-policy' ? await setUnlockPolicy(policy?.mode ?? 'daily', policy?.hours ?? 12, c)
      : kind === 'auth-policy' ? await setAuthPolicy(authPolicy ?? {}, c) : await presenceDisable(c, w)
    setBusy(false)
    setWords('') // never kept past the request
    if (r.ok) { onDone(); return }
    setError(r.sentence || vt('network', lang)); setCode('')
    setErrAction(r.action && r.action !== 'disable-presence' ? r.action : null)
  }
  useEscape(onCancel)
  return (
    <div style={overlay} role="dialog" aria-modal="true" aria-label={title} onClick={onCancel}>
      <form onClick={e => e.stopPropagation()} onSubmit={e => { e.preventDefault(); void submit() }} style={card}>
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6 }}>{title}</div>
        {kind === 'presence-off' && <Note tone="warn">{vt('pres_offConsequence', lang)}</Note>}
        {wantsCode && <CodeField value={code} onChange={setCode} label={vt('gate_dialog_code', lang)} autoFocus error={!!error} errorKey={error} />}
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
          <button type="submit" disabled={busy || (wantsCode && !codeComplete(code)) || (wantsWords && splitWords(words).length !== 24)} style={{ ...(kind === 'presence-off' ? dangerBtn : primaryBtn), minHeight: isMobile ? 44 : undefined }}>
            {busy ? vt('working', lang) : vt('gate_continue', lang)}
          </button>
        </div>
      </form>
    </div>
  )
}

export function useEscape(onEsc: () => void) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onEsc() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onEsc])
}

// ── the enrolment wizard (§7.3): [setup code] → [device check] → authenticator → presence → recovery key ─────────────────────────

type Phase = 'intro' | 'qr' | 'words' | 'confirm' | 'presence' | 'done'

export function EnrolWizard({ lang, isMobile, initial, steps, onClose, fixedKind, onAction }: {
  lang: 'en' | 'pt'; isMobile: boolean; initial: VaultView; steps: WizardStep[]; onClose: () => void
  /** v2.98.1: "add another way" — the wizard enrols THIS kind and offers no other. */
  fixedKind?: 'hello' | 'fido2' | null
  onAction?: (a: UiAction) => void
}) {
  // The whole §7.3 flow: [gesture | setup code] → device check → authenticator → presence → recovery key (each only if still missing).
  const [plan, setPlan] = useState<WizardPhaseStep[]>(() => wizardPlan(steps, initial.setupCode?.owed === true, initial.loopback === true && Boolean(initial.localProofKind)))
  const t = (k: VaultKey) => vt(k, lang)
  const [view, setView] = useState(initial)
  const [i, setI] = useState(0)
  const step = plan[i]
  const [flowOk, setFlowOk] = useState(false) // the one verified code stands for the rest of THIS wizard
  const [phase, setPhase] = useState<Phase>('intro')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errAction, setErrAction] = useState<UiAction | null>(null)
  const [oldCode, setOldCode] = useState('')
  const [uri, setUri] = useState<{ uri: string; secret: string } | null>(null)
  const [c1, setC1] = useState('')
  // The 24 words live in this state for exactly as long as they are on screen, and are dropped the
  // moment the person confirms or leaves — never persisted, never copied anywhere by this page.
  const [words, setWords] = useState<string[] | null>(null)
  const [positions, setPositions] = useState<number[]>([])
  const [typed, setTyped] = useState<string[]>(['', '', ''])
  const [kind, setKind] = useState<'hello' | 'fido2'>(fixedKind ?? (initial.presenceAvailable.includes('hello') ? 'hello' : 'fido2'))
  const [presCode, setPresCode] = useState('')
  // Review S2: the server answers `setup-code-required` for a page's FIRST enrolment; the code comes
  // from this machine's terminal (`agentop vault setup-code`). `askCode`: a first recovery key outside
  // this session's wizard needs the authenticator code.
  const [needSetup, setNeedSetup] = useState(false)
  const [setupCode, setSetupCode] = useState('')
  const [askCode, setAskCode] = useState(false)
  // Leader decision 2: a recovery key that already exists must follow the new data key — the page never
  // takes the 24 words, so it offers NEW words instead (the old ones stop working), or the terminal.
  const [needWords, setNeedWords] = useState(false)
  const [finished, setFinished] = useState(false)

  useEffect(() => () => { setWords(null) }, [])
  useEscape(() => { if (!busy) onClose() })

  // Live "confirmation i of n" while the service has a Windows Hello / key dialog up (owner 2026-10-02).
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
  const probeGestures = view.gestures?.probe ?? 0
  const enrolGestures = view.gestures?.enroll ?? 2
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
    setError(null); setErrAction(null); setOldCode(''); setC1(''); setPresCode(''); setUri(null); setWords(null); setTyped(['', '', ''])
    if (i + 1 < plan.length) { setI(i + 1); setPhase('intro') } else { setFinished(true); setPhase('done') }
  }
  // A failure names the step it stopped at; reopening the wizard resumes from what is still missing.
  const fail = (s: string, action?: UiAction) => { setError(`${vtf('wiz_failedAt', lang, { step: t(`wiz_step_${step ?? 'presence'}` as VaultKey) })} ${s || t('network')}`); setErrAction(action && action !== 'enroll' ? action : null); setBusy(false) }

  const gateOf = (action: string) => gateFor(view, action)
  const needCodeFor = (action: string) => needsTypedCode({ ...gateOf(action), grant: false }, false)
  const stepNo = Math.min(i + 1, plan.length)
  const presenceCodeNeeded = needCodeFor('enroll-presence') && !flowOk

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

  // ── authenticator
  const showQr = async () => {
    if (busy) return
    setBusy(true); setError(null)
    const r = await authenticatorBegin(needCodeFor('enroll-authenticator') ? oldCode : undefined, needSetup ? setupCode : undefined)
    setBusy(false)
    if (!r.ok) {
      if (r.code === 'setup-code-required') { setNeedSetup(true); setSetupCode('') }
      return fail(r.sentence, r.action)
    }
    setNeedSetup(false); setSetupCode('')
    setUri({ uri: r.uri, secret: r.secret }); setPhase('qr')
  }
  const confirmAuth = async () => {
    if (busy || !codeComplete(c1)) return
    setBusy(true); setError(null)
    const r = await authenticatorConfirm(c1)
    if (!r.ok) { setC1(''); return fail(r.sentence, r.action) }
    setBusy(false); setUri(null); setFlowOk(true)
    await next()
  }

  // ── recovery key
  const showWords = async () => {
    if (busy) return
    setBusy(true); setError(null)
    const r = await recoveryBegin((needCodeFor('rotate-recovery') && view.recoveryCreatedAt) || askCode ? oldCode : undefined, needSetup ? setupCode : undefined)
    setBusy(false)
    if (!r.ok) {
      if (r.code === 'setup-code-required') { setNeedSetup(true); setSetupCode('') }
      if (r.code === 'stepup-required') { setAskCode(true); setOldCode('') }
      return fail(r.sentence, r.action)
    }
    setNeedSetup(false); setSetupCode(''); setAskCode(false)
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

  // ── device check (before anything changes)
  const probe = async () => {
    if (busy) return
    setBusy(true); setError(null)
    setGestureTotal(probeGestures)
    const r = await presenceProbe(kind)
    setGestureTotal(0)
    if (!r.ok) return fail(r.sentence, r.action)
    setBusy(false)
    await next()
  }

  // ── presence
  const enrolPresence = async (replaceRecovery = false) => {
    if (busy) return
    setBusy(true); setError(null)
    setGestureTotal(enrolGestures)
    const r = await presenceEnrol(kind, presenceCodeNeeded ? presCode : undefined, replaceRecovery)
    setGestureTotal(0)
    if (!r.ok) {
      setPresCode('')
      if (r.code === 'presence-needs-recovery-words') { setNeedWords(true); setBusy(false); setError(r.sentence); return }
      return fail(r.sentence, r.action)
    }
    setBusy(false); setNeedWords(false)
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

  return (
    <div style={fullOnMobile(isMobile, card).o} role="dialog" aria-modal="true" aria-label={t('wiz_title')}>
      <div className="ag-vault-wizard" style={fullOnMobile(isMobile, { ...card, maxWidth: 460, maxHeight: '92vh', overflowY: 'auto', boxSizing: 'border-box' }).c}>
        <style>{PRINT_CSS}</style>
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>{t('wiz_title')}</div>
        {prog && <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', margin: '2px 0 10px' }}>{vtf('wiz_step', lang, { i: stepNo, n: plan.length })}</div>}
        {phase !== 'done' && <Note>{t('wiz_safe')}</Note>}

        {phase === 'intro' && step === 'local' && (
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{t('wiz_local_title')}</div>
            {gestureLine}
            <Note>{t('wiz_local_intro')}</Note>
            {error && <ActionErr text={error} action={errAction} lang={lang} onAction={onAction} />}
            <button type="button" style={cta} disabled={busy} onClick={() => { void proveLocal() }}>
              {busy ? t('unlocking') : t(view.localProofKind === 'fido2' ? 'wiz_local_go_fido2' : 'wiz_local_go_hello')}
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
        {phase === 'intro' && step === 'probe' && (
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{t('wiz_probe_title')}</div>
            {gestureLine}
            <Note>{vtf('wiz_probe_intro', lang, { presence: vt(presenceKey([kind]), lang) })}</Note>
            <Note>{t(kind === 'hello' ? 'wiz_pres_checkHello' : 'wiz_pres_checkKey')}</Note>
            {error && <ActionErr text={error} action={errAction} lang={lang} onAction={onAction} />}
            <button type="button" style={cta} disabled={busy} onClick={() => { void probe() }}>{busy ? t('unlocking') : t('wiz_probe_go')}</button>
          </div>
        )}
        {phase === 'intro' && step === 'authenticator' && (
          <form onSubmit={e => { e.preventDefault(); if (!busy && !(needCodeFor('enroll-authenticator') && !codeComplete(oldCode)) && !(needSetup && !setupCodeComplete(setupCode))) void showQr() }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{t('wiz_auth_title')}</div>
            <Note>{t('wiz_auth_intro')}</Note>
            {needCodeFor('enroll-authenticator') && <CodeField value={oldCode} onChange={setOldCode} label={t('wiz_oldCode')} autoFocus />}
            {needSetup && <SetupCodeField value={setupCode} onChange={setSetupCode} label={t('wiz_setup_label')} why={t('wiz_setup_why')} />}
            {error && <ActionErr text={error} action={errAction} lang={lang} onAction={onAction} />}
            <button type="submit" style={cta} disabled={busy || (needCodeFor('enroll-authenticator') && !codeComplete(oldCode)) || (needSetup && !setupCodeComplete(setupCode))}>{busy ? t('working') : t('wiz_auth_show')}</button>
          </form>
        )}
        {phase === 'qr' && uri && (
          <form onSubmit={e => { e.preventDefault(); void confirmAuth() }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{t('wiz_auth_title')}</div>
            <Note>{t('wiz_auth_scan')} {t('wiz_auth_once')}</Note>
            <Qr uri={uri.uri} />
            <details style={{ marginBottom: 10 }}>
              <summary style={{ fontSize: 12, color: 'var(--text-secondary)', cursor: 'pointer', padding: isMobile ? '10px 0' : '6px 0' }}>{t('wiz_auth_cant')}</summary>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', margin: '8px 0 6px' }}>{t('wiz_auth_type')}</div>
              <code style={{ ...codeBlock, display: 'block', marginBottom: 0 }}>{uri.secret.match(/.{1,4}/g)?.join(' ')}</code>
            </details>
            <CodeField value={c1} onChange={setC1} label={t('wiz_code')} autoFocus />
            {error && <ActionErr text={error} action={errAction} lang={lang} onAction={onAction} />}
            <button type="submit" style={cta} disabled={busy || !codeComplete(c1)}>{busy ? t('working') : t('codeConfirm')}</button>
          </form>
        )}

        {phase === 'intro' && step === 'recovery' && (
          <form onSubmit={e => { e.preventDefault(); if (!busy && !((((rotating && needCodeFor('rotate-recovery')) || askCode) && !codeComplete(oldCode))) && !(needSetup && !setupCodeComplete(setupCode))) void showWords() }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{t('wiz_rec_title')}</div>
            <Note>{t('wiz_rec_intro')}</Note>
            {rotating && <Note tone="warn">{t('wiz_rec_rotate')}</Note>}
            {((rotating && needCodeFor('rotate-recovery')) || askCode) && <CodeField value={oldCode} onChange={setOldCode} label={t('wiz_oldCode')} autoFocus />}
            {needSetup && <SetupCodeField value={setupCode} onChange={setSetupCode} label={t('wiz_setup_label')} why={t('wiz_setup_why')} />}
            {rotating && gateOf('rotate-recovery').gesture && <Note>{vtf('gate_dialog_presence', lang, { presence: vt(presenceKey(view.wrappers), lang) })}</Note>}
            {error && <ActionErr text={error} action={errAction} lang={lang} onAction={onAction} />}
            <button type="submit" style={cta} disabled={busy || (((rotating && needCodeFor('rotate-recovery')) || askCode) && !codeComplete(oldCode)) || (needSetup && !setupCodeComplete(setupCode))}>{busy ? t('working') : t('wiz_rec_show')}</button>
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
          <form onSubmit={e => { e.preventDefault(); if (!busy && !(presenceCodeNeeded && !codeComplete(presCode))) void enrolPresence(needWords) }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{t('wiz_pres_title')}</div>
            {gestureLine}
            <Note>{t('wiz_pres_intro')}</Note>
            {!fixedKind && (view.presenceAvailable.length > 1 || soonKinds(view).length > 0) && (
              <div role="radiogroup" style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
                {(['hello', 'fido2'] as const).filter(k => view.presenceAvailable.includes(k) && !view.wrappers.includes(k)).map(k => (
                  <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)}
                    style={{ ...primaryBtn, width: 'auto', minHeight: isMobile ? 44 : undefined, ...(kind === k ? null : { color: 'var(--text-secondary)', borderColor: 'var(--border)', background: 'transparent' }) }}>
                    {t(k === 'hello' ? 'presenceName_hello' : 'presenceName_fido2')}
                  </button>
                ))}
                {soonKinds(view).map(k => (
                  <button key={k} type="button" role="radio" aria-checked={false} disabled aria-disabled
                    style={{ ...primaryBtn, width: 'auto', minHeight: isMobile ? 44 : undefined, color: 'var(--text-tertiary)', borderColor: 'var(--border)', background: 'transparent', opacity: 0.6, cursor: 'not-allowed' }}>
                    {t('presenceName_fido2')} · {t('pres_soon')}
                  </button>
                ))}
              </div>
            )}
            {!fixedKind && soonKinds(view).length > 0 && <Note>{t('pres_soon_fido2')}</Note>}
            <Note>{vtf(kind === 'hello' ? 'wiz_pres_enrolHello' : 'wiz_pres_enrolKey', lang, { n: enrolGestures })}</Note>
            {view.wrappers.some(w => w !== 'hello' && w !== 'fido2' && w !== 'recovery' && w !== 'passphrase') && <Note>{t('wiz_pres_heldNote')}</Note>}
            {presenceCodeNeeded && <CodeField value={presCode} onChange={setPresCode} label={t('wiz_oldCode')} autoFocus />}
            {error && <ActionErr text={error} action={errAction} lang={lang} onAction={onAction} />}
            {!needWords && (
              <button type="submit" style={cta} disabled={busy || (presenceCodeNeeded && !codeComplete(presCode))}>
                {busy ? t('unlocking') : t('wiz_pres_go')}
              </button>
            )}
            {needWords && (
              <>
                <Note tone="warn">{t('wiz_pres_newWords_warn')}</Note>
                <button type="submit" style={cta} disabled={busy || (presenceCodeNeeded && !codeComplete(presCode))}>
                  {busy ? t('unlocking') : t('wiz_pres_newWords')}
                </button>
              </>
            )}
          </form>
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
      <form onSubmit={e => { e.preventDefault(); void submit() }} className="ag-vault-recover" style={fullOnMobile(isMobile, { ...card, maxWidth: 560, maxHeight: '92vh', overflowY: 'auto', boxSizing: 'border-box' }).c}>
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

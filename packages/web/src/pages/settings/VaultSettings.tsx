/**
 * Settings → Vault (SECRETS.4 §7.1). What is sealed on this machine and in what state — METADATA ONLY —
 * plus the vault's own controls: unlock (a gesture, then a code), the authenticator, presence, the
 * recovery key, auto-lock, and the hardening report.
 *
 * Nothing here decides what an action asks. The server sends its §2.4 table (`gates`), every route
 * enforces it again, and this screen only draws it (🔑 code, 👆 presence) and asks for the code BEFORE
 * the request where it knows one is owed. There is deliberately no "show secret" anywhere, no copy
 * button on the 24 words, and no field that accepts them — recovery is typed on a terminal (§4.3).
 */
import { useCallback, useEffect, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { FingerprintPattern, KeyRound, Loader2, Printer } from 'lucide-react'
import type { AppContext } from '../../lib/app-context'
import { useIsMobile } from '../../hooks/useIsMobile'
import { SectionHeader, Divider, PrefRow } from './primitives'
import { Err, Qr, card, codeBlock, dangerBtn, input, overlay, primaryBtn } from '../../components/MfaSetup'
import { itemStateKey, kindKey, orderItems, presenceKey, reasonKey, stateKey, vt, vtf, type VaultKey } from '../../lib/vaultText'
import {
  authenticatorBegin, authenticatorConfirm, cleanCode, cleanSetupCode, setupCodeComplete, clampAutoLock, codeComplete, credentials, gateFor, grantAlive, heartbeat,
  loadVault, lockNow, minutesLeft, missingSteps, needsTypedCode, parseAutoLockInput, presenceDisable, presenceEnrol, recoveryBegin,
  recoveryConfirm, remainingMs, setAutoLock, stepUp, unlockCode, unlockGesture, wordRows, AUTO_LOCK_MAX, AUTO_LOCK_MIN,
  askWords, presenceProbe, wizardPlan,
  type Credential, type LoadResult, type VaultView, type WizardPhaseStep, type WizardStep,
} from '../../lib/vaultApi'

const TONE = {
  sealed: 'var(--accent-green, #22c55e)',
  pending: 'var(--accent-orange, #f59e0b)',
  unreadable: 'var(--accent-red, #ef4444)',
} as const

const POLL_MS = 15_000
const BEAT_MS = 30_000
const UPGRADE_DISMISS_KEY = 'agentistics-vault-upgrade-dismissed'

type Load = { kind: 'loading' } | LoadResult

export default function VaultSettings() {
  const ctx = useOutletContext<AppContext>()
  const lang = ctx.lang === 'pt' ? 'pt' : 'en'
  const isMobile = useIsMobile()
  const t = (k: VaultKey) => vt(k, lang)

  const [res, setRes] = useState<Load>({ kind: 'loading' })
  const [reportedAt, setReportedAt] = useState(() => Date.now())
  const [now, setNow] = useState(() => Date.now())
  const [creds, setCreds] = useState<{ credentials: Credential[]; recoveryCreatedAt: string | null } | null>(null)
  const [wizard, setWizard] = useState<WizardStep[] | null>(null)
  const [dialog, setDialog] = useState<null | { kind: 'lock' | 'autolock' | 'presence-off'; minutes?: number }>(null)
  const [dismissed, setDismissed] = useState(() => { try { return localStorage.getItem(UPGRADE_DISMISS_KEY) === '1' } catch { return false } })
  const busyUi = wizard !== null || dialog !== null

  const load = useCallback(async () => {
    const r = await loadVault()
    setRes(r); setReportedAt(Date.now()); setNow(Date.now())
    return r
  }, [])
  useEffect(() => { void load() }, [load])

  // The idle clock and the lock state live in the SERVICE: poll while the page is in front, and tick
  // the countdown between polls from the time the server last reported.
  useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now())
      if (document.visibilityState === 'visible' && !busyUi) void load()
    }, POLL_MS)
    return () => clearInterval(id)
  }, [load, busyUi])

  const view: VaultView | null = res.kind === 'view' || res.kind === 'needs-stepup' ? res.view : null
  const open = view?.state === 'open'

  // §5.1: interaction on this page is human use — it resets the idle clock (throttled; only while open).
  useEffect(() => {
    if (!open) return
    let last = 0
    const beat = () => { const n = Date.now(); if (n - last >= BEAT_MS) { last = n; heartbeat() } }
    window.addEventListener('pointerdown', beat); window.addEventListener('keydown', beat)
    return () => { window.removeEventListener('pointerdown', beat); window.removeEventListener('keydown', beat) }
  }, [open])

  // The Presence section's list (gated like `list`): fetched once the inventory itself is readable.
  const readable = res.kind === 'view' && open
  const enrolledKey = view ? `${view.presence}-${view.recoveryCreatedAt}-${view.wrappers.join()}` : ''
  useEffect(() => {
    if (!readable) { setCreds(null); return }
    let alive = true
    void credentials().then(r => { if (alive && r.ok) setCreds({ credentials: r.credentials, recoveryCreatedAt: r.recoveryCreatedAt }) })
    return () => { alive = false }
  }, [readable, enrolledKey])

  const fmt = (iso?: string | null) => {
    if (!iso) return t('unknown')
    const d = new Date(iso)
    return Number.isNaN(d.getTime()) ? t('unknown') : d.toLocaleString(lang === 'pt' ? 'pt-BR' : 'en-US')
  }

  if (res.kind === 'failed') return <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{t('loadFailed')}</div>
  if (res.kind === 'loading' || !view) return <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>{t('loading')}</div>

  const mono: React.CSSProperties = { fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 12, wordBreak: 'break-all' }
  const btn: React.CSSProperties = {
    padding: isMobile ? '10px 16px' : '6px 14px', minHeight: isMobile ? 44 : undefined, borderRadius: 8, fontSize: 13,
    border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-primary)', cursor: 'pointer',
    display: 'inline-flex', alignItems: 'center', gap: 8, fontFamily: 'inherit',
  }
  const hot: React.CSSProperties = { ...btn, ...primaryBtn, width: 'auto', padding: btn.padding, minHeight: btn.minHeight }
  const left = remainingMs(view.autoLockInMs, reportedAt, now)
  const presWord = vt(presenceKey(view.wrappers), lang)
  const g = (action: string) => gateFor(view, action)
  // Every gated button says, on hover and to assistive tech, exactly what it will ask.
  const tip = (action: string): string => askWords(g(action), {
    code: t('tip_code'), presence: vtf('tip_presence', lang, { presence: presWord }), and: t('tip_and'), asks: t('tip_asks'), nothing: t('tip_nothing'),
  })
  const locked = view.state === 'locked'
  const steps = missingSteps(view)
  // A section's button runs the WHOLE missing flow (never one lonely step); only a replacement is single.
  const startSetup = (preferred: WizardStep) => setWizard(steps.length > 0 ? steps : [preferred])
  const canUpgrade = steps.length > 0 && view.state !== 'uninitialized' && view.state !== 'corrupt' && view.state !== 'protector-lost'
  const showBanner = canUpgrade && !view.recoveryTodo && (view.requirePresence || !dismissed) && open
  const dismiss = () => { setDismissed(true); try { localStorage.setItem(UPGRADE_DISMISS_KEY, '1') } catch { /* a convenience only */ } }

  const items = orderItems(res.kind === 'view' ? view.items : [])
  const pending = items.filter(i => i.state === 'pending')

  // An action's proofs: the icons say what it asks; a dialog collects the code (and warns about the gesture).
  const ask = (kind: 'lock' | 'autolock' | 'presence-off', minutes?: number) => {
    const action = kind === 'lock' ? 'lock' : kind === 'autolock' ? 'set-auto-lock' : 'disable-presence'
    const gate = g(action)
    if (!needsTypedCode(gate, grantAlive()) && !gate.gesture) {
      // A live grant covers the code and there is no gesture to raise: just do it; if the server
      // still wants something, the dialog opens and asks.
      void (async () => {
        const r = kind === 'lock' ? await lockNow() : kind === 'autolock' ? await setAutoLock(minutes ?? 30) : await presenceDisable()
        if (r.ok) await load(); else setDialog({ kind, minutes })
      })()
      return
    }
    setDialog({ kind, minutes })
  }

  return (
    <>
      <SectionHeader label={t('title')} />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <span aria-hidden style={{ width: 10, height: 10, borderRadius: '50%', background: open ? TONE.sealed : locked ? TONE.pending : TONE.unreadable, flexShrink: 0 }} />
          <strong style={{ fontSize: 15 }}>{t(stateKey(view.state))}</strong>
          {open && left !== null && <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>{vtf('openLocksIn', lang, { n: minutesLeft(left) })}</span>}
        </div>
        {locked && <UnlockControl view={view} lang={lang} onOpened={() => { void load() }} btn={hot} isMobile={isMobile} />}
        {open && (
          <button type="button" style={btn} onClick={() => ask('lock')} disabled={!view.canLock} title={tip('lock')} aria-label={`${t('lockNow')}. ${tip('lock')}`}>
            {t('lockNow')} <Gate code={g('lock').code} gesture={g('lock').gesture} lang={lang} />
          </button>
        )}
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 18 }}>
        {locked && view.authenticator
          ? (view.presence ? vtf('lockedIntro_presence', lang, { presence: presWord }) : t('lockedIntro_code'))
          : t('intro')}
      </div>
      {view.sentence && view.state !== 'open' && (
        <div role="status" style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 14 }}>{view.sentence}</div>
      )}

      {showBanner && (
        <div role="status" style={{
          border: '1px solid var(--anthropic-orange)', borderRadius: 10, padding: '12px 14px', marginBottom: 18,
          background: 'var(--anthropic-orange-dim)',
        }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>{t('ultraTitle')}</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6, marginTop: 4 }}>
            {view.requirePresence ? t('ultraRequired') : t('ultraBody')}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <button type="button" style={hot} onClick={() => setWizard(steps)} title={t('ultraBody')}>{t('ultraStart')}</button>
            {/* The owner's machine does not offer "skip" (§7.4). */}
            {!view.requirePresence && <button type="button" style={btn} onClick={dismiss}>{t('ultraLater')}</button>}
          </div>
        </div>
      )}

      {res.kind === 'needs-stepup' && open && (
        <StepUpCard lang={lang} sentence={res.sentence} code={res.code} isMobile={isMobile} onDone={() => { void load() }} />
      )}

      {res.kind === 'view' && open && (
        <>
          <SectionHeader label={t('sec_status')} />
          <PrefRow label={t('protector')}><span style={{ fontSize: 13, textAlign: 'right', minWidth: 0 }}>{view.protectorLabel ?? t('none')}</span></PrefRow>
          <PrefRow label={t('keyId')}><span style={mono}>{view.kid ?? t('none')}</span></PrefRow>
          <PrefRow label={t('created')}><span style={{ fontSize: 13 }}>{view.createdAt ? fmt(view.createdAt) : t('none')}</span></PrefRow>
          <Divider />

          <SectionHeader label={t('sec_authenticator')} />
          {view.authenticator ? (
            <>
              <PrefRow label={vtf('auth_ready', lang, { date: fmt(view.authenticator.enrolledAt) })}
                sub={`${t('auth_lastUsed')}: ${view.authenticator.lastUsedAt ? fmt(view.authenticator.lastUsedAt) : t('auth_never')}`}>
                <button type="button" style={btn} onClick={() => setWizard(['authenticator'])} title={tip('enroll-authenticator')} aria-label={`${t('auth_replace')}. ${tip('enroll-authenticator')}`}>
                  {t('auth_replace')} <Gate code={g('enroll-authenticator').code} gesture={g('enroll-authenticator').gesture} lang={lang} />
                </button>
              </PrefRow>
              <Note>{t('auth_explain')}</Note>
              {view.authenticator.pausedUntil && <Note tone="warn">{vtf('auth_paused', lang, { date: fmt(view.authenticator.pausedUntil) })}</Note>}
              {view.authenticator.frozen && <Note tone="bad">{t('auth_frozen')}</Note>}
            </>
          ) : (
            <>
              <PrefRow label={t('auth_none')}>
                <button type="button" style={hot} onClick={() => startSetup('authenticator')} title={t('ultraBody')}>{t('auth_setup')}</button>
              </PrefRow>
              <Note>{t('auth_explain')}</Note>
            </>
          )}
          <Divider />

          <SectionHeader label={t('sec_presence')} />
          {view.presence ? (
            <>
              {(creds?.credentials ?? []).map(c => (
                <PrefRow key={`${c.type}-${c.createdAt}`} label={c.label} sub={vtf('pres_since', lang, { date: fmt(c.createdAt) })}><span /></PrefRow>
              ))}
              {!creds && <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 10 }}>{presWord}</div>}
              {view.presenceAvailable.includes('fido2') && (
                <PrefRow label={t('pres_addKey')}>
                  <button type="button" style={btn} onClick={() => setWizard(['presence'])} title={tip('enroll-presence')} aria-label={`${t('pres_addKey')}. ${tip('enroll-presence')}`}>
                    {t('pres_addKey')} <Gate code={g('enroll-presence').code} gesture={g('enroll-presence').gesture} lang={lang} />
                  </button>
                </PrefRow>
              )}
              {view.requirePresence
                ? <Note>{t('pres_mainMachine')}</Note>
                : (
                  <PrefRow label={t('pres_turnOff')} sub={t('pres_offConsequence')}>
                    <button type="button" style={{ ...btn, color: '#ef4444', borderColor: '#ef4444' }} onClick={() => ask('presence-off')} title={tip('disable-presence')} aria-label={`${t('pres_turnOff')}. ${tip('disable-presence')}`}>
                      {t('pres_turnOff')} <Gate code={g('disable-presence').code} gesture={g('disable-presence').gesture} lang={lang} />
                    </button>
                  </PrefRow>
                )}
            </>
          ) : view.presenceAvailable.length === 0 ? (
            <Note>{t('pres_unavailable')}</Note>
          ) : (
            <PrefRow label={t('pres_off')}>
              <button type="button" style={hot} onClick={() => startSetup('presence')} title={t('ultraBody')}>{t(view.presenceAvailable.includes('hello') ? 'pres_turnOn' : 'pres_turnOnKey')}</button>
            </PrefRow>
          )}
          <Divider />

          <SectionHeader label={t('sec_recovery')} />
          <PrefRow label={view.recoveryCreatedAt ? vtf('rec_created', lang, { date: fmt(view.recoveryCreatedAt) }) : t('rec_none')} sub={undefined}>
            <button type="button" style={view.recoveryCreatedAt ? btn : hot} title={view.recoveryCreatedAt ? tip('rotate-recovery') : t('ultraBody')}
              onClick={() => (view.recoveryCreatedAt ? setWizard(['recovery']) : startSetup('recovery'))}>
              {view.recoveryCreatedAt ? t('rec_new') : t('rec_create')} <Gate code={g('rotate-recovery').code && Boolean(view.recoveryCreatedAt)} gesture={g('rotate-recovery').gesture && Boolean(view.recoveryCreatedAt)} lang={lang} />
            </button>
          </PrefRow>
          <Note>{t('rec_lost')}</Note>
          <Divider />

          <SectionHeader label={t('sec_autolock')} />
          <AutoLockRow view={view} lang={lang} isMobile={isMobile} gate={g('set-auto-lock')} tipText={tip('set-auto-lock')} btn={btn} onSave={m => ask('autolock', m)} />
          <Divider />

          <SectionHeader label={t('sec_hardening')} />
          <HardeningBlock view={view} lang={lang} />
          <Divider />
        </>
      )}

      {pending.length > 0 && (
        <div role="status" style={{
          border: '1px solid var(--accent-orange, #f59e0b)', borderRadius: 10, padding: '12px 14px', marginBottom: 18,
          background: 'color-mix(in srgb, var(--accent-orange, #f59e0b) 8%, transparent)',
        }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>{t('pendingTitle')} · {pending.length}</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6, marginTop: 4 }}>{t('pendingBody')}</div>
        </div>
      )}

      {res.kind === 'view' && open && (
        <>
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
        </>
      )}

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

      {dialog && (
        <GateDialog
          lang={lang} view={view} isMobile={isMobile} kind={dialog.kind} minutes={dialog.minutes}
          onCancel={() => setDialog(null)} onDone={() => { setDialog(null); void load() }}
        />
      )}
      {wizard && (
        <EnrolWizard
          lang={lang} isMobile={isMobile} initial={view} steps={wizard}
          onClose={() => { setWizard(null); void load() }}
        />
      )}
    </>
  )
}

// ── small pieces ─────────────────────────────────────────────────────────────────────────────

/** The two proofs an action asks, as icons (🔑 code, 👆 presence) — each with a name for assistive tech. */
function Gate({ code, gesture, lang }: { code: boolean; gesture: boolean; lang: 'en' | 'pt' }) {
  if (!code && !gesture) return null
  return (
    <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', opacity: 0.85 }}>
      {code && <span title={vt('gate_code', lang)} aria-label={vt('gate_code', lang)} role="img" style={{ display: 'inline-flex' }}><KeyRound size={14} /></span>}
      {gesture && <span title={vt('gate_presence', lang)} aria-label={vt('gate_presence', lang)} role="img" style={{ display: 'inline-flex' }}><FingerprintPattern size={14} /></span>}
    </span>
  )
}

function Note({ children, tone }: { children: React.ReactNode; tone?: 'warn' | 'bad' }) {
  const color = tone === 'bad' ? 'var(--accent-red, #ef4444)' : tone === 'warn' ? 'var(--accent-orange, #f59e0b)' : 'var(--text-secondary)'
  return <div role={tone ? 'alert' : undefined} style={{ fontSize: 12, color, lineHeight: 1.6, marginBottom: 12 }}>{children}</div>
}

/** Review S2: the 8-digit setup code this machine's terminal shows (`agentop vault setup-code`). */
function SetupCodeField({ value, onChange, label, why }: { value: string; onChange: (v: string) => void; label: string; why: string }) {
  return (
    <label style={{ display: 'block', marginBottom: 10 }}>
      <span style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>{why}</span>
      <span style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>{label}</span>
      <input
        value={value} onChange={e => onChange(cleanSetupCode(e.target.value))} placeholder="1234 5678" style={{ ...input, marginBottom: 0 }}
        inputMode="numeric" autoComplete="off" autoFocus maxLength={9}
      />
    </label>
  )
}

function CodeField({ value, onChange, label, autoFocus, onEnter }: { value: string; onChange: (v: string) => void; label: string; autoFocus?: boolean; onEnter?: () => void }) {
  return (
    <label style={{ display: 'block', marginBottom: 10 }}>
      <span style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>{label}</span>
      <input
        value={value} onChange={e => onChange(cleanCode(e.target.value))} placeholder="123456" style={{ ...input, marginBottom: 0 }}
        inputMode="numeric" autoComplete="one-time-code" autoFocus={autoFocus} maxLength={6}
        onKeyDown={e => { if (e.key === 'Enter' && onEnter) { e.preventDefault(); onEnter() } }}
      />
    </label>
  )
}

/** The locked state's button: gesture first (the SERVICE raises the dialog), then the code field. */
function UnlockControl({ view, lang, onOpened, btn, isMobile }: { view: VaultView; lang: 'en' | 'pt'; onOpened: () => void; btn: React.CSSProperties; isMobile: boolean }) {
  const [phase, setPhase] = useState<'idle' | 'gesture' | 'code'>(view.pendingStepup ? 'code' : 'idle')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const label: VaultKey = view.wrappers.includes('hello') ? 'unlockWith_hello' : view.wrappers.includes('fido2') ? 'unlockWith_fido2' : 'unlockPlain'

  const gesture = async () => {
    setError(null); setPhase('gesture')
    const r = await unlockGesture()
    if (!r.ok) { setPhase('idle'); setError(r.sentence || vt('network', lang)); return }
    if (r.state === 'pending-stepup') setPhase('code')
    else onOpened()
  }
  const submit = async () => {
    if (!codeComplete(code) || busy) return
    setBusy(true); setError(null)
    const r = await unlockCode(code)
    setBusy(false)
    if (r.ok) { setCode(''); onOpened(); return }
    // §2.2: a wrong code zeroes the key at once — back to the gesture, with the sentence saying why.
    setError(r.sentence || vt('network', lang)); setCode(''); setPhase('idle')
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: isMobile ? 'stretch' : 'flex-end', gap: 8, width: isMobile ? '100%' : undefined }}>
      {phase !== 'code' && (
        <button type="button" style={btn} onClick={() => { void gesture() }} disabled={phase === 'gesture'}>
          {phase === 'gesture' && <Loader2 size={14} className="ag-spin" />}
          {phase === 'gesture' ? vt('unlocking', lang) : vt(label, lang)}
        </button>
      )}
      {phase === 'code' && (
        <form onSubmit={e => { e.preventDefault(); void submit() }} style={{ width: isMobile ? '100%' : 260 }}>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8, lineHeight: 1.5 }}>{vt('pendingCodeHint', lang)}</div>
          <CodeField value={code} onChange={setCode} label={vt('codeLabel', lang)} autoFocus />
          <button type="submit" style={{ ...btn, width: '100%', justifyContent: 'center' }} disabled={!codeComplete(code) || busy}>{vt('codeConfirm', lang)}</button>
        </form>
      )}
      {error && <div role="alert" style={{ fontSize: 12, color: 'var(--accent-red, #ef4444)', maxWidth: isMobile ? undefined : 360, textAlign: isMobile ? 'left' : 'right' }}>{error}</div>}
    </div>
  )
}

/** The open vault asks for a code before it lists anything (§2.4 `list`). */
function StepUpCard({ lang, sentence, code: why, isMobile, onDone }: { lang: 'en' | 'pt'; sentence: string; code: string; isMobile: boolean; onDone: () => void }) {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(why !== 'stepup-required' && sentence ? sentence : null)
  const submit = async () => {
    if (!codeComplete(code) || busy) return
    setBusy(true); setError(null)
    const r = await stepUp(code)
    setBusy(false)
    if (r.ok) { setCode(''); onDone() } else { setError(r.sentence || vt('network', lang)); setCode('') }
  }
  return (
    <form onSubmit={e => { e.preventDefault(); void submit() }} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '14px 16px', marginBottom: 18, maxWidth: 420 }}>
      <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text-primary)' }}>{vt('stepupTitle', lang)}</div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '4px 0 12px', lineHeight: 1.6 }}>{vt('stepupBody', lang)}</div>
      <CodeField value={code} onChange={setCode} label={vt('codeLabel', lang)} autoFocus />
      {error && <Err text={error} />}
      <button type="submit" disabled={!codeComplete(code) || busy} style={{ ...primaryBtn, minHeight: isMobile ? 44 : undefined }}>{vt('codeConfirm', lang)}</button>
    </form>
  )
}

function AutoLockRow({ view, lang, isMobile, gate, tipText, btn, onSave }: {
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
function HardeningBlock({ view, lang }: { view: VaultView; lang: 'en' | 'pt' }) {
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

function GateDialog({ lang, view, isMobile, kind, minutes, onCancel, onDone }: {
  lang: 'en' | 'pt'; view: VaultView; isMobile: boolean; kind: 'lock' | 'autolock' | 'presence-off'; minutes?: number
  onCancel: () => void; onDone: () => void
}) {
  const action = kind === 'lock' ? 'lock' : kind === 'autolock' ? 'set-auto-lock' : 'disable-presence'
  const gate = gateFor(view, action)
  const wantsCode = needsTypedCode(gate, grantAlive())
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const title = kind === 'lock' ? vt('lockNow', lang) : kind === 'autolock' ? vt('sec_autolock', lang) : vt('pres_offConfirm', lang)
  const submit = async () => {
    if (busy || (wantsCode && !codeComplete(code))) return
    setBusy(true); setError(null)
    const c = wantsCode ? code : undefined
    const r = kind === 'lock' ? await lockNow(c) : kind === 'autolock' ? await setAutoLock(minutes ?? 30, c) : await presenceDisable(c)
    setBusy(false)
    if (r.ok) { onDone(); return }
    setError(r.sentence || vt('network', lang)); setCode('')
  }
  useEscape(onCancel)
  return (
    <div style={overlay} role="dialog" aria-modal="true" aria-label={title} onClick={onCancel}>
      <form onClick={e => e.stopPropagation()} onSubmit={e => { e.preventDefault(); void submit() }} style={card}>
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6 }}>{title}</div>
        {kind === 'presence-off' && <Note tone="warn">{vt('pres_offConsequence', lang)}</Note>}
        {wantsCode && <CodeField value={code} onChange={setCode} label={vt('gate_dialog_code', lang)} autoFocus />}
        {gate.gesture && <Note>{vtf('gate_dialog_presence', lang, { presence: vt(presenceKey(view.wrappers), lang) })}</Note>}
        {error && <Err text={error} />}
        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
          <button type="button" onClick={onCancel} style={{ ...primaryBtn, color: 'var(--text-secondary)', borderColor: 'var(--border)', background: 'transparent', minHeight: isMobile ? 44 : undefined }}>{vt('cancel', lang)}</button>
          <button type="submit" disabled={busy || (wantsCode && !codeComplete(code))} style={{ ...(kind === 'presence-off' ? dangerBtn : primaryBtn), minHeight: isMobile ? 44 : undefined }}>
            {busy ? vt('working', lang) : vt('gate_continue', lang)}
          </button>
        </div>
      </form>
    </div>
  )
}

function useEscape(onEsc: () => void) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onEsc() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onEsc])
}

// ── the enrolment wizard (§7.3): authenticator → recovery key → presence ─────────────────────────

type Phase = 'intro' | 'qr' | 'words' | 'confirm' | 'presence' | 'done'

function EnrolWizard({ lang, isMobile, initial, steps, onClose }: {
  lang: 'en' | 'pt'; isMobile: boolean; initial: VaultView; steps: WizardStep[]; onClose: () => void
}) {
  // The whole §7.3 flow: device check → authenticator → recovery key → presence (each only if still missing).
  const [plan] = useState<WizardPhaseStep[]>(() => wizardPlan(steps))
  const t = (k: VaultKey) => vt(k, lang)
  const [view, setView] = useState(initial)
  const [i, setI] = useState(0)
  const step = plan[i]
  const [flowOk, setFlowOk] = useState(false) // the one verified code stands for the rest of THIS wizard
  const [phase, setPhase] = useState<Phase>('intro')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [oldCode, setOldCode] = useState('')
  const [uri, setUri] = useState<{ uri: string; secret: string } | null>(null)
  const [c1, setC1] = useState('')
  // The 24 words live in this state for exactly as long as they are on screen, and are dropped the
  // moment the person confirms or leaves — never persisted, never copied anywhere by this page.
  const [words, setWords] = useState<string[] | null>(null)
  const [positions, setPositions] = useState<number[]>([])
  const [typed, setTyped] = useState<string[]>(['', '', ''])
  const [kind, setKind] = useState<'hello' | 'fido2'>(initial.presenceAvailable.includes('hello') ? 'hello' : 'fido2')
  const [presCode, setPresCode] = useState('')
  // Review S2: the server answers `setup-code-required` for a page's FIRST enrolment; the code comes
  // from this machine's terminal (`agentop vault setup-code`). `askCode`: a first recovery key outside
  // this session's wizard needs the authenticator code.
  const [needSetup, setNeedSetup] = useState(false)
  const [setupCode, setSetupCode] = useState('')
  const [askCode, setAskCode] = useState(false)
  const [finished, setFinished] = useState(false)

  useEffect(() => () => { setWords(null) }, [])
  useEscape(() => { if (!busy) onClose() })

  const refresh = async (): Promise<VaultView> => {
    const r = await loadVault()
    const v = r.kind === 'view' || r.kind === 'needs-stepup' ? r.view : view
    setView(v)
    return v
  }
  const next = async () => {
    await refresh()
    setError(null); setOldCode(''); setC1(''); setPresCode(''); setUri(null); setWords(null); setTyped(['', '', ''])
    if (i + 1 < plan.length) { setI(i + 1); setPhase('intro') } else { setFinished(true); setPhase('done') }
  }
  // A failure names the step it stopped at; reopening the wizard resumes from what is still missing.
  const fail = (s: string) => { setError(`${vtf('wiz_failedAt', lang, { step: t(`wiz_step_${step ?? 'presence'}` as VaultKey) })} ${s || t('network')}`); setBusy(false) }

  const gateOf = (action: string) => gateFor(view, action)
  const needCodeFor = (action: string) => needsTypedCode({ ...gateOf(action), grant: false }, false)
  const stepNo = Math.min(i + 1, plan.length)
  const presenceCodeNeeded = needCodeFor('enroll-presence') && !flowOk

  // ── authenticator
  const showQr = async () => {
    if (busy) return
    setBusy(true); setError(null)
    const r = await authenticatorBegin(needCodeFor('enroll-authenticator') ? oldCode : undefined, needSetup ? setupCode : undefined)
    setBusy(false)
    if (!r.ok) {
      if (r.code === 'setup-code-required') { setNeedSetup(true); setSetupCode('') }
      return fail(r.sentence)
    }
    setNeedSetup(false); setSetupCode('')
    setUri({ uri: r.uri, secret: r.secret }); setPhase('qr')
  }
  const confirmAuth = async () => {
    if (busy || !codeComplete(c1)) return
    setBusy(true); setError(null)
    const r = await authenticatorConfirm(c1)
    if (!r.ok) { setC1(''); return fail(r.sentence) }
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
      return fail(r.sentence)
    }
    setNeedSetup(false); setSetupCode(''); setAskCode(false)
    setWords(r.words); setPositions(r.positions); setTyped(['', '', '']); setPhase('words')
  }
  const confirmWords = async () => {
    if (busy || typed.some(w => w.trim() === '')) return
    setBusy(true); setError(null)
    const r = await recoveryConfirm(typed.map(w => w.trim().toLowerCase()))
    if (!r.ok) { setTyped(['', '', '']); return fail(r.sentence) }
    setBusy(false); setWords(null)
    await next()
  }

  // ── device check (before anything changes)
  const probe = async () => {
    if (busy) return
    setBusy(true); setError(null)
    const r = await presenceProbe(kind)
    if (!r.ok) return fail(r.sentence)
    setBusy(false)
    await next()
  }

  // ── presence
  const enrolPresence = async () => {
    if (busy) return
    setBusy(true); setError(null)
    const r = await presenceEnrol(kind, presenceCodeNeeded ? presCode : undefined)
    if (!r.ok) { setPresCode(''); return fail(r.sentence) }
    setBusy(false)
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
    <div style={overlay} role="dialog" aria-modal="true" aria-label={t('wiz_title')}>
      <div className="ag-vault-wizard" style={{ ...card, maxWidth: 460, maxHeight: '92vh', overflowY: 'auto', boxSizing: 'border-box' }}>
        <style>{PRINT_CSS}</style>
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>{t('wiz_title')}</div>
        {prog && <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', margin: '2px 0 10px' }}>{vtf('wiz_step', lang, { i: stepNo, n: plan.length })}</div>}
        {phase !== 'done' && <Note>{t('wiz_safe')}</Note>}

        {phase === 'intro' && step === 'probe' && (
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{t('wiz_probe_title')}</div>
            <Note>{vtf('wiz_probe_intro', lang, { presence: vt(presenceKey([kind]), lang) })}</Note>
            <Note>{t(kind === 'hello' ? 'wiz_pres_checkHello' : 'wiz_pres_checkKey')}</Note>
            {error && <Err text={error} />}
            <button type="button" style={cta} disabled={busy} onClick={() => { void probe() }}>{busy ? t('unlocking') : t('wiz_probe_go')}</button>
          </div>
        )}
        {phase === 'intro' && step === 'authenticator' && (
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{t('wiz_auth_title')}</div>
            <Note>{t('wiz_auth_intro')}</Note>
            {needCodeFor('enroll-authenticator') && <CodeField value={oldCode} onChange={setOldCode} label={t('wiz_oldCode')} autoFocus />}
            {needSetup && <SetupCodeField value={setupCode} onChange={setSetupCode} label={t('wiz_setup_label')} why={t('wiz_setup_why')} />}
            {error && <Err text={error} />}
            <button type="button" style={cta} disabled={busy || (needCodeFor('enroll-authenticator') && !codeComplete(oldCode)) || (needSetup && !setupCodeComplete(setupCode))} onClick={() => { void showQr() }}>{busy ? t('working') : t('wiz_auth_show')}</button>
          </div>
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
            {error && <Err text={error} />}
            <button type="submit" style={cta} disabled={busy || !codeComplete(c1)}>{busy ? t('working') : t('codeConfirm')}</button>
          </form>
        )}

        {phase === 'intro' && step === 'recovery' && (
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{t('wiz_rec_title')}</div>
            <Note>{t('wiz_rec_intro')}</Note>
            {rotating && <Note tone="warn">{t('wiz_rec_rotate')}</Note>}
            {((rotating && needCodeFor('rotate-recovery')) || askCode) && <CodeField value={oldCode} onChange={setOldCode} label={t('wiz_oldCode')} autoFocus />}
            {needSetup && <SetupCodeField value={setupCode} onChange={setSetupCode} label={t('wiz_setup_label')} why={t('wiz_setup_why')} />}
            {rotating && gateOf('rotate-recovery').gesture && <Note>{vtf('gate_dialog_presence', lang, { presence: vt(presenceKey(view.wrappers), lang) })}</Note>}
            {error && <Err text={error} />}
            <button type="button" style={cta} disabled={busy || (((rotating && needCodeFor('rotate-recovery')) || askCode) && !codeComplete(oldCode)) || (needSetup && !setupCodeComplete(setupCode))} onClick={() => { void showWords() }}>{busy ? t('working') : t('wiz_rec_show')}</button>
          </div>
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
            {error && <Err text={error} />}
            <button type="submit" style={cta} disabled={busy || typed.some(w => w.trim() === '')}>{busy ? t('working') : t('codeConfirm')}</button>
          </form>
        )}

        {phase === 'intro' && step === 'presence' && (
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{t('wiz_pres_title')}</div>
            <Note>{t('wiz_pres_intro')}</Note>
            {view.presenceAvailable.length > 1 && (
              <div role="radiogroup" style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
                {(['hello', 'fido2'] as const).filter(k => view.presenceAvailable.includes(k)).map(k => (
                  <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)}
                    style={{ ...primaryBtn, width: 'auto', minHeight: isMobile ? 44 : undefined, ...(kind === k ? null : { color: 'var(--text-secondary)', borderColor: 'var(--border)', background: 'transparent' }) }}>
                    {t(k === 'hello' ? 'presenceName_hello' : 'presenceName_fido2')}
                  </button>
                ))}
              </div>
            )}
            <Note>{t(kind === 'hello' ? 'wiz_pres_checkHello' : 'wiz_pres_checkKey')}</Note>
            {presenceCodeNeeded && <CodeField value={presCode} onChange={setPresCode} label={t('wiz_oldCode')} autoFocus />}
            {error && <Err text={error} />}
            <button type="button" style={cta} disabled={busy || (presenceCodeNeeded && !codeComplete(presCode))} onClick={() => { void enrolPresence() }}>
              {busy ? t('unlocking') : t('wiz_pres_go')}
            </button>
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

/** Print only the words (and their warning) — everything else on the page is hidden for the print dialog. */
const PRINT_CSS = `@media print {
  body * { visibility: hidden !important; }
  .ag-vault-print, .ag-vault-print * { visibility: visible !important; }
  .ag-vault-print { position: fixed; inset: 24px; border: none !important; }
  .ag-vault-print-title, .ag-vault-print-warn { display: block !important; margin: 8px 0; font-size: 14px; }
}`

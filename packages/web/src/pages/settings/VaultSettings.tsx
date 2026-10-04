/**
 * Settings → Vault (SECRETS.4 §7.1). What is sealed on this machine and in what state — METADATA ONLY —
 * plus the vault's own controls: unlock (a gesture, then a code), the authenticator, presence, the
 * recovery key, auto-lock, and the hardening report.
 *
 * Nothing here decides what an action asks. The server sends its §2.4 table (`gates`), every route
 * enforces it again, and this screen only draws it (🔑 code, 👆 presence) and asks for the code BEFORE
 * the request where it knows one is owed. There is deliberately no "show secret" anywhere and no copy
 * button on the 24 words. v2.98.1: the 24 words ARE accepted here for a recovery, but only from a page
 * opened on this computer (loopback — the server checks it on every request), and nothing on this page
 * ever tells a person to run a command: a refusal carries an `action` and the page draws its button.
 */
import { useCallback, useEffect, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { FingerprintPattern, KeyRound, List, Loader2, Lock, LockOpen, Printer, ShieldCheck, Smartphone, Timer, Vault } from 'lucide-react'
import type { AppContext } from '../../lib/app-context'
import { useIsMobile } from '../../hooks/useIsMobile'
import { SectionHeader, Divider, PrefRow, StatusDot } from './primitives'
import { Err, Qr, card, codeBlock, dangerBtn, input, overlay, primaryBtn } from '../../components/MfaSetup'
import { CodeField, VaultUnlock } from '../../components/vault/VaultUnlock'
import { itemStateKey, kindKey, orderItems, presenceKey, reasonKey, stateKey, vt, vtf, type VaultKey } from '../../lib/vaultText'
import {
  authenticatorBegin, authenticatorConfirm, gestureStep, presenceProgress, cleanCode, cleanSetupCode, setupCodeAccept, setupCodeComplete, clampAutoLock, codeComplete, credentials, gateFor, grantAlive, heartbeat,
  loadVault, lockNow, howStep2, parseUnlockHours, setUnlockPolicy, UNLOCK_MODES, type UnlockMode, minutesLeft, missingSteps, needsTypedCode, parseAutoLockInput, presenceDisable, presenceEnrol, recoveryBegin,
  recoveryConfirm, remainingMs, setAutoLock, stepUp, unlockCode, unlockGesture, wordRows, AUTO_LOCK_MAX, AUTO_LOCK_MIN,
  askWords, howConfirms, howNow, presenceProbe, primarySection, sectionBadge, wizardPlan,
  addableKinds, localProof, recoverWithWords, recoverySteps, splitWords,
  type BadgeKey, type SectionId, type Tone, type UiAction,
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
  // v2.98.1: "add another way" opens the wizard on ONE kind (never re-running one already enrolled).
  const [wizardKind, setWizardKind] = useState<'hello' | 'fido2' | null>(null)
  const [recoverOpen, setRecoverOpen] = useState(false)
  const [dialog, setDialog] = useState<null | { kind: GateKind; minutes?: number; policy?: { mode: UnlockMode; hours: number } }>(null)
  const [dismissed, setDismissed] = useState(() => { try { return localStorage.getItem(UPGRADE_DISMISS_KEY) === '1' } catch { return false } })
  const busyUi = wizard !== null || dialog !== null || recoverOpen

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
  const primary = primarySection(steps, showBanner)
  const styleFor = (id: WizardStep): React.CSSProperties => (primary === id ? hot : btn)
  const dismiss = () => { setDismissed(true); try { localStorage.setItem(UPGRADE_DISMISS_KEY, '1') } catch { /* a convenience only */ } }

  const items = orderItems(res.kind === 'view' ? view.items : [])
  const pending = items.filter(i => i.state === 'pending')
  const counts = { sealed: res.kind === 'view' ? view.items.filter(i => i.state === 'sealed').length : 0, pending: pending.length }
  const badgeOf = (id: SectionId): { tone: Tone; text: string } => {
    const b = sectionBadge(view, id, counts)
    const n = id === 'autolock' ? view.autoLockMinutes : id === 'secrets' ? (b.key === 'badge_pending' ? counts.pending : counts.sealed) : 0
    return { tone: b.tone, text: vtf(b.key as BadgeKey, lang, { n }) }
  }

  // An action's proofs: the icons say what it asks; a dialog collects the code (and warns about the gesture).
  const ask = (kind: GateKind, minutes?: number, policy?: { mode: UnlockMode; hours: number }) => {
    const action = gateActionOf(kind)
    if (kind === 'unlock-policy') { setDialog({ kind, policy }); return } // always the code AND the gesture
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

  /** v2.98.1: the page control a refusal points at — the server never sends a command to a page. */
  const onAction = (a: UiAction) => {
    setDialog(null)
    if (a === 'recover') { setWizard(null); setRecoverOpen(true) }
    else if (a === 'enroll') setWizard(view.recoveryTodo ? recoverySteps(view.recoveryTodo) : steps.length > 0 ? steps : null)
    else if (a === 'disable-presence') setDialog({ kind: 'presence-off' })
    else { setWizard(null); window.scrollTo({ top: 0, behavior: 'smooth' }) }
  }
  const canRecover = view.loopback === true && Boolean(view.recoveryCreatedAt)

  return (
    <>
      <SectionHeader label={t('title')} />
      {locked ? (
        // THE HERO: the empty state of a locked vault is the vault itself, with the one way in under it.
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 10, padding: isMobile ? '18px 4px 20px' : '26px 12px 28px', border: '1px solid var(--border)', borderRadius: 14, marginBottom: 18, background: 'var(--bg-surface, transparent)' }}>
          <span aria-hidden style={{ width: 88, height: 88, borderRadius: '50%', display: 'grid', placeItems: 'center', background: 'var(--anthropic-orange-dim)', color: 'var(--anthropic-orange)' }}>
            <Vault size={46} strokeWidth={1.6} />
          </span>
          <strong style={{ fontSize: 17 }}>{t('hero_locked')}</strong>
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6, maxWidth: 440 }}>
            {view.authenticator
              ? (view.presence ? vtf('lockedIntro_presence', lang, { presence: presWord }) : t('lockedIntro_code'))
              : t('intro')}
          </div>
          <div style={{ width: isMobile ? '100%' : undefined, marginTop: 4 }}>
            {/* §10: the same unlock every screen mounts — Hello here, the phone's own ways off this computer. */}
            <VaultUnlock lang={lang} onOpened={() => { void load() }} btn={hot} isMobile={isMobile} center onAction={onAction} />
          </div>
          {canRecover && (
            <button type="button" style={{ ...btn, background: 'transparent' }} onClick={() => setRecoverOpen(true)}>
              <KeyRound size={14} /> {t('rec_recover')}
            </button>
          )}
          {view.sentence && <div role="status" style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.6, maxWidth: 440 }}>{view.sentence}</div>}
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
              <span aria-hidden style={{ width: 34, height: 34, borderRadius: 10, display: 'grid', placeItems: 'center', flexShrink: 0, color: open ? TONE.sealed : TONE.unreadable, background: `color-mix(in srgb, ${open ? TONE.sealed : TONE.unreadable} 14%, transparent)` }}>
                {open ? <LockOpen size={18} /> : <Lock size={18} />}
              </span>
              <strong style={{ fontSize: 15 }}>{open && left !== null ? vtf('openLocksIn', lang, { n: minutesLeft(left) }) : t(stateKey(view.state))}</strong>
            </div>
            {open && (
              <button type="button" style={btn} onClick={() => ask('lock')} disabled={!view.canLock} title={tip('lock')} aria-label={`${t('lockNow')}. ${tip('lock')}`}>
                {t('lockNow')} <Gate code={g('lock').code} gesture={g('lock').gesture} lang={lang} />
              </button>
            )}
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 14 }}>{t('intro')}</div>
          {view.sentence && view.state !== 'open' && (
            <div role="status" style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 14 }}>{view.sentence}</div>
          )}
          {/* Owner 2026-10-03: while the vault is open there is ONE vault component. The unlock's code
              already grants the list; when it still owes a code (an unlock that asked none), the field
              lives here, under the state line — never as a second card. */}
          {res.kind === 'needs-stepup' && open && (
            <StepUpInline lang={lang} sentence={res.sentence} code={res.code} isMobile={isMobile} onDone={() => { void load() }} />
          )}
        </>
      )}

      <HowStrip view={view} lang={lang} isMobile={isMobile} minutes={view.autoLockMinutes} presWord={presWord} />

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

      {res.kind === 'view' && open && (
        <>
          <Sec icon={open ? LockOpen : Lock} title={t('sec_status')} desc={t('sec_status_d')} badge={{ tone: 'ok', text: t('state_open') }}>
            <PrefRow label={t('protector')}><span style={{ fontSize: 13, textAlign: 'right', minWidth: 0 }}>{view.protectorLabel ?? t('none')}</span></PrefRow>
            <PrefRow label={t('keyId')}><span style={mono}>{view.kid ?? t('none')}</span></PrefRow>
            <PrefRow label={t('created')}><span style={{ fontSize: 13 }}>{view.createdAt ? fmt(view.createdAt) : t('none')}</span></PrefRow>
          </Sec>

          <Sec icon={Smartphone} title={t('sec_authenticator')} desc={t('auth_explain')} badge={badgeOf('authenticator')}>
            {view.authenticator ? (
              <>
                <PrefRow label={vtf('auth_ready', lang, { date: fmt(view.authenticator.enrolledAt) })}
                  sub={`${t('auth_lastUsed')}: ${view.authenticator.lastUsedAt ? fmt(view.authenticator.lastUsedAt) : t('auth_never')}`}>
                  <button type="button" style={btn} onClick={() => setWizard(['authenticator'])} title={tip('enroll-authenticator')} aria-label={`${t('auth_replace')}. ${tip('enroll-authenticator')}`}>
                    {t('auth_replace')} <Gate code={g('enroll-authenticator').code} gesture={g('enroll-authenticator').gesture} lang={lang} />
                  </button>
                </PrefRow>
                {view.authenticator.pausedUntil && <Note tone="warn">{vtf('auth_paused', lang, { date: fmt(view.authenticator.pausedUntil) })}</Note>}
                {view.authenticator.frozen && <Note tone="bad">{t('auth_frozen')}</Note>}
              </>
            ) : (
              <PrefRow label={t('auth_none')}>
                <button type="button" style={styleFor('authenticator')} onClick={() => startSetup('authenticator')} title={t('ultraBody')}>{t('auth_setup')}</button>
              </PrefRow>
            )}
          </Sec>

          <Sec icon={FingerprintPattern} title={t('sec_presence')} desc={t('sec_presence_d')} badge={badgeOf('presence')}>
            {view.presence ? (
              <>
                {(creds?.credentials ?? []).map(c => (
                  <PrefRow key={`${c.type}-${c.createdAt}`} label={c.label} sub={vtf('pres_since', lang, { date: fmt(c.createdAt) })}><span /></PrefRow>
                ))}
                {!creds && <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 10 }}>{presWord}</div>}
                {/* v2.98.1: only kinds that are offered here AND not already on — never Hello a second time. */}
                {(addableKinds(view).length > 0 || soonKinds(view).length > 0) && (
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', margin: '4px 0 6px' }}>{t('pres_addOther')}</div>
                )}
                {addableKinds(view).map(k => {
                  const label = t(k === 'hello' ? 'pres_add_hello' : 'pres_add_fido2')
                  return (
                    <PrefRow key={k} label={label}>
                      <button type="button" style={btn} onClick={() => { setWizardKind(k); setWizard(['presence']) }} title={tip('enroll-presence')} aria-label={`${label}. ${tip('enroll-presence')}`}>
                        {label} <Gate code={g('enroll-presence').code} gesture={g('enroll-presence').gesture} lang={lang} />
                      </button>
                    </PrefRow>
                  )
                })}
                {soonKinds(view).map(k => <SoonRow key={k} lang={lang} btn={btn} />)}
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
              <>
                <Note>{t('pres_unavailable')}</Note>
                {soonKinds(view).map(k => <SoonRow key={k} lang={lang} btn={btn} />)}
              </>
            ) : (
              <>
                <Note>{t('pres_off')}</Note>
                <button type="button" style={styleFor('presence')} onClick={() => startSetup('presence')} title={t('ultraBody')}>{t(view.presenceAvailable.includes('hello') ? 'pres_turnOn' : 'pres_turnOnKey')}</button>
                {soonKinds(view).map(k => <SoonRow key={k} lang={lang} btn={btn} />)}
              </>
            )}
          </Sec>

          <Sec icon={KeyRound} title={t('sec_recovery')} desc={t('sec_recovery_d')} badge={badgeOf('recovery')}>
            <Note tone="warn">{t('rec_offline')}</Note>
            <PrefRow label={view.recoveryCreatedAt ? vtf('rec_created', lang, { date: fmt(view.recoveryCreatedAt) }) : t('rec_none')}>
              <button type="button" style={view.recoveryCreatedAt ? btn : styleFor('recovery')} title={view.recoveryCreatedAt ? tip('rotate-recovery') : t('ultraBody')}
                onClick={() => (view.recoveryCreatedAt ? setWizard(['recovery']) : startSetup('recovery'))}>
                {view.recoveryCreatedAt ? t('rec_new') : t('rec_create')} <Gate code={g('rotate-recovery').code && Boolean(view.recoveryCreatedAt)} gesture={g('rotate-recovery').gesture && Boolean(view.recoveryCreatedAt)} lang={lang} />
              </button>
            </PrefRow>
            <Note>{t('rec_lost')}</Note>
            {canRecover && (
              <button type="button" style={{ ...btn, marginBottom: 12 }} onClick={() => setRecoverOpen(true)}><KeyRound size={14} /> {t('rec_recover')}</button>
            )}
          </Sec>

          <Sec icon={Timer} title={t('sec_autolock')} desc={t('sec_autolock_d')} badge={badgeOf('autolock')}>
            <AutoLockRow view={view} lang={lang} isMobile={isMobile} gate={g('set-auto-lock')} tipText={tip('set-auto-lock')} btn={btn} onSave={m => ask('autolock', m)} />
          </Sec>

          {view.presence && view.authenticator && (
            <Sec icon={FingerprintPattern} title={t('sec_unlock')} desc={vtf('sec_unlock_d', lang, { presence: presWordOf(view, lang) })} badge={{ tone: 'ok', text: vt(unlockModeKey(view.unlockPolicy?.mode ?? 'daily'), lang).replace('{presence}', presWordOf(view, lang)) }}>
              <UnlockPolicyRow view={view} lang={lang} isMobile={isMobile} gate={g('set-unlock-policy')} btn={btn} onSave={p => ask('unlock-policy', undefined, p)} />
            </Sec>
          )}

          <Sec icon={ShieldCheck} title={t('sec_hardening')} desc={t('sec_memory_d')} badge={badgeOf('memory')}>
            <HardeningBlock view={view} lang={lang} />
          </Sec>
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
        <Sec icon={List} title={t('secretsHeader')} desc={t('sec_secrets_d')} badge={badgeOf('secrets')} last>
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
        </Sec>
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
          lang={lang} view={view} isMobile={isMobile} kind={dialog.kind} minutes={dialog.minutes} policy={dialog.policy}
          onCancel={() => setDialog(null)} onDone={() => { setDialog(null); void load() }} onAction={onAction}
        />
      )}
      {wizard && (
        <EnrolWizard
          lang={lang} isMobile={isMobile} initial={view} steps={wizard} fixedKind={wizardKind}
          onClose={() => { setWizard(null); setWizardKind(null); void load() }} onAction={onAction}
        />
      )}
      {recoverOpen && (
        <RecoverDialog
          lang={lang} isMobile={isMobile} loopback={view.loopback === true}
          onCancel={() => { setRecoverOpen(false); void load() }}
          onRecovered={todo => { setRecoverOpen(false); void load().then(() => { const st = recoverySteps(todo); if (st.length) setWizard(st) }) }}
        />
      )}
    </>
  )
}

// ── VAULT.UX2: the header strip, and a section that says what it is ─────────────────────────────

const TONE_COLOR: Record<Tone, string> = {
  ok: 'var(--accent-green, #22c55e)', warn: 'var(--accent-orange, #f59e0b)', rec: 'var(--anthropic-orange, #f59e0b)', off: 'var(--text-tertiary)',
}
const TONE_DOT: Record<Tone, 'ok' | 'warn' | 'error' | 'unknown'> = { ok: 'ok', warn: 'warn', rec: 'warn', off: 'unknown' }

/** The state a section is in, as a badge — a dot AND a glyph in the words, so colour is never the only cue. */
function Badge({ tone, text }: { tone: Tone; text: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, fontWeight: 700, color: TONE_COLOR[tone], whiteSpace: 'nowrap' }}>
      <StatusDot state={TONE_DOT[tone]} size={7} />{text}
    </span>
  )
}

/** One section of the page: an icon, the title, ONE line on what it is and why it matters, and its badge. */
function Sec({ icon: Icon, title, desc, badge, children, last }: {
  icon: React.ComponentType<{ size?: number }>; title: string; desc: string; badge: { tone: Tone; text: string }; children: React.ReactNode; last?: boolean
}) {
  return (
    <section style={{ marginBottom: last ? 0 : 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
          <span aria-hidden style={{ width: 28, height: 28, borderRadius: 8, display: 'grid', placeItems: 'center', flexShrink: 0, color: 'var(--anthropic-orange)', background: 'var(--anthropic-orange-dim)' }}>
            <Icon size={15} />
          </span>
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', letterSpacing: '0.07em', textTransform: 'uppercase' }}>{title}</span>
        </div>
        <Badge tone={badge.tone} text={badge.text} />
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.55, margin: '6px 0 14px' }}>{desc}</div>
      {children}
      {!last && <Divider />}
    </section>
  )
}

/** "How your vault works": locked → you confirm → open for N min, with where you are now lit up. */
function HowStrip({ view, lang, isMobile, minutes, presWord }: { view: VaultView; lang: 'en' | 'pt'; isMobile: boolean; minutes: number; presWord: string }) {
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
function Gate({ code, gesture, lang }: { code: boolean; gesture: boolean; lang: 'en' | 'pt' }) {
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
const soonKinds = (v: VaultView): string[] => (v.presenceSoon ?? []).filter(k => !v.wrappers.includes(k))

/** "Coming soon": shown, disabled, with ONE plain line — never offered and then failing. */
function SoonRow({ lang, btn }: { lang: 'en' | 'pt'; btn: React.CSSProperties }) {
  return (
    <PrefRow label={vt('pres_add_fido2', lang)} sub={vt('pres_soon_fido2', lang)}>
      <button type="button" style={{ ...btn, opacity: 0.55, cursor: 'not-allowed' }} disabled aria-disabled>{vt('pres_soon', lang)}</button>
    </PrefRow>
  )
}

/** A refusal, and — when the server pointed at a page control — the button for it (v2.98.1). */
function ActionErr({ text, action, lang, onAction }: { text: string; action?: UiAction | null; lang: 'en' | 'pt'; onAction?: (a: UiAction) => void }) {
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

function Note({ children, tone }: { children: React.ReactNode; tone?: 'warn' | 'bad' }) {
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

/** The open vault asks for a code before it lists anything (§2.4 `list`) — inline, inside the top component. */
function StepUpInline({ lang, sentence, code: why, isMobile, onDone }: { lang: 'en' | 'pt'; sentence: string; code: string; isMobile: boolean; onDone: () => void }) {
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
    <form onSubmit={e => { e.preventDefault(); void submit() }} aria-label={vt('stepupTitle', lang)} data-vault-stepup-inline style={{ marginBottom: 18, maxWidth: 420 }}>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '0 0 10px', lineHeight: 1.6 }}>{vt('stepupBody', lang)}</div>
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

type GateKind = 'lock' | 'autolock' | 'presence-off' | 'unlock-policy'
const gateActionOf = (k: GateKind): string => k === 'lock' ? 'lock' : k === 'autolock' ? 'set-auto-lock' : k === 'unlock-policy' ? 'set-unlock-policy' : 'disable-presence'
const presWordOf = (v: VaultView, lang: 'en' | 'pt') => vt(presenceKey(v.wrappers), lang)
const unlockModeKey = (m: UnlockMode): VaultKey => m === 'always' ? 'unlock_always' : m === 'hello-only' ? 'unlock_helloOnly' : 'unlock_daily'

/** Owner decision 2026-10-02: the three unlock modes, the per-day window's hours, and what the NEXT unlock asks. */
function UnlockPolicyRow({ view, lang, isMobile, gate, btn, onSave }: {
  view: VaultView; lang: 'en' | 'pt'; isMobile: boolean; gate: { code: boolean; gesture: boolean }; btn: React.CSSProperties
  onSave: (p: { mode: UnlockMode; hours: number }) => void
}) {
  const cur = view.unlockPolicy ?? { mode: 'daily' as const, hours: 12, chosen: false, codeNextUnlock: true, windowEndsAt: null }
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

function GateDialog({ lang, view, isMobile, kind, minutes, policy, onCancel, onDone, onAction }: {
  lang: 'en' | 'pt'; view: VaultView; isMobile: boolean; kind: GateKind; minutes?: number; policy?: { mode: UnlockMode; hours: number }
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
  const title = kind === 'lock' ? vt('lockNow', lang) : kind === 'autolock' ? vt('sec_autolock', lang) : kind === 'unlock-policy' ? vt('sec_unlock', lang) : vt('pres_offConfirm', lang)
  const submit = async () => {
    if (busy || (wantsCode && !codeComplete(code))) return
    setBusy(true); setError(null)
    const c = wantsCode ? code : undefined
    const w = wantsWords ? splitWords(words).join(' ') : undefined
    const r = kind === 'lock' ? await lockNow(c) : kind === 'autolock' ? await setAutoLock(minutes ?? 30, c)
      : kind === 'unlock-policy' ? await setUnlockPolicy(policy?.mode ?? 'daily', policy?.hours ?? 12, c) : await presenceDisable(c, w)
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
        {wantsCode && <CodeField value={code} onChange={setCode} label={vt('gate_dialog_code', lang)} autoFocus />}
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

function useEscape(onEsc: () => void) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onEsc() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onEsc])
}

// ── the enrolment wizard (§7.3): [setup code] → [device check] → authenticator → presence → recovery key ─────────────────────────

type Phase = 'intro' | 'qr' | 'words' | 'confirm' | 'presence' | 'done'

function EnrolWizard({ lang, isMobile, initial, steps, onClose, fixedKind, onAction }: {
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
      <Loader2 size={14} className="ag-spin" /> {vtf('wiz_gesture_progress', lang, { i: gestureNow.i, n: gestureNow.n })}
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
function RecoverDialog({ lang, isMobile, loopback, onCancel, onRecovered }: {
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

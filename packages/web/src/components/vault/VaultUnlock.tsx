/**
 * VaultUnlock — the ONE way any screen opens a locked vault (VAULT.PERSONAL §10).
 *
 * Settings → Vault, the personal vault page, the `:vault` chip, Providers, backup and the native chat
 * all mount this, so the flow is the same everywhere and nobody is sent "go to the Vault" first.
 *
 * What it offers is the shared table (`@agentistics/core` `unlockOffers`, via `offersHere`), never a
 * guess: ON this computer, Windows Hello (the service raises it) and then the code when the policy
 * asks; from any OTHER device, never Hello — the phone's biometrics (a passkey with PRF, over https)
 * plus the code, or the code alone on a phone the computer approved, when the owner turned that on.
 * A phone with no way in yet is told how to get one, in a sentence.
 *
 * Also here: `PhoneEnrol` (on the phone, vault open: ask to be registered, then finish after the
 * computer approves) and `PhoneRequests` (on the computer: the pending requests, approve with Hello).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type React from 'react'
import { Fingerprint, Loader2, Lock, Smartphone } from 'lucide-react'
import { Err, input, primaryBtn } from '../MfaSetup'
import { cleanCode, codeComplete, loadVault, unlockCode, unlockGesture, type UiAction, type VaultView } from '../../lib/vaultApi'
import { vt, type VaultKey } from '../../lib/vaultText'
import { PHONE_APPROVE_POLL_MS, PHONE_APPROVE_WAIT_MS, helloFallback } from '../../lib/helloFallback'
import {
  decidePhoneRequest, enrolDevice, enrolPasskey, enrolStatus, offersHere, phoneFacts, phoneRequests, readDeviceKey, requestEnrol,
  unlockWithDevice, unlockWithPasskey, type PhoneFacts, type PhoneRequest,
} from '../../lib/phoneVault'

type Lang = 'en' | 'pt'

const TEXT = {
  phoneLocked: { en: 'The vault is locked.', pt: 'O cofre está trancado.' },
  phoneBio: { en: 'Open with biometrics', pt: 'Abrir com a digital' },
  phoneCodeOnly: { en: 'Open with the code', pt: 'Abrir com o código' },
  phoneBioHint: { en: 'Type the code from your authenticator app, then confirm with this phone\'s fingerprint, face or PIN.', pt: 'Digite o código do seu app autenticador e confirme com a digital, o rosto ou o PIN deste celular.' },
  phoneCodeHint: { en: 'This phone was approved on the computer: the code from your authenticator app opens the vault.', pt: 'Este celular foi aprovado no computador: o código do seu app autenticador abre o cofre.' },
  phoneEnrolLocked: { en: 'This phone cannot open the vault yet. Open the vault once on the computer, then register this phone on the Vault page here on the phone — it asks your code here and an approval on the computer.', pt: 'Este celular ainda não abre o cofre. Abra o cofre uma vez no computador e registre este celular na página Cofre, aqui no celular — pede o seu código aqui e uma aprovação no computador.' },
  phoneHttps: { en: 'Biometrics need a secure address: turn on HTTPS certificates in your Tailscale admin and open Agentistics by the machine\'s https name.', pt: 'A digital precisa de um endereço seguro: ligue os certificados HTTPS no painel do Tailscale e abra o Agentistics pelo nome https da máquina.' },
  phoneStale: { en: 'The vault changed its key since this phone was approved. Approve it again on the computer.', pt: 'O cofre trocou de chave desde que este celular foi aprovado. Aprove-o de novo no computador.' },
  codeLabel: { en: 'Authenticator code', pt: 'Código do autenticador' },
  network: { en: 'Could not reach the server.', pt: 'Não deu para falar com o servidor.' },
  working: { en: 'Confirm on this phone…', pt: 'Confirme neste celular…' },
  // enrol (phone)
  enrolTitle: { en: 'Let this phone open the vault', pt: 'Deixar este celular abrir o cofre' },
  enrolWhy: { en: 'Asks your code here, then an approval with Windows Hello on the computer — so a code alone cannot register a phone.', pt: 'Pede o seu código aqui e depois uma aprovação com o Windows Hello no computador — assim um código sozinho não registra um celular.' },
  enrolName: { en: 'Name of this phone', pt: 'Nome deste celular' },
  enrolDefault: { en: 'Phone', pt: 'Celular' },
  enrolBio: { en: 'With biometrics (passkey)', pt: 'Com a digital (passkey)' },
  enrolCode: { en: 'With the code alone', pt: 'Só com o código' },
  enrolAsk: { en: 'Ask the computer', pt: 'Pedir ao computador' },
  enrolWaiting: { en: 'On the computer, approve the request showing {match}.', pt: 'No computador, aprove o pedido que mostra {match}.' },
  enrolDenied: { en: 'The computer refused this phone.', pt: 'O computador recusou este celular.' },
  enrolExpired: { en: 'The request expired. Ask again.', pt: 'O pedido expirou. Peça de novo.' },
  enrolCreating: { en: 'Approved. Now confirm with this phone\'s biometrics (twice: to create the passkey and to make its key).', pt: 'Aprovado. Agora confirme com a digital deste celular (duas vezes: para criar a passkey e para gerar a chave dela).' },
  enrolDone: { en: 'This phone can now open the vault.', pt: 'Este celular agora abre o cofre.' },
  enrolDoneDevice: { en: 'This phone can now open the vault with the code.', pt: 'Este celular agora abre o cofre com o código.' },
  enrolNoStore: { en: 'This browser would not keep the key (private window?). Nothing was saved here.', pt: 'Este navegador não guardou a chave (janela anônima?). Nada foi salvo aqui.' },
  enrolNothing: { en: 'Nothing to register from this address: biometrics need https, and "code alone" is off on the computer.', pt: 'Nada a registrar deste endereço: a digital precisa de https, e "só com o código" está desligado no computador.' },
  enrolReady: { en: 'This phone opens the vault.', pt: 'Este celular abre o cofre.' },
  // requests (computer)
  reqTitle: { en: 'A phone asks to open the vault', pt: 'Um celular pede para abrir o cofre' },
  reqBody: { en: '“{label}” ({kind}). Approve only if the phone in your hand shows {match}.', pt: '“{label}” ({kind}). Aprove só se o celular na sua mão mostrar {match}.' },
  reqKindPasskey: { en: 'biometrics', pt: 'digital' },
  reqKindDevice: { en: 'code alone', pt: 'só com o código' },
  reqApprove: { en: 'Approve with Windows Hello', pt: 'Aprovar com o Windows Hello' },
  reqDeny: { en: 'Refuse', pt: 'Recusar' },
  reqApproving: { en: 'Confirm on this computer…', pt: 'Confirme neste computador…' },
  // Windows Hello failed (an error, not a cancel) — owner decision 2026-10-03, fallback (A)
  helloFailedPhone: { en: 'Windows Hello did not work. Approve on your phone: open Agentistics there, type your authenticator code and confirm with your biometrics. This page carries on by itself.', pt: 'O Windows Hello não funcionou. Aprove no celular: abra o Agentistics nele, digite o código do autenticador e confirme com a digital. Esta página continua sozinha.' },
  helloFailedWaiting: { en: 'Waiting for the phone…', pt: 'Esperando o celular…' },
  helloFailedNoPhone: { en: 'Windows Hello did not work, and no phone with biometrics can open this vault yet. Try Hello again; register a phone on the Vault page so it can stand in next time. The 24 recovery words remain the last resort.', pt: 'O Windows Hello não funcionou, e nenhum celular com digital abre este cofre ainda. Tente o Hello de novo; registre um celular na página Cofre para que ele possa substituir da próxima vez. As 24 palavras de recuperação continuam sendo o último recurso.' },
  helloFailedExpired: { en: 'The phone did not open the vault in time.', pt: 'O celular não abriu o cofre a tempo.' },
  helloRetry: { en: 'Try Windows Hello again', pt: 'Tentar o Windows Hello de novo' },
} as const
type K = keyof typeof TEXT
const tx = (k: K, lang: Lang, vars: Record<string, string> = {}) => TEXT[k][lang].replace(/\{(\w+)\}/g, (_, v: string) => vars[v] ?? '')

const btnBase = (isMobile: boolean): React.CSSProperties => ({
  padding: isMobile ? '10px 14px' : '7px 14px', minHeight: isMobile ? 44 : undefined, borderRadius: 8, fontSize: 13,
  border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-primary)', cursor: 'pointer',
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontFamily: 'inherit',
})
const hotBtn = (isMobile: boolean): React.CSSProperties => ({ ...btnBase(isMobile), ...primaryBtn, width: 'auto', padding: btnBase(isMobile).padding, minHeight: btnBase(isMobile).minHeight })

export function CodeField({ value, onChange, label, autoFocus, onEnter }: { value: string; onChange: (v: string) => void; label: string; autoFocus?: boolean; onEnter?: () => void }) {
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

/** ON this computer: gesture first (the SERVICE raises the dialog), then the code field. */
export function UnlockControl({ view, lang, onOpened, btn, isMobile, center, onAction, passkeys = 0, onBusy }: { view: VaultView; lang: Lang; onOpened: () => void; btn: React.CSSProperties; isMobile: boolean; center?: boolean; onAction?: (a: UiAction) => void; passkeys?: number; onBusy?: (busy: boolean) => void }) {
  // 'phone': Hello ERRORED and a phone with biometrics stands in (fallback A); this page waits for it.
  const [phase, setPhase] = useState<'idle' | 'gesture' | 'code' | 'phone'>(view.pendingStepup ? 'code' : 'idle')
  const [noPhone, setNoPhone] = useState(false)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errAction, setErrAction] = useState<UiAction | null>(null)
  // The page's safe turns its dial while an unlock is IN PROGRESS: Hello asked, the code being checked, or
  // the phone being waited on. Reported as a level; the caller decides what to draw.
  const inProgress = phase === 'gesture' || phase === 'phone' || busy
  useEffect(() => { onBusy?.(inProgress) }, [inProgress, onBusy])
  const label: VaultKey = view.wrappers.includes('hello') ? 'unlockWith_hello' : view.wrappers.includes('fido2') ? 'unlockWith_fido2' : 'unlockPlain'

  const gesture = async () => {
    setError(null); setPhase('gesture')
    setNoPhone(false)
    const r = await unlockGesture()
    if (!r.ok) {
      const fb = helloFallback(r.code, { passkeys })
      if (fb.phone) { setPhase('phone'); return }
      setPhase('idle'); setNoPhone(fb.phoneMissing)
      setError(r.sentence || vt('network', lang)); setErrAction(r.action && r.action !== 'unlock' ? r.action : null); return
    }
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
    setError(r.sentence || vt('network', lang)); setErrAction(r.action && r.action !== 'unlock' ? r.action : null); setCode(''); setPhase('idle')
  }

  // Fallback (A): the phone opens the vault (passkey + code); this page notices and carries on.
  useEffect(() => {
    if (phase !== 'phone') return
    let alive = true
    const until = Date.now() + PHONE_APPROVE_WAIT_MS
    const poll = async () => {
      if (!alive) return
      const v = await loadVault()
      if (!alive) return
      if (v.kind !== 'failed' && v.view.state === 'open') { onOpened(); return }
      if (Date.now() > until) { setPhase('idle'); setError(tx('helloFailedExpired', lang)); return }
      setTimeout(() => { void poll() }, PHONE_APPROVE_POLL_MS)
    }
    const t = setTimeout(() => { void poll() }, PHONE_APPROVE_POLL_MS)
    return () => { alive = false; clearTimeout(t) }
  }, [phase, lang, onOpened])

  const align = isMobile ? 'left' : center ? 'center' : 'right'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: isMobile ? 'stretch' : center ? 'center' : 'flex-end', gap: 8, width: isMobile ? '100%' : undefined }}>
      {phase === 'phone' && (
        <div role="status" data-hello-fallback="phone" style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: isMobile ? undefined : 380, textAlign: align }}>
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6 }}><Smartphone size={14} style={{ verticalAlign: '-2px' }} /> {tx('helloFailedPhone', lang)}</div>
          <div style={{ fontSize: 12.5, fontWeight: 600 }}><Loader2 size={13} className="ag-spin" style={{ verticalAlign: '-2px' }} /> {tx('helloFailedWaiting', lang)}</div>
          <button type="button" style={{ ...btn, background: 'transparent' }} onClick={() => { void gesture() }}>{tx('helloRetry', lang)}</button>
        </div>
      )}
      {phase !== 'code' && phase !== 'phone' && (
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
      {error && <div role="alert" style={{ fontSize: 12, color: 'var(--accent-red, #ef4444)', maxWidth: isMobile ? undefined : 360, textAlign: align }}>{error}</div>}
      {noPhone && <div data-hello-fallback="no-phone" style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.55, maxWidth: isMobile ? undefined : 380, textAlign: align }}>{tx('helloFailedNoPhone', lang)}</div>}
      {/* "recover" has its own standing button under the hero on a loopback page; never draw it twice. */}
      {error && errAction && onAction && errAction !== 'recover' && (
        <button type="button" style={{ ...btn, background: 'transparent' }} onClick={() => onAction(errAction)}>{vt(errAction === 'enroll' ? 'act_enroll' : errAction === 'unlock' ? 'act_unlock' : 'act_disable', lang)}</button>
      )}
    </div>
  )
}

/** OFF this computer: the phone's biometrics and/or the code alone, from the offers table. */
function PhoneUnlock({ facts, lang, isMobile, onOpened }: { facts: PhoneFacts; lang: Lang; isMobile: boolean; onOpened: () => void }) {
  const offers = offersHere(facts, readDeviceKey())
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState<null | 'passkey' | 'code-only'>(null)
  const [error, setError] = useState<string | null>(null)
  const go = async (how: 'passkey' | 'code-only') => {
    if (!codeComplete(code) || busy) return
    setBusy(how); setError(null)
    const r = how === 'passkey' ? await unlockWithPasskey(code) : await unlockWithDevice(code)
    setBusy(null); setCode('')
    if (r.ok) { onOpened(); return }
    if (r.code !== 'passkey-cancelled') setError(r.sentence || tx('network', lang))
  }
  const canOpen = offers.includes('passkey') || offers.includes('code-only')
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%', maxWidth: isMobile ? undefined : 380 }}>
      {canOpen && (
        <form onSubmit={e => { e.preventDefault(); void go(offers[0] === 'passkey' ? 'passkey' : 'code-only') }}>
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.55, marginBottom: 8 }}>{tx(offers[0] === 'passkey' ? 'phoneBioHint' : 'phoneCodeHint', lang)}</div>
          <CodeField value={code} onChange={setCode} label={tx('codeLabel', lang)} autoFocus />
          <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', gap: 8 }}>
            {offers.includes('passkey') && (
              <button type="submit" style={hotBtn(isMobile)} disabled={!codeComplete(code) || busy !== null}>
                {busy === 'passkey' ? <Loader2 size={14} className="ag-spin" /> : <Fingerprint size={15} />} {busy === 'passkey' ? tx('working', lang) : tx('phoneBio', lang)}
              </button>
            )}
            {offers.includes('code-only') && (
              <button type={offers[0] === 'code-only' ? 'submit' : 'button'} style={offers[0] === 'code-only' ? hotBtn(isMobile) : btnBase(isMobile)}
                disabled={!codeComplete(code) || busy !== null} onClick={offers[0] === 'code-only' ? undefined : () => { void go('code-only') }}>
                {busy === 'code-only' && <Loader2 size={14} className="ag-spin" />} {tx('phoneCodeOnly', lang)}
              </button>
            )}
          </div>
        </form>
      )}
      {offers.includes('enrol') && <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6 }}><Smartphone size={14} style={{ verticalAlign: '-2px' }} /> {tx(facts.stale > 0 ? 'phoneStale' : 'phoneEnrolLocked', lang)}</div>}
      {offers.includes('https') && <div style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.55 }}>{tx('phoneHttps', lang)}</div>}
      {error && <Err text={error} />}
    </div>
  )
}

/**
 * The whole unlock, for any screen: reads the vault's state and where it is opened from, and calls
 * `onOpened` once the vault is open (at once, if it already is).
 */
export function VaultUnlock({ lang, isMobile, onOpened, center, onAction, btn, onBusy }: { lang: Lang; isMobile: boolean; onOpened: () => void; center?: boolean; onAction?: (a: UiAction) => void; btn?: React.CSSProperties; onBusy?: (busy: boolean) => void }) {
  const [view, setView] = useState<VaultView | null>(null)
  const [facts, setFacts] = useState<PhoneFacts | null>(null)
  const [failed, setFailed] = useState(false)
  // A caller's inline arrow must not re-run the load on every render.
  const opened = useRef(onOpened)
  opened.current = onOpened
  const done = useCallback(() => opened.current(), [])
  useEffect(() => {
    let alive = true
    void Promise.all([loadVault(), phoneFacts()]).then(([v, f]) => {
      if (!alive) return
      if (v.kind === 'failed' || !f.ok) { setFailed(true); return }
      if (v.view.state === 'open') { done(); return }
      setView(v.view); setFacts(f)
    })
    return () => { alive = false }
  }, [done])
  if (failed) return <Err text={tx('network', lang)} />
  if (!view || !facts) return <div style={{ color: 'var(--text-tertiary)' }}><Loader2 size={14} className="ag-spin" /></div>
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: isMobile ? 'stretch' : center ? 'center' : 'flex-start' }}>
      {facts.loopback
        ? <UnlockControl view={view} lang={lang} onOpened={done} btn={btn ?? hotBtn(isMobile)} isMobile={isMobile} center={center} onAction={onAction} passkeys={facts.passkeys} {...(onBusy ? { onBusy } : {})} />
        : <PhoneUnlock facts={facts} lang={lang} isMobile={isMobile} onOpened={done} />}
    </div>
  )
}

/** A compact "locked" block for a screen that needs the vault inline (the chip, the vault page). */
export function LockedVaultInline({ lang, isMobile, onOpened }: { lang: Lang; isMobile: boolean; onOpened: () => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13.5 }}><Lock size={16} /> {tx('phoneLocked', lang)}</div>
      <VaultUnlock lang={lang} isMobile={isMobile} onOpened={onOpened} />
    </div>
  )
}

/** ON the phone, vault open: register this phone (ask here, approve on the computer, finish here). */
export function PhoneEnrol({ lang, isMobile, onDone }: { lang: Lang; isMobile: boolean; onDone?: () => void }) {
  const [facts, setFacts] = useState<PhoneFacts | null>(null)
  const [label, setLabel] = useState(tx('enrolDefault', lang))
  const [kind, setKind] = useState<'passkey' | 'device'>('passkey')
  const [code, setCode] = useState('')
  const [phase, setPhase] = useState<'form' | 'waiting' | 'finishing' | 'done'>('form')
  const [match, setMatch] = useState('')
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { void phoneFacts().then(f => { if (f.ok) { setFacts(f); if (f.enrolKinds[0]) setKind(f.enrolKinds[0]) } }) }, [])

  const finish = useCallback(async (id: string, k: 'passkey' | 'device') => {
    setPhase('finishing')
    if (k === 'device') {
      const r = await enrolDevice(id)
      if (!r.ok) { setPhase('form'); setError(r.sentence || tx('network', lang)); return }
      setPhase('done'); setNote(tx(r.stored ? 'enrolDoneDevice' : 'enrolNoStore', lang)); onDone?.(); return
    }
    setNote(tx('enrolCreating', lang))
    const r = await enrolPasskey(id)
    if (!r.ok) { setPhase('form'); setNote(null); if (r.code !== 'passkey-cancelled') setError(r.sentence || tx('network', lang)); return }
    setPhase('done'); setNote(r.unlockable ? tx('enrolDone', lang) : (r.sentence ?? '')); onDone?.()
  }, [lang, onDone])

  const ask = async () => {
    if (!codeComplete(code)) return
    setError(null)
    const r = await requestEnrol(kind, label.trim() || tx('enrolDefault', lang), code)
    setCode('')
    if (!r.ok) { setError(r.sentence || tx('network', lang)); return }
    setMatch(r.match); setPhase('waiting')
    const k = kind
    const until = Date.now() + r.expiresInMs
    const poll = async () => {
      const s = await enrolStatus(r.id)
      if (s.ok && s.status === 'approved') { void finish(r.id, k); return }
      if (s.ok && (s.status === 'denied' || s.status === 'expired')) { setPhase('form'); setError(tx(s.status === 'denied' ? 'enrolDenied' : 'enrolExpired', lang)); return }
      if (Date.now() > until) { setPhase('form'); setError(tx('enrolExpired', lang)); return }
      setTimeout(() => { void poll() }, 2000)
    }
    setTimeout(() => { void poll() }, 1500)
  }

  if (!facts) return null
  const box: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: 12, padding: '14px 16px' }
  if (facts.enrolKinds.length === 0) return <div style={{ ...box, fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6 }}>{tx('enrolNothing', lang)}{!facts.secure && <div style={{ marginTop: 6, color: 'var(--text-tertiary)' }}>{tx('phoneHttps', lang)}</div>}</div>
  return (
    <div style={box}>
      <div style={{ fontSize: 13.5, fontWeight: 700, marginBottom: 6 }}>{tx('enrolTitle', lang)}</div>
      {phase === 'form' && (
        <form onSubmit={e => { e.preventDefault(); void ask() }}>
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 10 }}>{tx('enrolWhy', lang)}</div>
          <label style={{ display: 'block', marginBottom: 10 }}>
            <span style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>{tx('enrolName', lang)}</span>
            <input value={label} onChange={e => setLabel(e.target.value.slice(0, 60))} style={{ ...input, marginBottom: 0, letterSpacing: 'normal' }} />
          </label>
          {facts.enrolKinds.length > 1 && (
            <div role="radiogroup" style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', gap: 8, marginBottom: 10 }}>
              {facts.enrolKinds.map(k => (
                <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)}
                  style={{ ...btnBase(isMobile), borderColor: kind === k ? 'var(--anthropic-orange)' : 'var(--border)', fontWeight: kind === k ? 700 : 400 }}>
                  {k === 'passkey' ? tx('enrolBio', lang) : tx('enrolCode', lang)}
                </button>
              ))}
            </div>
          )}
          {!facts.secure && <div style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.55, marginBottom: 10 }}>{tx('phoneHttps', lang)}</div>}
          <CodeField value={code} onChange={setCode} label={tx('codeLabel', lang)} />
          <button type="submit" style={hotBtn(isMobile)} disabled={!codeComplete(code)}>{tx('enrolAsk', lang)}</button>
        </form>
      )}
      {phase === 'waiting' && (
        <div role="status" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: 4, fontVariantNumeric: 'tabular-nums' }}>{match}</div>
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6 }}><Loader2 size={13} className="ag-spin" style={{ verticalAlign: '-2px' }} /> {tx('enrolWaiting', lang, { match })}</div>
        </div>
      )}
      {phase === 'finishing' && note && <div role="status" style={{ fontSize: 12.5, lineHeight: 1.6 }}><Loader2 size={13} className="ag-spin" style={{ verticalAlign: '-2px' }} /> {note}</div>}
      {phase === 'done' && note && <div role="status" style={{ fontSize: 12.5, lineHeight: 1.6 }}>{note}</div>}
      {error && <div style={{ marginTop: 8 }}><Err text={error} /></div>}
    </div>
  )
}

/** ON the computer: the phones waiting for approval. Approve = Windows Hello, raised by the service. */
export function PhoneRequests({ lang, isMobile, requests, onChanged }: { lang: Lang; isMobile: boolean; requests: PhoneRequest[]; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (requests.length === 0) return null
  const decide = async (id: string, approve: boolean) => {
    setBusy(id); setError(null)
    const r = await decidePhoneRequest(id, approve)
    setBusy(null)
    if (!r.ok) setError(r.sentence || tx('network', lang))
    onChanged()
  }
  return (
    <div role="alert" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {requests.map(q => (
        <div key={q.id} style={{ border: '1px solid var(--anthropic-orange)', borderRadius: 12, padding: '12px 14px', background: 'var(--bg-card, var(--bg-elevated))' }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, marginBottom: 4, display: 'flex', gap: 6, alignItems: 'center' }}><Smartphone size={15} /> {tx('reqTitle', lang)}</div>
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 10 }}>
            {tx('reqBody', lang, { label: q.label, kind: tx(q.kind === 'passkey' ? 'reqKindPasskey' : 'reqKindDevice', lang), match: q.match })}
          </div>
          <div style={{ display: 'flex', gap: 8, flexDirection: isMobile ? 'column' : 'row' }}>
            <button type="button" style={hotBtn(isMobile)} disabled={busy !== null} onClick={() => { void decide(q.id, true) }}>
              {busy === q.id && <Loader2 size={14} className="ag-spin" />} {busy === q.id ? tx('reqApproving', lang) : tx('reqApprove', lang)}
            </button>
            <button type="button" style={btnBase(isMobile)} disabled={busy !== null} onClick={() => { void decide(q.id, false) }}>{tx('reqDeny', lang)}</button>
          </div>
        </div>
      ))}
      {error && <Err text={error} />}
    </div>
  )
}

/** Polls the computer's pending phone requests while mounted and the tab is visible (5 s). */
export function usePhoneRequests(enabled: boolean): { requests: PhoneRequest[]; refresh: () => void } {
  const [requests, setRequests] = useState<PhoneRequest[]>([])
  const refresh = useCallback(() => { void phoneRequests().then(r => setRequests(r.ok ? r.requests : [])) }, [])
  useEffect(() => {
    if (!enabled) { setRequests([]); return }
    refresh()
    const t = setInterval(() => { if (document.visibilityState === 'visible') refresh() }, 5000)
    return () => clearInterval(t)
  }, [enabled, refresh])
  return { requests, refresh }
}

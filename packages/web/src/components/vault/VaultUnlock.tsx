import { AgentisticsLoader } from '../../components/AgentisticsLoader'
/**
 * VaultUnlock — the ONE way any screen opens a locked vault (VAULT.PERSONAL §10).
 *
 * Settings → Vault, the personal vault page, the `:vault` chip, Providers, backup and the native chat
 * all mount this, so the flow is the same everywhere and nobody is sent "go to the Vault" first.
 *
 * What it offers is the shared table (`@agentistics/core` `unlockOffers`, via `offersHere`), never a
 * guess: ON this computer, the vault's own way to confirm — Touch ID or the Mac password, Windows Hello
 * or a key (the SERVICE raises the dialog), or the vault password (typed right here); from any OTHER
 * device, never a dialog on the computer — the phone's biometrics (a passkey with PRF, over https).
 * COFRE.DESBLOQUEIO (owner, 2026-11-07): there is no app code anywhere, before or after.
 *
 * Also here: `PhoneEnrol` (on the phone, vault open: ask to be registered, then finish after the
 * computer approves) and `PhoneRequests` (on the computer: the pending requests, approve with its proof).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type React from 'react'
import { Fingerprint, Lock, Smartphone } from 'lucide-react'
import { Err, input, primaryBtn } from '../MfaSetup'
import { confirmsWithPasswordOnly, createVault, loadVault, unlockGesture, type UiAction, type VaultView } from '../../lib/vaultApi'
import { vt, type VaultKey } from '../../lib/vaultText'
import { PHONE_APPROVE_POLL_MS, PHONE_APPROVE_WAIT_MS, helloFallback } from '../../lib/helloFallback'
import {
  decidePhoneRequest, enrolPasskey, enrolStatus, offersHere, phoneFacts, phoneRequests, requestEnrol,
  unlockWithPasskey, type PhoneFacts, type PhoneRequest,
} from '../../lib/phoneVault'
import { VaultPasswordInput } from './VaultPassword'

type Lang = 'en' | 'pt'

const TEXT = {
  phoneLocked: { en: 'The vault is locked.', pt: 'O cofre está trancado.' },
  phoneBio: { en: 'Open with biometrics', pt: 'Abrir com a digital' },
  phoneBioHint: { en: 'Confirm with this phone\'s fingerprint, face or PIN.', pt: 'Confirme com a digital, o rosto ou o PIN deste celular.' },
  phoneEnrolLocked: { en: 'This phone cannot open the vault yet. Open the vault once on the computer, then register this phone on the Vault page here on the phone — it asks for an approval on the computer.', pt: 'Este celular ainda não abre o cofre. Abra o cofre uma vez no computador e registre este celular na página Cofre, aqui no celular — pede uma aprovação no computador.' },
  phoneHttps: { en: 'Biometrics need a secure address: turn on HTTPS certificates in your Tailscale admin and open Agentistics by the machine\'s https name.', pt: 'A digital precisa de um endereço seguro: ligue os certificados HTTPS no painel do Tailscale e abra o Agentistics pelo nome https da máquina.' },
  phoneStale: { en: 'The vault changed its key since this phone was approved. Approve it again on the computer.', pt: 'O cofre trocou de chave desde que este celular foi aprovado. Aprove-o de novo no computador.' },
  network: { en: 'Could not reach the server.', pt: 'Não deu para falar com o servidor.' },
  working: { en: 'Confirm on this phone…', pt: 'Confirme neste celular…' },
  // enrol (phone)
  enrolTitle: { en: 'Let this phone open the vault', pt: 'Deixar este celular abrir o cofre' },
  enrolWhy: { en: 'Asks for an approval on the computer — so nobody registers a phone without you there. Then this phone\'s biometrics open the vault.', pt: 'Pede uma aprovação no computador — assim ninguém registra um celular sem você lá. Depois, a digital deste celular abre o cofre.' },
  enrolName: { en: 'Name of this phone', pt: 'Nome deste celular' },
  enrolDefault: { en: 'Phone', pt: 'Celular' },
  enrolAsk: { en: 'Ask the computer', pt: 'Pedir ao computador' },
  enrolWaiting: { en: 'On the computer, approve the request showing {match}.', pt: 'No computador, aprove o pedido que mostra {match}.' },
  enrolDenied: { en: 'The computer refused this phone.', pt: 'O computador recusou este celular.' },
  enrolExpired: { en: 'The request expired. Ask again.', pt: 'O pedido expirou. Peça de novo.' },
  enrolCreating: { en: 'Approved. Now confirm with this phone\'s biometrics (twice: to create the passkey and to make its key).', pt: 'Aprovado. Agora confirme com a digital deste celular (duas vezes: para criar a passkey e para gerar a chave dela).' },
  enrolDone: { en: 'This phone can now open the vault.', pt: 'Este celular agora abre o cofre.' },
  enrolNothing: { en: 'Nothing to register from this address: biometrics need https.', pt: 'Nada a registrar deste endereço: a digital precisa de https.' },
  // requests (computer)
  reqTitle: { en: 'A phone asks to open the vault', pt: 'Um celular pede para abrir o cofre' },
  reqBody: { en: '“{label}” (biometrics). Approve only if the phone in your hand shows {match}.', pt: '“{label}” (digital). Aprove só se o celular na sua mão mostrar {match}.' },
  reqApprove: { en: 'Approve', pt: 'Aprovar' },
  reqDeny: { en: 'Refuse', pt: 'Recusar' },
  reqApproving: { en: 'Confirm on this computer…', pt: 'Confirme neste computador…' },
  // the gesture failed (an error, not a cancel) — owner decision 2026-10-03, fallback (A)
  helloFailedPhone: { en: 'This computer\'s confirmation did not work. Approve on your phone: open Agentistics there and confirm with your biometrics. This page carries on by itself.', pt: 'A confirmação deste computador não funcionou. Aprove no celular: abra o Agentistics nele e confirme com a digital. Esta página continua sozinha.' },
  helloFailedWaiting: { en: 'Waiting for the phone…', pt: 'Esperando o celular…' },
  helloFailedNoPhone: { en: 'This computer\'s confirmation did not work, and no phone with biometrics can open this vault yet. Try again; register a phone on the Vault page so it can stand in next time. The 24 recovery words remain the last resort.', pt: 'A confirmação deste computador não funcionou, e nenhum celular com digital abre este cofre ainda. Tente de novo; registre um celular na página Cofre para que ele possa substituir da próxima vez. As 24 palavras de recuperação continuam sendo o último recurso.' },
  helloFailedExpired: { en: 'The phone did not open the vault in time.', pt: 'O celular não abriu o cofre a tempo.' },
  helloRetry: { en: 'Try again', pt: 'Tentar de novo' },
} as const
type K = keyof typeof TEXT
const tx = (k: K, lang: Lang, vars: Record<string, string> = {}) => TEXT[k][lang].replace(/\{(\w+)\}/g, (_, v: string) => vars[v] ?? '')

const btnBase = (isMobile: boolean): React.CSSProperties => ({
  padding: isMobile ? '10px 14px' : '7px 14px', minHeight: isMobile ? 44 : undefined, borderRadius: 8, fontSize: 13,
  border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-primary)', cursor: 'pointer',
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontFamily: 'inherit',
})
const hotBtn = (isMobile: boolean): React.CSSProperties => ({ ...btnBase(isMobile), ...primaryBtn, width: 'auto', padding: btnBase(isMobile).padding, minHeight: btnBase(isMobile).minHeight })

/** PURE. The unlock button's words for this vault's way to confirm. */
export function unlockLabel(wrappers: readonly string[]): VaultKey {
  return wrappers.includes('touchid') ? 'unlockWith_touchid' : wrappers.includes('hello') ? 'unlockWith_hello' : wrappers.includes('fido2') ? 'unlockWith_fido2' : 'unlockPlain'
}

/** ON this computer: the vault's own way — a dialog the SERVICE raises, or the vault password typed here. */
export function UnlockControl({ view, lang, onOpened, btn, isMobile, center, onAction, passkeys = 0, onBusy }: { view: VaultView; lang: Lang; onOpened: () => void; btn: React.CSSProperties; isMobile: boolean; center?: boolean; onAction?: (a: UiAction) => void; passkeys?: number; onBusy?: (busy: boolean) => void }) {
  // 'phone': the gesture ERRORED and a phone with biometrics stands in (fallback A); this page waits for it.
  const [phase, setPhase] = useState<'idle' | 'gesture' | 'phone'>('idle')
  const [noPhone, setNoPhone] = useState(false)
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [errAction, setErrAction] = useState<UiAction | null>(null)
  const withPassword = confirmsWithPasswordOnly(view)
  // The page's safe turns its dial while an unlock is IN PROGRESS. Reported as a level; the caller decides
  // what to draw. Only `onOpened` (the vault really open) lets the door move.
  const inProgress = phase === 'gesture' || phase === 'phone'
  useEffect(() => { onBusy?.(inProgress) }, [inProgress, onBusy])
  useEffect(() => () => { setPassword('') }, [])

  const unlock = async () => {
    if (phase === 'gesture' || (withPassword && !password)) return
    setError(null); setPhase('gesture'); setNoPhone(false)
    const r = await unlockGesture(withPassword ? password : undefined)
    setPassword('')
    if (!r.ok) {
      const fb = helloFallback(r.code, { passkeys })
      if (fb.phone && !withPassword) { setPhase('phone'); return }
      setPhase('idle'); setNoPhone(!withPassword && fb.phoneMissing)
      setError(r.sentence || vt('network', lang)); setErrAction(r.action && r.action !== 'unlock' ? r.action : null); return
    }
    onOpened()
  }

  // Fallback (A): the phone opens the vault (its biometrics); this page notices and carries on.
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
  // No vault on this computer yet: nothing to unlock — offer to create it, here, instead of a command.
  if (view.state === 'uninitialized') {
    return <CreateVaultControl lang={lang} isMobile={isMobile} center={center} btn={btn} onCreated={onOpened} onBusy={onBusy} />
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: isMobile ? 'stretch' : center ? 'center' : 'flex-end', gap: 8, width: isMobile ? '100%' : undefined }}>
      {phase === 'phone' && (
        <div role="status" data-hello-fallback="phone" style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: isMobile ? undefined : 380, textAlign: align }}>
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6 }}><Smartphone size={14} style={{ verticalAlign: '-2px' }} /> {tx('helloFailedPhone', lang)}</div>
          <div style={{ fontSize: 12.5, fontWeight: 600 }}><AgentisticsLoader size={13} style={{ verticalAlign: '-2px' }} /> {tx('helloFailedWaiting', lang)}</div>
          <button type="button" style={{ ...btn, background: 'transparent' }} onClick={() => { void unlock() }}>{tx('helloRetry', lang)}</button>
        </div>
      )}
      {phase !== 'phone' && withPassword && (
        <form data-vault-unlock-password onSubmit={e => { e.preventDefault(); void unlock() }} style={{ width: isMobile ? '100%' : 280, textAlign: 'left' }}>
          <VaultPasswordInput value={password} onChange={setPassword} label={vt('wiz_pw_label', lang)} lang={lang} autoFocus={!isMobile} invalid={!!error} />
          <button type="submit" style={{ ...btn, width: '100%', justifyContent: 'center' }} disabled={!password || phase === 'gesture'}>
            {phase === 'gesture' && <AgentisticsLoader size={14} />} {phase === 'gesture' ? vt('unlocking', lang) : vt('unlockWith_password', lang)}
          </button>
        </form>
      )}
      {phase !== 'phone' && !withPassword && (
        <button type="button" style={btn} onClick={() => { void unlock() }} disabled={phase === 'gesture'}>
          {phase === 'gesture' && <AgentisticsLoader size={14} />}
          {phase === 'gesture' ? vt('unlocking', lang) : vt(unlockLabel(view.wrappers), lang)}
        </button>
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

/**
 * The vault does not exist yet: one button creates it (`POST /api/vault/init`, the code path
 * `agentop vault init` runs). When the service finds no system keychain it answers `no-protector`;
 * the same control then asks for a passphrase instead of sending the person to a terminal.
 */
function CreateVaultControl({ lang, isMobile, center, btn, onCreated, onBusy }: { lang: Lang; isMobile: boolean; center?: boolean; btn: React.CSSProperties; onCreated: () => void; onBusy?: (busy: boolean) => void }) {
  const [busy, setBusy] = useState(false)
  const [needsPass, setNeedsPass] = useState(false)
  const [pass, setPass] = useState('')
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { onBusy?.(busy) }, [busy, onBusy])
  const create = async () => {
    if (busy || (needsPass && pass.length < 8)) return
    setBusy(true); setError(null)
    const r = await createVault(needsPass ? pass : undefined)
    setBusy(false)
    if (r.ok) { setPass(''); onCreated(); return }
    if (r.code === 'no-protector') { setNeedsPass(true); return }
    setError(r.sentence || vt('network', lang))
  }
  return (
    <form onSubmit={e => { e.preventDefault(); void create() }} data-vault-create
      style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: isMobile ? 'stretch' : center ? 'center' : 'flex-end', width: isMobile ? '100%' : undefined, maxWidth: 360 }}>
      <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.55, textAlign: isMobile ? 'left' : center ? 'center' : 'right' }}>
        {vt(needsPass ? 'createVaultPassHint' : 'createVaultHint', lang)}
      </div>
      {needsPass && (
        <input type="password" autoComplete="new-password" value={pass} onChange={e => setPass(e.target.value)} aria-label={vt('createVaultPassLabel', lang)}
          placeholder={vt('createVaultPassLabel', lang)} style={{ ...input, width: '100%', boxSizing: 'border-box' }} />
      )}
      <button type="submit" style={{ ...btn, ...(isMobile ? { justifyContent: 'center', minHeight: 44 } : {}) }} disabled={busy || (needsPass && pass.length < 8)}>
        {busy && <AgentisticsLoader size={14} />} {busy ? vt('createVaultCreating', lang) : vt('createVault', lang)}
      </button>
      {error && <div role="alert" style={{ fontSize: 12, color: 'var(--accent-red, #ef4444)' }}>{error}</div>}
    </form>
  )
}

/** OFF this computer: the phone's biometrics (a passkey with PRF), from the offers table. */
function PhoneUnlock({ facts, lang, isMobile, onOpened }: { facts: PhoneFacts; lang: Lang; isMobile: boolean; onOpened: () => void }) {
  const offers = offersHere(facts, null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const go = async () => {
    if (busy) return
    setBusy(true); setError(null)
    const r = await unlockWithPasskey()
    setBusy(false)
    if (r.ok) { onOpened(); return }
    if (r.code !== 'passkey-cancelled') setError(r.sentence || tx('network', lang))
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%', maxWidth: isMobile ? undefined : 380 }}>
      {offers.includes('passkey') && (
        <form onSubmit={e => { e.preventDefault(); void go() }}>
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.55, marginBottom: 8 }}>{tx('phoneBioHint', lang)}</div>
          <button type="submit" style={hotBtn(isMobile)} disabled={busy}>
            {busy ? <AgentisticsLoader size={14} /> : <Fingerprint size={15} />} {busy ? tx('working', lang) : tx('phoneBio', lang)}
          </button>
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
export function VaultUnlock({ lang, isMobile, onOpened, center, onAction, btn, onBusy, onWrappers }: { lang: Lang; isMobile: boolean; onOpened: () => void; center?: boolean; onAction?: (a: UiAction) => void; btn?: React.CSSProperties; onBusy?: (busy: boolean) => void; onWrappers?: (wrappers: string[]) => void }) {
  const [view, setView] = useState<VaultView | null>(null)
  const [facts, setFacts] = useState<PhoneFacts | null>(null)
  const [failed, setFailed] = useState(false)
  // A caller's inline arrow must not re-run the load on every render.
  const opened = useRef(onOpened)
  opened.current = onOpened
  const wrappersCb = useRef(onWrappers)
  wrappersCb.current = onWrappers
  const done = useCallback(() => opened.current(), [])
  useEffect(() => {
    let alive = true
    void Promise.all([loadVault(), phoneFacts()]).then(([v, f]) => {
      if (!alive) return
      if (v.kind === 'failed' || !f.ok) { setFailed(true); return }
      if (v.view.state === 'open') { done(); return }
      wrappersCb.current?.(v.view.wrappers)
      setView(v.view); setFacts(f)
    })
    return () => { alive = false }
  }, [done])
  if (failed) return <Err text={tx('network', lang)} />
  if (!view || !facts) return <div style={{ color: 'var(--text-tertiary)' }}><AgentisticsLoader size={14} /></div>
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
  const [phase, setPhase] = useState<'form' | 'waiting' | 'finishing' | 'done'>('form')
  const [match, setMatch] = useState('')
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { void phoneFacts().then(f => { if (f.ok) setFacts(f) }) }, [])

  const finish = useCallback(async (id: string) => {
    setPhase('finishing')
    setNote(tx('enrolCreating', lang))
    const r = await enrolPasskey(id)
    if (!r.ok) { setPhase('form'); setNote(null); if (r.code !== 'passkey-cancelled') setError(r.sentence || tx('network', lang)); return }
    setPhase('done'); setNote(r.unlockable ? tx('enrolDone', lang) : (r.sentence ?? '')); onDone?.()
  }, [lang, onDone])

  const ask = async () => {
    setError(null)
    const r = await requestEnrol('passkey', label.trim() || tx('enrolDefault', lang))
    if (!r.ok) { setError(r.sentence || tx('network', lang)); return }
    setMatch(r.match); setPhase('waiting')
    const until = Date.now() + r.expiresInMs
    const poll = async () => {
      const s = await enrolStatus(r.id)
      if (s.ok && s.status === 'approved') { void finish(r.id); return }
      if (s.ok && (s.status === 'denied' || s.status === 'expired')) { setPhase('form'); setError(tx(s.status === 'denied' ? 'enrolDenied' : 'enrolExpired', lang)); return }
      if (Date.now() > until) { setPhase('form'); setError(tx('enrolExpired', lang)); return }
      setTimeout(() => { void poll() }, 2000)
    }
    setTimeout(() => { void poll() }, 1500)
  }

  if (!facts) return null
  const box: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: 12, padding: '14px 16px' }
  if (!facts.enrolKinds.includes('passkey')) return <div style={{ ...box, fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6 }}>{tx('enrolNothing', lang)}{!facts.secure && <div style={{ marginTop: 6, color: 'var(--text-tertiary)' }}>{tx('phoneHttps', lang)}</div>}</div>
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
          <button type="submit" style={hotBtn(isMobile)}>{tx('enrolAsk', lang)}</button>
        </form>
      )}
      {phase === 'waiting' && (
        <div role="status" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: 4, fontVariantNumeric: 'tabular-nums' }}>{match}</div>
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6 }}><AgentisticsLoader size={13} style={{ verticalAlign: '-2px' }} /> {tx('enrolWaiting', lang, { match })}</div>
        </div>
      )}
      {phase === 'finishing' && note && <div role="status" style={{ fontSize: 12.5, lineHeight: 1.6 }}><AgentisticsLoader size={13} style={{ verticalAlign: '-2px' }} /> {note}</div>}
      {phase === 'done' && note && <div role="status" style={{ fontSize: 12.5, lineHeight: 1.6 }}>{note}</div>}
      {error && <div style={{ marginTop: 8 }}><Err text={error} /></div>}
    </div>
  )
}

/** ON the computer: the phones waiting for approval. Approving asks this vault's own proof. */
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
            {tx('reqBody', lang, { label: q.label, match: q.match })}
          </div>
          <div style={{ display: 'flex', gap: 8, flexDirection: isMobile ? 'column' : 'row' }}>
            <button type="button" style={hotBtn(isMobile)} disabled={busy !== null} onClick={() => { void decide(q.id, true) }}>
              {busy === q.id && <AgentisticsLoader size={14} />} {busy === q.id ? tx('reqApproving', lang) : tx('reqApprove', lang)}
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

/**
 * The vault's CONTROLS state (VAULT v4): what the old Settings → Vault screen held — the service's view
 * (`GET /api/vault`), its poll, the idle heartbeat, the enrolled credentials, and which flow is open
 * (gate dialog, enrolment wizard, recovery) — as one hook the `/vault` tabs share. Behaviour is the old
 * screen's, unchanged: nothing here decides what an action asks (the server's `gates` table does).
 */
import { useCallback, useEffect, useState } from 'react'
import {
  askWords, credentials, gateFor, grantAlive, heartbeat, loadVault, lockNow, missingSteps, needsTypedCode, presenceDisable, primarySection,
  recoverySteps, setAutoLock, type Credential, type LoadResult, type UiAction, type UnlockMode, type VaultView, type WizardStep, type ActionKind, type ProofChoice,
} from '../../lib/vaultApi'
import { presenceKey, vt, vtf } from '../../lib/vaultText'
import { EnrolWizard, GateDialog, RecoverDialog, gateActionOf, type GateKind } from '../../components/vault/VaultFlows'

const POLL_MS = 15_000
const BEAT_MS = 30_000
export const UPGRADE_DISMISS_KEY = 'agentistics-vault-upgrade-dismissed'

type Lang = 'en' | 'pt'
type Load = { kind: 'loading' } | LoadResult

export function useVaultControls(lang: Lang) {
  const [res, setRes] = useState<Load>({ kind: 'loading' })
  const [reportedAt, setReportedAt] = useState(() => Date.now())
  const [now, setNow] = useState(() => Date.now())
  const [creds, setCreds] = useState<{ credentials: Credential[]; recoveryCreatedAt: string | null } | null>(null)
  const [wizard, setWizard] = useState<WizardStep[] | null>(null)
  // v2.98.1: "add another way" opens the wizard on ONE kind (never re-running one already enrolled).
  const [wizardKind, setWizardKind] = useState<'hello' | 'fido2' | null>(null)
  const [recoverOpen, setRecoverOpen] = useState(false)
  const [dialog, setDialog] = useState<null | { kind: GateKind; minutes?: number; policy?: { mode: UnlockMode; hours: number }; authPolicy?: Partial<Record<ActionKind, ProofChoice>> }>(null)
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

  // The enrolled credentials (gated like `list`): fetched once the inventory itself is readable.
  const readable = res.kind === 'view' && open
  const enrolledKey = view ? `${view.presence}-${view.recoveryCreatedAt}-${view.wrappers.join()}` : ''
  useEffect(() => {
    if (!readable) { setCreds(null); return }
    let alive = true
    void credentials().then(r => { if (alive && r.ok) setCreds({ credentials: r.credentials, recoveryCreatedAt: r.recoveryCreatedAt }) })
    return () => { alive = false }
  }, [readable, enrolledKey])

  const steps = view ? missingSteps(view) : []
  const canUpgrade = view !== null && steps.length > 0 && view.state !== 'uninitialized' && view.state !== 'corrupt' && view.state !== 'protector-lost'
  const showBanner = view !== null && canUpgrade && !view.recoveryTodo && (view.requirePresence || !dismissed) && open
  const primary = primarySection(steps, showBanner)
  const dismiss = () => { setDismissed(true); try { localStorage.setItem(UPGRADE_DISMISS_KEY, '1') } catch { /* a convenience only */ } }
  // A section's button runs the WHOLE missing flow (never one lonely step); only a replacement is single.
  const startSetup = (preferred: WizardStep) => setWizard(steps.length > 0 ? steps : [preferred])
  const g = (action: string) => (view ? gateFor(view, action) : { code: false, gesture: false, grant: false })
  const presWord = view ? vt(presenceKey(view.wrappers), lang) : ''
  // Every gated button says, on hover and to assistive tech, exactly what it will ask.
  const tip = (action: string): string => (view ? askWords(gateFor(view, action), {
    code: vt('tip_code', lang), presence: vtf('tip_presence', lang, { presence: presWord }), and: vt('tip_and', lang), asks: vt('tip_asks', lang), nothing: vt('tip_nothing', lang),
  }) : '')

  // An action's proofs: the icons say what it asks; a dialog collects the code (and warns about the gesture).
  const ask = (kind: GateKind, minutes?: number, policy?: { mode: UnlockMode; hours: number }, authPolicy?: Partial<Record<ActionKind, ProofChoice>>) => {
    if (!view) return
    const action = gateActionOf(kind)
    if (kind === 'unlock-policy') { setDialog({ kind, policy }); return } // always the code AND the gesture
    // The policy table: always the dialog — it states what the CURRENT settings row asks, and the change is a decision.
    if (kind === 'auth-policy') { setDialog({ kind, authPolicy }); return }
    const gate = gateFor(view, action)
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
    else if (a === 'enroll' && view) setWizard(view.recoveryTodo ? recoverySteps(view.recoveryTodo) : steps.length > 0 ? steps : null)
    else if (a === 'disable-presence') setDialog({ kind: 'presence-off' })
    else { setWizard(null); window.scrollTo({ top: 0, behavior: 'smooth' }) }
  }
  const canRecover = view?.loopback === true && Boolean(view.recoveryCreatedAt)

  return {
    res, view, open, reportedAt, now, creds, steps, showBanner, primary, dismiss, startSetup, g, tip, ask, onAction, canRecover, presWord, load,
    wizard, setWizard, wizardKind, setWizardKind, recoverOpen, setRecoverOpen, dialog, setDialog,
  }
}

export type VaultControls = ReturnType<typeof useVaultControls>

/** The flows a control opens — drawn once by the page, whatever tab asked for them. */
export function VaultFlowHost({ c, lang, isMobile, onChanged }: { c: VaultControls; lang: Lang; isMobile: boolean; onChanged?: () => void }) {
  const { view } = c
  if (!view) return null
  const done = () => { void c.load().then(() => onChanged?.()) }
  return (
    <>
      {c.dialog && (
        <GateDialog
          lang={lang} view={view} isMobile={isMobile} kind={c.dialog.kind} minutes={c.dialog.minutes} policy={c.dialog.policy} authPolicy={c.dialog.authPolicy}
          onCancel={() => c.setDialog(null)} onDone={() => { c.setDialog(null); done() }} onAction={c.onAction}
        />
      )}
      {c.wizard && (
        <EnrolWizard
          lang={lang} isMobile={isMobile} initial={view} steps={c.wizard} fixedKind={c.wizardKind}
          onClose={() => { c.setWizard(null); c.setWizardKind(null); done() }} onAction={c.onAction}
        />
      )}
      {c.recoverOpen && (
        <RecoverDialog
          lang={lang} isMobile={isMobile} loopback={view.loopback === true}
          onCancel={() => { c.setRecoverOpen(false); done() }}
          onRecovered={todo => { c.setRecoverOpen(false); void c.load().then(() => { onChanged?.(); const st = recoverySteps(todo); if (st.length) c.setWizard(st) }) }}
        />
      )}
    </>
  )
}

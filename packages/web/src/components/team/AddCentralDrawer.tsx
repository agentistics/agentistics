import { AgentisticsLoader } from '../../components/AgentisticsLoader'
import { useMemo, useState, type ReactNode } from 'react'
import { Check, AlertTriangle } from 'lucide-react'
import type { SessionMeta, TeamConnection, ModelUsage } from '@agentistics/core'
import Drawer from '../../pages/settings/Drawer'
import { FieldInput } from '../../pages/settings/primitives'
import { useIsMobile } from '../../hooks/useIsMobile'
import { buildShareTargets, buildProjectTargets, hostOf, type ServerProject, type ProjectTarget } from '../../lib/shareRepos'
import { COPY, interpolate } from './copy'
import { drawerBtn as actionBtnStyle } from './ConnectionCardParts'
import { SharingRulesPicker } from './SharingRulesPicker'
import { diffDraft, toggleTarget, shareAllDraft, blockAllDraft } from './repoPanelState'
import {
  resolveInitialTab, toggleProjectTarget, shareAllProjectsDraft, blockAllProjectsDraft,
  isEmptyAllowlist, isProjectLocked, partiallyDeniedRepoKeys, resolveSubmittedRules,
  type PickerTab, type ShareMode,
} from './sharePanelState'
import {
  unpackToken, canOpenRules, canConnect, canAttemptTest, resolveDupeState, computeDirty,
  buildSubmitBody, buildDefaultDraft, type WizardStep, type TestOutcome,
} from './addCentralState'

/**
 * AddCentralDrawer.tsx — the two-step "add a central" wizard (Task 12, design doc §9.6), extended
 * by Plan 4 Tasks 6–7 with the same two-tab Projects/Repositories picker and the mode selector
 * `SharedReposPanel.tsx` uses, and by the save-and-rename fix with a single-action step 1.
 *
 * Step 1 identifies the central (token/endpoint); step 2 is the SAME picker, defaulted to
 * share-everything. Both steps commit in exactly ONE `POST /api/team/connections` carrying
 * `{ endpoint, token, org, shareMode, sources }` — see `addCentralState.ts`'s docstring for why
 * the connection is never created before the rules are chosen.
 *
 * Step 1 no longer forces a SEPARATE "Test connection" click before "Continue" unlocks — the
 * primary button (`handlePrimaryClick`) runs the test itself (`testing…` → the identity note →
 * a brief `Success!` on the button) and only then advances to step 2, exactly the single action
 * the product asked for. An explicit "Test connection" affordance stays for anyone who wants to
 * check first without committing to move on; both actions share the same `canAttemptTest` guard,
 * so a `tokenInUse` pairing fires NO request from either one. The step-2 gate itself
 * (`canOpenRules`/`canConnect`) is unchanged — only WHO triggers the test changed, not what makes
 * step 2 reachable.
 *
 * This file is layout plus fetches: the step machine, the token unpacking, the duplicate/conflict
 * decisions, the dirty computation and the exact submit body all live in `addCentralState.ts` and
 * are unit-tested there.
 */

export interface AddCentralDrawerProps {
  open: boolean
  onClose: () => void
  /** Fired once the connection is committed — the caller (`ConnectionsPanel`) refreshes its own
   *  `/api/preferences` read rather than this drawer trying to splice the new connection in by hand. */
  onConnected: () => void
  /** The connections this panel already loaded — the ONLY source `resolveDupeState` may consult;
   *  never re-fetched here, so the duplicate/conflict decision always matches what the list beside
   *  it shows. */
  connections: TeamConnection[]
  /** MUST be the unfiltered session/project lists — same requirement `ConnectionsPanel` documents
   *  for its own `shareTargets` memo: a filtered derivative would silently shrink what step 2 can
   *  even offer to block. */
  sessions: SessionMeta[]
  projects: ServerProject[]
  modelUsage: Record<string, ModelUsage>
  lang: 'pt' | 'en'
}

export function AddCentralDrawer({
  open, onClose, onConnected, connections, sessions, projects, modelUsage, lang,
}: AddCentralDrawerProps) {
  const isMobile = useIsMobile()
  const noRepoLabel = COPY.noRepoTitle[lang]

  const [step, setStep] = useState<WizardStep>('identity')
  const [tokenInput, setTokenInput] = useState('')
  const [endpoint, setEndpoint] = useState('')
  const [test, setTest] = useState<TestOutcome>(null)
  const [testing, setTesting] = useState(false)
  // The primary button's own transient word ('idle' → 'testing' → a brief 'success' flash before
  // the step actually advances). Separate from `testing` (which also drives the standalone Test
  // button) because the two can be mid-flight from different clicks and must not fight over one
  // flag — only the primary button ever enters 'success'.
  const [primaryPhase, setPrimaryPhase] = useState<'idle' | 'testing' | 'success'>('idle')

  const [draft, setDraft] = useState<Set<string> | null>(null)
  const [projectDraft, setProjectDraft] = useState<Set<string> | null>(null)
  const [mode, setMode] = useState<ShareMode>('denylist')
  const [tab, setTab] = useState<PickerTab>(resolveInitialTab())
  const [rulesTouched, setRulesTouched] = useState(false)
  const [search, setSearch] = useState('')
  const [showStale, setShowStale] = useState(false)
  const [showAllMobile, setShowAllMobile] = useState(false)
  const [showEmptyAllowlistWarning, setShowEmptyAllowlistWarning] = useState(false)

  const [connecting, setConnecting] = useState(false)
  const [connectErr, setConnectErr] = useState<string | null>(null)

  // Computed once from the unfiltered lists, same as ConnectionsPanel's own memo — deniedKeys=[]
  // (share-everything) is the right projection for a brand-new connection's picker.
  const targets = useMemo(
    () => buildShareTargets(sessions, projects, [], { noRepo: noRepoLabel }),
    [sessions, projects, noRepoLabel],
  )
  const projectTargets = useMemo(
    () => buildProjectTargets(sessions, projects, []),
    [sessions, projects],
  )
  const defaultDraft = useMemo(() => buildDefaultDraft(targets), [targets])
  const draftDenied = draft ?? defaultDraft
  const projectDraftDenied = projectDraft ?? new Set<string>()
  const emptyStored = useMemo(() => new Set<string>(), [])
  const diff = diffDraft(draftDenied, emptyStored)
  const projectDiff = diffDraft(projectDraftDenied, emptyStored)
  // The two drafts always mean "this switch is OFF" — the WIRE shape does not (see
  // `resolveSubmittedRules`). Computed ONCE and shared by the empty-allowlist gate and the submit
  // body, exactly as `SharedReposPanel` does: passing the raw drafts into either of them made a
  // wizard-created allowlist store the one repository the user had just switched OFF, and nothing
  // else.
  const submitted = useMemo(
    () => resolveSubmittedRules(mode, targets, projectTargets, draftDenied, projectDraftDenied),
    [mode, targets, projectTargets, draftDenied, projectDraftDenied],
  )
  const partialRepoKeys = useMemo(() => partiallyDeniedRepoKeys(submitted.projectRows), [submitted])

  const bareToken = useMemo(() => unpackToken(tokenInput).token, [tokenInput])
  const dupe = resolveDupeState(connections, endpoint, bareToken)

  function resetTest() {
    setTest(null)
    setPrimaryPhase('idle')
  }

  function handleTokenChange(v: string) {
    setTokenInput(v)
    const unpacked = unpackToken(v)
    if (unpacked.endpoint) setEndpoint(unpacked.endpoint)
    resetTest()
  }
  function handleEndpointChange(v: string) {
    setEndpoint(v)
    resetTest()
  }

  /** Runs the ONE test call and returns its outcome (also stored via `setTest`, for the inline
   *  note). Callers decide what to do with the result — the standalone Test button just shows it;
   *  `handlePrimaryClick` also uses it to decide whether to advance. Never called when
   *  `canAttemptTest` is false: a `tokenInUse` pairing must fire no request from anywhere. */
  async function runTest(): Promise<TestOutcome> {
    const trimmed = endpoint.trim()
    if (!trimmed) {
      const outcome: TestOutcome = { ok: false, error: COPY.addEndpointRequired[lang] }
      setTest(outcome)
      return outcome
    }
    setTesting(true)
    setTest(null)
    try {
      const res = await fetch('/api/team/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: trimmed.replace(/\/+$/, ''), token: bareToken }),
      })
      const data = await res.json().catch(() => ({})) as { ok?: boolean; error?: string; user?: string; org?: string }
      const outcome: TestOutcome = data.ok
        ? { ok: true, user: data.user ?? '', org: data.org }
        : { ok: false, error: data.error ?? COPY.couldNotIdentify[lang] }
      setTest(outcome)
      return outcome
    } catch (err) {
      const outcome: TestOutcome = { ok: false, error: err instanceof Error ? err.message : COPY.networkError[lang] }
      setTest(outcome)
      return outcome
    } finally {
      setTesting(false)
    }
  }

  /** The standalone "Test connection" affordance — checks the identity without committing to
   *  step 2. Kept because some users want to verify before moving on; no longer required to reach
   *  step 2 at all (see `handlePrimaryClick`). */
  async function handleTestClick() {
    if (!canAttemptTest(endpoint, dupe)) return
    await runTest()
  }

  /**
   * The merged primary action (save-and-rename fix 1): one click, `testing…` → the identity note
   * → a brief `Success!` on the button → step 2. `canAttemptTest` is checked FIRST — a token
   * already claimed by another connection, or no endpoint typed, fires no request at all, the
   * same guard `handleTestClick` uses. On failure the button returns to idle and the inline error
   * (already rendered from `test`) explains what to fix; nothing is created either way — that
   * still requires the step-2 Connect click, per `canConnect`.
   */
  async function handlePrimaryClick() {
    if (!canAttemptTest(endpoint, dupe)) return
    setPrimaryPhase('testing')
    const outcome = await runTest()
    if (canOpenRules(outcome, dupe)) {
      setPrimaryPhase('success')
      setTimeout(() => { setStep('rules'); setPrimaryPhase('idle') }, 450)
    } else {
      setPrimaryPhase('idle')
    }
  }

  function backToIdentity() {
    setStep('identity')
  }

  function onToggleRow(target: Parameters<typeof toggleTarget>[1], nextShared: boolean) {
    setDraft(toggleTarget(draftDenied, target, nextShared))
    setRulesTouched(true)
  }
  function onShareAll() {
    setDraft(shareAllDraft(targets))
    setRulesTouched(true)
  }
  function onBlockAll() {
    setDraft(blockAllDraft(targets))
    setRulesTouched(true)
  }
  function onToggleProjectRow(target: ProjectTarget, nextShared: boolean) {
    setProjectDraft(toggleProjectTarget(projectDraftDenied, target, nextShared, isProjectLocked(target, draftDenied)))
    setRulesTouched(true)
  }
  function onShareAllProjects() {
    setProjectDraft(shareAllProjectsDraft(projectTargets))
    setRulesTouched(true)
  }
  function onBlockAllProjects() {
    setProjectDraft(blockAllProjectsDraft(projectTargets))
    setRulesTouched(true)
  }
  function onModeChange(next: ShareMode) {
    setMode(next)
    setShowEmptyAllowlistWarning(false)
    setRulesTouched(true)
  }

  async function handleConnect() {
    if (!canConnect(step, test, dupe) || !test?.ok) return
    if (isEmptyAllowlist(mode, submitted.repoKeys, submitted.projectPaths)) {
      setShowEmptyAllowlistWarning(true)
      return
    }
    setConnecting(true)
    setConnectErr(null)
    const body = buildSubmitBody({
      endpoint, token: bareToken, org: test.org ?? '', mode, submitted,
    })
    try {
      const res = await fetch('/api/team/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({})) as { error?: string }
      if (!res.ok) { setConnectErr(data.error ?? `HTTP ${res.status}`); return }
      onConnected()
      handleClose()
    } catch (err) {
      setConnectErr(err instanceof Error ? err.message : COPY.networkError[lang])
    } finally {
      setConnecting(false)
    }
  }

  function handleClose() {
    setStep('identity')
    setTokenInput('')
    setEndpoint('')
    setTest(null)
    setPrimaryPhase('idle')
    setDraft(null)
    setProjectDraft(null)
    setMode('denylist')
    setTab(resolveInitialTab())
    setRulesTouched(false)
    setSearch('')
    setShowEmptyAllowlistWarning(false)
    setConnectErr(null)
    onClose()
  }

  const dirty = computeDirty(tokenInput, endpoint, rulesTouched)

  return (
    <Drawer open={open} title={COPY.addTitle[lang]} onClose={handleClose} dirty={dirty} lang={lang}>
      {step === 'identity' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-tertiary)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 6 }}>
            {COPY.addStep1Title[lang]}
          </div>

          <FieldInput
            label={COPY.addTokenLabel[lang]}
            sub={COPY.addTokenSub[lang]}
            value={tokenInput}
            onChange={handleTokenChange}
            type="password"
            placeholder="act1_…"
          />
          <FieldInput
            label={COPY.addEndpointLabel[lang]}
            value={endpoint}
            onChange={handleEndpointChange}
            placeholder="https://central.example.com"
          />

          {dupe.kind === 'duplicate' && (
            <InlineNote tone="warn">{COPY.dupCentral[lang]}</InlineNote>
          )}
          {dupe.kind === 'tokenInUse' && (
            <InlineNote tone="error">
              {interpolate(COPY.tokenInUse[lang], { central: hostOf(dupe.existing.endpoint) })}
            </InlineNote>
          )}

          {/* The standalone check — optional, never required to reach step 2. Same
             `canAttemptTest` guard as the primary button below, so a tokenInUse pairing fires no
             request from either one. */}
          <div style={{ display: 'flex', gap: 8, marginTop: 4, flexDirection: isMobile ? 'column' : 'row' }}>
            <button
              type="button"
              onClick={() => { void handleTestClick() }}
              disabled={testing || !canAttemptTest(endpoint, dupe)}
              style={{ ...actionBtnStyle(isMobile, 'secondary'), opacity: (testing || !canAttemptTest(endpoint, dupe)) ? 0.5 : 1 }}
            >
              {testing && primaryPhase === 'idle'
                ? <><AgentisticsLoader size={13} /> {COPY.testingConn[lang]}</>
                : COPY.testConnBtn[lang]}
            </button>
          </div>

          {test && (
            test.ok ? (
              <InlineNote tone="ok">
                {test.org
                  ? interpolate(COPY.testOkIdentity[lang], { user: test.user, org: test.org })
                  : interpolate(COPY.testOkIdentityNoOrg[lang], { user: test.user })}
              </InlineNote>
            ) : (
              <InlineNote tone="error">{test.error}</InlineNote>
            )
          )}

          {/* The merged primary action (save-and-rename fix 1): pressing this alone tests the
             connection AND, on success, continues into step 2 — no separate "Test connection"
             click is required to unlock it anymore. */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
            <button
              type="button"
              onClick={() => { void handlePrimaryClick() }}
              disabled={primaryPhase !== 'idle' || !canAttemptTest(endpoint, dupe)}
              style={{
                ...actionBtnStyle(isMobile, 'primary'),
                opacity: (primaryPhase === 'idle' && canAttemptTest(endpoint, dupe)) ? 1 : 0.6,
                cursor: (primaryPhase === 'idle' && canAttemptTest(endpoint, dupe)) ? 'pointer' : 'not-allowed',
              }}
            >
              {primaryPhase === 'testing' && <><AgentisticsLoader size={13} /> {COPY.testingConn[lang]}</>}
              {primaryPhase === 'success' && <><Check size={14} /> {COPY.testSuccess[lang]}</>}
              {primaryPhase === 'idle' && COPY.continueBtn[lang]}
            </button>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-tertiary)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            {COPY.addStep2Title[lang]}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            {COPY.addRulesIntro[lang]}
          </div>

          <SharingRulesPicker
            mode={mode}
            onModeChange={onModeChange}
            tab={tab}
            onTabChange={setTab}
            lang={lang}
            isMobile={isMobile}
            targets={targets}
            projectTargets={projectTargets}
            draftDenied={draftDenied}
            projectDraftDenied={projectDraftDenied}
            diff={diff}
            projectDiff={projectDiff}
            partialRepoKeys={partialRepoKeys}
            search={search}
            onSearch={setSearch}
            showStale={showStale}
            onToggleStale={() => setShowStale(v => !v)}
            showAllMobile={showAllMobile}
            onShowAllMobile={() => setShowAllMobile(true)}
            showEmptyAllowlistWarning={showEmptyAllowlistWarning}
            onToggleRow={onToggleRow}
            onShareAll={onShareAll}
            onBlockAll={onBlockAll}
            onToggleProjectRow={onToggleProjectRow}
            onShareAllProjects={onShareAllProjects}
            onBlockAllProjects={onBlockAllProjects}
          />

          {connectErr && <InlineNote tone="error">{connectErr}</InlineNote>}

          <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{COPY.whatIsPushed[lang]}</div>

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8, flexDirection: isMobile ? 'column-reverse' : 'row' }}>
            <button type="button" onClick={backToIdentity} disabled={connecting} style={actionBtnStyle(isMobile, 'secondary')}>
              {COPY.backBtn[lang]}
            </button>
            <button
              type="button"
              onClick={() => { void handleConnect() }}
              disabled={connecting || !canConnect(step, test, dupe)}
              style={{
                ...actionBtnStyle(isMobile, 'primary'),
                opacity: (connecting || !canConnect(step, test, dupe)) ? 0.5 : 1,
                cursor: (connecting || !canConnect(step, test, dupe)) ? 'not-allowed' : 'pointer',
              }}
            >
              {connecting ? <AgentisticsLoader size={13} /> : <Check size={14} />}
              {COPY.connectBtn[lang]}
            </button>
          </div>
        </div>
      )}
    </Drawer>
  )
}

function InlineNote({ tone, children }: { tone: 'ok' | 'warn' | 'error'; children: ReactNode }) {
  const palette = {
    ok: { bg: 'color-mix(in srgb, var(--accent-green) 12%, transparent)', color: 'var(--accent-green)' },
    warn: { bg: 'color-mix(in srgb, var(--anthropic-orange) 10%, transparent)', color: 'var(--anthropic-orange)' },
    error: { bg: 'color-mix(in srgb, var(--accent-red) 10%, transparent)', color: 'var(--accent-red)' },
  }[tone]
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 7, padding: '8px 10px', borderRadius: 7,
      background: palette.bg, color: palette.color, fontSize: 11.5, lineHeight: 1.5,
    }}>
      {tone === 'error' && <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 1 }} />}
      <span>{children}</span>
    </div>
  )
}

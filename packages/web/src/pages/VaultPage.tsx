import { AgentisticsLoader } from '../components/AgentisticsLoader'
/**
 * /vault — the ONE vault page (VAULT v4, owner-approved 2026-10-06: "tá perfeito! implementa exatamente
 * assim"). Locked: only the centred safe and its way in (the safe IS the title). Unlocked: the page
 * header (glyph, "Cofre", the code clock), then four tabs — Segredos · Métodos de desbloqueio ·
 * Dispositivos · Configurações — each an area header and rows of one line. The old Settings → Vault
 * screen is folded in here (its controls in `vault/VaultAreas.tsx`, its flows in `VaultFlows.tsx`) and
 * its route redirects to the tab that holds them.
 *
 * Nothing here decides what an action asks: every call goes to the server's gate; when it answers
 * `stepup-required` the page asks for the code once and retries (`withStepUp`), and while a request
 * that needs the gesture is in flight the page says "confirm on this computer". A value exists in this
 * page only after a reveal, in one row's state, for 30 seconds; copying overwrites the clipboard after
 * 30 seconds too.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useOutletContext, useSearchParams } from 'react-router-dom'
import { Copy, Eye, EyeOff, FileUp, FolderInput, FolderPlus, History, Info, KeyRound, Pencil, Plus, Replace, RotateCcw, Search, ShieldCheck, Trash2, X } from 'lucide-react'
import { VaultGlyph as VaultIcon } from '../components/vault/VaultGlyph'
import { Checkbox, ConfirmModal, DialogActions, FieldInput, Select, dialogButtonStyle } from './settings/primitives'
import { Field, TabStrip, inputStyle } from '../components/sessions/formBits'
import { BandOverflowMenu, type BandOverflowEntry } from '../components/sessions/bandControls'
import type { AppContext } from '../lib/app-context'
import { useIsMobile } from '../hooks/useIsMobile'
import { Err, card, overlay } from '../components/MfaSetup'
import { codeComplete, loadVault, vaultPost, type Reply, type VaultItem } from '../lib/vaultApi'
import { itemStateKey, kindKey, orderItems, reasonKey, vt } from '../lib/vaultText'
import { resolvePaging } from '../components/team/tablePaging'
import {
  KIND_FIELDS, PERSONAL_KINDS, REVEAL_HIDE_MS, copyWithAutoClear, createGroup, createPersonal, defaultImportChoices, deleteGroup, editPersonal,
  filterPersonal, importCommit, importPreview, importReady, listPersonal, listVersions, movePersonal, parseTags, purgePersonal, renameGroup,
  USE_ONLY_DEFAULT, isUseOnly, restorePersonal, restoreVersion, revealPersonal, trashPersonal, withStepUp,
  type ImportChoice, type ImportKey, type PersonalFilter, type PersonalGroup, type PersonalKind, type PersonalMeta,
} from '../lib/vaultPersonal'
import { pt_, type PKey } from '../lib/personalText'
import { hasPasskeyHere, mobileState, passkeySupport, phoneGesture, type MobileState } from '../lib/passkey'
import { CodeField } from '../components/vault/VaultUnlock'
import { VaultCodeStage, VaultStage } from '../components/vault/VaultStage'
import { VaultCodeClock } from '../components/vault/VaultCodeClock'
import { lockedPhoneBox, phoneFacts, type PhoneFacts } from '../lib/phoneVault'
import { VAULT_TABS, parseVaultTab, type VaultTab } from './vault/vaultTabs'
import { VaultFlowHost, useVaultControls } from './vault/useVaultControls'
import { DevicesArea, MethodsArea, SettingsArea, type Gated } from './vault/VaultAreas'
import { AreaHead, InfoBlocks, LearnMore, Pill, Rows, Sheet, TextButton, TextField, VaultRow, hotBtn, iconBtn, pageBtn } from './vault/vaultUi'

type Lang = 'en' | 'pt'
type State = { kind: 'loading' } | { kind: 'locked' } | { kind: 'code'; error: string | null } | { kind: 'ready' } | { kind: 'failed' }

/**
 * The page's state, its load and its `gated` runner — shared by the page and the FAB's quick panel
 * (`QuickVault`), so the two can never disagree about what a reveal asks or how a locked vault opens.
 */
export function usePersonalVault() {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [items, setItems] = useState<PersonalMeta[]>([])
  const [groups, setGroups] = useState<PersonalGroup[]>([])
  // VAULT.UX-R2 item 10: the secrets Agentistics keeps for itself (GET /api/vault's inventory) — names,
  // files, dates and states, never a value — listed beside the person's own, in ONE list.
  const [systemItems, setSystemItems] = useState<VaultItem[]>([])
  const [busyHello, setBusyHello] = useState(false)
  // The code dialog the gate asks for: resolved with the typed code, or null when cancelled.
  const [codeAsk, setCodeAsk] = useState<null | ((code: string | null) => void)>(null)
  const askCode = useCallback(() => new Promise<string | null>(res => setCodeAsk(() => (c: string | null) => { setCodeAsk(null); res(c) })), [])
  // §7: on a page NOT on this computer (the phone), a gesture is a passkey token, never a Hello prompt.
  const [mobile, setMobile] = useState<MobileState | null>(null)
  const [lockedPhone, setLockedPhone] = useState<PhoneFacts | null>(null)
  const isPhone = mobile !== null && !mobile.loopback
  const host = typeof window !== 'undefined' ? window.location.hostname : ''
  const canPasskey = isPhone && passkeySupport(window) === 'ok' && hasPasskeyHere(mobile, host)
  /**
   * Run a gated call: the code when asked. With `gesture`, on the computer the service raises Windows
   * Hello ("confirm on this computer"); on the phone the passkey is asked FIRST and its single-use token,
   * bound to exactly this action + target, rides the call.
   */
  const gated = useCallback(async <T,>(run: (code?: string, token?: string) => Promise<Reply<T>>, gesture: false | { action: string; target: string }): Promise<Reply<T>> => {
    if (gesture && canPasskey) {
      setBusyHello(true)
      try {
        const g = await withStepUp(c => phoneGesture(gesture.action, gesture.target, c), askCode)
        if (!g.ok) return g as Reply<T>
        return await withStepUp(c => run(c, g.gestureToken), askCode)
      } finally { setBusyHello(false) }
    }
    if (gesture && !isPhone) setBusyHello(true)
    try { return await withStepUp(c => run(c), askCode) } finally { setBusyHello(false) }
  }, [askCode, canPasskey, isPhone])

  const load = useCallback(async () => {
    const v = await loadVault()
    if (v.kind === 'failed') { setState({ kind: 'failed' }); return }
    const pf = await phoneFacts()
    if (pf.ok) setLockedPhone(pf)
    if (v.view.state !== 'open') { setState({ kind: 'locked' }); return }
    if (v.kind === 'view') setSystemItems(orderItems(v.view.items))
    const r = await listPersonal()
    if (r.ok) {
      setItems(r.items); setGroups(r.groups); setState({ kind: 'ready' })
      const ms = await mobileState()
      if (ms.ok) setMobile({ passkeys: ms.passkeys, codeReveal: ms.codeReveal, loopback: ms.loopback, devices: ms.devices })
      return
    }
    if (r.code === 'stepup-required' || r.status === 401) { setState(s => ({ kind: 'code', error: s.kind === 'code' ? s.error : null })); return }
    if (r.code === 'locked') { setState({ kind: 'locked' }); return }
    setState({ kind: 'failed' })
  }, [])
  useEffect(() => { void load() }, [load])
  return { state, setState, items, setItems, groups, setGroups, systemItems, busyHello, codeAsk, mobile, setMobile, lockedPhone, isPhone, host, gated, load }
}

export default function VaultPage() {
  const ctx = useOutletContext<AppContext>()
  const lang: Lang = ctx.lang === 'pt' ? 'pt' : 'en'
  const t = (k: PKey, v?: Record<string, string | number>) => pt_(k, lang, v)
  const isMobile = useIsMobile()
  const location = useLocation()
  const [, setSearchParams] = useSearchParams()
  const tab = parseVaultTab(location.search)
  const pickTab = (next: VaultTab) => setSearchParams(p => { p.set('tab', next); p.delete('show'); return p }, { replace: true })
  const [toast, setToast] = useState<string | null>(null)
  // A vault that WAS open and is now locked (auto-lock, the Lock button) closes its safe on the way in.
  const wasReady = useRef(false)
  const personal = usePersonalVault()
  const { state, setState, busyHello, codeAsk, mobile, setMobile, lockedPhone, isPhone, host, gated, load } = personal
  const c = useVaultControls(lang)
  useEffect(() => { if (state.kind === 'ready') wasReady.current = true }, [state.kind])
  // The controls poll the service: when it reports the vault no longer open (auto-lock), the page follows.
  const serviceState = c.view?.state
  useEffect(() => { if (state.kind === 'ready' && serviceState && serviceState !== 'open') void load() }, [serviceState]) // eslint-disable-line react-hooks/exhaustive-deps

  const flash = (s: string) => { setToast(s); setTimeout(() => setToast(cur => (cur === s ? null : cur)), 4000) }
  const refreshMobile = () => { void mobileState().then(ms => { if (ms.ok) setMobile({ passkeys: ms.passkeys, codeReveal: ms.codeReveal, loopback: ms.loopback, devices: ms.devices }) }) }
  const pageWrap: React.CSSProperties = { width: '100%', maxWidth: 1020, margin: '0 auto', padding: isMobile ? '22px 16px 96px' : '28px 28px 70px', boxSizing: 'border-box' }

  const header = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 5, flexWrap: isMobile ? 'wrap' : 'nowrap' }}>
      <span aria-hidden style={{ width: 36, height: 36, borderRadius: 10, display: 'grid', placeItems: 'center', background: 'var(--anthropic-orange-dim)', color: 'var(--anthropic-orange)', flexShrink: 0 }}><VaultIcon size={19} /></span>
      <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>{t('title')}</h1>
      {state.kind === 'ready' && <VaultCodeClock lang={lang} style={{ marginLeft: isMobile ? 0 : 'auto', flexBasis: isMobile ? '100%' : undefined }} />}
    </div>
  )

  if (state.kind === 'loading') return <div style={pageWrap}>{header}<div style={{ color: 'var(--text-tertiary)', fontSize: 13 }}><AgentisticsLoader size={14} /></div></div>
  if (state.kind === 'failed') return <div style={pageWrap}>{header}<Err text={t('network')} /></div>
  if (state.kind === 'locked') {
    // §10: unlock RIGHT HERE — Hello on this computer, the phone's own ways on a phone — under a centred
    // safe whose dial turns while it happens and whose door opens before the content appears.
    const box = lockedPhoneBox(lockedPhone && {
      loopback: lockedPhone.loopback,
      passkeys: lockedPhone.passkeys,
      devices: lockedPhone.devices,
      secure: lockedPhone.secure && window.isSecureContext !== false,
    })
    return (
      // No page header here: the safe in the centre IS the title (owner, 2026-10-05).
      <div style={pageWrap}>
        <VaultStage lang={lang} isMobile={isMobile} fromOpen={wasReady.current} onAction={c.onAction} onOpened={() => { wasReady.current = false; void load() }}
          extra={c.canRecover ? <div style={{ marginTop: 8 }}><TextButton onClick={() => c.setRecoverOpen(true)}>{vt('rec_recover', lang)}</TextButton></div> : undefined} />
        {box !== 'none' && (
          <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: '14px 16px', margin: '18px auto 0', maxWidth: 430 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>{t('phoneTitle')}</div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 10 }}>{t('phoneLockedRegister')}</div>
            {box === 'insecure' && <div style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.55, marginBottom: 10 }}>{t('phoneInsecure')}</div>}
            <button type="button" onClick={() => window.location.reload()} style={dialogButtonStyle('secondary', isMobile)}>{t('phoneReload')}</button>
          </div>
        )}
        <VaultFlowHost c={c} lang={lang} isMobile={isMobile} onChanged={() => { void load() }} />
      </div>
    )
  }
  if (state.kind === 'code') {
    return (
      <div style={pageWrap}>
        <VaultCodeStage lang={lang} isMobile={isMobile} title={t('codeStageTitle')} sub={t('codeStageSub')} error={state.error} onSubmit={async code => {
          const r = await vaultPost<{ grant: string }>('/api/vault/stepup', { code })
          if (!r.ok) { setState({ kind: 'code', error: r.sentence || t('network') }); return }
          await load()
        }} />
      </div>
    )
  }

  const view = c.view
  return (
    <div style={pageWrap} data-vault-page>
      {header}
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: isMobile ? '2px 0 18px' : '0 0 18px' }}>{t('pageIntro')}</p>

      {c.showBanner && view && (
        // The first-time setup (authenticator, personal confirmation, recovery key) — the wizard opens from here.
        <div role="status" style={{ marginBottom: 18 }}>
          <VaultRow data="setup" isMobile={isMobile} icon={<ShieldCheck size={16} />} title={vt('ultraTitle', lang)}
            desc={view.requirePresence ? vt('ultraRequired', lang) : vt('ultraBody', lang)}>
            {!view.requirePresence && <button type="button" style={pageBtn(isMobile)} onClick={c.dismiss}>{vt('ultraLater', lang)}</button>}
            <button type="button" style={hotBtn(isMobile)} onClick={() => c.setWizard(c.steps)}>{vt('ultraStart', lang)}</button>
          </VaultRow>
        </div>
      )}

      <TabStrip<VaultTab> variant="underline" tabs={VAULT_TABS} value={tab} onPick={pickTab} ariaLabel={t('areasLabel')} tap={isMobile ? 44 : undefined}
        label={id => t(`tab_${id}` as PKey)} />

      {busyHello && <div role="status" aria-live="polite" style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, fontWeight: 600, marginBottom: 10 }}><AgentisticsLoader size={14} /> {t('confirmHello')}</div>}
      {toast && <div role="status" style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 10 }}>{toast}</div>}

      {tab === 'secrets' && <SecretsArea lang={lang} isMobile={isMobile} personal={personal} pending={(view?.items ?? []).filter(i => i.state === 'pending').length} onFlash={flash} />}
      {tab === 'methods' && <MethodsArea lang={lang} isMobile={isMobile} c={c} mobile={mobile} isPhone={isPhone} onGoDevices={() => pickTab('devices')} />}
      {tab === 'devices' && <DevicesArea lang={lang} isMobile={isMobile} mobile={mobile} isPhone={isPhone} host={host} gated={gated} onChanged={refreshMobile} />}
      {tab === 'settings' && <SettingsArea lang={lang} isMobile={isMobile} c={c} isPhone={isPhone} gated={gated} onFlash={flash} />}

      <VaultFlowHost c={c} lang={lang} isMobile={isMobile} onChanged={() => { void load() }} />
      {codeAsk && <CodeDialog lang={lang} isMobile={isMobile} onDone={codeAsk} />}
    </div>
  )
}

// ── Segredos ─────────────────────────────────────────────────────────────────────────────────

/** ONE list: the person's secrets (paged, filtered) and, under them, the ones Agentistics keeps for itself. */
function SecretsArea({ lang, isMobile, personal, pending, onFlash }: {
  lang: Lang; isMobile: boolean; personal: ReturnType<typeof usePersonalVault>; pending: number; onFlash: (s: string) => void
}) {
  const t = (k: PKey, v?: Record<string, string | number>) => pt_(k, lang, v)
  const { items, setItems, groups, systemItems, gated, load } = personal
  const [filter, setFilter] = useState<PersonalFilter>({ q: '', kind: 'all', groupId: 'all', trash: false })
  const [qLive, setQLive] = useState('')
  const [page, setPage] = useState(0)
  const [size, setSize] = useState(25)
  const [dialog, setDialog] = useState<{ item: PersonalMeta | null; replace?: boolean; tab?: 'create' | 'import' } | null>(null)
  const [versionsOf, setVersionsOf] = useState<PersonalMeta | null>(null)
  const [moving, setMoving] = useState<PersonalMeta | null>(null)
  const [groupsOpen, setGroupsOpen] = useState(false)
  const [learn, setLearn] = useState(false)
  const [sysDetails, setSysDetails] = useState<VaultItem | null>(null)

  // Reactive search: every keystroke, debounced 120 ms; page back to 1 whenever the filter changes.
  useEffect(() => { const id = setTimeout(() => setFilter(f => ({ ...f, q: qLive })), 120); return () => clearTimeout(id) }, [qLive])
  useEffect(() => { setPage(0) }, [filter])

  const kindLabel = useCallback((k: PersonalKind) => t(`kind_${k}` as PKey), [lang]) // eslint-disable-line react-hooks/exhaustive-deps
  const shown = useMemo(() => filterPersonal(items, groups, filter, kindLabel), [items, groups, filter, kindLabel])
  // The system secrets carry no kind of the person's and no group: a kind or group filter, or the trash, hides them.
  const showSystem = !filter.trash && filter.kind === 'all' && filter.groupId === 'all'
  const sysShown = useMemo(() => (showSystem ? filterSystem(systemItems, filter.q, lang) : []), [systemItems, filter.q, lang, showSystem])
  const paging = resolvePaging({ mode: 'maximized', total: shown.length, page, size })
  const rows = shown.slice(paging.start, paging.end)
  const groupName = (id: string | null) => (id ? groups.find(g => g.id === id)?.name ?? '' : '')
  const upsert = (m: PersonalMeta) => setItems(cur => [m, ...cur.filter(x => x.id !== m.id)])
  const mineCount = items.filter(i => !i.deletedAt).length
  const trashCount = items.filter(i => i.deletedAt).length
  const btn = pageBtn(isMobile)
  const grow: React.CSSProperties = isMobile ? { flex: 1 } : {}

  return (
    <section data-vault-area="secrets">
      <AreaHead title={t('tab_secrets')} desc={t('area_secrets_d')} isMobile={isMobile} actions={(
        <>
          <button type="button" style={{ ...btn, ...grow }} onClick={() => setDialog({ item: null, tab: 'import' })}><FileUp size={14} /> {t('importShort')}</button>
          <button type="button" style={{ ...hotBtn(isMobile), ...grow }} onClick={() => setDialog({ item: null, tab: 'create' })}><Plus size={14} /> {t('new')}</button>
        </>
      )} />

      {pending > 0 && (
        <div style={{ marginBottom: 12 }}>
          <VaultRow data="pending" isMobile={isMobile} title={`${vt('pendingTitle', lang)} · ${pending}`} desc={vt('pendingBody', lang)} status={<Pill tone="warn" text={String(pending)} />} />
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'minmax(0, 1fr) 160px 160px', gap: 8, marginBottom: 12 }}>
        <div style={{ gridColumn: isMobile ? '1 / -1' : undefined, minWidth: 0 }}>
          <Field label={t('f_search')}>
            <div style={{ position: 'relative' }}>
              <Search size={14} aria-hidden style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-tertiary)' }} />
              <input value={qLive} onChange={e => setQLive(e.target.value)} placeholder={t('searchShort')} aria-label={t('search')}
                style={{ ...inputStyle, minHeight: isMobile ? 44 : undefined }} />
            </div>
          </Field>
        </div>
        <div style={{ minWidth: 0 }}>
          <Field label={t('f_kind')}>
            <Select value={filter.kind} onChange={v => setFilter(f => ({ ...f, kind: v as PersonalFilter['kind'] }))}
              options={[{ value: 'all', label: t('allKinds') }, ...PERSONAL_KINDS.map(k => ({ value: k, label: kindLabel(k) }))]} />
          </Field>
        </div>
        <div style={{ minWidth: 0 }}>
          <Field label={t('f_group')}>
            <Select value={filter.groupId} onChange={v => setFilter(f => ({ ...f, groupId: v }))}
              options={[{ value: 'all', label: t('allGroups') }, { value: 'none', label: t('noGroup') }, ...groups.map(g => ({ value: g.id, label: g.name }))]} />
          </Field>
        </div>
      </div>
      {filter.trash && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 10 }}>
          <Trash2 size={13} aria-hidden /> <span style={{ flex: 1, minWidth: 0 }}>{t('trash')} · {t('trashNote')}</span>
          <TextButton onClick={() => setFilter(f => ({ ...f, trash: false }))}>{t('close')}</TextButton>
        </div>
      )}

      {rows.length === 0 && sysShown.length === 0
        ? <div style={{ fontSize: 13, color: 'var(--text-tertiary)', padding: '18px 0' }}>{items.length === 0 && systemItems.length === 0 ? t('empty') : t('noMatch')}</div>
        : (
          <Rows>
            {rows.map(m => (
              <SecretRow key={m.id} m={m} lang={lang} isMobile={isMobile} group={groupName(m.groupId)} groups={groups}
                gated={gated} onChanged={upsert} onRemoved={id => setItems(cur => cur.filter(x => x.id !== id))} onFlash={onFlash}
                onEdit={replace => setDialog({ item: m, replace })} onVersions={() => setVersionsOf(m)} onMove={() => setMoving(m)} />
            ))}
            {paging.end >= shown.length && sysShown.map((i, n) => <SystemSecretRow key={`${i.file}-${n}`} item={i} lang={lang} isMobile={isMobile} onDetails={() => setSysDetails(i)} />)}
          </Rows>
        )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 12, fontSize: 12, color: 'var(--text-secondary)' }}>
        <span>{t('countLine', { n: mineCount + systemItems.length, s: systemItems.length })}</span>
        <span aria-hidden>·</span>
        <TextButton onClick={() => setGroupsOpen(true)}>{t('manageGroups')}</TextButton>
        <span aria-hidden>·</span>
        <TextButton pressed={filter.trash} onClick={() => setFilter(f => ({ ...f, trash: !f.trash }))}>{t('trash')} ({trashCount})</TextButton>
        <span aria-hidden>·</span>
        <LearnMore label={t('learnMore')} onClick={() => setLearn(true)} />
        {shown.length > 10 && (
          <div style={{ display: 'inline-flex', gap: 8, alignItems: 'center', marginLeft: isMobile ? 0 : 'auto', flexWrap: 'wrap' }}>
            <span>{t('showing', { a: paging.start + 1, b: paging.end, n: shown.length })}</span>
            {paging.paged && (
              <>
                <button type="button" style={btn} disabled={paging.page === 0} onClick={() => setPage(paging.page - 1)}>{t('prev')}</button>
                <span>{paging.page + 1} / {paging.pageCount}</span>
                <button type="button" style={btn} disabled={paging.page + 1 >= paging.pageCount} onClick={() => setPage(paging.page + 1)}>{t('next')}</button>
              </>
            )}
            <div style={{ width: 80 }} aria-label={t('perPage')}>
              <Select value={String(paging.size)} onChange={v => setSize(Number(v))} options={paging.sizes.map(n => ({ value: String(n), label: String(n) }))} />
            </div>
            {t('perPage')}
          </div>
        )}
      </div>

      {dialog && (
        <SecretDialog lang={lang} isMobile={isMobile} item={dialog.item} replace={dialog.replace === true} initialTab={dialog.tab ?? 'create'} groups={groups} gated={gated}
          defaultGroup={filter.groupId !== 'all' && filter.groupId !== 'none' ? filter.groupId : null}
          onClose={() => setDialog(null)} onSaved={m => { upsert(m); setDialog(null) }} onImported={s => { setDialog(null); onFlash(s); void load() }} />
      )}
      {versionsOf && <VersionsDialog lang={lang} isMobile={isMobile} item={versionsOf} gated={gated} onClose={() => setVersionsOf(null)} onRestored={m => { upsert(m); setVersionsOf(null) }} />}
      {moving && <MoveDialog lang={lang} isMobile={isMobile} item={moving} groups={groups} gated={gated} onClose={() => setMoving(null)} onMoved={m => { upsert(m); setMoving(null) }} />}
      {groupsOpen && <GroupsDialog lang={lang} isMobile={isMobile} groups={groups} items={items} gated={gated} onClose={() => setGroupsOpen(false)} onChanged={() => { void load() }} />}
      {learn && (
        <Sheet closeLabel={t('close')} isMobile={isMobile} title={t('tab_secrets')} onClose={() => setLearn(false)}
          footer={<DialogActions><button type="button" onClick={() => setLearn(false)} style={dialogButtonStyle('secondary', isMobile)}>{t('close')}</button></DialogActions>}>
          <InfoBlocks blocks={[
            { body: t('intro') }, { h: t('systemMeta'), body: t('systemNote') }, { h: t('trash'), body: t('trashNote') },
            { h: t('useOnly'), body: t('useOnlyHelp') }, { h: t('copy'), body: `${t('copied')} ${t('clipboardWarn')}` }, { body: t('neverPaste') },
          ]} />
        </Sheet>
      )}
      {sysDetails && <SystemDetails item={sysDetails} lang={lang} isMobile={isMobile} onClose={() => setSysDetails(null)} />}
    </section>
  )
}

/** The system secrets a search keeps: matched on the kind's words (both languages' reading) and the file. */
export function filterSystem(list: VaultItem[], q: string, lang: Lang): VaultItem[] {
  const needle = q.trim().toLowerCase()
  if (!needle) return list
  return list.filter(i => `${vt(kindKey(i.kind), lang)} ${i.file}`.toLowerCase().includes(needle))
}

const fmtWhen = (iso: string, lang: Lang) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(lang === 'pt' ? 'pt-BR' : 'en-US') }
const fmtDay = (iso: string, lang: Lang) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(lang === 'pt' ? 'pt-BR' : 'en-US') }

/** One secret Agentistics keeps for itself: name, date and state — never a value, never Ver/Copiar. */
function SystemSecretRow({ item: i, lang, isMobile, onDetails }: { item: VaultItem; lang: Lang; isMobile: boolean; onDetails: () => void }) {
  const t = (k: PKey, v?: Record<string, string | number>) => pt_(k, lang, v)
  const meta = [t('systemMeta'), i.sealedAt ? t('sealedOn', { date: fmtDay(i.sealedAt, lang) }) : ''].filter(Boolean).join(' · ')
  const entries: BandOverflowEntry[] = [{ id: 'details', label: t('details'), icon: <Info size={14} />, onSelect: onDetails }]
  return (
    <VaultRow data="system" stackActions isMobile={isMobile} icon={<ShieldCheck size={16} />} title={vt(kindKey(i.kind), lang)} desc={meta}
      status={i.state !== 'sealed' ? <Pill tone={i.state === 'pending' ? 'warn' : 'bad'} text={vt(itemStateKey(i.state), lang)} /> : undefined}>
      <BandOverflowMenu label={t('moreActions')} entries={entries} isMobile={isMobile} />
    </VaultRow>
  )
}

function SystemDetails({ item: i, lang, isMobile, onClose }: { item: VaultItem; lang: Lang; isMobile: boolean; onClose: () => void }) {
  const t = (k: PKey) => pt_(k, lang)
  const why = reasonKey(i.reason)
  const mono: React.CSSProperties = { fontFamily: 'var(--font-mono, ui-monospace, monospace)', overflowWrap: 'anywhere' }
  return (
    <Sheet closeLabel={t('close')} isMobile={isMobile} title={vt(kindKey(i.kind), lang)} onClose={onClose}
      footer={<DialogActions><button type="button" onClick={onClose} style={dialogButtonStyle('secondary', isMobile)}>{t('close')}</button></DialogActions>}>
      <InfoBlocks blocks={[
        { body: t('systemNote') },
        { h: t('details'), body: (
          <>
            <span style={mono}>{i.file}</span><br />
            {vt(itemStateKey(i.state), lang)}
            {i.sealedAt && <><br />{vt('sealedAt', lang)}: {fmtWhen(i.sealedAt, lang)}</>}
            {why && <><br />{vt(why, lang)}</>}
            {i.restoreWith && <><br />{vt('howToReenter', lang)}: <span style={mono}>{i.restoreWith}</span></>}
          </>
        ) },
      ]} />
    </Sheet>
  )
}

// ── the FAB's quick vault ────────────────────────────────────────────────────────────────────

/**
 * The personal vault as a quick sheet, opened from the chat button's vault icon (owner 2026-10-03):
 * search + the list + reveal/copy, from anywhere. The SAME hook, rows and unlock as the page — a
 * locked vault shows the shared inline unlock, a list that owes its code asks it here. Managing a
 * secret (versions, groups, trash) stays on the page, one link away.
 */
export function QuickVault({ lang, isMobile, onClose }: { lang: Lang; isMobile: boolean; onClose: () => void }) {
  const t = (k: PKey, v?: Record<string, string | number>) => pt_(k, lang, v)
  const [asking, setAsking] = useState(false)
  // Escape closes the sheet — but not while a code dialog on top of it is the one being answered.
  useEffect(() => {
    if (asking) return
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h)
  }, [onClose, asking])
  const o: React.CSSProperties = isMobile ? { ...overlay, padding: 0, zIndex: 3000 } : { ...overlay, zIndex: 3000 }
  const c: React.CSSProperties = isMobile
    ? { ...card, maxWidth: 'none', width: '100%', height: '100dvh', maxHeight: '100dvh', borderRadius: 0, border: 'none', overflowY: 'auto', boxSizing: 'border-box' }
    : { ...card, maxWidth: 560, maxHeight: '86vh', overflowY: 'auto', boxSizing: 'border-box' }
  return (
    <div style={o} role="dialog" aria-modal="true" aria-label={t('quickTitle')} onClick={onClose} data-quick-vault>
      <div style={c} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <span aria-hidden style={{ width: 30, height: 30, borderRadius: 9, display: 'grid', placeItems: 'center', background: 'var(--anthropic-orange-dim)', color: 'var(--anthropic-orange)' }}><VaultIcon size={16} /></span>
          <strong style={{ fontSize: 15, flex: 1 }}>{t('quickTitle')}</strong>
          <button type="button" className="ag-tap-icon" aria-label={t('quickClose')} onClick={onClose}
            style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: 6 }}><X size={18} /></button>
        </div>
        <QuickVaultBody lang={lang} isMobile={isMobile} onNavigate={onClose} onAsking={setAsking} />
      </div>
    </div>
  )
}

/**
 * The quick view itself — search, rows (reveal / copy), the inline unlock — WITHOUT a frame, so the
 * FAB's sheet (`QuickVault`) and the Nay panel's "Cofre" tab draw exactly the same thing.
 * `onNavigate` runs before "open the whole vault" navigates (the sheet closes; the tab has nothing to).
 */
export function QuickVaultBody({ lang, isMobile, onNavigate, onAsking }: { lang: Lang; isMobile: boolean; onNavigate?: () => void; onAsking?: (asking: boolean) => void }) {
  const t = (k: PKey, v?: Record<string, string | number>) => pt_(k, lang, v)
  const navigate = useNavigate()
  const { state, setState, items, setItems, groups, busyHello, codeAsk, gated, load } = usePersonalVault()
  const [q, setQ] = useState('')
  const [toast, setToast] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ item: PersonalMeta | null; replace?: boolean } | null>(null)
  const kindLabel = useCallback((k: PersonalKind) => pt_(`kind_${k}` as PKey, lang), [lang])
  const shown = useMemo(() => filterPersonal(items, groups, { q, kind: 'all', groupId: 'all', trash: false }, kindLabel), [items, groups, q, kindLabel])
  const groupName = (id: string | null) => (id ? groups.find(g => g.id === id)?.name ?? '' : '')
  const flash = (s: string) => { setToast(s); setTimeout(() => setToast(cur => (cur === s ? null : cur)), 4000) }
  useEffect(() => { onAsking?.(!!codeAsk || !!editing) }, [codeAsk, editing, onAsking])
  // The two actions share the top row, balanced: the primary (new) and the secondary (the full page).
  // Equal halves; the longer label wraps inside its own button instead of pushing the other one out.
  const half: React.CSSProperties = { flex: '1 1 0', minWidth: 0, justifyContent: 'center', whiteSpace: 'normal', textAlign: 'center', lineHeight: 1.3, minHeight: isMobile ? 44 : 36 }
  return (
    <>
      {state.kind === 'loading' && <AgentisticsLoader size={14} />}
      {state.kind === 'failed' && <Err text={t('network')} />}
      {/* Locked: the SAME centred safe as the /vault page, scaled for the panel (owner, 2026-10-05). */}
      {state.kind === 'locked' && <VaultStage lang={lang} isMobile={isMobile} compact onOpened={() => { void load() }} />}
      {state.kind === 'code' && (
        <VaultCodeStage lang={lang} isMobile={isMobile} compact title={t('codeStageTitle')} sub={t('codeStageSub')} error={state.error} onSubmit={async code => {
          const r = await vaultPost<{ grant: string }>('/api/vault/stepup', { code })
          if (!r.ok) { setState({ kind: 'code', error: r.sentence || t('network') }); return }
          await load()
        }} />
      )}
      {state.kind === 'ready' && (
        <>
          <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            <button type="button" data-quick-new style={{ ...dialogButtonStyle('primary', isMobile), ...half, width: undefined }} onClick={() => setEditing({ item: null })}>
              <Plus size={14} /> {t('new')}
            </button>
            <button type="button" data-vault-full-list title={t('quickAllHint')} style={{ ...dialogButtonStyle('secondary', isMobile), ...half, width: undefined, color: 'var(--text-primary)' }}
              onClick={() => { onNavigate?.(); navigate('/vault') }}>
              <VaultIcon size={14} /> {t('quickAll')}
            </button>
          </div>
          <VaultCodeClock lang={lang} style={{ marginBottom: 10 }} />
          <label style={{ position: 'relative', display: 'block', marginBottom: 10 }}>
            <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-tertiary)' }} />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder={t('search')} aria-label={t('search')} autoFocus={!isMobile}
              style={{ ...inputStyle, minHeight: isMobile ? 44 : undefined }} />
          </label>
          {busyHello && <div role="status" aria-live="polite" style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, fontWeight: 600, marginBottom: 10 }}><AgentisticsLoader size={14} /> {t('confirmHello')}</div>}
          {toast && <div role="status" style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 10 }}>{toast}</div>}
          {shown.length === 0
            ? <div style={{ fontSize: 13, color: 'var(--text-tertiary)', padding: '12px 0' }}>{items.filter(i => !i.deletedAt).length === 0 ? t('empty') : t('noMatch')}</div>
            : (
              <Rows>
                {shown.map(m => (
                  <SecretRow key={m.id} m={m} lang={lang} isMobile={isMobile} group={groupName(m.groupId)} groups={groups} compact
                    gated={gated} onChanged={x => setItems(cur => [x, ...cur.filter(y => y.id !== x.id)])} onRemoved={id => setItems(cur => cur.filter(x => x.id !== id))}
                    onFlash={flash} onEdit={replace => setEditing({ item: m, replace })} onVersions={() => {}} onMove={() => {}} />
                ))}
              </Rows>
            )}
        </>
      )}
      {editing && (
        <SecretDialog lang={lang} isMobile={isMobile} item={editing.item} replace={editing.replace === true} initialTab="create" groups={groups} gated={gated} defaultGroup={null}
          onClose={() => setEditing(null)} onSaved={m => { setItems(cur => [m, ...cur.filter(y => y.id !== m.id)]); setEditing(null) }}
          onImported={s => { setEditing(null); flash(s); void load() }} />
      )}
      {codeAsk && <CodeDialog lang={lang} isMobile={isMobile} onDone={codeAsk} />}
    </>
  )
}

// ── one row ──────────────────────────────────────────────────────────────────────────────────

/** The field a row's own eye and copy act on: the password or the value (a login's user name is the other one). */
const primaryField = (m: PersonalMeta): string => (m.fields.includes('password') ? 'password' : m.fields.includes('value') ? 'value' : m.fields[0] ?? 'value')

function SecretRow({ m, lang, isMobile, group, groups, gated, onChanged, onRemoved, onFlash, onEdit, onVersions, onMove, compact = false }: {
  m: PersonalMeta; lang: Lang; isMobile: boolean; group: string; groups: PersonalGroup[]; gated: Gated
  onChanged: (m: PersonalMeta) => void; onRemoved: (id: string) => void; onFlash: (s: string) => void
  /** Open the dialog; `replace` = the "Substituir valor" entry of a use-only secret (value fields only). */
  onEdit: (replace?: boolean) => void; onVersions: () => void; onMove: () => void
  /** The quick panel: reveal, copy and EDIT — versions, groups and the trash stay on the page. */
  compact?: boolean
}) {
  const t = (k: PKey, v?: Record<string, string | number>) => pt_(k, lang, v)
  // field → value, for 30 s after a reveal; dropped on unmount and when the row closes.
  const [shown, setShown] = useState<Record<string, string>>({})
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [purgeAsk, setPurgeAsk] = useState(false)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  useEffect(() => () => { timers.current.forEach(clearTimeout); setShown({}) }, [])
  const hideLater = (field: string) => { timers.current.push(setTimeout(() => setShown(s => { const n = { ...s }; delete n[field]; return n }), REVEAL_HIDE_MS)) }
  const reveal = async (field: string): Promise<string | null> => {
    setError(null)
    const r = await gated((code, tk) => revealPersonal(m.id, field, code, undefined, tk), { action: 'personal-reveal', target: `${m.id}:${field}` })
    if (!r.ok) { setError(r.sentence || t('network')); return null }
    return r.value
  }
  const show = async (field: string) => {
    if (shown[field] !== undefined) { setShown(s => { const n = { ...s }; delete n[field]; return n }); return }
    const v = await reveal(field)
    if (v === null) return
    setShown(s => ({ ...s, [field]: v })); hideLater(field)
  }
  const copy = async (field: string) => {
    const v = shown[field] ?? (await reveal(field))
    if (v === null) return
    const ok = await copyWithAutoClear(v).done
    onFlash(ok ? `${t('copied')} ${t('clipboardWarn')}` : t('network'))
  }
  const toggleOpen = () => {
    if (open) { setOpen(false); setShown({}); return }
    setOpen(true); void show(primaryField(m))
  }
  const act = async (kind: 'trash' | 'restore' | 'purge') => {
    setError(null)
    const r = kind === 'trash' ? await gated((c, tk) => trashPersonal(m.id, m.version, c, tk), { action: 'personal-trash', target: m.id })
      : kind === 'restore' ? await gated((c, tk) => restorePersonal(m.id, m.version, c, tk), { action: 'personal-restore', target: m.id })
        : await gated((c, tk) => purgePersonal(m.id, c, tk), { action: 'personal-purge', target: m.id })
    if (!r.ok) { setError(r.sentence || t('network')); return }
    if (kind === 'purge') onRemoved(m.id); else onChanged((r as unknown as { meta: PersonalMeta }).meta)
  }
  const trashed = m.deletedAt !== null
  const sealed = isUseOnly(m)
  const meta = [
    t(`kind_${m.kind}` as PKey), group, sealed ? t('useOnlyBadge') : '', m.confirmEach === false ? t('confirmEachOff') : '',
    ...m.tags.map(x => `#${x}`), t('updated', { date: fmtDay(m.updatedAt, lang) }),
  ].filter(Boolean).join(' · ')
  const entries: BandOverflowEntry[] = trashed
    ? (compact ? [] : [
      { id: 'restore', label: t('restore'), icon: <RotateCcw size={14} />, onSelect: () => { void act('restore') } },
      { id: 'purge', label: t('purge'), icon: <Trash2 size={14} />, onSelect: () => setPurgeAsk(true) },
    ])
    : [
      { id: 'edit', label: t('edit'), icon: <Pencil size={14} />, onSelect: () => onEdit(false) },
      ...(sealed ? [{ id: 'replace', label: t('replaceValue'), icon: <Replace size={14} />, onSelect: () => onEdit(true) }] : []),
      ...(compact ? [] : [
        { id: 'versions', label: t('versions'), icon: <History size={14} />, onSelect: onVersions },
        ...(groups.length > 0 ? [{ id: 'move', label: t('moveTo'), icon: <FolderInput size={14} />, onSelect: onMove }] : []),
        { id: 'trash', label: t('delete'), icon: <Trash2 size={14} />, onSelect: () => { void act('trash') } },
      ]),
    ]
  const field = primaryField(m)
  const fieldName = t(`field_${field}` as PKey)
  return (
    <>
      <VaultRow data="secret" stackActions isMobile={isMobile} icon={<KeyRound size={16} style={{ color: trashed ? 'var(--text-tertiary)' : 'var(--anthropic-orange)' }} />}
        title={m.name} desc={<span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{meta}</span>}
        extra={(
          <>
            {open && !sealed && !trashed && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
                {(m.url || m.notes) && <div style={{ fontSize: 12, color: 'var(--text-secondary)', overflowWrap: 'anywhere' }}>{m.url}{m.url && m.notes ? ' · ' : ''}{m.notes}</div>}
                {m.fields.map(f => (
                  <div key={f} style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                    <span style={{ fontSize: 12, color: 'var(--text-tertiary)', width: 64, flexShrink: 0 }}>{t(`field_${f}` as PKey)}</span>
                    <code style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 12, flex: 1, minWidth: 0, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap', maxHeight: 160, overflowY: 'auto', userSelect: shown[f] !== undefined ? 'text' : 'none' }}>
                      {shown[f] !== undefined ? shown[f] : '••••••••••'}
                    </code>
                    <button type="button" className="ag-tap-icon" style={iconBtn} onClick={() => { void show(f) }} aria-label={`${shown[f] !== undefined ? t('hide') : t('reveal')} ${t(`field_${f}` as PKey)}`} title={shown[f] !== undefined ? t('hide') : t('reveal')}>
                      {shown[f] !== undefined ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                    <button type="button" className="ag-tap-icon" style={iconBtn} onClick={() => { void copy(f) }} aria-label={`${t('copy')} ${t(`field_${f}` as PKey)}`} title={t('copy')}><Copy size={14} /></button>
                  </div>
                ))}
              </div>
            )}
            {error && <div style={{ marginTop: 8 }}><Err text={error} /></div>}
          </>
        )}>
        {!sealed && !trashed && (
          <>
            <button type="button" className="ag-tap-icon" style={iconBtn} onClick={toggleOpen} aria-expanded={open}
              aria-label={`${open ? t('hide') : t('reveal')} ${fieldName}`} title={open ? t('hide') : t('reveal')}>
              {open ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
            <button type="button" className="ag-tap-icon" style={iconBtn} onClick={() => { void copy(field) }} aria-label={`${t('copy')} ${fieldName}`} title={t('copy')}><Copy size={15} /></button>
          </>
        )}
        <BandOverflowMenu label={t('moreActions')} entries={entries} isMobile={isMobile} />
      </VaultRow>
      <ConfirmModal open={purgeAsk} title={t('purge')} message={t('purgeConfirm', { name: m.name })} confirmLabel={t('purge')} cancelLabel={t('cancel')}
        onCancel={() => setPurgeAsk(false)} onConfirm={() => { setPurgeAsk(false); void act('purge') }} />
    </>
  )
}

// ── dialogs ──────────────────────────────────────────────────────────────────────────────────

/**
 * "Novo segredo", "Editar" and "Importar" — ONE dialog (VAULT v4): Criar | Importar .env / JSON for a
 * new secret, the same form alone for an edit, and only the value fields for "Substituir valor".
 */
function SecretDialog({ lang, isMobile, item, replace, initialTab, groups, gated, defaultGroup, onClose, onSaved, onImported }: {
  lang: Lang; isMobile: boolean; item: PersonalMeta | null
  /** "Substituir valor" on a use-only secret: only the value fields, nothing else on the form. */
  replace?: boolean
  initialTab: 'create' | 'import'
  groups: PersonalGroup[]; gated: Gated; defaultGroup: string | null
  onClose: () => void; onSaved: (m: PersonalMeta) => void; onImported: (summary: string) => void
}) {
  const t = (k: PKey, v?: Record<string, string | number>) => pt_(k, lang, v)
  const editing = item !== null
  const [tab, setTab] = useState<'create' | 'import'>(editing ? 'create' : initialTab)
  const [kind, setKind] = useState<PersonalKind>(item?.kind ?? 'password')
  const [name, setName] = useState(item?.name ?? '')
  const [url, setUrl] = useState(item?.url ?? '')
  const [groupId, setGroupId] = useState<string>(item?.groupId ?? defaultGroup ?? '')
  const [tags, setTags] = useState((item?.tags ?? []).join(', '))
  const [notes, setNotes] = useState(item?.notes ?? '')
  // "Sempre confirmar": ON by default (absent on an older record reads ON).
  const [confirmEach, setConfirmEach] = useState(item?.confirmEach !== false)
  // "Só uso": a NEW secret starts at the kind's default (API keys ON) until the person touches the box;
  // a sealed one stays sealed (the server refuses to lift it, so the form does not offer to).
  const sealed = item !== null && isUseOnly(item)
  const [useOnly, setUseOnly] = useState<boolean>(item ? sealed : USE_ONLY_DEFAULT['password'])
  const [useOnlyTouched, setUseOnlyTouched] = useState(false)
  // The values typed here live only in this dialog's state, until save or close.
  const [fields, setFields] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => () => setFields({}), [])
  const multiline = kind === 'env' || kind === 'note'
  const pickKind = (k: PersonalKind) => { setKind(k); if (!editing && !useOnlyTouched) setUseOnly(USE_ONLY_DEFAULT[k]) }
  const save = async () => {
    if (busy || !name.trim()) return
    setBusy(true); setError(null)
    const f: Record<string, string> = {}
    for (const k of KIND_FIELDS[kind]) if (fields[k]) f[k] = fields[k]!
    const body = { kind, name: name.trim(), url, groupId: groupId || null, tags: parseTags(tags), notes, confirmEach, ...(useOnly ? { useOnly: true } : {}), ...(Object.keys(f).length ? { fields: f } : {}) }
    const r = editing ? await gated((c, tk) => editPersonal(item.id, item.version, body, c, tk), { action: 'personal-edit', target: item.id }) : await gated(c => createPersonal(body, c), false)
    setBusy(false)
    if (!r.ok) { setError(r.sentence || t('network')); return }
    setFields({})
    onSaved(r.meta)
  }

  // ── the import tab (a .env or flat JSON file: preview the keys, choose, commit)
  const [preview, setPreview] = useState<{ token: string; keys: ImportKey[]; skipped: number } | null>(null)
  const [choices, setChoices] = useState<ImportChoice[]>([])
  const [importGroup, setImportGroup] = useState(defaultGroup ?? '')
  const fileRef = useRef<HTMLInputElement>(null)
  const onFile = async (file: File | undefined) => {
    if (!file) return
    setBusy(true); setError(null)
    // Read in the browser and sent ONCE; nothing keeps the text after this function returns.
    let text = await file.text()
    const r = await gated(c => importPreview(text, c), false)
    text = ''
    setBusy(false)
    if (!r.ok) { setError(r.sentence || t('network')); return }
    setPreview(r); setChoices(defaultImportChoices(r.keys))
  }
  const commit = async () => {
    if (!preview || busy || !importReady(choices)) return
    setBusy(true); setError(null)
    const r = await gated(c => importCommit(preview.token, choices, importGroup || null, c), false)
    setBusy(false)
    if (!r.ok) { setError(r.sentence || t('network')); return }
    onImported(t('importDone', { c: r.created, r: r.replaced, s: r.skipped }))
  }
  const setChoice = (key: string, patch: Partial<ImportChoice>) => setChoices(cs => cs.map(c => (c.key === key ? { ...c, ...patch } : c)))

  const tagList = parseTags(tags)
  const label = (text: string) => <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>{text}</div>
  const valueFields = KIND_FIELDS[kind].map(k => (
    <TextField key={k} lang={lang} label={t(`field_${k}` as PKey)} value={fields[k] ?? ''} onChange={v => setFields(cur => ({ ...cur, [k]: v }))}
      {...(multiline ? { rows: kind === 'env' ? 6 : 3, mono: true } : { secret: k === 'password' || k === 'value', mono: k !== 'login' })}
      autoComplete={k === 'login' ? 'off' : 'new-password'} {...(k === 'login' ? { placeholder: t('loginHint') } : { placeholder: t('valuePh') })}
      {...(editing ? { hint: sealed ? t('f_newValue') : t('f_keep') } : {})} />
  ))
  const groupOptions = [{ value: '', label: t('noGroup') }, ...groups.map(g => ({ value: g.id, label: g.name }))]
  const footer = tab === 'import'
    ? (
      <>
        {error && <div style={{ marginTop: 12 }}><Err text={error} /></div>}
        <DialogActions>
          <button type="button" onClick={onClose} style={dialogButtonStyle('secondary', isMobile)}>{t('cancel')}</button>
          {preview
            ? <button type="button" disabled={busy || !importReady(choices)} onClick={() => { void commit() }} style={dialogButtonStyle('primary', isMobile, busy || !importReady(choices))}>{busy && <AgentisticsLoader size={14} />} {busy ? t('working') : t('importGo')}</button>
            : <button type="button" disabled={busy} onClick={() => fileRef.current?.click()} style={dialogButtonStyle('primary', isMobile, busy)}>{busy ? <AgentisticsLoader size={14} /> : <FileUp size={14} />} {busy ? t('working') : t('chooseFile')}</button>}
        </DialogActions>
      </>
    )
    : (
      <>
        {editing && !replace && <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 12 }}>{t('editAsks')}</div>}
        {error && <div style={{ marginTop: 12 }}><Err text={error} /></div>}
        <DialogActions>
          <button type="button" onClick={onClose} style={dialogButtonStyle('secondary', isMobile)}>{t('cancel')}</button>
          <button type="submit" form="vault-edit-form" disabled={busy || !name.trim()} style={dialogButtonStyle('primary', isMobile, busy || !name.trim())}>
            {busy && <AgentisticsLoader size={14} />} {busy ? t('working') : editing ? t('save') : t('saveSecret')}
          </button>
        </DialogActions>
      </>
    )
  const title = replace && item ? `${t('replaceTitle')} · ${item.name}` : editing ? t('editTitle') : t('createTitle')
  return (
    <Sheet closeLabel={t('close')} isMobile={isMobile} title={title} onClose={onClose} footer={footer} wide={tab === 'import' && preview !== null}>
      {!editing && (
        <TabStrip<'create' | 'import'> variant="underline" tabs={['create', 'import']} value={tab} onPick={v => { setTab(v); setError(null) }}
          label={v => (v === 'create' ? t('tabCreate') : t('tabImport'))} tap={isMobile ? 44 : undefined} ariaLabel={title} />
      )}
      {tab === 'import' ? (
        <div data-vault-import>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 10, lineHeight: 1.6 }}>{t('importIntro')}</div>
          <input ref={fileRef} type="file" accept=".env,.json,application/json,text/plain,*/*" style={{ display: 'none' }} onChange={e => { void onFile(e.target.files?.[0]); e.target.value = '' }} />
          {preview && (
            <>
              {preview.skipped > 0 && <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 8 }}>{t('importSkipped', { n: preview.skipped })}</div>}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
                {preview.keys.map(k => {
                  const c = choices.find(x => x.key === k.key)!
                  return (
                    <div key={k.key} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                      <code style={{ fontSize: 12, minWidth: 0, overflowWrap: 'anywhere', flex: '1 1 140px' }}>{k.key}</code>
                      {k.clash && <span style={{ fontSize: 11, color: 'var(--anthropic-orange)' }}>{t('clash')}</span>}
                      {k.empty && <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{t('emptyValue')}</span>}
                      <div style={{ width: isMobile ? '100%' : 150 }}>
                        <Select value={c.action} onChange={v => setChoice(k.key, { action: v as ImportChoice['action'] })}
                          options={(k.clash ? ['skip', 'replace', 'rename'] as const : ['import', 'skip'] as const).map(a => ({ value: a, label: t(`act_${a}` as PKey) }))} />
                      </div>
                      {c.action === 'rename' && (
                        <div style={{ width: isMobile ? '100%' : 180 }}>
                          <FieldInput label={t('f_name')} value={c.name ?? ''} onChange={v => setChoice(k.key, { name: v })} placeholder={k.key} />
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
              <div style={{ marginBottom: 4 }}>
                {label(t('importInto'))}
                <Select value={importGroup} onChange={setImportGroup} placeholder={t('noGroup')} options={groupOptions} />
              </div>
            </>
          )}
        </div>
      ) : (
        <form id="vault-edit-form" onSubmit={e => { e.preventDefault(); void save() }}>
          {replace ? valueFields : (
            <>
              <TextField lang={lang} label={t('f_name')} value={name} onChange={setName} maxLength={120} autoFocus={!isMobile} placeholder={t('namePh')} />
              <div style={{ marginBottom: 14 }}>
                <Field label={t('f_kind')}>
                  <Select value={kind} onChange={v => pickKind(v as PersonalKind)} options={PERSONAL_KINDS.map(k => ({ value: k, label: t(`kind_${k}` as PKey) }))} />
                </Field>
              </div>
              {valueFields}
              <div data-use-only-field style={{ marginBottom: 14 }}>
                {sealed
                  ? <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}><strong style={{ color: 'var(--anthropic-orange)', fontWeight: 600 }}>{t('useOnly')}</strong> — {t('useOnlySealed')}</div>
                  : <Checkbox checked={useOnly} onChange={v => { setUseOnly(v); setUseOnlyTouched(true) }} label={`${t('useOnly')} — ${t('useOnlyShort')}`} />}
              </div>
              <div style={{ marginBottom: 14 }}>
                <Field label={t('f_group')}>
                  <Select value={groupId} onChange={setGroupId} placeholder={t('noGroup')} options={groupOptions} />
                </Field>
              </div>
              <TextField lang={lang} label={t('f_tagsShort')} value={tags} onChange={setTags} placeholder={t('tagsPh')} />
              {tagList.length > 0 && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: -8, marginBottom: 14 }}>
                  {tagList.map(tag => <span key={tag} style={{ fontSize: 11, padding: '2px 8px', borderRadius: 999, border: '1px solid var(--border)', color: 'var(--text-secondary)', background: 'var(--bg-elevated)' }}>#{tag}</span>)}
                </div>
              )}
              <details>
                <summary style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', cursor: 'pointer', padding: isMobile ? '10px 0' : '4px 0', marginBottom: 10 }}>{t('moreOptions')}</summary>
                <TextField lang={lang} label={t('f_url')} value={url} onChange={setUrl} maxLength={500} />
                <TextField lang={lang} label={t('f_notes')} value={notes} onChange={setNotes} rows={3} maxLength={4000} />
                <Checkbox checked={confirmEach} onChange={setConfirmEach} label={t('confirmEach')} />
                <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2, lineHeight: 1.5, paddingLeft: 24 }}>{t('confirmEachHelp')}</div>
              </details>
            </>
          )}
        </form>
      )}
    </Sheet>
  )
}

function VersionsDialog({ lang, isMobile, item, gated, onClose, onRestored }: { lang: Lang; isMobile: boolean; item: PersonalMeta; gated: Gated; onClose: () => void; onRestored: (m: PersonalMeta) => void }) {
  const t = (k: PKey, v?: Record<string, string | number>) => pt_(k, lang, v)
  const [list, setList] = useState<PersonalMeta[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { void listVersions(item.id).then(r => { if (r.ok) setList(r.versions); else setError(r.sentence || t('network')) }) }, [item.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const restore = async (v: number) => {
    setError(null)
    const r = await gated((c, tk) => restoreVersion(item.id, v, item.version, c, tk), { action: 'personal-restore-version', target: item.id })
    if (!r.ok) { setError(r.sentence || t('network')); return }
    onRestored(r.meta)
  }
  return (
    <Sheet closeLabel={t('close')} isMobile={isMobile} title={t('versionsTitle', { name: item.name })} onClose={onClose}
      footer={<DialogActions><button type="button" onClick={onClose} style={dialogButtonStyle('secondary', isMobile)}>{t('close')}</button></DialogActions>}>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 10, lineHeight: 1.6 }}>{t('versionsNote')}</div>
      {!list && !error && <AgentisticsLoader size={14} />}
      {list?.map(v => (
        <div key={v.version} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderTop: '1px solid var(--border)', flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 13 }}>{t('version', { n: v.version })}</strong>
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{fmtWhen(v.updatedAt, lang)} · {v.name}{v.deletedAt ? ` · ${t('trash')}` : ''}</span>
          {v.version === item.version
            ? <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--accent-green, #22c55e)' }}>{t('current')}</span>
            : <button type="button" onClick={() => { void restore(v.version) }} style={{ ...dialogButtonStyle('primary', isMobile), width: isMobile ? '100%' : undefined, marginLeft: 'auto' }}>{t('restoreThis')}</button>}
        </div>
      ))}
      {error && <Err text={error} />}
    </Sheet>
  )
}

/** "Mover para grupo": the one choice, then the move (no gesture — the server's gate says so). */
function MoveDialog({ lang, isMobile, item, groups, gated, onClose, onMoved }: { lang: Lang; isMobile: boolean; item: PersonalMeta; groups: PersonalGroup[]; gated: Gated; onClose: () => void; onMoved: (m: PersonalMeta) => void }) {
  const t = (k: PKey, v?: Record<string, string | number>) => pt_(k, lang, v)
  const [groupId, setGroupId] = useState(item.groupId ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const move = async () => {
    setBusy(true); setError(null)
    const r = await gated(c => movePersonal(item.id, item.version, groupId || null, c), false)
    setBusy(false)
    if (!r.ok) { setError(r.sentence || t('network')); return }
    onMoved(r.meta)
  }
  const same = (item.groupId ?? '') === groupId
  return (
    <Sheet closeLabel={t('close')} isMobile={isMobile} title={`${t('moveTo')} · ${item.name}`} onClose={onClose}
      footer={(
        <>
          {error && <Err text={error} />}
          <DialogActions>
            <button type="button" onClick={onClose} style={dialogButtonStyle('secondary', isMobile)}>{t('cancel')}</button>
            <button type="button" disabled={busy || same} onClick={() => { void move() }} style={dialogButtonStyle('primary', isMobile, busy || same)}>{busy ? t('working') : t('save')}</button>
          </DialogActions>
        </>
      )}>
      <Select value={groupId} onChange={setGroupId} placeholder={t('noGroup')} options={[{ value: '', label: t('noGroup') }, ...groups.map(g => ({ value: g.id, label: g.name }))]} />
    </Sheet>
  )
}

function GroupsDialog({ lang, isMobile, groups, items, gated, onClose, onChanged }: { lang: Lang; isMobile: boolean; groups: PersonalGroup[]; items: PersonalMeta[]; gated: Gated; onClose: () => void; onChanged: () => void }) {
  const t = (k: PKey, v?: Record<string, string | number>) => pt_(k, lang, v)
  const [name, setName] = useState('')
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const run = async <T,>(fn: (c?: string, tk?: string) => Promise<Reply<T>>, gesture: false | { action: string; target: string }) => {
    setError(null)
    const r = await gated(fn, gesture)
    if (!r.ok) { setError(r.sentence || t('network')); return false }
    onChanged(); return true
  }
  // Row buttons: the dialog's own shapes, content-sized even on a phone (two of them share the row).
  const small = (kind: 'secondary' | 'primary' | 'danger'): React.CSSProperties => ({ ...dialogButtonStyle(kind, isMobile), width: undefined, ...(kind === 'danger' ? { background: 'transparent', color: '#ef4444' } : null) })
  return (
    <Sheet closeLabel={t('close')} isMobile={isMobile} title={t('groups')} onClose={onClose}
      footer={<DialogActions><button type="button" onClick={onClose} style={dialogButtonStyle('secondary', isMobile)}>{t('close')}</button></DialogActions>}>
      <form onSubmit={e => { e.preventDefault(); if (name.trim()) void run(c => createGroup(name.trim(), c), false).then(ok => { if (ok) setName('') }) }}
        style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 6, flexDirection: isMobile ? 'column' : 'row' }}>
        <div style={{ flex: 1, minWidth: 0, width: isMobile ? '100%' : undefined }}>
          <FieldInput label={t('groupName')} value={name} onChange={setName} maxLength={120} />
        </div>
        <button type="submit" disabled={!name.trim()} style={{ ...dialogButtonStyle('primary', isMobile, !name.trim()), marginBottom: 14 }}><FolderPlus size={14} /> {t('newGroup')}</button>
      </form>
      {groups.map(g => (
        <div key={g.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 0', borderTop: '1px solid var(--border)', flexWrap: 'wrap' }}>
          {renaming?.id === g.id
            ? <div style={{ flex: 1, minWidth: 160 }}><FieldInput label={t('rename')} value={renaming.name} onChange={v => setRenaming({ id: g.id, name: v })} autoFocus /></div>
            : <span style={{ fontSize: 13, fontWeight: 600, flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{g.name} <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--text-tertiary)' }}>· {t('items', { n: items.filter(i => i.groupId === g.id && !i.deletedAt).length })}</span></span>}
          <div style={{ display: 'flex', gap: 8 }}>
            {renaming?.id === g.id
              ? <button type="button" onClick={() => { void run(c => renameGroup(g.id, g.version, renaming.name.trim(), c), false).then(ok => { if (ok) setRenaming(null) }) }} style={small('primary')}>{t('save')}</button>
              : <button type="button" onClick={() => setRenaming({ id: g.id, name: g.name })} style={small('secondary')}>{t('rename')}</button>}
            <button type="button" title={t('deleteGroupNote')} onClick={() => { void run((c, tk) => deleteGroup(g.id, c, tk), { action: 'personal-group-delete', target: g.id }) }} style={small('danger')}>{t('deleteGroup')}</button>
          </div>
        </div>
      ))}
      {groups.length > 0 && <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 6 }}>{t('deleteGroupNote')}</div>}
      {error && <Err text={error} />}
    </Sheet>
  )
}

/** The code the gate asked for in the middle of an action: the app's code field, the dialog footer. */
function CodeDialog({ lang, isMobile, onDone }: { lang: Lang; isMobile: boolean; onDone: (code: string | null) => void }) {
  const [code, setCode] = useState('')
  const ok = codeComplete(code)
  return (
    <Sheet closeLabel={pt_('close', lang)} isMobile={isMobile} title={pt_('codeLabel', lang)} onClose={() => onDone(null)}
      footer={(
        <DialogActions>
          <button type="button" onClick={() => onDone(null)} style={dialogButtonStyle('secondary', isMobile)}>{pt_('cancel', lang)}</button>
          <button type="submit" form="vault-code-form" disabled={!ok} style={dialogButtonStyle('primary', isMobile, !ok)}>{pt_('confirm', lang)}</button>
        </DialogActions>
      )}>
      <form id="vault-code-form" onSubmit={e => { e.preventDefault(); if (ok) onDone(code) }}>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 10, lineHeight: 1.55 }}>{pt_('needsCode', lang).replace(/ para ver a lista\.| to see the list\./, '.')}</div>
        <CodeField value={code} onChange={setCode} label={pt_('codeLabel', lang)} autoFocus />
      </form>
    </Sheet>
  )
}

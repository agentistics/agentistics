import { AgentisticsLoader } from '../components/AgentisticsLoader'
/**
 * /vault — VAULT.PERSONAL (spec `2026-10-03-vault-personal.md`). The person's OWN secrets: a paginated
 * list with a reactive search over METADATA, groups, a trash, versions, a `.env` import, and a reveal
 * that asks for confirmation every time.
 *
 * Nothing here decides what an action asks: every call goes to the server's gate; when it answers
 * `stepup-required` the page asks for the code once and retries (`withStepUp`), and while a request
 * that needs the gesture is in flight the page says "confirm on this computer". A value exists in this
 * page only after a reveal, in one row's state, for 30 seconds; copying overwrites the clipboard after
 * 30 seconds too.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useOutletContext } from 'react-router-dom'
import { Copy, Eye, EyeOff, FileUp, FolderPlus, History, KeyRound, Lock, Pencil, Plus, Replace, RotateCcw, Search, ShieldCheck, Trash2, X } from 'lucide-react'
import { VaultGlyph as VaultIcon } from '../components/vault/VaultGlyph'
import { Checkbox, ConfirmModal, DialogActions, FieldInput, FieldTextarea, Select, TabSelect, dialogButtonStyle } from './settings/primitives'
import type { AppContext } from '../lib/app-context'
import { useIsMobile } from '../hooks/useIsMobile'
import { Err, card, input, overlay, primaryBtn } from '../components/MfaSetup'
import { codeComplete, loadVault, vaultPost, type Reply, type VaultItem } from '../lib/vaultApi'
import { itemStateKey, kindKey, orderItems, reasonKey, vt } from '../lib/vaultText'
import { resolvePaging } from '../components/team/tablePaging'
import {
  KIND_FIELDS, PERSONAL_KINDS, REVEAL_HIDE_MS, copyWithAutoClear, createGroup, createPersonal, defaultImportChoices, deleteGroup, editPersonal,
  filterPersonal, importCommit, importPreview, importReady, listPersonal, listVersions, movePersonal, parseTags, purgePersonal, renameGroup,
  USE_ONLY_DEFAULT, isUseOnly, restorePersonal, restoreVersion, revealPersonal, trashPersonal, withStepUp, wipeBackupHistory,
  type ImportChoice, type ImportKey, type PersonalFilter, type PersonalGroup, type PersonalKind, type PersonalMeta,
} from '../lib/vaultPersonal'
import { pt_, type PKey } from '../lib/personalText'
import { hasPasskeyHere, mobileState, passkeySupport, phoneGesture, removePasskey, setCodeReveal, type MobileState } from '../lib/passkey'
import { CodeField, PhoneEnrol } from '../components/vault/VaultUnlock'
import { VaultCodeStage, VaultStage } from '../components/vault/VaultStage'
import { VaultCodeClock } from '../components/vault/VaultCodeClock'
import { clearStalePhones, lockedPhoneBox, phoneFacts, readDeviceKey, removeDevice, type PhoneFacts } from '../lib/phoneVault'

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

type Section = 'all' | 'mine' | 'system'

export default function VaultPage() {
  const ctx = useOutletContext<AppContext>()
  const lang: Lang = ctx.lang === 'pt' ? 'pt' : 'en'
  const t = (k: PKey, v?: Record<string, string | number>) => pt_(k, lang, v)
  const isMobile = useIsMobile()

  const [filter, setFilter] = useState<PersonalFilter>({ q: '', kind: 'all', groupId: 'all', trash: false })
  const [section, setSection] = useState<Section>(() => sectionFromUrl())
  const [qLive, setQLive] = useState('')
  const [page, setPage] = useState(0)
  const [size, setSize] = useState(25)
  const [editing, setEditing] = useState<{ item: PersonalMeta | null; replace?: boolean } | null>(null)
  const [versionsOf, setVersionsOf] = useState<PersonalMeta | null>(null)
  const [importing, setImporting] = useState(false)
  const [groupsOpen, setGroupsOpen] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [wipeAsk, setWipeAsk] = useState(false)
  // A vault that WAS open and is now locked (auto-lock, the Lock button) closes its safe on the way in.
  const wasReady = useRef(false)
  const { state, setState, items, setItems, groups, systemItems, busyHello, codeAsk, mobile, setMobile, lockedPhone, isPhone, host, gated, load } = usePersonalVault()
  useEffect(() => { if (state.kind === 'ready') wasReady.current = true }, [state.kind])

  // Reactive search: every keystroke, debounced 120 ms; page back to 1 whenever the filter changes.
  useEffect(() => { const id = setTimeout(() => setFilter(f => ({ ...f, q: qLive })), 120); return () => clearTimeout(id) }, [qLive])
  useEffect(() => { setPage(0) }, [filter])

  const kindLabel = useCallback((k: PersonalKind) => t(`kind_${k}` as PKey), [lang]) // eslint-disable-line react-hooks/exhaustive-deps
  const shown = useMemo(() => filterPersonal(items, groups, filter, kindLabel), [items, groups, filter, kindLabel])
  const sysShown = useMemo(() => filterSystem(systemItems, filter.q, lang), [systemItems, filter.q, lang])
  const paging = resolvePaging({ mode: 'maximized', total: shown.length, page, size })
  const rows = shown.slice(paging.start, paging.end)
  const groupName = (id: string | null) => (id ? groups.find(g => g.id === id)?.name ?? '' : '')
  const flash = (s: string) => { setToast(s); setTimeout(() => setToast(cur => (cur === s ? null : cur)), 4000) }
  const upsert = (m: PersonalMeta) => setItems(cur => [m, ...cur.filter(x => x.id !== m.id)])

  const btn = pageBtn(isMobile)
  const hot: React.CSSProperties = { ...btn, ...primaryBtn, width: 'auto', padding: btn.padding, minHeight: btn.minHeight }
  const pageWrap: React.CSSProperties = { maxWidth: 1100, margin: '0 auto', padding: isMobile ? '16px 16px 96px' : '24px 28px', boxSizing: 'border-box' }

  const header = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6, flexWrap: 'wrap' }}>
      <span aria-hidden style={{ width: 36, height: 36, borderRadius: 10, display: 'grid', placeItems: 'center', background: 'var(--anthropic-orange-dim)', color: 'var(--anthropic-orange)' }}><VaultIcon size={19} /></span>
      <h1 style={{ fontSize: 20, margin: 0 }}>{t('title')}</h1>
      {state.kind === 'ready' && <VaultCodeClock lang={lang} style={{ marginLeft: isMobile ? 0 : 'auto', flexBasis: isMobile ? '100%' : undefined }} />}
    </div>
  )

  if (state.kind === 'loading') return <div style={pageWrap}>{header}<div style={{ color: 'var(--text-tertiary)', fontSize: 13 }}><AgentisticsLoader size={14} /></div></div>
  if (state.kind === 'failed') return <div style={pageWrap}>{header}<Err text={t('network')} /></div>
  if (state.kind === 'locked') {
    // §10: unlock RIGHT HERE — Hello on this computer, the phone's own ways on a phone — under a centred
    // safe whose dial turns while it happens and whose door opens before the content appears.
    return (
      // No page header here: the safe in the centre IS the title (owner, 2026-10-05).
      <div style={pageWrap}>
        <VaultStage lang={lang} isMobile={isMobile} fromOpen={wasReady.current} onOpened={() => { wasReady.current = false; void load() }} />
        {lockedPhoneBox(lockedPhone && {
          loopback: lockedPhone.loopback,
          passkeys: lockedPhone.passkeys,
          devices: lockedPhone.devices,
          secure: lockedPhone.secure && window.isSecureContext !== false,
        }) !== 'none' && (
          <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: '14px 16px', margin: '18px auto 0', maxWidth: 430 }}>
            <div style={{ fontSize: 13.5, fontWeight: 700, marginBottom: 6 }}>{t('phoneTitle')}</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 10 }}>{t('phoneLockedRegister')}</div>
            {lockedPhoneBox(lockedPhone && {
              loopback: lockedPhone.loopback,
              passkeys: lockedPhone.passkeys,
              devices: lockedPhone.devices,
              secure: lockedPhone.secure && window.isSecureContext !== false,
            }) === 'insecure' && <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)', lineHeight: 1.55, marginBottom: 10 }}>{t('phoneInsecure')}</div>}
            <button type="button" onClick={() => window.location.reload()} style={dialogButtonStyle('secondary', isMobile)}>{t('phoneReload')}</button>
          </div>
        )}
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

  const mineCount = items.filter(i => !i.deletedAt).length
  const showMine = section !== 'system'
  const showSystem = section !== 'mine' && !filter.trash
  return (
    <div style={pageWrap}>
      {header}
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, margin: '0 0 14px', maxWidth: 720 }}>{t('intro')}</p>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <button type="button" style={hot} onClick={() => setEditing({ item: null })}><Plus size={14} /> {t('new')}</button>
        <button type="button" style={btn} onClick={() => setImporting(true)}><FileUp size={14} /> {t('importEnv')}</button>
        <button type="button" style={btn} onClick={() => setGroupsOpen(true)}><FolderPlus size={14} /> {t('groups')}</button>
      </div>

      <div style={{ marginBottom: 10, overflowX: 'auto', maxWidth: '100%' }}>
        <TabSelect<Section> value={section} onChange={v => { setSection(v); if (v === 'system') setFilter(f => ({ ...f, trash: false })) }} options={[
          { value: 'all', label: `${t('section_all')} · ${mineCount + systemItems.length}` },
          { value: 'mine', label: `${t('section_mine')} · ${mineCount}` },
          { value: 'system', label: `${t('section_system')} · ${systemItems.length}` },
        ]} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : showMine ? 'minmax(0, 1fr) 170px 190px auto' : 'minmax(0, 1fr)', gap: 8, marginBottom: 12, alignItems: 'center' }}>
        <label style={{ position: 'relative', gridColumn: isMobile ? '1 / -1' : undefined }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-tertiary)' }} />
          <input value={qLive} onChange={e => setQLive(e.target.value)} placeholder={t('search')} aria-label={t('search')}
            style={{ ...input, marginBottom: 0, paddingLeft: 30, letterSpacing: 'normal', width: '100%', boxSizing: 'border-box', fontSize: isMobile ? 16 : 13, minHeight: isMobile ? 44 : undefined }} />
        </label>
        {showMine && (
          <>
            <div aria-label={t('f_kind')}>
              <Select value={filter.kind} onChange={v => setFilter(f => ({ ...f, kind: v as PersonalFilter['kind'] }))}
                options={[{ value: 'all', label: t('allKinds') }, ...PERSONAL_KINDS.map(k => ({ value: k, label: kindLabel(k) }))]} />
            </div>
            <div aria-label={t('f_group')}>
              <Select value={filter.groupId} onChange={v => setFilter(f => ({ ...f, groupId: v }))}
                options={[{ value: 'all', label: t('allGroups') }, { value: 'none', label: t('noGroup') }, ...groups.map(g => ({ value: g.id, label: g.name }))]} />
            </div>
            <button type="button" style={{ ...btn, justifyContent: 'center', gridColumn: isMobile ? '1 / -1' : undefined, ...(filter.trash ? { borderColor: 'var(--anthropic-orange)', color: 'var(--anthropic-orange)' } : null) }}
              aria-pressed={filter.trash} onClick={() => setFilter(f => ({ ...f, trash: !f.trash }))}>
              <Trash2 size={14} /> {t('trash')} · {items.filter(i => i.deletedAt).length}
            </button>
          </>
        )}
      </div>
      {filter.trash && showMine && <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 10 }}>{t('trashNote')}</div>}

      {busyHello && <div role="status" aria-live="polite" style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, fontWeight: 600, marginBottom: 10 }}><AgentisticsLoader size={14} /> {t('confirmHello')}</div>}
      {toast && <div role="status" style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginBottom: 10 }}>{toast}</div>}

      {showMine && (rows.length === 0 ? (
        section === 'mine' || (shown.length === 0 && sysShown.length === 0)
          ? <div style={{ fontSize: 13, color: 'var(--text-tertiary)', padding: '18px 0' }}>{items.length === 0 ? t('empty') : t('noMatch')}</div>
          : null
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rows.map(m => (
            <ItemRow key={m.id} m={m} lang={lang} isMobile={isMobile} btn={btn} group={groupName(m.groupId)} groups={groups}
              gated={gated} onChanged={upsert} onRemoved={id => setItems(cur => cur.filter(x => x.id !== id))} onFlash={flash}
              onEdit={replace => setEditing({ item: m, replace })} onVersions={() => setVersionsOf(m)} />
          ))}
        </div>
      ))}

      {showMine && shown.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 12, fontSize: 12.5, color: 'var(--text-secondary)' }}>
          <span>{t('showing', { a: paging.start + 1, b: paging.end, n: shown.length })}</span>
          {paging.paged && (
            <>
              <button type="button" style={btn} disabled={paging.page === 0} onClick={() => setPage(paging.page - 1)}>{t('prev')}</button>
              <span>{paging.page + 1} / {paging.pageCount}</span>
              <button type="button" style={btn} disabled={paging.page + 1 >= paging.pageCount} onClick={() => setPage(paging.page + 1)}>{t('next')}</button>
            </>
          )}
          <div style={{ display: 'inline-flex', gap: 8, alignItems: 'center', marginLeft: 'auto' }}>
            <div style={{ width: 84 }} aria-label={t('perPage')}>
              <Select value={String(paging.size)} onChange={v => setSize(Number(v))} options={paging.sizes.map(n => ({ value: String(n), label: String(n) }))} />
            </div>
            {t('perPage')}
          </div>
        </div>
      )}

      {showSystem && (
        <div data-vault-system style={{ marginTop: showMine ? 22 : 0 }}>
          {showMine && <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 8 }}><ShieldCheck size={14} /> {t('section_system')}</div>}
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.55, marginBottom: 10, maxWidth: 720 }}>{t('systemNote')}</div>
          {sysShown.length === 0
            ? <div style={{ fontSize: 13, color: 'var(--text-tertiary)', padding: '6px 0 12px' }}>{systemItems.length === 0 ? t('systemEmpty') : t('noMatch')}</div>
            : <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{sysShown.map((i, n) => <SystemRow key={`${i.file}-${n}`} item={i} lang={lang} />)}</div>}
        </div>
      )}

      {mobile && <PhonePanel lang={lang} isMobile={isMobile} state={mobile} isPhone={isPhone} host={host} gated={gated} onChanged={() => { void mobileState().then(ms => { if (ms.ok) setMobile({ passkeys: ms.passkeys, codeReveal: ms.codeReveal, loopback: ms.loopback, devices: ms.devices }) }) }} />}
      {!isPhone && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: '12px 16px', marginTop: 18, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6, flex: '1 1 260px' }}>{t('backupNote')}</span>
          <button type="button" style={btn} onClick={() => setWipeAsk(true)}><History size={14} /> {t('backupWipe')}</button>
        </div>
      )}
      <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginTop: 18, lineHeight: 1.6 }}>{t('neverPaste')}</div>

      {editing && (
        <EditDialog lang={lang} isMobile={isMobile} item={editing.item} replace={editing.replace === true} groups={groups} gated={gated}
          defaultGroup={filter.groupId !== 'all' && filter.groupId !== 'none' ? filter.groupId : null}
          onClose={() => setEditing(null)} onSaved={m => { upsert(m); setEditing(null) }} />
      )}
      {versionsOf && <VersionsDialog lang={lang} isMobile={isMobile} item={versionsOf} gated={gated} onClose={() => setVersionsOf(null)} onRestored={m => { upsert(m); setVersionsOf(null) }} />}
      {importing && <ImportDialog lang={lang} isMobile={isMobile} groups={groups} gated={gated} onClose={() => setImporting(false)} onDone={s => { setImporting(false); flash(s); void load() }} />}
      {groupsOpen && <GroupsDialog lang={lang} isMobile={isMobile} groups={groups} items={items} gated={gated} onClose={() => setGroupsOpen(false)} onChanged={() => { void load() }} />}
      {codeAsk && <CodeDialog lang={lang} isMobile={isMobile} onDone={codeAsk} />}
      <ConfirmModal open={wipeAsk} title={t('backupWipe')} message={t('backupWipeConfirm')} confirmLabel={t('backupWipe')} cancelLabel={t('cancel')}
        onCancel={() => setWipeAsk(false)} onConfirm={() => {
          setWipeAsk(false)
          void gated(c => wipeBackupHistory(c), { action: 'personal-backup-wipe', target: '' }).then(r => flash(r.ok ? t('backupWiped', { n: r.deleted }) : (r.sentence || t('network'))))
        }} />
    </div>
  )
}

/** `/vault?show=system` (the Settings link) opens on the system section; anything else on "All". */
function sectionFromUrl(): Section {
  try { const v = new URLSearchParams(window.location.search).get('show'); return v === 'system' || v === 'mine' ? v : 'all' } catch { return 'all' }
}

/** The system secrets a search keeps: matched on the kind's words (both languages' reading) and the file. */
export function filterSystem(list: VaultItem[], q: string, lang: Lang): VaultItem[] {
  const needle = q.trim().toLowerCase()
  if (!needle) return list
  return list.filter(i => `${vt(kindKey(i.kind), lang)} ${i.file}`.toLowerCase().includes(needle))
}

/** The app's page button (outlined, elevated) — 44px on mobile. One definition for the page and the quick view. */
function pageBtn(isMobile: boolean): React.CSSProperties {
  return {
    padding: isMobile ? '10px 14px' : '6px 12px', minHeight: isMobile ? 44 : undefined, borderRadius: 8, fontSize: 13,
    border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-primary)', cursor: 'pointer',
    display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'inherit', boxSizing: 'border-box',
  }
}

const SYSTEM_TONE = { sealed: 'var(--accent-green, #22c55e)', pending: 'var(--accent-orange, #f59e0b)', unreadable: 'var(--accent-red, #ef4444)' } as const

/** One secret Agentistics keeps for itself: name, file, date and state — never a value, never Ver/Copiar. */
function SystemRow({ item: i, lang }: { item: VaultItem; lang: Lang }) {
  const t = (k: PKey) => pt_(k, lang)
  const why = reasonKey(i.reason)
  const tone = SYSTEM_TONE[i.state] ?? SYSTEM_TONE.unreadable
  const fmt = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(lang === 'pt' ? 'pt-BR' : 'en-US') }
  return (
    <div data-system-row style={{ border: `1px solid ${i.state === 'sealed' ? 'var(--border)' : tone}`, borderRadius: 10, padding: '12px 14px', minWidth: 0 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <ShieldCheck size={14} style={{ color: 'var(--text-tertiary)', flexShrink: 0, alignSelf: 'center' }} />
        <strong style={{ fontSize: 14, minWidth: 0, overflowWrap: 'anywhere' }}>{vt(kindKey(i.kind), lang)}</strong>
        <span style={{ fontSize: 11, padding: '1px 7px', borderRadius: 999, border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>{t('systemBadge')}</span>
        <span style={{ marginLeft: 'auto', fontSize: 11.5, fontWeight: 700, color: tone }}>{vt(itemStateKey(i.state), lang)}</span>
      </div>
      <div style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 12, color: 'var(--text-tertiary)', marginTop: 6, overflowWrap: 'anywhere' }}>{i.file}</div>
      {i.sealedAt && <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>{vt('sealedAt', lang)}: {fmt(i.sealedAt)}</div>}
      {why && <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>{vt(why, lang)}</div>}
      {i.restoreWith && <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>{vt('howToReenter', lang)}: <span style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)' }}>{i.restoreWith}</span></div>}
    </div>
  )
}

// ── the FAB's quick vault ────────────────────────────────────────────────────────────────────

/**
 * The personal vault as a quick sheet, opened from the chat button's vault icon (owner 2026-10-03):
 * search + the list + reveal/copy, from anywhere. The SAME hook, rows and unlock as the page — a
 * locked vault shows the shared inline unlock, a list that owes its code asks it here. Managing a
 * secret (edit, versions, groups, trash) stays on the page, one link away.
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
  const btn = pageBtn(isMobile)
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
              style={{ ...input, marginBottom: 0, paddingLeft: 30, letterSpacing: 'normal', width: '100%', boxSizing: 'border-box', fontSize: isMobile ? 16 : 13, minHeight: isMobile ? 44 : undefined }} />
          </label>
          {busyHello && <div role="status" aria-live="polite" style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, fontWeight: 600, marginBottom: 10 }}><AgentisticsLoader size={14} /> {t('confirmHello')}</div>}
          {toast && <div role="status" style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginBottom: 10 }}>{toast}</div>}
          {shown.length === 0
            ? <div style={{ fontSize: 13, color: 'var(--text-tertiary)', padding: '12px 0' }}>{items.filter(i => !i.deletedAt).length === 0 ? t('empty') : t('noMatch')}</div>
            : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {shown.map(m => (
                  <ItemRow key={m.id} m={m} lang={lang} isMobile={isMobile} btn={btn} group={groupName(m.groupId)} groups={groups} compact
                    gated={gated} onChanged={x => setItems(cur => [x, ...cur.filter(y => y.id !== x.id)])} onRemoved={id => setItems(cur => cur.filter(x => x.id !== id))}
                    onFlash={flash} onEdit={replace => setEditing({ item: m, replace })} onVersions={() => {}} />
                ))}
              </div>
            )}
        </>
      )}
      {editing && (
        <EditDialog lang={lang} isMobile={isMobile} item={editing.item} replace={editing.replace === true} groups={groups} gated={gated} defaultGroup={null}
          onClose={() => setEditing(null)} onSaved={m => { setItems(cur => [m, ...cur.filter(y => y.id !== m.id)]); setEditing(null) }} />
      )}
      {codeAsk && <CodeDialog lang={lang} isMobile={isMobile} onDone={codeAsk} />}
    </>
  )
}

type Gated = <T>(run: (code?: string, token?: string) => Promise<Reply<T>>, gesture: false | { action: string; target: string }) => Promise<Reply<T>>

// ── one row ──────────────────────────────────────────────────────────────────────────────────

function ItemRow({ m, lang, isMobile, btn, group, groups, gated, onChanged, onRemoved, onFlash, onEdit, onVersions, compact = false }: {
  m: PersonalMeta; lang: Lang; isMobile: boolean; btn: React.CSSProperties; group: string; groups: PersonalGroup[]; gated: Gated
  onChanged: (m: PersonalMeta) => void; onRemoved: (id: string) => void; onFlash: (s: string) => void
  /** Open the edit dialog; `replace` = the "Substituir valor" entry of a use-only secret (value fields only). */
  onEdit: (replace?: boolean) => void; onVersions: () => void
  /** The quick panel: reveal, copy and EDIT — versions, groups and the trash stay on the page. */
  compact?: boolean
}) {
  const t = (k: PKey, v?: Record<string, string | number>) => pt_(k, lang, v)
  // field → value, for 30 s after a reveal; dropped on unmount.
  const [shown, setShown] = useState<Record<string, string>>({})
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
  const act = async (kind: 'trash' | 'restore' | 'purge') => {
    setError(null)
    const r = kind === 'trash' ? await gated((c, tk) => trashPersonal(m.id, m.version, c, tk), { action: 'personal-trash', target: m.id })
      : kind === 'restore' ? await gated((c, tk) => restorePersonal(m.id, m.version, c, tk), { action: 'personal-restore', target: m.id })
        : await gated((c, tk) => purgePersonal(m.id, c, tk), { action: 'personal-purge', target: m.id })
    if (!r.ok) { setError(r.sentence || t('network')); return }
    if (kind === 'purge') onRemoved(m.id); else onChanged((r as unknown as { meta: PersonalMeta }).meta)
  }
  const move = async (groupId: string | null) => {
    const r = await gated(c => movePersonal(m.id, m.version, groupId, c), false)
    if (!r.ok) { setError(r.sentence || t('network')); return }
    onChanged(r.meta)
  }
  const fmt = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(lang === 'pt' ? 'pt-BR' : 'en-US') }
  const trashed = m.deletedAt !== null
  const sealed = isUseOnly(m)
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px', minWidth: 0 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <KeyRound size={14} style={{ color: 'var(--anthropic-orange)', flexShrink: 0, alignSelf: 'center' }} />
        <strong style={{ fontSize: 14, minWidth: 0, overflowWrap: 'anywhere' }}>{m.name}</strong>
        <span style={{ fontSize: 11, padding: '1px 7px', borderRadius: 999, border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>{t(`kind_${m.kind}` as PKey)}</span>
        {sealed && <span data-use-only title={t('useOnlySealed')} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, padding: '1px 7px', borderRadius: 999, border: '1px solid var(--anthropic-orange)', color: 'var(--anthropic-orange)' }}><Lock size={10} /> {t('useOnlyBadge')}</span>}
        {m.confirmEach === false && <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{t('confirmEachOff')}</span>}
        {group && <span style={{ fontSize: 11.5, color: 'var(--anthropic-orange)' }}>▸ {group}</span>}
        {m.tags.map(tag => <span key={tag} style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>#{tag}</span>)}
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-tertiary)' }}>{t('updated', { date: fmt(m.updatedAt) })}</span>
      </div>
      {(m.notes || m.url) && <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4, overflowWrap: 'anywhere' }}>{m.url && <span>{m.url}{m.notes ? ' · ' : ''}</span>}{m.notes}</div>}
      {!trashed && !sealed && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
          {m.fields.map(f => (
            <div key={f} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
              <span style={{ fontSize: 12, color: 'var(--text-tertiary)', width: isMobile ? '100%' : 64, flexShrink: 0 }}>{t(`field_${f}` as PKey)}</span>
              <code style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 12.5, flex: isMobile ? '1 1 0' : '1 1 160px', minWidth: 0, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap', maxHeight: 160, overflowY: 'auto', userSelect: shown[f] !== undefined ? 'text' : 'none' }}>
                {shown[f] !== undefined ? shown[f] : '••••••••••'}
              </code>
              <button type="button" style={btn} onClick={() => { void show(f) }} aria-label={`${shown[f] !== undefined ? t('hide') : t('reveal')} ${t(`field_${f}` as PKey)}`}>
                {shown[f] !== undefined ? <EyeOff size={14} /> : <Eye size={14} />} {isMobile ? '' : shown[f] !== undefined ? t('hide') : t('reveal')}
              </button>
              <button type="button" style={btn} onClick={() => { void copy(f) }} aria-label={`${t('copy')} ${t(`field_${f}` as PKey)}`}><Copy size={14} /> {isMobile ? '' : t('copy')}</button>
            </div>
          ))}
        </div>
      )}
      {!trashed && sealed && (
        // "Só uso": no value, no Ver/Copiar — what it is, and the one way to change it.
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          <span style={{ fontSize: 12, color: 'var(--text-secondary)', flex: '1 1 220px', minWidth: 0, lineHeight: 1.5 }}>{t('useOnlySealed')}</span>
          <button type="button" style={btn} onClick={() => onEdit(true)}><Replace size={13} /> {t('replaceValue')}</button>
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10, alignItems: 'center' }}>
        {!trashed && <button type="button" style={btn} onClick={() => onEdit(false)}><Pencil size={13} /> {t('edit')}</button>}
        {!compact && !trashed && <button type="button" style={btn} onClick={onVersions}><History size={13} /> {t('versions')}</button>}
        {!compact && !trashed && groups.length > 0 && (
          <div style={{ width: isMobile ? '100%' : 180 }} aria-label={t('move')}>
            <Select value={m.groupId ?? ''} onChange={v => { void move(v || null) }} placeholder={t('noGroup')}
              options={[{ value: '', label: t('noGroup') }, ...groups.map(g => ({ value: g.id, label: g.name }))]} />
          </div>
        )}
        {!compact && !trashed && <button type="button" style={btn} onClick={() => { void act('trash') }}><Trash2 size={13} /> {t('delete')}</button>}
        {!compact && trashed && <button type="button" style={btn} onClick={() => { void act('restore') }}><RotateCcw size={13} /> {t('restore')}</button>}
        {!compact && trashed && <button type="button" style={{ ...btn, color: '#ef4444', borderColor: '#ef4444' }} onClick={() => setPurgeAsk(true)}><Trash2 size={13} /> {t('purge')}</button>}
      </div>
      <ConfirmModal open={purgeAsk} title={t('purge')} message={t('purgeConfirm', { name: m.name })} confirmLabel={t('purge')} cancelLabel={t('cancel')}
        onCancel={() => setPurgeAsk(false)} onConfirm={() => { setPurgeAsk(false); void act('purge') }} />
      {error && <div style={{ marginTop: 8 }}><Err text={error} /></div>}
    </div>
  )
}

// ── dialogs ──────────────────────────────────────────────────────────────────────────────────

function Sheet({ lang, isMobile, title, onClose, children, wide, footer }: { lang: Lang; isMobile: boolean; title: string; onClose: () => void; children: React.ReactNode; wide?: boolean; footer?: React.ReactNode }) {
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }; window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h) }, [onClose])
  const o: React.CSSProperties = isMobile ? { ...overlay, padding: 0, zIndex: 3000 } : { ...overlay, zIndex: 3000 }
  const c: React.CSSProperties = isMobile
    ? { ...card, maxWidth: 'none', width: '100%', height: '100dvh', maxHeight: '100dvh', borderRadius: 0, border: 'none', overflowY: 'auto', boxSizing: 'border-box' }
    : { ...card, maxWidth: wide ? 640 : 480, maxHeight: '92vh', overflowY: 'auto', boxSizing: 'border-box', boxShadow: '0 12px 48px rgba(0,0,0,0.5)' }
  return (
    <div style={o} role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div style={c} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', flex: 1, minWidth: 0 }}>{title}</span>
          <button type="button" className="ag-tap-icon" aria-label={pt_('close', lang)} onClick={onClose}
            style={{ background: 'transparent', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', padding: 4, display: 'inline-flex' }}><X size={16} /></button>
        </div>
        {children}
        {footer}
      </div>
    </div>
  )
}

function EditDialog({ lang, isMobile, item, replace, groups, gated, defaultGroup, onClose, onSaved }: {
  lang: Lang; isMobile: boolean; item: PersonalMeta | null
  /** "Substituir valor" on a use-only secret: only the value fields, nothing else on the form. */
  replace?: boolean
  groups: PersonalGroup[]; gated: Gated; defaultGroup: string | null
  onClose: () => void; onSaved: (m: PersonalMeta) => void
}) {
  const t = (k: PKey, v?: Record<string, string | number>) => pt_(k, lang, v)
  const [kind, setKind] = useState<PersonalKind>(item?.kind ?? 'login')
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
  const [useOnly, setUseOnly] = useState<boolean>(item ? sealed : USE_ONLY_DEFAULT['login'])
  const [useOnlyTouched, setUseOnlyTouched] = useState(false)
  // The values typed here live only in this dialog's state, until save or close.
  const [fields, setFields] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => () => setFields({}), [])
  const editing = item !== null
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
  const tagList = parseTags(tags)
  const valueFields = KIND_FIELDS[kind].map(k => (
    multiline
      ? <FieldTextarea key={k} label={t(`field_${k}` as PKey)} value={fields[k] ?? ''} onChange={v => setFields(s => ({ ...s, [k]: v }))} rows={kind === 'env' ? 6 : 4} mono spellCheck={false} autoComplete="off"
          {...(editing ? { sub: sealed ? t('f_newValue') : t('f_keep') } : {})} />
      : <FieldInput key={k} label={t(`field_${k}` as PKey)} value={fields[k] ?? ''} onChange={v => setFields(s => ({ ...s, [k]: v }))}
          type={k === 'password' || k === 'value' ? 'password' : 'text'} mono={k !== 'login'} spellCheck={false}
          autoComplete={k === 'login' ? 'off' : 'new-password'} {...(k === 'login' ? { placeholder: t('loginHint') } : {})}
          {...(editing ? { sub: sealed ? t('f_newValue') : t('f_keep') } : {})} />
  ))
  const footer = (
    <>
      {editing && !replace && <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>{t('editAsks')}</div>}
      {error && <Err text={error} />}
      <DialogActions>
        <button type="button" onClick={onClose} style={dialogButtonStyle('secondary', isMobile)}>{t('cancel')}</button>
        <button type="submit" form="vault-edit-form" disabled={busy || !name.trim()} style={dialogButtonStyle('primary', isMobile, busy || !name.trim())}>
          {busy && <AgentisticsLoader size={14} />} {busy ? t('working') : t('save')}
        </button>
      </DialogActions>
    </>
  )
  return (
    <Sheet lang={lang} isMobile={isMobile} title={replace && item ? `${t('replaceTitle')} · ${item.name}` : editing ? t('editTitle') : t('createTitle')} onClose={onClose} footer={footer}>
      <form id="vault-edit-form" onSubmit={e => { e.preventDefault(); void save() }}>
        {replace ? valueFields : (
          <>
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>{t('f_kind')}</div>
              <Select value={kind} onChange={v => pickKind(v as PersonalKind)} options={PERSONAL_KINDS.map(k => ({ value: k, label: t(`kind_${k}` as PKey) }))} />
            </div>
            <FieldInput label={t('f_name')} value={name} onChange={setName} maxLength={120} autoFocus={!isMobile} />
            {valueFields}
            <FieldInput label={t('f_url')} value={url} onChange={setUrl} maxLength={500} />
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>{t('f_group')}</div>
              <Select value={groupId} onChange={setGroupId} placeholder={t('noGroup')} options={[{ value: '', label: t('noGroup') }, ...groups.map(g => ({ value: g.id, label: g.name }))]} />
            </div>
            <FieldInput label={t('f_tags')} value={tags} onChange={setTags} />
            {tagList.length > 0 && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: -8, marginBottom: 14 }}>
                {tagList.map(tag => <span key={tag} style={{ fontSize: 11.5, padding: '2px 8px', borderRadius: 999, border: '1px solid var(--border)', color: 'var(--text-secondary)', background: 'var(--bg-elevated)' }}>#{tag}</span>)}
              </div>
            )}
            <FieldTextarea label={t('f_notes')} value={notes} onChange={setNotes} rows={3} maxLength={4000} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '12px 14px', border: '1px solid var(--border)', borderRadius: 10, background: 'var(--bg-elevated)' }}>
              <div>
                <Checkbox checked={confirmEach} onChange={setConfirmEach} label={t('confirmEach')} />
                <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginTop: 2, lineHeight: 1.5, paddingLeft: 24 }}>{t('confirmEachHelp')}</div>
              </div>
              <div data-use-only-field>
                {sealed
                  ? <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--anthropic-orange)', fontWeight: 600 }}><Lock size={14} /> {t('useOnly')}</div>
                  : <Checkbox checked={useOnly} onChange={v => { setUseOnly(v); setUseOnlyTouched(true) }} label={t('useOnly')} />}
                <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginTop: 2, lineHeight: 1.5, paddingLeft: 24 }}>{sealed ? t('useOnlySealed') : t('useOnlyHelp')}</div>
              </div>
            </div>
          </>
        )}
      </form>
    </Sheet>
  )
}

function VersionsDialog({ lang, isMobile, item, gated, onClose, onRestored }: { lang: Lang; isMobile: boolean; item: PersonalMeta; gated: Gated; onClose: () => void; onRestored: (m: PersonalMeta) => void }) {
  const t = (k: PKey, v?: Record<string, string | number>) => pt_(k, lang, v)
  const [list, setList] = useState<PersonalMeta[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { void listVersions(item.id).then(r => { if (r.ok) setList(r.versions); else setError(r.sentence || t('network')) }) }, [item.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const fmt = (iso: string) => new Date(iso).toLocaleString(lang === 'pt' ? 'pt-BR' : 'en-US')
  const restore = async (v: number) => {
    setError(null)
    const r = await gated((c, tk) => restoreVersion(item.id, v, item.version, c, tk), { action: 'personal-restore-version', target: item.id })
    if (!r.ok) { setError(r.sentence || t('network')); return }
    onRestored(r.meta)
  }
  return (
    <Sheet lang={lang} isMobile={isMobile} title={t('versionsTitle', { name: item.name })} onClose={onClose}
      footer={<DialogActions><button type="button" onClick={onClose} style={dialogButtonStyle('secondary', isMobile)}>{t('close')}</button></DialogActions>}>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 10, lineHeight: 1.6 }}>{t('versionsNote')}</div>
      {!list && !error && <AgentisticsLoader size={14} />}
      {list?.map(v => (
        <div key={v.version} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderTop: '1px solid var(--border)', flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 13 }}>{t('version', { n: v.version })}</strong>
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{fmt(v.updatedAt)} · {v.name}{v.deletedAt ? ` · ${t('trash')}` : ''}</span>
          {v.version === item.version
            ? <span style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--accent-green, #22c55e)' }}>{t('current')}</span>
            : <button type="button" onClick={() => { void restore(v.version) }} style={{ ...dialogButtonStyle('primary', isMobile), width: isMobile ? '100%' : undefined, marginLeft: 'auto' }}>{t('restoreThis')}</button>}
        </div>
      ))}
      {error && <Err text={error} />}
    </Sheet>
  )
}

function ImportDialog({ lang, isMobile, groups, gated, onClose, onDone }: { lang: Lang; isMobile: boolean; groups: PersonalGroup[]; gated: Gated; onClose: () => void; onDone: (summary: string) => void }) {
  const t = (k: PKey, v?: Record<string, string | number>) => pt_(k, lang, v)
  const [preview, setPreview] = useState<{ token: string; keys: ImportKey[]; skipped: number } | null>(null)
  const [choices, setChoices] = useState<ImportChoice[]>([])
  const [groupId, setGroupId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const onFile = async (f: File | undefined) => {
    if (!f) return
    setBusy(true); setError(null)
    // Read in the browser and sent ONCE; nothing keeps the text after this function returns.
    let text = await f.text()
    const r = await gated(c => importPreview(text, c), false)
    text = ''
    setBusy(false)
    if (!r.ok) { setError(r.sentence || t('network')); return }
    setPreview(r); setChoices(defaultImportChoices(r.keys))
  }
  const commit = async () => {
    if (!preview || busy || !importReady(choices)) return
    setBusy(true); setError(null)
    const r = await gated(c => importCommit(preview.token, choices, groupId || null, c), false)
    setBusy(false)
    if (!r.ok) { setError(r.sentence || t('network')); return }
    onDone(t('importDone', { c: r.created, r: r.replaced, s: r.skipped }))
  }
  const setChoice = (key: string, patch: Partial<ImportChoice>) => setChoices(cs => cs.map(c => (c.key === key ? { ...c, ...patch } : c)))
  const footer = (
    <DialogActions>
      <button type="button" onClick={onClose} style={dialogButtonStyle('secondary', isMobile)}>{t('cancel')}</button>
      {preview
        ? <button type="button" disabled={busy || !importReady(choices)} onClick={() => { void commit() }} style={dialogButtonStyle('primary', isMobile, busy || !importReady(choices))}>{busy && <AgentisticsLoader size={14} />} {busy ? t('working') : t('importGo')}</button>
        : <button type="button" disabled={busy} onClick={() => fileRef.current?.click()} style={dialogButtonStyle('primary', isMobile, busy)}>{busy ? <AgentisticsLoader size={14} /> : <FileUp size={14} />} {busy ? t('working') : t('chooseFile')}</button>}
    </DialogActions>
  )
  return (
    <Sheet lang={lang} isMobile={isMobile} title={t('importTitle')} onClose={onClose} wide footer={footer}>
      <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginBottom: 10, lineHeight: 1.6 }}>{t('importIntro')}</div>
      <input ref={fileRef} type="file" accept=".env,.json,application/json,text/plain,*/*" style={{ display: 'none' }} onChange={e => { void onFile(e.target.files?.[0]); e.target.value = '' }} />
      {preview && (
        <>
          {preview.skipped > 0 && <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 8 }}>{t('importSkipped', { n: preview.skipped })}</div>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
            {preview.keys.map(k => {
              const c = choices.find(x => x.key === k.key)!
              return (
                <div key={k.key} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                  <code style={{ fontSize: 12.5, minWidth: 0, overflowWrap: 'anywhere', flex: '1 1 140px' }}>{k.key}</code>
                  {k.clash && <span style={{ fontSize: 11, color: 'var(--accent-orange, #f59e0b)' }}>{t('clash')}</span>}
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
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>{t('importInto')}</div>
            <Select value={groupId} onChange={setGroupId} placeholder={t('noGroup')} options={[{ value: '', label: t('noGroup') }, ...groups.map(g => ({ value: g.id, label: g.name }))]} />
          </div>
        </>
      )}
      {error && <div style={{ marginTop: 8 }}><Err text={error} /></div>}
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
    <Sheet lang={lang} isMobile={isMobile} title={t('groups')} onClose={onClose}
      footer={<DialogActions><button type="button" onClick={onClose} style={dialogButtonStyle('secondary', isMobile)}>{t('close')}</button></DialogActions>}>
      <form onSubmit={e => { e.preventDefault(); if (name.trim()) void run(c => createGroup(name.trim(), c), false).then(ok => { if (ok) setName('') }) }}
        style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 6, flexDirection: isMobile ? 'column' : 'row' }}>
        <div style={{ flex: 1, minWidth: 0, width: isMobile ? '100%' : undefined }}>
          <FieldInput label={t('groupName')} value={name} onChange={setName} maxLength={120} />
        </div>
        <button type="submit" disabled={!name.trim()} style={{ ...dialogButtonStyle('primary', isMobile, !name.trim()), marginBottom: 14 }}><FolderPlus size={14} /> {t('save')}</button>
      </form>
      {groups.map(g => (
        <div key={g.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 0', borderTop: '1px solid var(--border)', flexWrap: 'wrap' }}>
          {renaming?.id === g.id
            ? <div style={{ flex: 1, minWidth: 160 }}><FieldInput label={t('rename')} value={renaming.name} onChange={v => setRenaming({ id: g.id, name: v })} autoFocus /></div>
            : <span style={{ fontSize: 13.5, fontWeight: 600, flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{g.name} <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--text-tertiary)' }}>· {t('items', { n: items.filter(i => i.groupId === g.id && !i.deletedAt).length })}</span></span>}
          <div style={{ display: 'flex', gap: 8 }}>
            {renaming?.id === g.id
              ? <button type="button" onClick={() => { void run(c => renameGroup(g.id, g.version, renaming.name.trim(), c), false).then(ok => { if (ok) setRenaming(null) }) }} style={small('primary')}>{t('save')}</button>
              : <button type="button" onClick={() => setRenaming({ id: g.id, name: g.name })} style={small('secondary')}>{t('rename')}</button>}
            <button type="button" title={t('deleteGroupNote')} onClick={() => { void run((c, tk) => deleteGroup(g.id, c, tk), { action: 'personal-group-delete', target: g.id }) }} style={small('danger')}>{t('deleteGroup')}</button>
          </div>
        </div>
      ))}
      {groups.length > 0 && <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginTop: 6 }}>{t('deleteGroupNote')}</div>}
      {error && <Err text={error} />}
    </Sheet>
  )
}

/**
 * §7 — the phone. ON the phone: register this phone's passkey (needs https; the code, then Windows Hello
 * on the computer — the one time both are needed). ON the computer: the registered phones (remove) and
 * the opt-in "accept the code on the phone" switch, with its cost stated.
 */
function PhonePanel({ lang, isMobile, state, isPhone, host, gated, onChanged }: {
  lang: Lang; isMobile: boolean; state: MobileState; isPhone: boolean; host: string; gated: Gated; onChanged: () => void
}) {
  const t = (k: PKey, v?: Record<string, string | number>) => pt_(k, lang, v)
  const [error, setError] = useState<string | null>(null)
  const [stale, setStale] = useState(0)
  const support = passkeySupport(window)
  const here = hasPasskeyHere(state, host)
  const device = readDeviceKey()
  const deviceHere = Boolean(device && state.codeReveal && state.devices?.some(d => d.id === device.deviceId))
  useEffect(() => { if (!isPhone) void phoneFacts().then(f => { if (f.ok) setStale(f.stale) }) }, [isPhone, state])
  const box: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: 12, padding: '14px 16px', marginTop: 18 }
  const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderTop: '1px solid var(--border)', flexWrap: 'wrap' }
  const small: React.CSSProperties = { ...dialogButtonStyle('danger', isMobile), width: undefined, background: 'transparent', color: '#ef4444' }
  if (isPhone) {
    // §10: register through the request the computer approves; once this phone works, say so.
    return (
      <div style={{ marginTop: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {(here || deviceHere)
          ? <div style={{ ...box, marginTop: 0, fontSize: 12.5, color: 'var(--text-secondary)' }}><div style={{ fontSize: 13.5, fontWeight: 700, marginBottom: 6, color: 'var(--text-primary)' }}>{t('phoneTitle')}</div>{here ? t('phoneReady') : t('phoneCodeOn')}</div>
          : <PhoneEnrol lang={lang} isMobile={isMobile} onDone={onChanged} />}
        {support === 'unsupported' && <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{t('phoneUnsupported')}</div>}
      </div>
    )
  }
  return (
    <div style={box}>
      <div style={{ fontSize: 13.5, fontWeight: 700, marginBottom: 6 }}>{t('phoneTitle')}</div>
      <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 8 }}>{t('phoneDesktopIntro')}</div>
      {state.passkeys.length === 0 && !(state.devices?.length) && <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)', marginBottom: 8 }}>{t('phoneNone')}</div>}
      {state.passkeys.length > 0 && <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginTop: 4 }}>{t('phonePasskeys')}</div>}
      {state.passkeys.map(p => (
        <div key={p.id} style={row}>
          <span style={{ fontSize: 13, flex: 1, minWidth: 0 }}>{p.label} <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>· {p.rpId}</span></span>
          <button type="button" onClick={() => { void gated(c => removePasskey(p.id, c), { action: 'mobile-passkey-remove', target: p.id }).then(r => { if (r.ok) onChanged(); else setError(r.sentence || t('network')) }) }}
            style={small}>{t('phoneRemove')}</button>
        </div>
      ))}
      {(state.devices?.length ?? 0) > 0 && <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginTop: 8 }}>{t('phoneDevices')}</div>}
      {state.devices?.map(d => (
        <div key={d.id} style={row}>
          <span style={{ fontSize: 13, flex: 1, minWidth: 0 }}>{d.label}</span>
          <button type="button" onClick={() => { void gated(c => removeDevice(d.id, c), { action: 'mobile-passkey-remove', target: d.id }).then(r => { if (r.ok) onChanged(); else setError(r.sentence || t('network')) }) }}
            style={small}>{t('phoneRemove')}</button>
        </div>
      ))}
      {stale > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 8, fontSize: 12.5, color: 'var(--text-secondary)' }}>
          <span style={{ flex: 1, minWidth: 0 }}>{t('phoneStale', { n: stale })}</span>
          <button type="button" style={small} onClick={() => { void gated(c => clearStalePhones(c), { action: 'mobile-passkey-remove', target: '' }).then(r => { if (r.ok) onChanged(); else setError(r.sentence || t('network')) }) }}>{t('phoneStaleClear')}</button>
        </div>
      )}
      <div style={{ marginTop: 12 }}>
        <Checkbox checked={state.codeReveal} label={t('phoneCodeToggle')}
          onChange={on => { void gated(c => setCodeReveal(on, c), { action: 'mobile-code-reveal', target: '' }).then(r => { if (r.ok) onChanged(); else setError(r.sentence || t('network')) }) }} />
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5, marginTop: 2, paddingLeft: 24 }}>{t('phoneCodeCost')}</div>
      </div>
      {error && <div style={{ marginTop: 8 }}><Err text={error} /></div>}
    </div>
  )
}

/** The code the gate asked for in the middle of an action: the app's code field, the dialog footer. */
function CodeDialog({ lang, isMobile, onDone }: { lang: Lang; isMobile: boolean; onDone: (code: string | null) => void }) {
  const [code, setCode] = useState('')
  const ok = codeComplete(code)
  return (
    <Sheet lang={lang} isMobile={isMobile} title={pt_('codeLabel', lang)} onClose={() => onDone(null)}
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

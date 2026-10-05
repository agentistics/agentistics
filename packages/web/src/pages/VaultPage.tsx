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
import { Copy, Eye, EyeOff, FileUp, FolderPlus, History, KeyRound, Loader2, Pencil, Plus, RotateCcw, Search, Trash2, X } from 'lucide-react'
import { VaultGlyph as VaultIcon } from '../components/vault/VaultGlyph'
import { Checkbox } from './settings/primitives'
import type { AppContext } from '../lib/app-context'
import { useIsMobile } from '../hooks/useIsMobile'
import { Err, card, input, overlay, primaryBtn, dangerBtn } from '../components/MfaSetup'
import { cleanCode, codeComplete, loadVault, vaultPost, type Reply } from '../lib/vaultApi'
import { resolvePaging } from '../components/team/tablePaging'
import {
  KIND_FIELDS, PERSONAL_KINDS, REVEAL_HIDE_MS, copyWithAutoClear, createGroup, createPersonal, defaultImportChoices, deleteGroup, editPersonal,
  filterPersonal, importCommit, importPreview, importReady, listPersonal, listVersions, movePersonal, parseTags, purgePersonal, renameGroup,
  restorePersonal, restoreVersion, revealPersonal, trashPersonal, withStepUp, wipeBackupHistory,
  type ImportChoice, type ImportKey, type PersonalFilter, type PersonalGroup, type PersonalKind, type PersonalMeta,
} from '../lib/vaultPersonal'
import { pt_, type PKey } from '../lib/personalText'
import { hasPasskeyHere, mobileState, passkeySupport, phoneGesture, removePasskey, setCodeReveal, type MobileState } from '../lib/passkey'
import { LockedVaultInline, PhoneEnrol } from '../components/vault/VaultUnlock'
import { clearStalePhones, phoneFacts, readDeviceKey, removeDevice } from '../lib/phoneVault'

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
  const [busyHello, setBusyHello] = useState(false)
  // The code dialog the gate asks for: resolved with the typed code, or null when cancelled.
  const [codeAsk, setCodeAsk] = useState<null | ((code: string | null) => void)>(null)
  const askCode = useCallback(() => new Promise<string | null>(res => setCodeAsk(() => (c: string | null) => { setCodeAsk(null); res(c) })), [])
  // §7: on a page NOT on this computer (the phone), a gesture is a passkey token, never a Hello prompt.
  const [mobile, setMobile] = useState<MobileState | null>(null)
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
    if (v.view.state !== 'open') { setState({ kind: 'locked' }); return }
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
  return { state, setState, items, setItems, groups, setGroups, busyHello, codeAsk, mobile, setMobile, isPhone, host, gated, load }
}

export default function VaultPage() {
  const ctx = useOutletContext<AppContext>()
  const lang: Lang = ctx.lang === 'pt' ? 'pt' : 'en'
  const t = (k: PKey, v?: Record<string, string | number>) => pt_(k, lang, v)
  const isMobile = useIsMobile()

  const [filter, setFilter] = useState<PersonalFilter>({ q: '', kind: 'all', groupId: 'all', trash: false })
  const [qLive, setQLive] = useState('')
  const [page, setPage] = useState(0)
  const [size, setSize] = useState(25)
  const [editing, setEditing] = useState<PersonalMeta | 'new' | null>(null)
  const [versionsOf, setVersionsOf] = useState<PersonalMeta | null>(null)
  const [importing, setImporting] = useState(false)
  const [groupsOpen, setGroupsOpen] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const { state, setState, items, setItems, groups, busyHello, codeAsk, mobile, setMobile, isPhone, host, gated, load } = usePersonalVault()

  // Reactive search: every keystroke, debounced 120 ms; page back to 1 whenever the filter changes.
  useEffect(() => { const id = setTimeout(() => setFilter(f => ({ ...f, q: qLive })), 120); return () => clearTimeout(id) }, [qLive])
  useEffect(() => { setPage(0) }, [filter])

  const kindLabel = useCallback((k: PersonalKind) => t(`kind_${k}` as PKey), [lang]) // eslint-disable-line react-hooks/exhaustive-deps
  const shown = useMemo(() => filterPersonal(items, groups, filter, kindLabel), [items, groups, filter, kindLabel])
  const paging = resolvePaging({ mode: 'maximized', total: shown.length, page, size })
  const rows = shown.slice(paging.start, paging.end)
  const groupName = (id: string | null) => (id ? groups.find(g => g.id === id)?.name ?? '' : '')
  const flash = (s: string) => { setToast(s); setTimeout(() => setToast(cur => (cur === s ? null : cur)), 4000) }
  const upsert = (m: PersonalMeta) => setItems(cur => [m, ...cur.filter(x => x.id !== m.id)])

  const btn: React.CSSProperties = {
    padding: isMobile ? '10px 14px' : '6px 12px', minHeight: isMobile ? 44 : undefined, borderRadius: 8, fontSize: 13,
    border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-primary)', cursor: 'pointer',
    display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'inherit',
  }
  const hot: React.CSSProperties = { ...btn, ...primaryBtn, width: 'auto', padding: btn.padding, minHeight: btn.minHeight }
  const pageWrap: React.CSSProperties = { maxWidth: 1100, margin: '0 auto', padding: isMobile ? '16px 16px 96px' : '24px 28px', boxSizing: 'border-box' }

  const header = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
      <span aria-hidden style={{ width: 36, height: 36, borderRadius: 10, display: 'grid', placeItems: 'center', background: 'var(--anthropic-orange-dim)', color: 'var(--anthropic-orange)' }}><VaultIcon size={19} /></span>
      <h1 style={{ fontSize: 20, margin: 0 }}>{t('title')}</h1>
    </div>
  )

  if (state.kind === 'loading') return <div style={pageWrap}>{header}<div style={{ color: 'var(--text-tertiary)', fontSize: 13 }}><Loader2 size={14} className="ag-spin" /></div></div>
  if (state.kind === 'failed') return <div style={pageWrap}>{header}<Err text={t('network')} /></div>
  if (state.kind === 'locked') {
    return (
      <div style={pageWrap}>{header}
        <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 20, display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'flex-start' }}>
          {/* §10: unlock RIGHT HERE — Hello on this computer, the phone's own ways on a phone. */}
          <LockedVaultInline lang={lang} isMobile={isMobile} onOpened={() => { void load() }} />
        </div>
      </div>
    )
  }
  if (state.kind === 'code') {
    return (
      <div style={pageWrap}>{header}
        <CodeForm lang={lang} isMobile={isMobile} prompt={t('needsCode')} error={state.error} onSubmit={async code => {
          const { vaultPost } = await import('../lib/vaultApi')
          const r = await vaultPost<{ grant: string }>('/api/vault/stepup', { code })
          if (!r.ok) { setState({ kind: 'code', error: r.sentence || t('network') }); return }
          await load()
        }} />
      </div>
    )
  }

  return (
    <div style={pageWrap}>
      {header}
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, margin: '0 0 14px', maxWidth: 720 }}>{t('intro')}</p>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <button type="button" style={hot} onClick={() => setEditing('new')}><Plus size={14} /> {t('new')}</button>
        <button type="button" style={btn} onClick={() => setImporting(true)}><FileUp size={14} /> {t('importEnv')}</button>
        <button type="button" style={btn} onClick={() => setGroupsOpen(true)}><FolderPlus size={14} /> {t('groups')}</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'minmax(0, 1fr) 170px 190px auto', gap: 8, marginBottom: 12 }}>
        <label style={{ position: 'relative', gridColumn: isMobile ? '1 / -1' : undefined }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-tertiary)' }} />
          <input value={qLive} onChange={e => setQLive(e.target.value)} placeholder={t('search')} aria-label={t('search')}
            style={{ ...input, marginBottom: 0, paddingLeft: 30, letterSpacing: 'normal', width: '100%', boxSizing: 'border-box', minHeight: isMobile ? 44 : undefined }} />
        </label>
        <select value={filter.kind} onChange={e => setFilter(f => ({ ...f, kind: e.target.value as PersonalFilter['kind'] }))} aria-label={t('f_kind')} style={{ ...input, marginBottom: 0, letterSpacing: 'normal', minHeight: isMobile ? 44 : undefined }}>
          <option value="all">{t('allKinds')}</option>
          {PERSONAL_KINDS.map(k => <option key={k} value={k}>{kindLabel(k)}</option>)}
        </select>
        <select value={filter.groupId} onChange={e => setFilter(f => ({ ...f, groupId: e.target.value }))} aria-label={t('f_group')} style={{ ...input, marginBottom: 0, letterSpacing: 'normal', minHeight: isMobile ? 44 : undefined }}>
          <option value="all">{t('allGroups')}</option>
          <option value="none">{t('noGroup')}</option>
          {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
        <button type="button" style={{ ...btn, justifyContent: 'center', gridColumn: isMobile ? '1 / -1' : undefined, ...(filter.trash ? { borderColor: 'var(--anthropic-orange)', color: 'var(--anthropic-orange)' } : null) }}
          aria-pressed={filter.trash} onClick={() => setFilter(f => ({ ...f, trash: !f.trash }))}>
          <Trash2 size={14} /> {t('trash')} · {items.filter(i => i.deletedAt).length}
        </button>
      </div>
      {filter.trash && <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 10 }}>{t('trashNote')}</div>}

      {busyHello && <div role="status" aria-live="polite" style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, fontWeight: 600, marginBottom: 10 }}><Loader2 size={14} className="ag-spin" /> {t('confirmHello')}</div>}
      {toast && <div role="status" style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginBottom: 10 }}>{toast}</div>}

      {rows.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--text-tertiary)', padding: '18px 0' }}>{items.length === 0 ? t('empty') : t('noMatch')}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rows.map(m => (
            <ItemRow key={m.id} m={m} lang={lang} isMobile={isMobile} btn={btn} group={groupName(m.groupId)} groups={groups}
              gated={gated} onChanged={upsert} onRemoved={id => setItems(cur => cur.filter(x => x.id !== id))} onFlash={flash}
              onEdit={() => setEditing(m)} onVersions={() => setVersionsOf(m)} />
          ))}
        </div>
      )}

      {shown.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 12, fontSize: 12.5, color: 'var(--text-secondary)' }}>
          <span>{t('showing', { a: paging.start + 1, b: paging.end, n: shown.length })}</span>
          {paging.paged && (
            <>
              <button type="button" style={btn} disabled={paging.page === 0} onClick={() => setPage(paging.page - 1)}>{t('prev')}</button>
              <span>{paging.page + 1} / {paging.pageCount}</span>
              <button type="button" style={btn} disabled={paging.page + 1 >= paging.pageCount} onClick={() => setPage(paging.page + 1)}>{t('next')}</button>
            </>
          )}
          <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', marginLeft: 'auto' }}>
            <select value={paging.size} onChange={e => setSize(Number(e.target.value))} style={{ ...input, marginBottom: 0, width: 'auto', letterSpacing: 'normal', padding: '4px 8px', minHeight: isMobile ? 44 : undefined }}>
              {paging.sizes.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            {t('perPage')}
          </label>
        </div>
      )}
      {mobile && <PhonePanel lang={lang} isMobile={isMobile} state={mobile} isPhone={isPhone} host={host} gated={gated} onChanged={() => { void mobileState().then(ms => { if (ms.ok) setMobile({ passkeys: ms.passkeys, codeReveal: ms.codeReveal, loopback: ms.loopback, devices: ms.devices }) }) }} />}
      {!isPhone && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: '12px 16px', marginTop: 18, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6, flex: '1 1 260px' }}>{t('backupNote')}</span>
          <button type="button" style={btn} onClick={() => {
            if (!window.confirm(t('backupWipeConfirm'))) return
            void gated(c => wipeBackupHistory(c), { action: 'personal-backup-wipe', target: '' }).then(r => flash(r.ok ? t('backupWiped', { n: r.deleted }) : (r.sentence || t('network'))))
          }}><History size={14} /> {t('backupWipe')}</button>
        </div>
      )}
      <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginTop: 18, lineHeight: 1.6 }}>{t('neverPaste')}</div>

      {editing && (
        <EditDialog lang={lang} isMobile={isMobile} item={editing === 'new' ? null : editing} groups={groups} gated={gated}
          defaultGroup={filter.groupId !== 'all' && filter.groupId !== 'none' ? filter.groupId : null}
          onClose={() => setEditing(null)} onSaved={m => { upsert(m); setEditing(null) }} />
      )}
      {versionsOf && <VersionsDialog lang={lang} isMobile={isMobile} item={versionsOf} gated={gated} onClose={() => setVersionsOf(null)} onRestored={m => { upsert(m); setVersionsOf(null) }} />}
      {importing && <ImportDialog lang={lang} isMobile={isMobile} groups={groups} gated={gated} onClose={() => setImporting(false)} onDone={s => { setImporting(false); flash(s); void load() }} />}
      {groupsOpen && <GroupsDialog lang={lang} isMobile={isMobile} groups={groups} items={items} gated={gated} onClose={() => setGroupsOpen(false)} onChanged={() => { void load() }} />}
      {codeAsk && <CodeDialog lang={lang} isMobile={isMobile} onDone={codeAsk} />}
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
  const [creating, setCreating] = useState(false)
  const kindLabel = useCallback((k: PersonalKind) => pt_(`kind_${k}` as PKey, lang), [lang])
  const shown = useMemo(() => filterPersonal(items, groups, { q, kind: 'all', groupId: 'all', trash: false }, kindLabel), [items, groups, q, kindLabel])
  const groupName = (id: string | null) => (id ? groups.find(g => g.id === id)?.name ?? '' : '')
  const flash = (s: string) => { setToast(s); setTimeout(() => setToast(cur => (cur === s ? null : cur)), 4000) }
  useEffect(() => { onAsking?.(!!codeAsk) }, [codeAsk, onAsking])
  const btn: React.CSSProperties = {
    padding: isMobile ? '10px 14px' : '6px 12px', minHeight: isMobile ? 44 : undefined, borderRadius: 8, fontSize: 13,
    border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-primary)', cursor: 'pointer',
    display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'inherit',
  }
  return (
    <>
        {state.kind === 'loading' && <Loader2 size={14} className="ag-spin" />}
        {state.kind === 'failed' && <Err text={t('network')} />}
        {state.kind === 'locked' && <LockedVaultInline lang={lang} isMobile={isMobile} onOpened={() => { void load() }} />}
        {state.kind === 'code' && (
          <CodeForm lang={lang} isMobile={isMobile} prompt={t('needsCode')} error={state.error} onSubmit={async code => {
            const r = await vaultPost<{ grant: string }>('/api/vault/stepup', { code })
            if (!r.ok) { setState({ kind: 'code', error: r.sentence || t('network') }); return }
            await load()
          }} />
        )}
        {state.kind === 'ready' && (
          <>
            <label style={{ position: 'relative', display: 'block', marginBottom: 10 }}>
              <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-tertiary)' }} />
              <input value={q} onChange={e => setQ(e.target.value)} placeholder={t('search')} aria-label={t('search')} autoFocus={!isMobile}
                style={{ ...input, marginBottom: 0, paddingLeft: 30, letterSpacing: 'normal', width: '100%', boxSizing: 'border-box', minHeight: isMobile ? 44 : undefined }} />
            </label>
            <button type="button" data-quick-new style={{ ...btn, ...primaryBtn, marginBottom: 10 }} onClick={() => setCreating(true)}><Plus size={14} /> {t('new')}</button>
            {busyHello && <div role="status" aria-live="polite" style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, fontWeight: 600, marginBottom: 10 }}><Loader2 size={14} className="ag-spin" /> {t('confirmHello')}</div>}
            {toast && <div role="status" style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginBottom: 10 }}>{toast}</div>}
            {shown.length === 0
              ? <div style={{ fontSize: 13, color: 'var(--text-tertiary)', padding: '12px 0' }}>{items.filter(i => !i.deletedAt).length === 0 ? t('empty') : t('noMatch')}</div>
              : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {shown.map(m => (
                    <ItemRow key={m.id} m={m} lang={lang} isMobile={isMobile} btn={btn} group={groupName(m.groupId)} groups={groups} compact
                      gated={gated} onChanged={x => setItems(cur => [x, ...cur.filter(y => y.id !== x.id)])} onRemoved={id => setItems(cur => cur.filter(x => x.id !== id))}
                      onFlash={flash} onEdit={() => {}} onVersions={() => {}} />
                  ))}
                </div>
              )}
          </>
        )}
        <button type="button" style={{ ...btn, marginTop: 14, background: 'transparent' }} onClick={() => { onNavigate?.(); navigate('/vault') }}>
          <VaultIcon size={14} /> {t('quickAll')}
        </button>
      {creating && (
        <EditDialog lang={lang} isMobile={isMobile} item={null} groups={groups} gated={gated} defaultGroup={null}
          onClose={() => setCreating(false)} onSaved={m => { setItems(cur => [m, ...cur.filter(y => y.id !== m.id)]); setCreating(false) }} />
      )}
      {codeAsk && <CodeDialog lang={lang} isMobile={isMobile} onDone={codeAsk} />}
    </>
  )
}

type Gated = <T>(run: (code?: string, token?: string) => Promise<Reply<T>>, gesture: false | { action: string; target: string }) => Promise<Reply<T>>

// ── one row ──────────────────────────────────────────────────────────────────────────────────

function ItemRow({ m, lang, isMobile, btn, group, groups, gated, onChanged, onRemoved, onFlash, onEdit, onVersions, compact = false }: {
  m: PersonalMeta; lang: Lang; isMobile: boolean; btn: React.CSSProperties; group: string; groups: PersonalGroup[]; gated: Gated
  onChanged: (m: PersonalMeta) => void; onRemoved: (id: string) => void; onFlash: (s: string) => void; onEdit: () => void; onVersions: () => void
  /** The quick panel: reveal and copy only — managing a secret is the page's job. */
  compact?: boolean
}) {
  const t = (k: PKey, v?: Record<string, string | number>) => pt_(k, lang, v)
  // field → value, for 30 s after a reveal; dropped on unmount.
  const [shown, setShown] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
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
    if (kind === 'purge' && !window.confirm(t('purgeConfirm', { name: m.name }))) return
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
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px', minWidth: 0 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <KeyRound size={14} style={{ color: 'var(--anthropic-orange)', flexShrink: 0, alignSelf: 'center' }} />
        <strong style={{ fontSize: 14, minWidth: 0, overflowWrap: 'anywhere' }}>{m.name}</strong>
        <span style={{ fontSize: 11, padding: '1px 7px', borderRadius: 999, border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>{t(`kind_${m.kind}` as PKey)}</span>
        {m.confirmEach === false && <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{t('confirmEachOff')}</span>}
        {group && <span style={{ fontSize: 11.5, color: 'var(--anthropic-orange)' }}>▸ {group}</span>}
        {m.tags.map(tag => <span key={tag} style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>#{tag}</span>)}
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-tertiary)' }}>{t('updated', { date: fmt(m.updatedAt) })}</span>
      </div>
      {(m.notes || m.url) && <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4, overflowWrap: 'anywhere' }}>{m.url && <span>{m.url}{m.notes ? ' · ' : ''}</span>}{m.notes}</div>}
      {!trashed && (
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
      {!compact && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
        {!trashed && <button type="button" style={btn} onClick={onEdit}><Pencil size={13} /> {t('edit')}</button>}
        {!trashed && <button type="button" style={btn} onClick={onVersions}><History size={13} /> {t('versions')}</button>}
        {!trashed && (
          <select value={m.groupId ?? ''} onChange={e => { void move(e.target.value || null) }} aria-label={t('move')}
            style={{ ...input, marginBottom: 0, width: 'auto', letterSpacing: 'normal', padding: '5px 8px', fontSize: 12.5, minHeight: isMobile ? 44 : undefined }}>
            <option value="">{t('noGroup')}</option>
            {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        )}
        {!trashed && <button type="button" style={btn} onClick={() => { void act('trash') }}><Trash2 size={13} /> {t('delete')}</button>}
        {trashed && <button type="button" style={btn} onClick={() => { void act('restore') }}><RotateCcw size={13} /> {t('restore')}</button>}
        {trashed && <button type="button" style={{ ...btn, color: '#ef4444', borderColor: '#ef4444' }} onClick={() => { void act('purge') }}><Trash2 size={13} /> {t('purge')}</button>}
      </div>}
      {error && <div style={{ marginTop: 8 }}><Err text={error} /></div>}
    </div>
  )
}

// ── dialogs ──────────────────────────────────────────────────────────────────────────────────

function Sheet({ isMobile, title, onClose, children, wide }: { isMobile: boolean; title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }; window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h) }, [onClose])
  const o: React.CSSProperties = isMobile ? { ...overlay, padding: 0, zIndex: 3000 } : overlay
  const c: React.CSSProperties = isMobile
    ? { ...card, maxWidth: 'none', width: '100%', height: '100dvh', maxHeight: '100dvh', borderRadius: 0, border: 'none', overflowY: 'auto', boxSizing: 'border-box' }
    : { ...card, maxWidth: wide ? 640 : 480, maxHeight: '92vh', overflowY: 'auto', boxSizing: 'border-box' }
  return (
    <div style={o} role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div style={c} onClick={e => e.stopPropagation()}>
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 10 }}>{title}</div>
        {children}
      </div>
    </div>
  )
}
const label = (text: string, el: React.ReactNode) => (
  <label style={{ display: 'block', marginBottom: 10 }}><span style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>{text}</span>{el}</label>
)
const fieldStyle = (isMobile: boolean): React.CSSProperties => ({ ...input, marginBottom: 0, letterSpacing: 'normal', width: '100%', boxSizing: 'border-box', minHeight: isMobile ? 44 : undefined })

function EditDialog({ lang, isMobile, item, groups, gated, defaultGroup, onClose, onSaved }: {
  lang: Lang; isMobile: boolean; item: PersonalMeta | null; groups: PersonalGroup[]; gated: Gated; defaultGroup: string | null
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
  // The values typed here live only in this dialog's state, until save or close.
  const [fields, setFields] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => () => setFields({}), [])
  const editing = item !== null
  const multiline = kind === 'env' || kind === 'note'
  const save = async () => {
    if (busy || !name.trim()) return
    setBusy(true); setError(null)
    const f: Record<string, string> = {}
    for (const k of KIND_FIELDS[kind]) if (fields[k]) f[k] = fields[k]!
    const body = { kind, name: name.trim(), url, groupId: groupId || null, tags: parseTags(tags), notes, confirmEach, ...(Object.keys(f).length ? { fields: f } : {}) }
    const r = editing ? await gated((c, tk) => editPersonal(item.id, item.version, body, c, tk), { action: 'personal-edit', target: item.id }) : await gated(c => createPersonal(body, c), false)
    setBusy(false)
    if (!r.ok) { setError(r.sentence || t('network')); return }
    setFields({})
    onSaved(r.meta)
  }
  return (
    <Sheet isMobile={isMobile} title={editing ? t('editTitle') : t('createTitle')} onClose={onClose}>
      <form onSubmit={e => { e.preventDefault(); void save() }}>
        {label(t('f_kind'), (
          <select value={kind} onChange={e => setKind(e.target.value as PersonalKind)} style={fieldStyle(isMobile)}>
            {PERSONAL_KINDS.map(k => <option key={k} value={k}>{t(`kind_${k}` as PKey)}</option>)}
          </select>
        ))}
        {label(t('f_name'), <input value={name} onChange={e => setName(e.target.value)} maxLength={120} autoFocus style={fieldStyle(isMobile)} />)}
        {KIND_FIELDS[kind].map(k => (
          <div key={k}>
            {label(t(`field_${k}` as PKey), multiline
              ? <textarea value={fields[k] ?? ''} onChange={e => setFields(s => ({ ...s, [k]: e.target.value }))} rows={kind === 'env' ? 6 : 4} spellCheck={false} autoComplete="off"
                style={{ ...fieldStyle(isMobile), fontFamily: 'var(--font-mono, ui-monospace, monospace)', resize: 'vertical' }} />
              : <input value={fields[k] ?? ''} onChange={e => setFields(s => ({ ...s, [k]: e.target.value }))} type={k === 'password' || k === 'value' ? 'password' : 'text'}
                placeholder={k === 'login' ? t('loginHint') : ''} autoComplete={k === 'login' ? 'off' : 'new-password'} spellCheck={false} style={fieldStyle(isMobile)} />)}
          </div>
        ))}
        {editing && <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginTop: -4, marginBottom: 10 }}>{t('f_keep')}</div>}
        {label(t('f_url'), <input value={url} onChange={e => setUrl(e.target.value)} maxLength={500} style={fieldStyle(isMobile)} />)}
        {label(t('f_group'), (
          <select value={groupId} onChange={e => setGroupId(e.target.value)} style={fieldStyle(isMobile)}>
            <option value="">{t('noGroup')}</option>
            {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        ))}
        {label(t('f_tags'), <input value={tags} onChange={e => setTags(e.target.value)} style={fieldStyle(isMobile)} />)}
        {label(t('f_notes'), <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3} maxLength={4000} style={{ ...fieldStyle(isMobile), resize: 'vertical' }} />)}
        <div style={{ marginBottom: 10 }}>
          <Checkbox checked={confirmEach} onChange={setConfirmEach} label={t('confirmEach')} />
          <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginTop: 2, lineHeight: 1.5 }}>{t('confirmEachHelp')}</div>
        </div>
        {editing && <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 10 }}>{t('editAsks')}</div>}
        {error && <Err text={error} />}
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" onClick={onClose} style={{ ...primaryBtn, color: 'var(--text-secondary)', borderColor: 'var(--border)', background: 'transparent', minHeight: isMobile ? 44 : undefined }}>{t('cancel')}</button>
          <button type="submit" disabled={busy || !name.trim()} style={{ ...primaryBtn, minHeight: isMobile ? 44 : undefined }}>{busy ? t('working') : t('save')}</button>
        </div>
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
    <Sheet isMobile={isMobile} title={t('versionsTitle', { name: item.name })} onClose={onClose}>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 10, lineHeight: 1.6 }}>{t('versionsNote')}</div>
      {!list && !error && <Loader2 size={14} className="ag-spin" />}
      {list?.map(v => (
        <div key={v.version} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderTop: '1px solid var(--border)', flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 13 }}>{t('version', { n: v.version })}</strong>
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{fmt(v.updatedAt)} · {v.name}{v.deletedAt ? ` · ${t('trash')}` : ''}</span>
          {v.version === item.version
            ? <span style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--accent-green, #22c55e)' }}>{t('current')}</span>
            : <button type="button" onClick={() => { void restore(v.version) }} style={{ ...primaryBtn, width: 'auto', marginLeft: 'auto', padding: '5px 10px', minHeight: isMobile ? 44 : undefined }}>{t('restoreThis')}</button>}
        </div>
      ))}
      {error && <Err text={error} />}
      <button type="button" onClick={onClose} style={{ marginTop: 10, background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', fontFamily: 'inherit', padding: isMobile ? '12px 0' : '4px 0' }}>{t('close')}</button>
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
  return (
    <Sheet isMobile={isMobile} title={t('importTitle')} onClose={onClose} wide>
      <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginBottom: 10, lineHeight: 1.6 }}>{t('importIntro')}</div>
      {!preview && (
        <label style={{ ...primaryBtn, display: 'inline-flex', alignItems: 'center', gap: 6, width: 'auto', cursor: 'pointer', minHeight: isMobile ? 44 : undefined }}>
          <FileUp size={14} /> {busy ? t('working') : t('chooseFile')}
          <input type="file" accept=".env,text/plain,*/*" style={{ display: 'none' }} onChange={e => { void onFile(e.target.files?.[0]); e.target.value = '' }} />
        </label>
      )}
      {preview && (
        <>
          {preview.skipped > 0 && <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 8 }}>{t('importSkipped', { n: preview.skipped })}</div>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
            {preview.keys.map(k => {
              const c = choices.find(x => x.key === k.key)!
              return (
                <div key={k.key} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', borderTop: '1px solid var(--border)', paddingTop: 6 }}>
                  <code style={{ fontSize: 12.5, minWidth: 0, overflowWrap: 'anywhere', flex: '1 1 140px' }}>{k.key}</code>
                  {k.clash && <span style={{ fontSize: 11, color: 'var(--accent-orange, #f59e0b)' }}>{t('clash')}</span>}
                  {k.empty && <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{t('emptyValue')}</span>}
                  <select value={c.action} onChange={e => setChoice(k.key, { action: e.target.value as ImportChoice['action'] })}
                    style={{ ...input, marginBottom: 0, width: 'auto', letterSpacing: 'normal', padding: '4px 8px', fontSize: 12.5, minHeight: isMobile ? 44 : undefined }}>
                    {(k.clash ? ['skip', 'replace', 'rename'] as const : ['import', 'skip'] as const).map(a => <option key={a} value={a}>{t(`act_${a}` as PKey)}</option>)}
                  </select>
                  {c.action === 'rename' && <input value={c.name ?? ''} onChange={e => setChoice(k.key, { name: e.target.value })} placeholder={k.key} style={{ ...input, marginBottom: 0, width: 160, letterSpacing: 'normal', minHeight: isMobile ? 44 : undefined }} />}
                </div>
              )
            })}
          </div>
          {label(t('importInto'), (
            <select value={groupId} onChange={e => setGroupId(e.target.value)} style={fieldStyle(isMobile)}>
              <option value="">{t('noGroup')}</option>
              {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          ))}
          <button type="button" style={{ ...primaryBtn, minHeight: isMobile ? 44 : undefined }} disabled={busy || !importReady(choices)} onClick={() => { void commit() }}>{busy ? t('working') : t('importGo')}</button>
        </>
      )}
      {error && <div style={{ marginTop: 8 }}><Err text={error} /></div>}
      <button type="button" onClick={onClose} style={{ marginTop: 10, background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', fontFamily: 'inherit', padding: isMobile ? '12px 0' : '4px 0' }}>{t('cancel')}</button>
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
  return (
    <Sheet isMobile={isMobile} title={t('groups')} onClose={onClose}>
      <form onSubmit={e => { e.preventDefault(); if (name.trim()) void run(c => createGroup(name.trim(), c), false).then(ok => { if (ok) setName('') }) }} style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <input value={name} onChange={e => setName(e.target.value)} placeholder={t('groupName')} aria-label={t('groupName')} maxLength={120} style={{ ...fieldStyle(isMobile), flex: 1 }} />
        <button type="submit" disabled={!name.trim()} style={{ ...primaryBtn, width: 'auto', minHeight: isMobile ? 44 : undefined }}><FolderPlus size={14} /></button>
      </form>
      {groups.map(g => (
        <div key={g.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderTop: '1px solid var(--border)', flexWrap: 'wrap' }}>
          {renaming?.id === g.id
            ? <input value={renaming.name} onChange={e => setRenaming({ id: g.id, name: e.target.value })} autoFocus style={{ ...fieldStyle(isMobile), flex: 1 }} />
            : <span style={{ fontSize: 13.5, fontWeight: 600, flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{g.name} <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--text-tertiary)' }}>· {t('items', { n: items.filter(i => i.groupId === g.id && !i.deletedAt).length })}</span></span>}
          {renaming?.id === g.id
            ? <button type="button" onClick={() => { void run(c => renameGroup(g.id, g.version, renaming.name.trim(), c), false).then(ok => { if (ok) setRenaming(null) }) }} style={{ ...primaryBtn, width: 'auto', padding: '5px 10px' }}>{t('save')}</button>
            : <button type="button" onClick={() => setRenaming({ id: g.id, name: g.name })} style={{ ...primaryBtn, width: 'auto', padding: '5px 10px', color: 'var(--text-secondary)', borderColor: 'var(--border)', background: 'transparent' }}>{t('rename')}</button>}
          <button type="button" title={t('deleteGroupNote')} onClick={() => { void run((c, tk) => deleteGroup(g.id, c, tk), { action: 'personal-group-delete', target: g.id }) }} style={{ ...dangerBtn, width: 'auto', padding: '5px 10px' }}>{t('deleteGroup')}</button>
        </div>
      ))}
      {groups.length > 0 && <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginTop: 6 }}>{t('deleteGroupNote')}</div>}
      {error && <Err text={error} />}
      <button type="button" onClick={onClose} style={{ marginTop: 10, background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', fontFamily: 'inherit', padding: isMobile ? '12px 0' : '4px 0' }}>{t('close')}</button>
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
  const small: React.CSSProperties = { ...dangerBtn, width: 'auto', padding: '5px 10px', minHeight: isMobile ? 44 : undefined }
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
      <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 10, cursor: 'pointer' }}>
        <input type="checkbox" checked={state.codeReveal} onChange={e => { const on = e.target.checked; void gated(c => setCodeReveal(on, c), { action: 'mobile-code-reveal', target: '' }).then(r => { if (r.ok) onChanged(); else setError(r.sentence || t('network')) }) }} style={{ marginTop: 3 }} />
        <span>
          <span style={{ display: 'block', fontSize: 13, fontWeight: 600 }}>{t('phoneCodeToggle')}</span>
          <span style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{t('phoneCodeCost')}</span>
        </span>
      </label>
      {error && <div style={{ marginTop: 8 }}><Err text={error} /></div>}
    </div>
  )
}

function CodeForm({ lang, isMobile, prompt, error, onSubmit }: { lang: Lang; isMobile: boolean; prompt: string; error: string | null; onSubmit: (code: string) => Promise<void> }) {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <form onSubmit={e => { e.preventDefault(); if (codeComplete(code) && !busy) { setBusy(true); void onSubmit(code).finally(() => { setBusy(false); setCode('') }) } }}
      style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 18, maxWidth: 420 }}>
      <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 10 }}>{prompt}</div>
      <input value={code} onChange={e => setCode(cleanCode(e.target.value))} placeholder="123456" inputMode="numeric" autoComplete="one-time-code" autoFocus maxLength={6}
        aria-label={pt_('codeLabel', lang)} style={{ ...input, minHeight: isMobile ? 44 : undefined }} />
      {error && <Err text={error} />}
      <button type="submit" disabled={busy || !codeComplete(code)} style={{ ...primaryBtn, minHeight: isMobile ? 44 : undefined }}>{busy ? pt_('working', lang) : pt_('confirm', lang)}</button>
    </form>
  )
}

function CodeDialog({ lang, isMobile, onDone }: { lang: Lang; isMobile: boolean; onDone: (code: string | null) => void }) {
  return (
    <Sheet isMobile={isMobile} title={pt_('codeLabel', lang)} onClose={() => onDone(null)}>
      <CodeForm lang={lang} isMobile={isMobile} prompt={pt_('needsCode', lang).replace(/ para ver a lista\.| to see the list\./, '.')} error={null} onSubmit={async code => { onDone(code) }} />
    </Sheet>
  )
}

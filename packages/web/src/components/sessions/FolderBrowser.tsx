/**
 * FolderBrowser — "Procurar pasta…": pick ANY folder without typing a path.
 *
 * Drawn inline in the "Onde" step in place of the project list (not a second dialog on top of the
 * wizard — a phone cannot hold two). It is the same rows, borders and `Muted` text the list beside
 * it uses, with a breadcrumb (disks → folder → subfolder) on top and "Usar esta pasta" below. One
 * level per request; the server decides what may be browsed (`/api/fs/folders`) and this component
 * says its refusals in words, never as an empty list.
 */
import { useEffect, useRef, useState } from 'react'
import { ChevronRight, Folder, FolderPlus, HardDrive, Loader } from 'lucide-react'
import { checkProjectName, joinProjectPath, projectNameMessage } from '@agentistics/core'
import { breadcrumbs, fetchFolders, rootLabels, shortPath, startFolderPath, type DiskInfo, type FolderListing } from '../../lib/folderBrowser'
import { createProjectFolder, type CreateFolderRefusal } from '../../lib/newProjectApi'
import { ConfirmModal } from '../../pages/settings/primitives'
import { Muted, inputStyle } from './formBits'

export interface FolderBrowserProps {
  lang: 'pt' | 'en'
  isMobile: boolean
  /** The disk chosen in the picker's disk filter; the install disk (or `all`) starts at the home. */
  startDisk?: { path: string; install: boolean } | null
  /** The picker's own disks, so a root reads as the filter names it ("This disk", "Drive D:"). */
  disks?: readonly DiskInfo[]
  onUse: (path: string) => void
  onCancel: () => void
  /** The primary button's words; "Usar esta pasta" by default. */
  useLabel?: string
  /** "Novo projeto" (t-eab4751cb3): offer "Nova pasta aqui" in the folder being browsed; a
   *  created folder is USED at once (`onUse`). Absent = today's browser, unchanged. */
  allowCreate?: boolean
}

export function FolderBrowser({ lang, isMobile, startDisk, disks = [], onUse, onCancel, useLabel, allowCreate }: FolderBrowserProps) {
  const pt = lang === 'pt'
  const [roots, setRoots] = useState<string[]>([])
  const [listing, setListing] = useState<FolderListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const rootsRef = useRef<string[]>([])
  // Option B's inline "new folder" row: closed (null) or the name being typed.
  const [newName, setNewName] = useState<string | null>(null)
  const [createError, setCreateError] = useState<{ reason: CreateFolderRefusal; path?: string } | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [creating, setCreating] = useState(false)

  async function go(path: string, signal?: AbortSignal) {
    setLoading(true); setError(null)
    try {
      const l = await fetchFolders(path, signal)
      if (path === '') { const r = l.folders.map(f => f.path); rootsRef.current = r; setRoots(r) }
      setListing(l)
    } catch (e) {
      if (signal?.aborted) return
      const code = e instanceof Error ? e.message : 'failed'
      setError(code === 'forbidden'
        ? (pt ? 'Essa pasta não está liberada para navegar.' : 'That folder is not open for browsing.')
        : code === 'not-found'
          ? (pt ? 'Não achei essa pasta.' : 'I could not find that folder.')
          : (pt ? 'Não consegui listar as pastas.' : 'I could not list the folders.'))
    } finally { if (!signal?.aborted) setLoading(false) }
  }

  useEffect(() => {
    const ac = new AbortController()
    void (async () => {
      await go('', ac.signal)
      if (ac.signal.aborted) return
      const home = rootsRef.current[0]
      const start = startFolderPath(startDisk, home)
      if (start) await go(start, ac.signal)
    })()
    return () => ac.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const here = listing?.path ?? ''
  const labels = rootLabels(roots, disks, pt)
  const crumbs = breadcrumbs(here, roots, pt ? 'Discos' : 'Disks', labels)
  const rowH = isMobile ? 44 : 36

  return (
    <div>
      <nav aria-label={pt ? 'Caminho' : 'Path'} style={{
        display: 'flex', alignItems: 'center', gap: 2, marginBottom: 8, overflowX: 'auto',
        whiteSpace: 'nowrap', fontSize: 11.5,
      }}>
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1
          return (
            <span key={c.path || 'top'} style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
              {i > 0 && <ChevronRight size={12} style={{ color: 'var(--text-tertiary)' }} />}
              <button type="button" disabled={last} onClick={() => void go(c.path)} style={{
                border: 'none', background: 'transparent', cursor: last ? 'default' : 'pointer',
                fontFamily: 'inherit', fontSize: 11.5, padding: isMobile ? '12px 6px' : '4px 6px', borderRadius: 6,
                color: last ? 'var(--text-primary)' : 'var(--anthropic-orange)', fontWeight: last ? 650 : 500,
              }}>{c.label}</button>
            </span>
          )
        })}
      </nav>

      <div style={{
        maxHeight: 220, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4,
        border: '1px solid var(--border-subtle)', borderRadius: 10, padding: 6,
      }}>
        {allowCreate && here && newName === null && (
          <button type="button" onClick={() => { setNewName(''); setCreateError(null) }} style={{
            display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left', minHeight: rowH,
            padding: '6px 10px', borderRadius: 8, border: '1px dashed var(--border)', minWidth: 0, flexShrink: 0,
            background: 'transparent', color: 'var(--anthropic-orange)', cursor: 'pointer', fontFamily: 'inherit',
          }}>
            <FolderPlus size={15} style={{ flexShrink: 0 }} />
            <span style={{ fontSize: 12.5, fontWeight: 600 }}>{pt ? 'Nova pasta aqui' : 'New folder here'}</span>
          </button>
        )}
        {allowCreate && here && newName !== null && (() => {
          const check = checkProjectName(newName)
          const err = createError?.reason ?? (!check.ok && check.reason !== 'empty' ? check.reason : null)
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 6, borderRadius: 8, flexShrink: 0, background: 'var(--anthropic-orange-dim)' }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexDirection: isMobile ? 'column' : 'row' }}>
                <input autoFocus value={newName} spellCheck={false} autoComplete="off"
                  aria-invalid={err ? true : undefined}
                  placeholder={pt ? 'Nome da nova pasta' : 'New folder name'}
                  onChange={e => { setNewName(e.target.value); setCreateError(null) }}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && check.ok) { e.preventDefault(); setConfirming(true) }
                    if (e.key === 'Escape') { e.stopPropagation(); setNewName(null) }
                  }}
                  style={{ ...inputStyle, paddingLeft: 12, flex: 1, ...(err ? { borderColor: 'var(--accent-red)' } : {}) }} />
                <span style={{ display: 'flex', gap: 6, width: isMobile ? '100%' : undefined }}>
                  <button type="button" onClick={() => setNewName(null)} style={{
                    minHeight: isMobile ? 44 : 34, padding: '0 12px', borderRadius: 9, cursor: 'pointer', flex: isMobile ? 1 : undefined,
                    border: '1px solid var(--border-subtle)', background: 'transparent', color: 'var(--text-secondary)', fontFamily: 'inherit', fontSize: 12.5,
                  }}>{pt ? 'Cancelar' : 'Cancel'}</button>
                  <button type="button" disabled={!check.ok || creating} onClick={() => setConfirming(true)} style={{
                    minHeight: isMobile ? 44 : 34, padding: '0 12px', borderRadius: 9, border: 'none', flex: isMobile ? 1 : undefined,
                    cursor: check.ok ? 'pointer' : 'not-allowed', opacity: check.ok ? 1 : 0.5,
                    background: 'var(--anthropic-orange)', color: '#fff', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 650,
                  }}>{pt ? 'Criar' : 'Create'}</button>
                </span>
              </div>
              {err && (
                <span role="alert" style={{ fontSize: 11.5, color: 'var(--accent-red)', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {projectNameMessage(err, pt)}
                  {createError?.reason === 'exists' && createError.path && (
                    <button type="button" onClick={() => onUse(createError.path!)} style={{
                      border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', fontFamily: 'inherit',
                      fontSize: 11.5, fontWeight: 650, color: 'var(--anthropic-orange)', textDecoration: 'underline',
                    }}>{pt ? 'Usar a pasta que já existe' : 'Use the existing folder'}</button>
                  )}
                </span>
              )}
              <ConfirmModal
                open={confirming && check.ok}
                tone="default"
                icon={<FolderPlus size={17} />}
                title={pt ? `Criar a pasta “${newName.trim()}”?` : `Create the folder “${newName.trim()}”?`}
                message={pt
                  ? `Vou criar ${shortPath(joinProjectPath(here, newName.trim()))} e abrir a sessão dentro dela.`
                  : `I will create ${shortPath(joinProjectPath(here, newName.trim()))} and start the session inside it.`}
                confirmLabel={pt ? 'Criar pasta' : 'Create folder'}
                cancelLabel={pt ? 'Cancelar' : 'Cancel'}
                onCancel={() => setConfirming(false)}
                onConfirm={() => {
                  setConfirming(false); setCreating(true)
                  void createProjectFolder(here, newName.trim()).then(out => {
                    setCreating(false)
                    if (out.ok) onUse(out.path)
                    else setCreateError({ reason: out.reason, ...(out.path ? { path: out.path } : {}) })
                  })
                }}
              />
            </div>
          )
        })()}
        {loading && !listing ? (
          <Muted text={pt ? 'Lendo as pastas…' : 'Reading folders…'} />
        ) : error ? (
          <Muted text={error} />
        ) : listing && listing.folders.length === 0 ? (
          <Muted text={listing.partial
            ? (pt ? 'Este disco demorou para responder. Tente de novo em instantes.' : 'This disk was slow to answer. Try again in a moment.')
            : (pt ? 'Não há subpastas aqui. Você pode usar esta pasta.' : 'There are no subfolders here. You can use this folder.')} />
        ) : listing?.folders.map(f => (
          <button key={f.path} type="button" onClick={() => void go(f.path)} style={{
            display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left', minHeight: rowH,
            padding: '6px 10px', borderRadius: 8, border: 'none', minWidth: 0,
            background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer', fontFamily: 'inherit',
          }}>
            {here === '' ? <HardDrive size={15} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
              : <Folder size={15} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />}
            <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{here === '' ? (labels[f.path] ?? f.name) : f.name}</span>
            {f.hasChildren && <ChevronRight size={13} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />}
          </button>
        ))}
        {loading && listing && (
          <Loader size={13} className="ag-working-spin" style={{ alignSelf: 'center', color: 'var(--text-tertiary)' }} />
        )}
      </div>
      {listing?.partial && listing.folders.length > 0 && (
        <p style={{ margin: '6px 0 0', fontSize: 10.5, color: 'var(--text-tertiary)' }}>
          {pt ? 'A lista pode estar incompleta: o disco demorou para responder.' : 'The list may be incomplete: the disk was slow to answer.'}
        </p>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 8, justifyContent: 'flex-end' }}>
        <button type="button" onClick={onCancel} style={{
          minHeight: isMobile ? 44 : 32, padding: '0 14px', borderRadius: 9, cursor: 'pointer',
          border: '1px solid var(--border-subtle)', background: 'transparent', color: 'var(--text-secondary)',
          fontFamily: 'inherit', fontSize: 12.5,
        }}>{pt ? 'Voltar à busca' : 'Back to search'}</button>
        <button type="button" disabled={!here} onClick={() => here && onUse(here)} style={{
          minHeight: isMobile ? 44 : 32, padding: '0 14px', borderRadius: 9, border: 'none',
          cursor: here ? 'pointer' : 'not-allowed', opacity: here ? 1 : 0.5,
          background: 'var(--anthropic-orange)', color: '#fff', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 650,
        }}>{useLabel ?? (pt ? 'Usar esta pasta' : 'Use this folder')}</button>
      </div>
    </div>
  )
}

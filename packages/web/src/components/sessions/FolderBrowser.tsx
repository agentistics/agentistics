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
import { ChevronRight, Folder, HardDrive, Loader } from 'lucide-react'
import { breadcrumbs, diskLabel, fetchFolders, rootLabels, type DiskInfo, type FolderListing } from '../../lib/folderBrowser'
import { Muted } from './formBits'

export interface FolderBrowserProps {
  lang: 'pt' | 'en'
  isMobile: boolean
  /** The disk chosen in the picker's disk filter; the install disk (or `all`) starts at the home. */
  startDisk?: { path: string; install: boolean } | null
  /** The picker's own disks, so a root reads as the filter names it ("This disk", "Drive D:"). */
  disks?: readonly DiskInfo[]
  onUse: (path: string) => void
  onCancel: () => void
}

export function FolderBrowser({ lang, isMobile, startDisk, disks = [], onUse, onCancel }: FolderBrowserProps) {
  const pt = lang === 'pt'
  const [roots, setRoots] = useState<string[]>([])
  const [listing, setListing] = useState<FolderListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const rootsRef = useRef<string[]>([])

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
      const start = startDisk && !startDisk.install ? startDisk.path : home
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
        }}>{pt ? 'Usar esta pasta' : 'Use this folder'}</button>
      </div>
    </div>
  )
}

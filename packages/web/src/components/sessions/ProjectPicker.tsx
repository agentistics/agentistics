/**
 * ProjectPicker — the folder/project search-and-pick UI, pulled out of `NewSessionModal`'s "Onde"
 * step so a second dialog that needs a folder (the staged-session compose panel, t-918cc82233) does
 * not fall back to a raw absolute-path text field the person has to type blind.
 *
 * THE SEARCH BOX IS ALSO THE ESCAPE HATCH: typing a full path (starting with `/` or `~`) is checked
 * against the disk by the server (`project-source.ts`'s `typed` candidate) and, when it resolves,
 * appears as a normal row in the list — so "type an absolute path" and "pick from the list" are the
 * SAME gesture, never two different fields with two different amounts of validation.
 *
 * THE FOUR KINDS, AND ALL. A repository, a worktree, a project and a plain folder were one list
 * separated only by an icon; the tabs are the division said in words, and the counts are what make
 * an empty tab readable as "nothing of this kind matched" rather than as a broken filter.
 * `projectKind` is `@agentistics/core`'s, so these buckets and the server's per-kind budget can
 * never disagree about what a row is. `all` is the default and keeps the server's own ranking — the
 * tabs FILTER it, they never re-order it.
 */
import { useMemo, useState } from 'react'
import { FolderClock, FolderGit2, FolderOpen, FolderSymlink, Folder, Loader, Search, X } from 'lucide-react'
import { projectKind, type ProjectKind } from '@agentistics/core'
import {
  KIND_TABS, kindCount, kindEmpty, kindHint, kindLabel, kindMore, kindMoreText, type ProjectTab,
} from '../../lib/projectTabs'
import { Muted, inputStyle } from './formBits'
import { diskLabel, shortPath } from '../../lib/folderBrowser'
import { chooseFolderLabel } from '../../lib/projectPickerCopy'
import { FolderBrowser } from './FolderBrowser'

export interface ProjectPickerOption {
  path: string
  label: string
  repo?: string
  detail: string
  source: string
  /** True only for a LINKED worktree — never its own main checkout. See `ProjectKind`. */
  worktree?: boolean
}

export interface ProjectPickerProps {
  lang: 'pt' | 'en'
  isMobile: boolean
  projects: readonly ProjectPickerOption[]
  /** How many places of each kind MATCHED, before the server's per-kind cap. `undefined` means this
   *  server does not say. */
  projectTotals: Record<ProjectKind, number> | undefined
  projectIndexing?: boolean
  projectIndexProgress?: { root: string; visited: number; queued: number; complete: boolean }[]
  projectDisks?: { id: string; label: string; letter?: string; install: boolean; count: number }[]
  projectDisk?: string
  onProjectDiskChange?: (disk: string) => void
  /** The field's own value — see `useFleetNewOptions`. */
  query: string
  onQueryChange: (q: string) => void
  /** A search is in flight for a query the list has not caught up with yet. */
  searching: boolean
  /** The chosen path, or `''` for "none chosen yet". */
  value: string
  onChange: (path: string) => void
}

export function ProjectPicker({
  lang, isMobile, projects, projectTotals, projectIndexing, projectIndexProgress, projectDisks, projectDisk, onProjectDiskChange, query, onQueryChange, searching, value, onChange,
}: ProjectPickerProps) {
  const pt = lang === 'pt'
  /** Which kind of place the list is showing. `all` is the default — see `projectKind`. */
  const [kindTab, setKindTab] = useState<ProjectTab>('all')
  /** "Procurar pasta…" is open: the browser takes the list's place. */
  const [browsing, setBrowsing] = useState(false)

  /**
   * The rows, split by KIND, and the counts the tabs carry.
   *
   * `projectKind` is `@agentistics/core`'s — the same function the server caps its results with, so
   * a row can never be counted under one kind here and budgeted under another there.
   */
  const byKind = useMemo(() => {
    const out: Record<ProjectKind, ProjectPickerOption[]> = { repo: [], worktree: [], project: [], folder: [] }
    for (const p of projects) {
      out[projectKind({ source: p.source, remote: p.repo, worktree: p.worktree })].push(p)
    }
    // Worktrees read better GROUPED by the repository they belong to, so the siblings of one
    // checkout sit together rather than scattered across the tab by unrelated recency. A worktree
    // with no known repo sorts last, under an empty key, rather than mixing in among named ones.
    out.worktree.sort((a, b) => (a.repo ?? '￿').localeCompare(b.repo ?? '￿'))
    return out
  }, [projects])

  /** What the list is showing. `all` keeps the server's ranking, which is the useful default. */
  const shownProjects = (kindTab === 'all' ? projects : byKind[kindTab]).filter(p => p.path !== value)
  /** Whether rows are being held back, and how many — `null` whenever that cannot be known. */
  const shownMore = kindMore(
    shownProjects.length,
    projectTotals ? kindCount(kindTab, shownProjects.length, projectTotals) : undefined,
    shownProjects.length > 0,
  )

  return (
    <div>
      <div style={{ position: 'relative', marginBottom: 8 }}>
        <Search size={13} style={{
          position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)',
          color: 'var(--text-tertiary)', pointerEvents: 'none',
        }} />
        <input
          value={query}
          onChange={e => onQueryChange(e.target.value)}
          placeholder={pt ? 'Buscar repositório, projeto ou pasta…' : 'Search repository, project or folder…'}
          style={inputStyle}
        />
        {/* THE SEARCH SAYS IT IS RUNNING. The field answers instantly and the list follows a
            debounce behind it, so without this the two disagree for a moment and the list reads as
            stale rather than as catching up. */}
        {searching && (
          <Loader size={13} className="ag-working-spin" style={{
            position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
            color: 'var(--text-tertiary)', pointerEvents: 'none',
          }} />
        )}
      </div>

      {browsing ? (
        <FolderBrowser
          lang={lang}
          isMobile={isMobile}
          disks={projectDisks}
          startDisk={(() => {
            const d = projectDisks?.find(x => x.id === projectDisk)
            return d ? { path: d.id, install: d.install } : null
          })()}
          onUse={path => { onChange(path); setBrowsing(false) }}
          onCancel={() => setBrowsing(false)}
        />
      ) : (<>
      {projectDisks && projectDisks.length > 1 && (
        <div role="tablist" aria-label={pt ? 'Disco' : 'Disk'} style={{
          display: 'flex', gap: 3, marginBottom: 8, padding: 3, borderRadius: 9,
          background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)',
          overflowX: isMobile ? 'auto' : 'visible',
        }}>
          {[...projectDisks.map(d => ({
            id: d.id,
            label: diskLabel(d, pt),
            count: d.count,
          })), { id: 'all', label: pt ? 'Todos os discos' : 'All disks', count: projectDisks.reduce((n, d) => n + d.count, 0) }].map(d => {
            const on = (projectDisk || projectDisks.find(x => x.install)?.id) === d.id
            return <button key={d.id} role="tab" aria-selected={on} onClick={() => onProjectDiskChange?.(d.id)} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
              minHeight: 28, borderRadius: 7, border: 'none', cursor: 'pointer',
              background: on ? 'var(--bg-surface)' : 'transparent',
              color: on ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
              fontFamily: 'inherit', fontSize: 11, fontWeight: on ? 650 : 500,
              ...(isMobile ? { flexShrink: 0, padding: '0 10px', whiteSpace: 'nowrap' } : { flex: 1, minWidth: 0 }),
            }}><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.label}</span><span style={{ fontSize: 10, color: 'var(--text-tertiary)', flexShrink: 0 }}>{d.count}</span></button>
          })}
        </div>
      )}

      <div role="tablist" style={{
        display: 'flex', gap: 3, marginBottom: 8, padding: 3, borderRadius: 9,
        background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)',
        // FIVE equal-flex tabs at 390px truncated every label to a couple of letters — technically
        // no page scroll, but unreadable. On mobile each tab keeps its NATURAL width (measured, not
        // shrunk) and the strip scrolls horizontally INSIDE ITSELF instead — the page as a whole
        // must never gain a horizontal scrollbar over this row, but this row may have its own.
        overflowX: isMobile ? 'auto' : 'visible',
      }}>
        {KIND_TABS.map(id => {
          const on = kindTab === id
          const n = kindCount(id, id === 'all' ? projects.length : byKind[id].length, projectTotals)
          return (
            <button
              key={id}
              role="tab"
              aria-selected={on}
              onClick={() => setKindTab(id)}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                gap: 5, minHeight: 30, borderRadius: 7, border: 'none', cursor: 'pointer',
                background: on ? 'var(--bg-surface)' : 'transparent',
                color: on ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
                fontFamily: 'inherit', fontSize: 11.5, fontWeight: on ? 650 : 500,
                ...(isMobile
                  ? { flexShrink: 0, padding: '0 10px', whiteSpace: 'nowrap' }
                  : { flex: 1, minWidth: 0 }),
              }}
            >
              <span style={isMobile ? undefined : { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {kindLabel(id, pt)}
              </span>
              {/* The count is DIMMED and never coloured: it is a size, not a state. */}
              <span style={{ fontSize: 10, color: 'var(--text-tertiary)', flexShrink: 0 }}>{n}</span>
            </button>
          )
        })}
      </div>

      {/* WHAT THIS TAB HOLDS, in a sentence — an icon separated a repository from a folder and
          nothing on screen ever said what the difference was. */}
      <p style={{ margin: '0 0 8px', fontSize: 10.5, lineHeight: 1.45, color: 'var(--text-tertiary)' }}>
        {kindHint(kindTab, pt)}
        {shownMore && <> {kindMoreText(shownMore, pt)}</>}
        {projectIndexing && <> {pt ? 'Indexando discos em segundo plano' : 'Indexing disks in the background'}{projectIndexProgress?.length ? ` (${projectIndexProgress.reduce((n, p) => n + p.visited, 0)} visited, ${projectIndexProgress.reduce((n, p) => n + p.queued, 0)} queued)…` : '…'}</>}
      </p>

      <div style={{
        maxHeight: 190, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4,
        border: '1px solid var(--border-subtle)', borderRadius: 10, padding: 6,
      }}>
        {value && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 8, minWidth: 0,
            background: 'var(--anthropic-orange-dim)', color: 'var(--text-primary)',
          }}>
            <Folder size={15} style={{ color: 'var(--anthropic-orange)', flexShrink: 0 }} />
            <span style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }} title={value}>
              <span style={{ fontSize: 12.5, fontWeight: 650, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {projects.find(p => p.path === value)?.label ?? (value.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || value)}
              </span>
              <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {shortPath(value)}
              </span>
            </span>
            <button type="button" className="ag-tap-icon" onClick={() => onChange('')} aria-label={pt ? 'Desfazer a escolha' : 'Clear the choice'} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, border: 'none',
              background: 'transparent', cursor: 'pointer', color: 'var(--text-tertiary)', borderRadius: 6,
              width: 28, height: 28,
            }}><X size={14} /></button>
          </div>
        )}
        {shownProjects.length === 0 && !value ? (
          /* A SENTENCE PER REASON. "Nothing matched this search" and "nothing of this kind is here"
             send a reader to two different actions — clear the box, or switch tab. */
          <Muted text={kindEmpty(kindTab, query, projects.length > 0, pt, (() => {
            const selected = projectDisk && projectDisk !== 'all'
            const progress = selected ? projectIndexProgress?.find(p => p.root === projectDisk) : undefined
            return selected && progress
              ? { selected: true, indexing: !progress.complete, visited: progress.visited }
              : undefined
          })())} />
        ) : shownProjects.map(p => {
          const on = value === p.path
          return (
            <button
              key={p.path}
              type="button"
              onClick={() => onChange(p.path)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left',
                padding: '8px 10px', borderRadius: 8, border: 'none', minWidth: 0,
                background: on ? 'var(--anthropic-orange-dim)' : 'transparent',
                color: 'var(--text-primary)', cursor: 'pointer', fontFamily: 'inherit',
              }}
            >
              {/* THE MARK IS THE KIND, and it is the same `projectKind` the tabs file by — so the
                  icon and the tab a row sits under can never say different things. */}
              {(() => {
                const kind = projectKind({ source: p.source, remote: p.repo, worktree: p.worktree })
                if (kind === 'repo') return <FolderGit2 size={15} style={{ color: 'var(--accent-purple)', flexShrink: 0 }} />
                // A DIFFERENT mark from `repo`, on purpose — it is PART of a repository, not a
                // repository of its own.
                if (kind === 'worktree') return <FolderSymlink size={15} style={{ color: 'var(--accent-cyan)', flexShrink: 0 }} />
                if (kind === 'project') return <FolderClock size={15} style={{ color: 'var(--anthropic-orange)', flexShrink: 0 }} />
                return <Folder size={15} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
              })()}
              <span style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontSize: 12.5, fontWeight: on ? 650 : 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {p.label}
                </span>
                <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {p.repo ? `${p.repo} · ${p.detail}` : p.detail}
                </span>
              </span>
            </button>
          )
        })}
        <button
          type="button"
          onClick={() => setBrowsing(true)}
          style={{
            display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left',
            padding: '8px 10px', borderRadius: 8, border: 'none', minWidth: 0,
            background: 'transparent', color: 'var(--anthropic-orange)', cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          <FolderOpen size={15} style={{ flexShrink: 0 }} />
          <span style={{ fontSize: 12.5 }}>{chooseFolderLabel(pt)}</span>
        </button>
      </div>
      </>)}
    </div>
  )
}

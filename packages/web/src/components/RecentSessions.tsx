import React, { useState, useMemo, useEffect, useRef } from 'react'
import type { SessionMeta } from '@agentistics/core'
import { sessionTime } from '../lib/sessionTime'
import { formatProjectName, repoShortName, sessionLabel, sessionTokenTotal } from '@agentistics/core'
import type { SessionActivity } from '../lib/sessionNotifications'
import { resumeCommand } from '../lib/resumeCommand'
import { HARNESS_LABELS, HARNESS_COLORS } from '../lib/harness'
import { format, parseISO } from 'date-fns'
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  Terminal,
  Send,
  Check,
  Copy,
  ChevronsRight,
  Search,
  Clock,
  Wrench,
  FileCode,
  GitCommit,
  ExternalLink,
  LayoutGrid,
  List,
  Layers,
  ChevronDown,
  ChevronUp,
  Folder,
  Radio,
  Tag,
  Bookmark,
  Bot,
  ArrowUpDown,
  Filter,
  Maximize2,
  X,
} from 'lucide-react'

// Types

interface Props {
  sessions: SessionMeta[]
  lang: 'pt' | 'en'
  onSelect?: (session: SessionMeta) => void
  /** session_ids to pin to the top of the list (e.g. live/open sessions), regardless of sort. */
  pinnedIds?: Set<string>
  /** What each LIVE session is doing right now, from `/api/live-sessions`. A session absent here
   *  has no observable state — the row says so rather than claiming one. */
  activities?: Record<string, SessionActivity>
  viewMode?: 'list' | 'grid'
  onViewModeChange?: (mode: 'list' | 'grid') => void
  title?: React.ReactNode
  subtitle?: React.ReactNode
  topActions?: React.ReactNode
}

/** `task` is deliberately absent: a task is a fact of the agentop session registry, not of a
 *  stored `SessionMeta`, so a "group by task" here could only ever produce one "no task" band. */
export type SessionGrouping = 'none' | 'status' | 'repo' | 'project' | 'harness' | 'model' | 'marked'

const STATUS_BUCKETS: Record<SessionActivity, { label: string; color: string }> = {
  'waiting-approval': { label: 'Aguardando aprovação', color: '#ef4444' },
  waiting: { label: 'Aguardando resposta', color: '#f59e0b' },
  working: { label: 'Trabalhando', color: '#22c55e' },
  exited: { label: 'Encerradas / Histórico', color: 'var(--text-tertiary)' },
}
export type StatusShortcut = 'all' | 'active' | 'waiting' | 'closed'
export type SortKey = 'date' | 'status' | 'tokens' | 'messages' | 'tools' | 'files' | 'name'
export type SortDir = 'asc' | 'desc'

// Translations

const T = {
  pt: {
    group_by: 'Agrupar por:',
    group_none: 'Nenhum',
    group_status: 'Status',
    group_repo: 'Repositório',
    group_project: 'Projeto',
    group_task: 'Tarefa',
    group_harness: 'Harness',
    group_model: 'Modelo',
    group_marked: 'Marcadas',

    shortcut_all: 'Todas',
    shortcut_active: 'Ativas',
    shortcut_waiting: 'Aguardando',
    shortcut_closed: 'Encerradas',

    sort_date: 'Data',
    sort_status: 'Status',
    sort_tokens: 'Tokens',
    sort_messages: 'Mensagens',
    sort_tools: 'Tools',
    sort_files: 'Arquivos',
    sort_name: 'Nome',

    filters: 'Filtros',
    search_placeholder: 'Buscar sessão...',
    showing: 'Exibindo',
    of: 'de',
    per_page: 'por página',
    no_results: 'Nenhuma sessão encontrada',
    page: 'Página',
    sessions_unit: 'sessões',
    details_btn: 'Detalhes da sessão',
  },
  en: {
    group_by: 'Group by:',
    group_none: 'None',
    group_status: 'Status',
    group_repo: 'Repo',
    group_project: 'Project',
    group_task: 'Task',
    group_harness: 'Harness',
    group_model: 'Model',
    group_marked: 'Marked',

    shortcut_all: 'All',
    shortcut_active: 'Active',
    shortcut_waiting: 'Waiting',
    shortcut_closed: 'Closed',

    sort_date: 'Date',
    sort_status: 'Status',
    sort_tokens: 'Tokens',
    sort_messages: 'Messages',
    sort_tools: 'Tools',
    sort_files: 'Files',
    sort_name: 'Name',

    filters: 'Filters',
    search_placeholder: 'Search session...',
    showing: 'Showing',
    of: 'of',
    per_page: 'per page',
    no_results: 'No sessions found',
    page: 'Page',
    sessions_unit: 'sessions',
    details_btn: 'Session details',
  },
}

// Helpers

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return String(n)
}

function totalTokens(s: SessionMeta): number {
  // All four billed counters — `input + output` alone is a fraction of a percent of the volume.
  return sessionTokenTotal(s)
}

function totalMessages(s: SessionMeta): number {
  return (s.user_message_count || 0) + (s.assistant_message_count || 0)
}

function totalTools(s: SessionMeta): number {
  return Object.values(s.tool_counts ?? {}).reduce((a, b) => a + b, 0)
}

function truncate(str: string, max: number): string {
  if (!str) return ''
  return str.length <= max ? str : str.slice(0, max) + '…'
}

/** The state is the live poll's, never the session record's — a stored session has none, and a
 *  pinned row is only known to be OPEN, which is why it falls back to "working". */
function getStatusInfo(state?: SessionActivity, isPinned?: boolean): { color: string; labelPt: string; labelEn: string } {
  if (state === 'waiting-approval') {
    return { color: '#ef4444', labelPt: 'precisa de aprovação', labelEn: 'needs approval' }
  }
  if (state === 'waiting') {
    return { color: '#f59e0b', labelPt: 'aguardando resposta', labelEn: 'waiting input' }
  }
  if (state === 'working' || isPinned) {
    return { color: '#22c55e', labelPt: 'trabalhando', labelEn: 'working' }
  }
  return { color: 'rgba(156, 163, 175, 0.5)', labelPt: 'encerrada', labelEn: 'closed' }
}

// Sub-components

function Chip({
  icon,
  label,
  color = 'var(--text-tertiary)',
  title,
}: {
  icon: React.ReactNode
  label: string
  color?: string
  title?: string
}) {
  return (
    <div
      title={title}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 3,
        fontSize: 10,
        color,
        fontWeight: 500,
        cursor: title ? 'help' : undefined,
      }}
    >
      {icon}
      {label}
    </div>
  )
}

function HarnessBadge({ harness }: { harness?: string }) {
  if (!harness) return null
  const h = harness.toLowerCase()
  const color = (HARNESS_COLORS as Record<string, string>)[h] ?? '#888'
  const label = (HARNESS_LABELS as Record<string, string>)[h] ?? harness
  return (
    <span
      title={label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px 6px',
        borderRadius: 4,
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: 0.3,
        lineHeight: 1.4,
        background: `${color}18`,
        color,
        border: `1px solid ${color}44`,
        flexShrink: 0,
        textTransform: 'uppercase',
      }}
    >
      {label}
    </span>
  )
}

function SourceDot({ source }: { source?: 'meta' | 'jsonl' | 'subdir' }) {
  if (!source) return null
  const colors: Record<string, string> = {
    meta: 'var(--anthropic-orange, #e8690b)',
    jsonl: 'var(--accent-blue, #3b82f6)',
    subdir: 'var(--accent-purple, #a855f7)',
  }
  const color = colors[source] ?? 'var(--text-tertiary)'
  return (
    <span
      title={source}
      style={{
        display: 'inline-block',
        width: 7,
        height: 7,
        borderRadius: '50%',
        background: color,
        flexShrink: 0,
        marginTop: 1,
      }}
    />
  )
}

function PillButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '4px 10px',
        borderRadius: 999,
        border: active
          ? '1px solid var(--anthropic-orange, #e8690b)'
          : '1px solid var(--border-subtle)',
        background: active ? 'rgba(232,105,11,0.12)' : 'transparent',
        color: active ? 'var(--anthropic-orange, #e8690b)' : 'var(--text-secondary)',
        fontSize: 11,
        fontWeight: active ? 600 : 400,
        cursor: 'pointer',
        transition: 'all 0.15s',
        lineHeight: 1.4,
        fontFamily: 'inherit',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </button>
  )
}

function IconButton({
  onClick,
  disabled,
  title,
  children,
}: {
  onClick: () => void
  disabled?: boolean
  title?: string
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 28,
        height: 28,
        borderRadius: 6,
        border: '1px solid var(--border-subtle)',
        background: 'transparent',
        color: disabled ? 'var(--text-tertiary)' : 'var(--text-secondary)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        transition: 'all 0.15s',
        padding: 0,
      }}
    >
      {children}
    </button>
  )
}

function isNayChatSession(projectPath: string): boolean {
  return projectPath.includes('.agentistics/nay-chat')
}

function encodeProjectDir(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9-]/g, '-')
}

function openSession(s: SessionMeta, e: React.MouseEvent) {
  e.stopPropagation()
  if (isNayChatSession(s.project_path)) {
    window.dispatchEvent(new CustomEvent('agentistics:open-nay-chat', {
      detail: { sessionId: s.session_id },
    }))
  } else {
    const harness = s.harness ?? 'claude'
    const encodedDir = encodeProjectDir(s.project_path)
    window.dispatchEvent(new CustomEvent('agentistics:open-transcript', {
      detail: {
        harness,
        sessionId: s.session_id,
        project: { path: s.project_path, name: s.project_path.split('/').pop() ?? s.project_path, encodedDir },
      },
    }))
  }
}

// Grouping Helper: extracts bucket key for a session
function getSessionBucketKey(
  s: SessionMeta,
  groupBy: SessionGrouping,
  pinnedIds?: Set<string>,
  activities?: Record<string, SessionActivity>,
): { key: string; label: string; icon: React.ReactNode } {
  const isPinned = pinnedIds?.has(s.session_id)
  switch (groupBy) {
    case 'status': {
      // The state comes from the live poll, never from the session record — a stored session
      // carries no state, and grouping every one of them under "working" would be an invention.
      const st = activities?.[s.session_id]
      if (st) {
        const info = STATUS_BUCKETS[st]
        return { key: st, label: info.label, icon: <Radio size={13} style={{ color: info.color }} /> }
      }
      if (isPinned) return { key: 'working', label: 'Em Execução / Ativa', icon: <Radio size={13} style={{ color: '#22c55e' }} /> }
      return { key: 'closed', label: 'Encerradas / Histórico', icon: <Radio size={13} style={{ color: 'var(--text-tertiary)' }} /> }
    }
    case 'repo': {
      // A repo is keyed by its normalized git remote — never by a path segment, which splits the
      // same repository across machines and worktrees.
      const remote = s.git_remote ? repoShortName(s.git_remote) : ''
      const repo = remote || 'Sem repositório'
      return { key: repo, label: repo, icon: <GitCommit size={13} style={{ color: 'var(--accent-purple, #a855f7)' }} /> }
    }
    case 'project': {
      const proj = s.project_path ? formatProjectName(s.project_path) : 'Sem projeto'
      return { key: proj, label: proj, icon: <Folder size={13} style={{ color: 'var(--anthropic-orange)' }} /> }
    }
    case 'harness': {
      const h = s.harness || 'claude'
      const label = (HARNESS_LABELS as Record<string, string>)[h] ?? h
      return { key: h, label, icon: <Bot size={13} style={{ color: (HARNESS_COLORS as Record<string, string>)[h] || 'var(--text-primary)' }} /> }
    }
    case 'model': {
      const model = s.model || 'Sem modelo definido'
      return { key: model, label: model, icon: <Tag size={13} style={{ color: 'var(--accent-blue, #3b82f6)' }} /> }
    }
    case 'marked': {
      if (isPinned) return { key: 'marked', label: 'Marcadas / Live Sessions', icon: <Bookmark size={13} style={{ color: 'var(--anthropic-orange)' }} /> }
      return { key: 'unmarked', label: 'Outras Sessões', icon: <Bookmark size={13} style={{ color: 'var(--text-tertiary)' }} /> }
    }
    default:
      return { key: 'all', label: 'Todas as Sessões', icon: <Layers size={13} /> }
  }
}

const PAGE_SIZE_OPTIONS = [5, 10, 20, 50]

export function RecentSessions({ sessions, lang, onSelect, pinnedIds, activities, viewMode: externalViewMode, onViewModeChange, title, subtitle, topActions }: Props) {
  const t = T[lang]

  // Grouping state (default 'project' to match agentop session ls)
  const [groupBy, setGroupBy] = useState<SessionGrouping>('project')

  // Status shortcut filter
  const [statusShortcut, setStatusShortcut] = useState<StatusShortcut>('all')

  // Sort state
  const [sortKey, setSortKey] = useState<SortKey>('date')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  // Search state
  const [search, setSearch] = useState('')

  // View mode (list vs grid)
  const [internalViewMode, setInternalViewMode] = useState<'list' | 'grid'>('list')
  const viewMode = externalViewMode ?? internalViewMode

  function handleViewModeChange(mode: 'list' | 'grid') {
    if (onViewModeChange) onViewModeChange(mode)
    setInternalViewMode(mode)
  }

  // Pagination state (default 5 per page)
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(5)

  // Per-group pagination state
  const [groupPages, setGroupPages] = useState<Record<string, number>>({})

  // Batch selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  function toggleSelect(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const [openWarningModal, setOpenWarningModal] = useState<string[] | null>(null)
  const [promptModal, setPromptModal] = useState<boolean>(false)
  const [batchPromptText, setBatchPromptText] = useState('')

  // Collapsed groups accordion map
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({})

  // Filter & Sort list
  const filteredAndSorted = useMemo(() => {
    let list = [...sessions]

    // Text search filter
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      list = list.filter(
        s =>
          (s.title ?? '').toLowerCase().includes(q) ||
          (s.first_prompt ?? '').toLowerCase().includes(q) ||
          (s.project_path ?? '').toLowerCase().includes(q) ||
          (s.git_remote ?? '').toLowerCase().includes(q)
      )
    }

    // Status shortcut filter
    if (statusShortcut !== 'all') {
      list = list.filter(s => {
        const isLive = pinnedIds?.has(s.session_id)
        if (statusShortcut === 'active') return isLive
        if (statusShortcut === 'waiting') {
          const st = activities?.[s.session_id]
          return isLive && (st === 'waiting' || st === 'waiting-approval')
        }
        if (statusShortcut === 'closed') return !isLive
        return true
      })
    }

    // Sorting
    list.sort((a, b) => {
      // Float pinned sessions if sortKey is date
      if (pinnedIds && sortKey === 'date') {
        const pa = pinnedIds.has(a.session_id) ? 1 : 0
        const pb = pinnedIds.has(b.session_id) ? 1 : 0
        if (pa !== pb) return pb - pa
      }

      let res = 0
      switch (sortKey) {
        case 'date':
          res = new Date(b.start_time).getTime() - new Date(a.start_time).getTime()
          break
        case 'tokens':
          res = totalTokens(b) - totalTokens(a)
          break
        case 'messages':
          res = totalMessages(b) - totalMessages(a)
          break
        case 'tools':
          res = totalTools(b) - totalTools(a)
          break
        case 'files':
          res = (b.files_modified ?? 0) - (a.files_modified ?? 0)
          break
        case 'name':
          res = (sessionLabel(a) || a.project_path || '').localeCompare(sessionLabel(b) || b.project_path || '')
          break
        case 'status': {
          const pa = pinnedIds?.has(a.session_id) ? 1 : 0
          const pb = pinnedIds?.has(b.session_id) ? 1 : 0
          res = pb - pa
          break
        }
        default:
          res = 0
      }
      return sortDir === 'asc' ? -res : res
    })

    return list
  }, [sessions, search, statusShortcut, sortKey, sortDir, pinnedIds])

  // Grouped list
  const groups = useMemo(() => {
    if (groupBy === 'none') return []

    const map = new Map<string, { key: string; label: string; icon: React.ReactNode; sessions: SessionMeta[] }>()
    for (const s of filteredAndSorted) {
      const bucket = getSessionBucketKey(s, groupBy, pinnedIds, activities)
      const existing = map.get(bucket.key)
      if (existing) {
        existing.sessions.push(s)
      } else {
        map.set(bucket.key, { key: bucket.key, label: bucket.label, icon: bucket.icon, sessions: [s] })
      }
    }
    return Array.from(map.values())
  }, [filteredAndSorted, groupBy, pinnedIds, activities])

  // Reset page on filter changes
  const totalItems = filteredAndSorted.length
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize))
  const safePage = Math.min(page, totalPages - 1)
  const startIdx = safePage * pageSize
  const endIdx = Math.min(startIdx + pageSize, totalItems)
  const pageItems = filteredAndSorted.slice(startIdx, endIdx)

  function changeSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir(d => (d === 'desc' ? 'asc' : 'desc'))
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
    setPage(0)
  }

  function toggleGroupCollapse(key: string) {
    setCollapsedGroups(prev => ({ ...prev, [key]: !prev[key] }))
  }

  const groupOptions: { key: SessionGrouping; label: string }[] = [
    { key: 'none', label: t.group_none },
    { key: 'status', label: t.group_status },
    { key: 'repo', label: t.group_repo },
    { key: 'project', label: t.group_project },
    { key: 'harness', label: t.group_harness },
    { key: 'model', label: t.group_model },
    { key: 'marked', label: t.group_marked },
  ]

  const shortcutOptions: { key: StatusShortcut; label: string }[] = [
    { key: 'all', label: t.shortcut_all },
    { key: 'active', label: t.shortcut_active },
    { key: 'waiting', label: t.shortcut_waiting },
    { key: 'closed', label: t.shortcut_closed },
  ]

  const sortOptions: { key: SortKey; label: string }[] = [
    { key: 'date', label: t.sort_date },
    { key: 'status', label: t.sort_status },
    { key: 'tokens', label: t.sort_tokens },
    { key: 'messages', label: t.sort_messages },
    { key: 'tools', label: t.sort_tools },
    { key: 'files', label: t.sort_files },
    { key: 'name', label: t.sort_name },
  ]

  const inputStyle: React.CSSProperties = {
    padding: '4px 8px',
    borderRadius: 6,
    border: '1px solid var(--border-subtle)',
    background: 'var(--bg-elevated)',
    color: 'var(--text-primary)',
    fontSize: 11,
    outline: 'none',
    minWidth: 0,
    fontFamily: 'inherit',
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%', minWidth: 0, boxSizing: 'border-box' }}>
      {/* Control Bar: Agrupar por + Filtros + Ordenação */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          padding: '14px 18px',
          borderRadius: 12,
          background: 'var(--bg-surface)',
          border: '1px solid var(--border-subtle)',
        }}
      >
        {/* Row 0: Title, Subtitle, and Top Actions (Notifications + View Mode) if provided */}
        {(title || subtitle || topActions) && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', paddingBottom: 10, borderBottom: '1px solid var(--border-subtle)' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 260 }}>
              {title && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>
                  {title}
                </div>
              )}
              {subtitle && (
                <div style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
                  {subtitle}
                </div>
              )}
            </div>
            {topActions && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {topActions}
              </div>
            )}
          </div>
        )}

        {/* Row 1: Agrupar por */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', flexShrink: 0 }}>
            <Layers size={13} style={{ color: 'var(--anthropic-orange)' }} />
            <span>{t.group_by}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
            {groupOptions.map(opt => (
              <PillButton key={opt.key} active={groupBy === opt.key} onClick={() => { setGroupBy(opt.key); setPage(0) }}>
                {opt.label}
              </PillButton>
            ))}
          </div>
        </div>

        {/* Row 2: Status Shortcuts + Sort + Search + View Mode */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          {/* Shortcuts & Sort */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            {/* Status shortcuts */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <Filter size={12} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
              {shortcutOptions.map(opt => (
                <PillButton key={opt.key} active={statusShortcut === opt.key} onClick={() => { setStatusShortcut(opt.key); setPage(0) }}>
                  {opt.label}
                </PillButton>
              ))}
            </div>

            {/* Separator */}
            <div style={{ width: 1, height: 16, background: 'var(--border-subtle)' }} />

            {/* Sort keys */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <ArrowUpDown size={12} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
              {sortOptions.map(opt => (
                <PillButton key={opt.key} active={sortKey === opt.key} onClick={() => changeSort(opt.key)}>
                  {opt.label} {sortKey === opt.key ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </PillButton>
              ))}
            </div>

            {/* Select all — over everything the filters and search left standing, NOT one page.
                With bands and per-group paging there is no single "page" this could mean. */}
            <button
              onClick={() => {
                if (selectedIds.size === filteredAndSorted.length && filteredAndSorted.length > 0) {
                  setSelectedIds(new Set())
                } else {
                  setSelectedIds(new Set(filteredAndSorted.map(s => s.session_id)))
                }
              }}
              style={{
                padding: '4px 10px',
                borderRadius: 6,
                border: '1px solid var(--border-subtle)',
                background: 'var(--bg-elevated)',
                color: 'var(--text-secondary)',
                fontSize: 11,
                cursor: 'pointer',
                marginLeft: 4,
              }}
            >
              {selectedIds.size === filteredAndSorted.length && filteredAndSorted.length > 0
                ? (lang === 'pt' ? 'Desmarcar todas' : 'Deselect all')
                : (lang === 'pt' ? 'Selecionar todas' : 'Select all')}
            </button>
          </div>

          {/* Search Input & View Mode */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <div style={{ position: 'relative', width: 180 }}>
              <Search
                size={12}
                style={{
                  position: 'absolute',
                  left: 8,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  color: 'var(--text-tertiary)',
                  pointerEvents: 'none',
                }}
              />
              <input
                type="text"
                value={search}
                onChange={e => { setSearch(e.target.value); setPage(0) }}
                placeholder={t.search_placeholder}
                style={{ ...inputStyle, paddingLeft: 24, width: '100%', boxSizing: 'border-box' }}
              />
            </div>

            <div style={{ display: 'flex', alignItems: 'center', border: '1px solid var(--border-subtle)', borderRadius: 6, padding: 2, background: 'var(--bg-elevated)' }}>
              <button
                onClick={() => handleViewModeChange('list')}
                title={lang === 'pt' ? 'Exibir em lista' : 'List view'}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 24,
                  height: 22,
                  borderRadius: 4,
                  border: 'none',
                  background: viewMode === 'list' ? 'var(--bg-card)' : 'transparent',
                  color: viewMode === 'list' ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
                  cursor: 'pointer',
                }}
              >
                <List size={13} />
              </button>
              <button
                onClick={() => handleViewModeChange('grid')}
                title={lang === 'pt' ? 'Exibir em grid' : 'Grid view'}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 24,
                  height: 22,
                  borderRadius: 4,
                  border: 'none',
                  background: viewMode === 'grid' ? 'var(--bg-card)' : 'transparent',
                  color: viewMode === 'grid' ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
                  cursor: 'pointer',
                }}
              >
                <LayoutGrid size={13} />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Main Content Area: Grouped or Ungrouped */}
      {filteredAndSorted.length === 0 ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '40px 24px',
            gap: 8,
            color: 'var(--text-tertiary)',
            background: 'var(--bg-card)',
            borderRadius: 10,
            border: '1px solid var(--border-subtle)',
          }}
        >
          <Search size={28} style={{ opacity: 0.35 }} />
          <span style={{ fontSize: 13, fontWeight: 500 }}>{t.no_results}</span>
        </div>
      ) : groupBy !== 'none' ? (
        /* Group Bands View */
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {groups.map(g => {
            const isCollapsed = Boolean(collapsedGroups[g.key])
            const gTotal = g.sessions.length
            const gTotalPages = Math.max(1, Math.ceil(gTotal / pageSize))
            const gPage = groupPages[g.key] ?? 0
            const gSafePage = Math.min(gPage, gTotalPages - 1)
            const gStart = gSafePage * pageSize
            const gEnd = Math.min(gStart + pageSize, gTotal)
            const gItems = g.sessions.slice(gStart, gEnd)

            return (
              <div
                key={g.key}
                style={{
                  background: 'var(--bg-surface)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 10,
                  padding: 12,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                }}
              >
                {/* Group Band Header */}
                <div
                  onClick={() => toggleGroupCollapse(g.key)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    cursor: 'pointer',
                    userSelect: 'none',
                    padding: '2px 4px',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
                    {g.icon}
                    <span>{g.label}</span>
                    <span
                      style={{
                        fontSize: 11,
                        padding: '1px 8px',
                        borderRadius: 999,
                        background: 'rgba(232,105,11,0.12)',
                        color: 'var(--anthropic-orange)',
                        fontWeight: 600,
                      }}
                    >
                      {gTotal} {t.sessions_unit}
                    </span>
                  </div>
                  <div style={{ color: 'var(--text-tertiary)' }}>
                    {isCollapsed ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
                  </div>
                </div>

                {/* Group Items */}
                {!isCollapsed && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: viewMode === 'grid' ? 'repeat(auto-fill, minmax(min(100%, 320px), 1fr))' : '1fr',
                        gap: 8,
                        width: '100%',
                        minWidth: 0,
                        boxSizing: 'border-box',
                      }}
                    >
                      {gItems.map(s => (
                        <SessionCard
                          key={s.session_id}
                          s={s}
                          lang={lang}
                          onSelect={onSelect}
                          isPinned={pinnedIds?.has(s.session_id)}
                          state={activities?.[s.session_id]}
                          selected={selectedIds.has(s.session_id)}
                          onToggleSelect={toggleSelect}
                          viewMode={viewMode}
                        />
                      ))}
                    </div>

                    {/* Group pagination — every grouping keeps the same page size */}
                    {gTotal > pageSize && (
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          flexWrap: 'wrap',
                          gap: 8,
                          paddingTop: 8,
                          borderTop: '1px solid var(--border-subtle)',
                        }}
                      >
                        <span style={{ fontSize: 11, color: 'var(--text-tertiary)', flexShrink: 0 }}>
                          {`${t.showing} ${gStart + 1}–${gEnd} ${t.of} ${gTotal}`}
                        </span>

                        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <IconButton
                            onClick={() => setGroupPages(p => ({ ...p, [g.key]: 0 }))}
                            disabled={gSafePage === 0}
                            title={`${t.page} 1`}
                          >
                            <ChevronsLeft size={12} />
                          </IconButton>
                          <IconButton
                            onClick={() => setGroupPages(p => ({ ...p, [g.key]: Math.max(0, gSafePage - 1) }))}
                            disabled={gSafePage === 0}
                          >
                            <ChevronLeft size={12} />
                          </IconButton>

                          <span style={{ fontSize: 11, color: 'var(--text-secondary)', padding: '0 6px', whiteSpace: 'nowrap' }}>
                            {gSafePage + 1} / {gTotalPages}
                          </span>

                          <IconButton
                            onClick={() => setGroupPages(p => ({ ...p, [g.key]: Math.min(gTotalPages - 1, gSafePage + 1) }))}
                            disabled={gSafePage >= gTotalPages - 1}
                          >
                            <ChevronRight size={12} />
                          </IconButton>
                          <IconButton
                            onClick={() => setGroupPages(p => ({ ...p, [g.key]: gTotalPages - 1 }))}
                            disabled={gSafePage >= gTotalPages - 1}
                            title={`${t.page} ${gTotalPages}`}
                          >
                            <ChevronsRight size={12} />
                          </IconButton>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      ) : (
        /* Flat List/Grid View with Pagination */
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: viewMode === 'grid' ? 'repeat(auto-fill, minmax(min(100%, 320px), 1fr))' : '1fr',
            gap: 8,
            width: '100%',
            minWidth: 0,
            boxSizing: 'border-box',
          }}
        >
          {pageItems.map(s => (
            <SessionCard
              key={s.session_id}
              s={s}
              lang={lang}
              onSelect={onSelect}
              isPinned={pinnedIds?.has(s.session_id)}
              state={activities?.[s.session_id]}
              selected={selectedIds.has(s.session_id)}
              onToggleSelect={toggleSelect}
              viewMode={viewMode}
            />
          ))}
        </div>
      )}

      {/* Pagination Footer (when not grouped or flat view) */}
      {groupBy === 'none' && totalItems > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 8,
            marginTop: 2,
            paddingTop: 10,
            borderTop: '1px solid var(--border-subtle)',
          }}
        >
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)', flexShrink: 0 }}>
            {`${t.showing} ${startIdx + 1}–${endIdx} ${t.of} ${totalItems}`}
          </span>

          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <IconButton onClick={() => setPage(0)} disabled={safePage === 0} title={`${t.page} 1`}>
              <ChevronsLeft size={13} />
            </IconButton>
            <IconButton onClick={() => setPage(p => Math.max(0, p - 1))} disabled={safePage === 0}>
              <ChevronLeft size={13} />
            </IconButton>

            <span style={{ fontSize: 11, color: 'var(--text-secondary)', padding: '0 6px', whiteSpace: 'nowrap' }}>
              {safePage + 1} / {totalPages}
            </span>

            <IconButton onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={safePage >= totalPages - 1}>
              <ChevronRight size={13} />
            </IconButton>
            <IconButton onClick={() => setPage(totalPages - 1)} disabled={safePage >= totalPages - 1} title={`${t.page} ${totalPages}`}>
              <ChevronsRight size={13} />
            </IconButton>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{t.per_page}</span>
            <div style={{ display: 'flex', gap: 4 }}>
              {PAGE_SIZE_OPTIONS.map(size => (
                <PillButton key={size} active={pageSize === size} onClick={() => { setPageSize(size); setPage(0) }}>
                  {size}
                </PillButton>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Sticky Floating Mass Action Bar */}
      {selectedIds.size > 0 && (
        <div
          style={{
            position: 'sticky',
            bottom: 16,
            zIndex: 100,
            background: 'var(--bg-elevated)',
            border: '1px solid var(--anthropic-orange, #e8690b)',
            boxShadow: '0 4px 20px rgba(0,0,0,0.25)',
            borderRadius: 12,
            padding: '12px 18px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
            {lang === 'pt' ? `${selectedIds.size} sessão(ões) selecionada(s)` : `${selectedIds.size} session(s) selected`}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {/* Mandar Prompt */}
            <button
              onClick={() => setPromptModal(true)}
              style={{
                padding: '6px 12px',
                borderRadius: 6,
                background: 'var(--anthropic-orange)',
                color: '#fff',
                border: 'none',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {lang === 'pt' ? '💬 Enviar Prompt' : '💬 Send Prompt'}
            </button>

            {/* Desligar */}
            <button
              onClick={() => {
                for (const id of selectedIds) {
                  fetch(`/api/session/kill`, { method: 'POST', body: JSON.stringify({ id }) }).catch(() => {})
                }
                setSelectedIds(new Set())
              }}
              style={{
                padding: '6px 12px',
                borderRadius: 6,
                background: 'rgba(239, 68, 68, 0.15)',
                color: '#ef4444',
                border: '1px solid rgba(239, 68, 68, 0.3)',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {lang === 'pt' ? '🛑 Desligar' : '🛑 Kill'}
            </button>

            {/* Reabrir */}
            <button
              onClick={() => {
                const selectedSessions = sessions.filter(s => selectedIds.has(s.session_id))
                const open = selectedSessions.filter(s => pinnedIds?.has(s.session_id))
                if (open.length > 0) {
                  setOpenWarningModal(open.map(s => sessionLabel(s) || s.session_id))
                } else {
                  for (const s of selectedSessions) {
                    fetch(`/api/session/start`, { method: 'POST', body: JSON.stringify({ resumeId: s.session_id, harness: s.harness, cwd: s.project_path }) }).catch(() => {})
                  }
                  setSelectedIds(new Set())
                }
              }}
              style={{
                padding: '6px 12px',
                borderRadius: 6,
                background: 'rgba(34, 197, 94, 0.15)',
                color: '#22c55e',
                border: '1px solid rgba(34, 197, 94, 0.3)',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {lang === 'pt' ? '🔄 Reabrir' : '🔄 Reopen'}
            </button>

            {/* Clear selection */}
            <button
              onClick={() => setSelectedIds(new Set())}
              style={{
                padding: '6px 12px',
                borderRadius: 6,
                background: 'transparent',
                color: 'var(--text-tertiary)',
                border: '1px solid var(--border-subtle)',
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              {lang === 'pt' ? 'Limpar seleção' : 'Clear selection'}
            </button>
          </div>
        </div>
      )}

      {/* Warning Modal */}
      {openWarningModal && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.6)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20
        }}>
          <div style={{
            background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12,
            padding: 24, maxWidth: 480, width: '100%', display: 'flex', flexDirection: 'column', gap: 16
          }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#ef4444' }}>
              {lang === 'pt' ? 'Aviso: Não é possível reabrir' : 'Warning: Cannot reopen'}
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              {lang === 'pt'
                ? 'As seguintes sessões já estão abertas e não podem ser religadas:'
                : 'The following sessions are already open and cannot be restarted:'}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, background: 'var(--bg-elevated)', padding: 12, borderRadius: 8 }}>
              {openWarningModal.map(name => (
                <div key={name} style={{ fontSize: 13, fontWeight: 600, color: 'var(--anthropic-orange)' }}>
                  • {name}
                </div>
              ))}
            </div>
            <button
              onClick={() => setOpenWarningModal(null)}
              style={{
                alignSelf: 'flex-end', padding: '8px 18px', borderRadius: 8,
                background: 'var(--anthropic-orange)', color: '#fff', border: 'none',
                fontWeight: 600, fontSize: 13, cursor: 'pointer'
              }}
            >
              {lang === 'pt' ? 'Entendido' : 'OK'}
            </button>
          </div>
        </div>
      )}

      {/* Prompt Modal */}
      {promptModal && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.6)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20
        }}>
          <div style={{
            background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12,
            padding: 24, maxWidth: 500, width: '100%', display: 'flex', flexDirection: 'column', gap: 16
          }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>
              {lang === 'pt' ? `Enviar prompt para ${selectedIds.size} sessões` : `Send prompt to ${selectedIds.size} sessions`}
            </div>
            <textarea
              value={batchPromptText}
              onChange={e => setBatchPromptText(e.target.value)}
              placeholder={lang === 'pt' ? 'Digite a instrução para as sessões selecionadas...' : 'Type prompt for selected sessions...'}
              rows={4}
              style={{
                width: '100%', boxSizing: 'border-box', padding: 10, borderRadius: 8,
                border: '1px solid var(--border)', background: 'var(--bg-elevated)',
                color: 'var(--text-primary)', fontFamily: 'inherit', fontSize: 13, outline: 'none'
              }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button
                onClick={() => { setPromptModal(false); setBatchPromptText('') }}
                style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 13 }}
              >
                {lang === 'pt' ? 'Cancelar' : 'Cancel'}
              </button>
              <button
                onClick={() => {
                  for (const id of selectedIds) {
                    fetch(`/api/session/prompt`, { method: 'POST', body: JSON.stringify({ id, prompt: batchPromptText }) }).catch(() => {})
                  }
                  setPromptModal(false)
                  setBatchPromptText('')
                  setSelectedIds(new Set())
                }}
                style={{ padding: '8px 16px', borderRadius: 8, background: 'var(--anthropic-orange)', color: '#fff', border: 'none', fontWeight: 600, cursor: 'pointer', fontSize: 13 }}
              >
                {lang === 'pt' ? 'Enviar' : 'Send'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// Modal for copying session resume command via Agentop or Native Harness CLI
function ResumeCommandModal({
  s,
  lang,
  onClose,
}: {
  s: SessionMeta
  lang: 'pt' | 'en'
  onClose: () => void
}) {
  const [copiedAgentop, setCopiedAgentop] = useState(false)
  const [copiedNative, setCopiedNative] = useState(false)

  useEffect(() => {
    const originalStyle = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = originalStyle
    }
  }, [])

  const nativeCmd = resumeCommand(s) || (s.project_path ? `cd '${s.project_path}' && ${s.harness || 'claude'} --resume ${s.session_id}` : `${s.harness || 'claude'} --resume ${s.session_id}`)
  const agentopCmd = s.project_path
    ? `cd '${s.project_path}' && agentop session attach ${s.session_id}`
    : `agentop session attach ${s.session_id}`

  const titleName = s.title || (s.project_path ? formatProjectName(s.project_path) : '') || s.session_id.slice(0, 8)

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: 'rgba(0, 0, 0, 0.7)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 540,
          background: 'var(--bg-surface)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 12,
          padding: 24,
          boxShadow: '0 20px 50px rgba(0,0,0,0.6)',
          display: 'flex',
          flexDirection: 'column',
          gap: 18,
          color: 'var(--text-primary)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: 8,
                background: 'rgba(232, 105, 11, 0.12)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--anthropic-orange)',
              }}
            >
              <Terminal size={18} />
            </div>
            <div>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>
                {lang === 'pt' ? 'Retomar Sessão' : 'Resume AI Session'}
              </h3>
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2 }}>
                {titleName}
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-tertiary)',
              cursor: 'pointer',
              padding: 4,
              borderRadius: 6,
            }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Option 1: Agentop CLI */}
        <div
          style={{
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 8,
            padding: 14,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--anthropic-orange)' }}>
              {lang === 'pt' ? 'Opção 1: Via Agentop CLI (agentop session attach)' : 'Option 1: Via Agentop CLI (agentop session attach)'}
            </span>
            <button
              onClick={() => {
                navigator.clipboard.writeText(agentopCmd)
                setCopiedAgentop(true)
                setTimeout(() => setCopiedAgentop(false), 2000)
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: '4px 10px',
                borderRadius: 6,
                border: copiedAgentop ? '1px solid rgba(34, 197, 94, 0.4)' : '1px solid var(--border-subtle)',
                background: copiedAgentop ? 'rgba(34, 197, 94, 0.12)' : 'var(--bg-surface)',
                color: copiedAgentop ? '#22c55e' : 'var(--text-primary)',
                fontSize: 11,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {copiedAgentop ? <Check size={12} color="#22c55e" /> : <Copy size={12} />}
              <span>{copiedAgentop ? (lang === 'pt' ? 'Copiado!' : 'Copied!') : (lang === 'pt' ? 'Copiar comando Agentop' : 'Copy Agentop command')}</span>
            </button>
          </div>
          <code
            style={{
              fontSize: 12,
              fontFamily: 'var(--font-mono, monospace)',
              background: 'var(--bg-base)',
              padding: '8px 12px',
              borderRadius: 6,
              color: 'var(--text-primary)',
              wordBreak: 'break-all',
            }}
          >
            {agentopCmd}
          </code>
        </div>

        {/* Option 2: Native Harness CLI */}
        <div
          style={{
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 8,
            padding: 14,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--accent-blue, #3b82f6)' }}>
              {lang === 'pt' ? `Opção 2: Via ${HARNESS_LABELS[s.harness ?? 'claude']} Nativo` : `Option 2: Via Native ${HARNESS_LABELS[s.harness ?? 'claude']}`}
            </span>
            <button
              onClick={() => {
                navigator.clipboard.writeText(nativeCmd)
                setCopiedNative(true)
                setTimeout(() => setCopiedNative(false), 2000)
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: '4px 10px',
                borderRadius: 6,
                border: copiedNative ? '1px solid rgba(34, 197, 94, 0.4)' : '1px solid var(--border-subtle)',
                background: copiedNative ? 'rgba(34, 197, 94, 0.12)' : 'var(--bg-surface)',
                color: copiedNative ? '#22c55e' : 'var(--text-primary)',
                fontSize: 11,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {copiedNative ? <Check size={12} color="#22c55e" /> : <Copy size={12} />}
              <span>{copiedNative ? (lang === 'pt' ? 'Copiado!' : 'Copied!') : (lang === 'pt' ? 'Copiar comando Nativo' : 'Copy Native command')}</span>
            </button>
          </div>
          <code
            style={{
              fontSize: 12,
              fontFamily: 'var(--font-mono, monospace)',
              background: 'var(--bg-base)',
              padding: '8px 12px',
              borderRadius: 6,
              color: 'var(--text-primary)',
              wordBreak: 'break-all',
            }}
          >
            {nativeCmd}
          </code>
        </div>
      </div>

    </div>
  )
}

function SessionCard({
  s,
  lang,
  onSelect,
  isPinned,
  state,
  selected,
  onToggleSelect,
  viewMode = 'list',
}: {
  s: SessionMeta
  lang: 'pt' | 'en'
  onSelect?: (s: SessionMeta) => void
  isPinned?: boolean
  /** What this session is doing right now; absent when it is not live. */
  state?: SessionActivity
  /** Whether this row is in the batch selection. */
  selected?: boolean
  onToggleSelect?: (id: string) => void
  viewMode?: 'list' | 'grid'
}) {
  const t = T[lang]
  const tokens = totalTokens(s)
  const tools = totalTools(s)
  const msgs = totalMessages(s)
  const clickable = Boolean(onSelect)
  const status = getStatusInfo(state, isPinned)

  const cmd = resumeCommand(s)
  const [showResumeModal, setShowResumeModal] = useState(false)
  const [promptText, setPromptText] = useState('')
  const [sendingPrompt, setSendingPrompt] = useState(false)
  const [promptFeedback, setPromptFeedback] = useState<{ ok: boolean; msg: string } | null>(null)

  async function handleSendPrompt(e?: React.FormEvent) {
    if (e) {
      e.preventDefault()
      e.stopPropagation()
    }
    const text = promptText.trim()
    if (!text || sendingPrompt) return

    setSendingPrompt(true)
    setPromptFeedback(null)
    try {
      const res = await fetch('/api/sessions/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: s.session_id, prompt: text }),
      })
      const json = await res.json() as { ok?: boolean; message?: string; error?: string }
      if (res.ok && json.ok) {
        setPromptFeedback({
          ok: true,
          msg: lang === 'pt' ? 'Prompt enviado para a sessão!' : 'Prompt sent to terminal!',
        })
        setPromptText('')
      } else {
        setPromptFeedback({
          ok: false,
          msg: json.error || (lang === 'pt' ? 'Erro ao enviar.' : 'Failed to send.'),
        })
      }
    } catch (err: any) {
      setPromptFeedback({
        ok: false,
        msg: err?.message || (lang === 'pt' ? 'Erro de rede.' : 'Network error.'),
      })
    } finally {
      setSendingPrompt(false)
      setTimeout(() => setPromptFeedback(null), 4000)
    }
  }

  const [showDetails, setShowDetails] = useState(false)
  const [messages, setMessages] = useState<{ role: 'user' | 'assistant'; content: string; timestamp?: number | string; tools?: string[] }[] | null>(null)
  const [loadingMsgs, setLoadingMsgs] = useState(false)
  const detailsContainerRef = useRef<HTMLDivElement>(null)

  // Click outside listener for Detalhes popover
  useEffect(() => {
    if (!showDetails) return
    function handleClickOutside(e: MouseEvent) {
      if (detailsContainerRef.current && !detailsContainerRef.current.contains(e.target as Node)) {
        setShowDetails(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showDetails])

  // Body scroll lock when Detalhes popover is open
  useEffect(() => {
    if (!showDetails) return
    const originalOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = originalOverflow
    }
  }, [showDetails])

  const isLiveSession = Boolean(isPinned || cmd)
  const isWaitingForInput = isLiveSession && (state === 'waiting' || state === 'waiting-approval')
  const titleName = s.title || (s.project_path ? formatProjectName(s.project_path) : '') || s.session_id.slice(0, 8)

  useEffect(() => {
    if (!showDetails) return

    let interval: ReturnType<typeof setInterval> | null = null
    const fetchMsgs = () => {
      fetch(`/api/sessions/${encodeURIComponent(s.session_id)}/messages?harness=${encodeURIComponent(s.harness || 'claude')}&projectPath=${encodeURIComponent(s.project_path || '')}`)
        .then(r => r.ok ? r.json() : [])
        .then((msgs: any[]) => {
          if (Array.isArray(msgs)) setMessages(msgs)
          else setMessages([])
        })
        .catch(() => setMessages([]))
        .finally(() => setLoadingMsgs(false))
    }

    if (messages === null && !loadingMsgs) {
      setLoadingMsgs(true)
    }
    fetchMsgs()

    const es = new EventSource('/api/events')
    es.addEventListener('change', fetchMsgs)
    if (isLiveSession) {
      interval = setInterval(fetchMsgs, 2000)
    }

    return () => {
      es.close()
      if (interval) clearInterval(interval)
    }
  }, [showDetails, s.session_id, s.harness, s.project_path, isLiveSession])
  const isList = viewMode === 'list'

  return (
    <>
      {showResumeModal && (
        <ResumeCommandModal s={s} lang={lang} onClose={() => setShowResumeModal(false)} />
      )}

      <div
        style={{
          position: 'relative',
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 10,
          padding: isList ? '14px 18px' : '16px 18px',
          boxSizing: 'border-box',
          minWidth: 0,
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          transition: 'all 0.15s ease',
        }}
      >
        {/* List Mode Layout */}
        {isList ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%' }}>
            {/* Single Header Row: Badges, Title, Date/Time & Action Buttons ALL in one row */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              {/* Left Group: Badges & Title */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 200 }}>
                {onToggleSelect && (
                  <input
                    type="checkbox"
                    checked={Boolean(selected)}
                    onChange={e => { e.stopPropagation(); onToggleSelect(s.session_id) }}
                    onClick={e => e.stopPropagation()}
                    aria-label={lang === 'pt' ? 'Selecionar sessão' : 'Select session'}
                    style={{ cursor: 'pointer', width: 16, height: 16, flexShrink: 0, accentColor: 'var(--anthropic-orange)' }}
                  />
                )}
                {/* Status Badge */}
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 5,
                    padding: '3px 8px',
                    borderRadius: 999,
                    fontSize: 11,
                    fontWeight: 600,
                    color: status.color,
                    background: `${status.color}14`,
                    border: `1px solid ${status.color}33`,
                    flexShrink: 0,
                  }}
                >
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: status.color }} />
                  {lang === 'pt' ? status.labelPt : status.labelEn}
                </span>

                <HarnessBadge harness={s.harness} />

                {/* Project Title */}
                <span
                  style={{
                    fontSize: 15,
                    fontWeight: 600,
                    color: 'var(--text-primary)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={titleName}
                >
                  {titleName}
                </span>
              </div>

              {/* Right Group: Date/Time + Action Buttons */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                <span style={{ fontSize: 12, color: 'var(--text-tertiary)', fontVariantNumeric: 'tabular-nums', marginRight: 4 }}>
                  {s.start_time ? format(parseISO(s.start_time), 'MMM d, HH:mm') : ''}
                </span>

                {/* Retomar Sessão Button */}
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    setShowResumeModal(true)
                  }}
                  title={lang === 'pt' ? 'Retomar sessão (Agentop / Nativo)' : 'Resume session (Agentop / Native)'}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 5,
                    padding: '5px 10px',
                    borderRadius: 6,
                    border: '1px solid var(--border-subtle)',
                    background: 'var(--bg-surface)',
                    color: 'var(--anthropic-orange)',
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: 'pointer',
                    transition: 'all 0.15s',
                    fontFamily: 'inherit',
                  }}
                >
                  <Terminal size={12} />
                  <span>{lang === 'pt' ? 'Retomar Sessão' : 'Resume'}</span>
                </button>

                {/* Detalhes Trigger & Popover Wrapper */}
                <div ref={detailsContainerRef} style={{ position: 'relative' }}>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      setShowDetails(v => !v)
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                      padding: '5px 10px',
                      borderRadius: 6,
                      border: showDetails ? '1px solid var(--anthropic-orange)' : '1px solid var(--border-subtle)',
                      background: showDetails ? 'rgba(232, 105, 11, 0.1)' : 'var(--bg-surface)',
                      color: showDetails ? 'var(--anthropic-orange)' : 'var(--text-secondary)',
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: 'pointer',
                      transition: 'all 0.15s',
                      fontFamily: 'inherit',
                    }}
                  >
                    <span>{lang === 'pt' ? 'Detalhes' : 'Details'}</span>
                    {showDetails ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                  </button>

                  {/* Floating Detalhes Popover */}
                  {showDetails && (
                    <div
                      onClick={(e) => e.stopPropagation()}
                      style={{
                        position: 'absolute',
                        top: 'calc(100% + 6px)',
                        right: 0,
                        width: 380,
                        maxWidth: '90vw',
                        zIndex: 100,
                        background: 'var(--bg-surface)',
                        border: '1px solid var(--anthropic-orange)',
                        borderRadius: 10,
                        padding: '14px 16px',
                        boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.5)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 12,
                      }}
                    >
                      {s.first_prompt && (
                        <div>
                          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase', marginBottom: 4 }}>
                            {lang === 'pt' ? 'Prompt Inicial' : 'First Prompt'}
                          </div>
                          <div style={{ fontSize: 12, color: 'var(--text-secondary)', fontStyle: 'italic', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 120, overflowY: 'auto' }}>
                            "{s.first_prompt}"
                          </div>
                        </div>
                      )}

                      <div>
                        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase', marginBottom: 4 }}>
                          {lang === 'pt' ? 'Últimas mensagens' : 'Latest messages'}
                        </div>
                        {loadingMsgs ? (
                          <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{lang === 'pt' ? 'Carregando...' : 'Loading...'}</div>
                        ) : !messages || messages.length === 0 ? (
                          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', fontStyle: 'italic' }}>{lang === 'pt' ? 'Nenhuma mensagem recente' : 'No recent messages'}</div>
                        ) : (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 180, overflowY: 'auto' }}>
                            {messages.slice(-3).map((m, mi) => (
                              <div key={mi} style={{ fontSize: 11, padding: '6px 8px', borderRadius: 6, background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', gap: 2 }}>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                  <span style={{ fontWeight: 700, color: m.role === 'user' ? 'var(--accent-blue)' : 'var(--anthropic-orange)' }}>
                                    {m.role === 'user' ? 'User: ' : 'Assistant: '}
                                  </span>
                                  {m.timestamp && (
                                    <span style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>
                                      {format(parseISO(typeof m.timestamp === 'string' ? m.timestamp : new Date(m.timestamp).toISOString()), 'HH:mm:ss')}
                                    </span>
                                  )}
                                </div>
                                <span style={{ color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.content.slice(0, 200)}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {/* Métricas Modal Button */}
                {clickable && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      onSelect!(s)
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 5,
                      padding: '5px 10px',
                      borderRadius: 6,
                      border: '1px solid var(--border-subtle)',
                      background: 'var(--bg-surface)',
                      color: 'var(--text-primary)',
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: 'pointer',
                      transition: 'all 0.15s',
                      fontFamily: 'inherit',
                    }}
                  >
                    <Maximize2 size={11} />
                    <span>{lang === 'pt' ? 'Métricas da sessão' : 'Session metrics'}</span>
                  </button>
                )}
              </div>
            </div>

            {/* Bottom Row: Stats Chips */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <Chip icon={<Clock size={11} />} label={sessionTime(s, lang).combined} title={sessionTime(s, lang).tooltip} />
              <Chip icon={null} label={`${msgs} msgs`} color="var(--accent-blue, #3b82f6)" />
              {tokens > 0 && <Chip icon={null} label={`${fmt(tokens)} tkn`} color="var(--anthropic-orange, #e8690b)" />}
              {tools > 0 && <Chip icon={<Wrench size={11} />} label={`${tools} tools`} color="var(--accent-green, #22c55e)" />}
              {s.git_commits > 0 && <Chip icon={<GitCommit size={11} />} label={`${s.git_commits} commits`} color="var(--accent-purple, #a855f7)" />}
              {s.files_modified > 0 && <Chip icon={<FileCode size={11} />} label={`${s.files_modified} files`} />}
            </div>
          </div>
        ) : (
          /* Grid Mode Layout */
          <>
            {/* Header Row: Badges & Time */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: '3px 8px',
                    borderRadius: 999,
                    fontSize: 11,
                    fontWeight: 600,
                    color: status.color,
                    background: `${status.color}14`,
                    border: `1px solid ${status.color}33`,
                  }}
                >
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: status.color }} />
                  {lang === 'pt' ? status.labelPt : status.labelEn}
                </span>
                <HarnessBadge harness={s.harness} />
              </div>

              <span style={{ fontSize: 11, color: 'var(--text-tertiary)', fontVariantNumeric: 'tabular-nums' }}>
                {s.start_time ? format(parseISO(s.start_time), 'MMM d, HH:mm') : ''}
              </span>
            </div>

            {/* Title */}
            <div
              style={{
                fontSize: 15,
                fontWeight: 600,
                color: 'var(--text-primary)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={titleName}
            >
              {titleName}
            </div>

            {/* Minimal Essential Chips */}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <Chip icon={<Clock size={11} />} label={sessionTime(s, lang).combined} title={sessionTime(s, lang).tooltip} />
              <Chip icon={null} label={`${msgs} msgs`} color="var(--accent-blue, #3b82f6)" />
              {tokens > 0 && <Chip icon={null} label={`${fmt(tokens)} tkn`} color="var(--anthropic-orange, #e8690b)" />}
            </div>

            {/* Actions Row */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingTop: 4, flexWrap: 'wrap' }}>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setShowResumeModal(true)
                }}
                title={lang === 'pt' ? 'Retomar sessão' : 'Resume session'}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '4px 8px',
                  borderRadius: 6,
                  border: '1px solid var(--border-subtle)',
                  background: 'var(--bg-surface)',
                  color: 'var(--anthropic-orange)',
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                <Terminal size={11} />
                <span>{lang === 'pt' ? 'Retomar Sessão' : 'Resume'}</span>
              </button>

              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div ref={detailsContainerRef} style={{ position: 'relative' }}>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      setShowDetails(v => !v)
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 3,
                      padding: '4px 8px',
                      borderRadius: 6,
                      border: showDetails ? '1px solid var(--anthropic-orange)' : '1px solid var(--border-subtle)',
                      background: showDetails ? 'rgba(232, 105, 11, 0.1)' : 'var(--bg-surface)',
                      color: showDetails ? 'var(--anthropic-orange)' : 'var(--text-secondary)',
                      fontSize: 11,
                      fontWeight: 600,
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    <span>{lang === 'pt' ? 'Detalhes' : 'Details'}</span>
                    {showDetails ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
                  </button>

                  {/* Floating Detalhes Popover Grid Mode */}
                  {showDetails && (
                    <div
                      onClick={(e) => e.stopPropagation()}
                      style={{
                        position: 'absolute',
                        top: 'calc(100% + 6px)',
                        right: 0,
                        width: 300,
                        maxWidth: '85vw',
                        zIndex: 100,
                        background: 'var(--bg-surface)',
                        border: '1px solid var(--anthropic-orange)',
                        borderRadius: 10,
                        padding: '12px 14px',
                        boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.5)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 10,
                      }}
                    >
                      {s.first_prompt && (
                        <div>
                          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase', marginBottom: 4 }}>
                            {lang === 'pt' ? 'Prompt Inicial' : 'First Prompt'}
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--text-secondary)', fontStyle: 'italic', lineHeight: 1.4, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 100, overflowY: 'auto' }}>
                            "{s.first_prompt}"
                          </div>
                        </div>
                      )}

                      <div>
                        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase', marginBottom: 4 }}>
                          {lang === 'pt' ? 'Últimas mensagens' : 'Latest messages'}
                        </div>
                        {loadingMsgs ? (
                          <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{lang === 'pt' ? 'Carregando...' : 'Loading...'}</div>
                        ) : !messages || messages.length === 0 ? (
                          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', fontStyle: 'italic' }}>{lang === 'pt' ? 'Nenhuma mensagem recente' : 'No recent messages'}</div>
                        ) : (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 160, overflowY: 'auto' }}>
                            {messages.slice(-3).map((m, mi) => (
                              <div key={mi} style={{ fontSize: 11, padding: '5px 7px', borderRadius: 6, background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', gap: 2 }}>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                  <span style={{ fontWeight: 700, color: m.role === 'user' ? 'var(--accent-blue)' : 'var(--anthropic-orange)' }}>
                                    {m.role === 'user' ? 'User: ' : 'Assistant: '}
                                  </span>
                                  {m.timestamp && (
                                    <span style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>
                                      {format(parseISO(typeof m.timestamp === 'string' ? m.timestamp : new Date(m.timestamp).toISOString()), 'HH:mm:ss')}
                                    </span>
                                  )}
                                </div>
                                <span style={{ color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.content.slice(0, 180)}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {clickable && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      onSelect!(s)
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 3,
                      padding: '4px 8px',
                      borderRadius: 6,
                      border: '1px solid var(--border-subtle)',
                      background: 'var(--bg-surface)',
                      color: 'var(--text-primary)',
                      fontSize: 11,
                      fontWeight: 600,
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    <Maximize2 size={10} />
                    <span>{lang === 'pt' ? 'Métricas' : 'Metrics'}</span>
                  </button>
                )}
              </div>
            </div>
          </>
        )}

        {/* Live Session Interactive Short Prompt Resizable Textarea Form (only when waiting for user response) */}
        {isWaitingForInput && (
          <div style={{ paddingTop: 2 }}>
            <form
              onSubmit={handleSendPrompt}
              onClick={(e) => e.stopPropagation()}
              style={{
                display: 'flex',
                alignItems: 'flex-end',
                gap: 8,
                background: 'var(--bg-card)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 6,
                padding: '6px 8px',
              }}
            >
              <textarea
                rows={1}
                value={promptText}
                onChange={e => setPromptText(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    handleSendPrompt()
                  }
                }}
                placeholder={lang === 'pt' ? 'Enviar short prompt...' : 'Send short prompt...'}
                style={{
                  flex: 1,
                  background: 'transparent',
                  border: 'none',
                  outline: 'none',
                  fontSize: 12,
                  color: 'var(--text-primary)',
                  fontFamily: 'inherit',
                  resize: 'vertical',
                  minHeight: 36,
                  maxHeight: 140,
                  padding: '2px 4px',
                  boxSizing: 'border-box',
                }}
              />
              <button
                type="submit"
                disabled={sendingPrompt || !promptText.trim()}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '6px 12px',
                  borderRadius: 5,
                  border: 'none',
                  background: 'var(--anthropic-orange)',
                  color: '#fff',
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: sendingPrompt || !promptText.trim() ? 'not-allowed' : 'pointer',
                  opacity: sendingPrompt || !promptText.trim() ? 0.5 : 1,
                  fontFamily: 'inherit',
                  flexShrink: 0,
                  alignSelf: 'flex-end',
                }}
              >
                <Send size={11} />
                <span>{lang === 'pt' ? 'Enviar' : 'Send'}</span>
              </button>
            </form>
            {promptFeedback && (
              <div style={{ fontSize: 11, color: promptFeedback.ok ? '#22c55e' : '#ef4444', fontStyle: 'italic', marginTop: 4 }}>
                {promptFeedback.msg}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  )
}

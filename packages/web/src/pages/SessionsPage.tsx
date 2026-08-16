import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useOutletContext, useNavigate } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { Clock, Radio, Copy, Check, Bell, BellOff, Settings, Sparkles, Folder, User, Terminal, FileText, ChevronDown, ChevronUp, Send, Info, ExternalLink, LayoutGrid, List, ChevronLeft, ChevronRight, MessageSquare, Loader } from 'lucide-react'
import type { HarnessId, LiveProcess, LiveUnavailableReason, SessionMeta } from '@agentistics/core'
import { sessionLabel, sessionTokenTotal } from '@agentistics/core'
import { HARNESS_COLORS, HARNESS_LABELS } from '../lib/harness'
import type { AppContext } from '../lib/app-context'
import { Section } from '../components/Section'
import { RecentSessions } from '../components/RecentSessions'
import { lastActivityMs, liveEmptyNotice } from '../lib/sessionLive'
import { resumeCommand } from '../lib/resumeCommand'
import {
  getNotificationSettings,
  saveNotificationSettings,
  requestNotificationPermission,
  getBrowserNotificationPermission,
  handleSessionStateTransitions,
  triggerSessionNotification,
  type SessionActivity,
  type NotificationSettings,
} from '../lib/sessionNotifications'

const LIVE_POLL_MS = 4000

export default function SessionsPage() {
  const ctx = useOutletContext<AppContext>()
  const { data, derived, lang, setSelectedSession, isCentral } = ctx
  const pt = lang === 'pt'
  const navigate = useNavigate()

  // Real-time open-session detection.
  const [liveIdList, setLiveIdList] = useState<string[]>(data.liveSessionIds ?? [])
  const [liveProcs, setLiveProcs] = useState<LiveProcess[]>(data.liveProcesses ?? [])
  const [liveUnavailable, setLiveUnavailable] =
    useState<LiveUnavailableReason | undefined>(data.liveUnavailable)
  const [liveActivities, setLiveActivities] = useState<Record<string, SessionActivity>>({})

  // Notification settings state & prompt banner
  const [notifSettings, setNotifSettings] = useState<NotificationSettings>(getNotificationSettings)
  const prevActivitiesRef = useRef<Record<string, SessionActivity>>({})

  // Sessions map lookup helper
  const sessionsMap = useMemo(() => {
    const map = new Map<string, SessionMeta>()
    for (const s of data.sessions) {
      map.set(s.session_id, s)
    }
    return map
  }, [data.sessions])

  // Poll live sessions
  useEffect(() => {
    let alive = true
    const poll = async () => {
      try {
        const res = await fetch('/api/live-sessions')
        if (!res.ok) return
        const json = await res.json() as {
          liveSessionIds?: string[]
          liveProcesses?: LiveProcess[]
          liveUnavailable?: LiveUnavailableReason
          liveSessionActivities?: Record<string, SessionActivity>
        }
        if (!alive) return
        if (Array.isArray(json.liveSessionIds)) setLiveIdList(json.liveSessionIds)
        setLiveProcs(Array.isArray(json.liveProcesses) ? json.liveProcesses : [])
        setLiveUnavailable(json.liveUnavailable)

        const activities = json.liveSessionActivities || {}
        setLiveActivities(activities)

        // Check state transitions for notifications
        handleSessionStateTransitions(prevActivitiesRef.current, activities, sessionsMap, pt ? 'pt' : 'en')
        prevActivitiesRef.current = activities
      } catch { /* transient — keep last known */ }
    }
    poll()
    const id = setInterval(poll, LIVE_POLL_MS)
    return () => { alive = false; clearInterval(id) }
  }, [isCentral, sessionsMap, pt])

  const liveIds = useMemo(() => new Set(liveIdList), [liveIdList])
  const live = useMemo(
    () => data.sessions.filter(s => liveIds.has(s.session_id))
      .sort((a, b) => lastActivityMs(b) - lastActivityMs(a)),
    [data.sessions, liveIds],
  )
  const liveCount = live.length + liveProcs.length
  const notice = liveEmptyNotice({ count: liveCount, central: isCentral, unavailable: liveUnavailable, lang: pt ? 'pt' : 'en' })

  // Pagination (5 by 5) and view mode state for live sessions
  const [livePage, setLivePage] = useState(1)
  const [liveViewMode, setLiveViewMode] = useState<'list' | 'grid'>('list')
  const LIVE_PAGE_SIZE = 5
  const totalLivePages = Math.max(1, Math.ceil(live.length / LIVE_PAGE_SIZE))
  const currentLivePage = Math.min(livePage, totalLivePages)
  const pagedLive = useMemo(() => {
    const start = (currentLivePage - 1) * LIVE_PAGE_SIZE
    return live.slice(start, start + LIVE_PAGE_SIZE)
  }, [live, currentLivePage])

  // Handle enabling notifications from prompt banner
  async function handleEnableNotifications() {
    const perm = await requestNotificationPermission()
    const next = { ...notifSettings, enabled: true, askedPrompt: true }
    setNotifSettings(next)
    saveNotificationSettings(next)

    if (perm === 'granted') {
      triggerSessionNotification({
        title: pt ? 'Notificações Ativadas' : 'Notifications Enabled',
        body: pt
          ? 'Você receberá alertas em tempo real sobre o andamento das suas live sessions.'
          : 'You will receive real-time alerts on your live sessions progress.',
      })
    }
  }

  function handleDismissPrompt() {
    const next = { ...notifSettings, askedPrompt: true }
    setNotifSettings(next)
    saveNotificationSettings(next)
  }

  const showPromptBanner = !notifSettings.askedPrompt && getBrowserNotificationPermission() !== 'granted'

  return (
    <>
      <PageHead
        pt={pt}
        central={isCentral}
        liveViewMode={liveViewMode}
        setLiveViewMode={setLiveViewMode}
        notifSettings={notifSettings}
        onOpenNotifs={() => navigate('/settings/notifications')}
      />

      {/* Notification Permission Prompt Banner */}
      {showPromptBanner && (
        <div
          style={{
            background: 'var(--bg-elevated)',
            border: '1px solid var(--anthropic-orange-dim, rgba(232,105,11,0.3))',
            borderRadius: 12,
            padding: '16px 20px',
            marginBottom: 16,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1, minWidth: 280 }}>
            <div
              style={{
                width: 38,
                height: 38,
                borderRadius: 10,
                background: 'rgba(232,105,11,0.12)',
                color: 'var(--anthropic-orange)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <Bell size={20} />
            </div>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 2 }}>
                {pt
                  ? 'Deseja receber notificações sobre os andamentos de suas live sessions?'
                  : 'Would you like to receive notifications for your live sessions?'}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                {pt
                  ? 'Receba alertas visuais e sonoros detalhados quando uma sessão precisar de aprovação, aguardar resposta ou encerrar.'
                  : 'Receive detailed visual and sound alerts when a session needs approval, waits for response, or exits.'}
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <button
              onClick={handleEnableNotifications}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '8px 16px',
                borderRadius: 8,
                background: 'var(--anthropic-orange)',
                color: '#fff',
                border: 'none',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              <Sparkles size={14} />
              <span>{pt ? 'Sim, ativar notificações' : 'Yes, enable notifications'}</span>
            </button>
            <button
              onClick={() => navigate('/settings/notifications')}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: '8px 12px',
                borderRadius: 8,
                border: '1px solid var(--border-subtle)',
                background: 'transparent',
                color: 'var(--text-secondary)',
                fontSize: 12,
                fontWeight: 500,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              <Settings size={13} />
              <span>{pt ? 'Configurar' : 'Configure'}</span>
            </button>
            <button
              onClick={handleDismissPrompt}
              style={{
                padding: '8px 12px',
                borderRadius: 8,
                border: '1px solid var(--border-subtle)',
                background: 'transparent',
                color: 'var(--text-tertiary)',
                fontSize: 12,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {pt ? 'Agora não' : 'Not now'}
            </button>
          </div>
        </div>
      )}

      {/* Primary Unified Sessions View */}
      <RecentSessions
        sessions={derived.filteredSessions}
        lang={lang}
        onSelect={setSelectedSession}
        pinnedIds={liveIds}
        activities={liveActivities}
        viewMode={liveViewMode}
        onViewModeChange={setLiveViewMode}
      />
    </>
  )
}

function PageHead({
  pt,
  central,
  liveViewMode,
  setLiveViewMode,
  notifSettings,
  onOpenNotifs,
}: {
  pt: boolean
  central?: boolean
  liveViewMode: 'list' | 'grid'
  setLiveViewMode: (mode: 'list' | 'grid') => void
  notifSettings: NotificationSettings
  onOpenNotifs: () => void
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: 12,
        marginBottom: 12,
        padding: '14px 18px',
        borderRadius: 12,
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-subtle)',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 260 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>
          <span style={{ color: 'var(--anthropic-orange)' }}><Clock size={18} /></span>
          {pt ? 'Sessões' : 'Sessions'}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
          {central
            ? (pt
                ? 'Últimas sessões do time (metadados, sem chat) — reativo aos filtros, inclusive por membro.'
                : "The team's latest sessions (metadata, no chat) — reactive to the filters, including by member.")
            : (pt
                ? 'Sessões abertas agora (em tempo real) e as últimas sessões, com comando para retomar.'
                : 'Sessions open right now (real time) and your latest sessions, with a resume command.')}
        </div>
      </div>

      {/* Right Side Controls: View Mode TabMenu & Notifications Button */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
        {/* TabMenu: List vs Grid Toggle */}
        <div style={{ display: 'flex', alignItems: 'center', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: 3, background: 'var(--bg-elevated)' }}>
          <button
            onClick={() => setLiveViewMode('list')}
            title={pt ? 'Exibir em lista' : 'List view'}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              padding: '4px 10px',
              borderRadius: 6,
              border: 'none',
              background: liveViewMode === 'list' ? 'var(--bg-card)' : 'transparent',
              color: liveViewMode === 'list' ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
              fontSize: 11,
              fontWeight: liveViewMode === 'list' ? 600 : 400,
              cursor: 'pointer',
              fontFamily: 'inherit',
              transition: 'all 0.15s',
            }}
          >
            <List size={13} />
            <span>{pt ? 'Lista' : 'List'}</span>
          </button>
          <button
            onClick={() => setLiveViewMode('grid')}
            title={pt ? 'Exibir em grade' : 'Grid view'}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              padding: '4px 10px',
              borderRadius: 6,
              border: 'none',
              background: liveViewMode === 'grid' ? 'var(--bg-card)' : 'transparent',
              color: liveViewMode === 'grid' ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
              fontSize: 11,
              fontWeight: liveViewMode === 'grid' ? 600 : 400,
              cursor: 'pointer',
              fontFamily: 'inherit',
              transition: 'all 0.15s',
            }}
          >
            <LayoutGrid size={13} />
            <span>{pt ? 'Grade' : 'Grid'}</span>
          </button>
        </div>

        {/* Notifications Settings Button */}
        <button
          onClick={onOpenNotifs}
          title={pt ? 'Configurar Notificações' : 'Configure Notifications'}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 11,
            fontWeight: 500,
            padding: '6px 12px',
            borderRadius: 8,
            border: '1px solid var(--border-subtle)',
            background: 'var(--bg-elevated)',
            color: 'var(--text-secondary)',
            cursor: 'pointer',
            fontFamily: 'inherit',
            transition: 'all 0.15s',
          }}
        >
          {notifSettings.enabled ? <Bell size={13} style={{ color: 'var(--anthropic-orange)' }} /> : <BellOff size={13} />}
          <span>{pt ? 'Notificações' : 'Notifications'}</span>
        </button>
      </div>
    </div>
  )
}

function StatusBadge({ activity, pt }: { activity?: SessionActivity; pt: boolean }) {
  const act = activity || 'working'
  const config = {
    'working': {
      labelPt: 'trabalhando',
      labelEn: 'working',
      color: '#22c55e',
      bg: 'rgba(34, 197, 94, 0.12)',
      border: 'rgba(34, 197, 94, 0.3)',
    },
    'waiting': {
      labelPt: 'aguardando resposta',
      labelEn: 'waiting input',
      color: '#f59e0b',
      bg: 'rgba(245, 158, 11, 0.12)',
      border: 'rgba(245, 158, 11, 0.3)',
    },
    'waiting-approval': {
      labelPt: 'precisa de aprovação',
      labelEn: 'needs approval',
      color: '#ef4444',
      bg: 'rgba(239, 68, 68, 0.12)',
      border: 'rgba(239, 68, 68, 0.3)',
    },
    'exited': {
      labelPt: 'encerrada',
      labelEn: 'exited',
      color: '#9ca3af',
      bg: 'rgba(156, 163, 175, 0.12)',
      border: 'rgba(156, 163, 175, 0.3)',
    },
  }[act] || {
    labelPt: 'trabalhando',
    labelEn: 'working',
    color: '#22c55e',
    bg: 'rgba(34, 197, 94, 0.12)',
    border: 'rgba(34, 197, 94, 0.3)',
  }

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '2px 8px',
        borderRadius: 999,
        fontSize: 10,
        fontWeight: 600,
        color: config.color,
        background: config.bg,
        border: `1px solid ${config.border}`,
        whiteSpace: 'nowrap',
        flexShrink: 0,
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: config.color,
          boxShadow: `0 0 6px ${config.color}`,
        }}
      />
      {pt ? config.labelPt : config.labelEn}
    </span>
  )
}

function LiveCard({
  s,
  pt,
  onOpen,
  central,
  activity,
  viewMode = 'list',
}: {
  s: SessionMeta
  pt: boolean
  onOpen: () => void
  central?: boolean
  activity?: SessionActivity
  viewMode?: 'list' | 'grid'
}) {
  const cmd = central ? null : resumeCommand(s)
  const [copied, setCopied] = useState(false)
  const [showDetails, setShowDetails] = useState(false)
  const [promptText, setPromptText] = useState('')
  const [sendingPrompt, setSendingPrompt] = useState(false)
  const [promptFeedback, setPromptFeedback] = useState<{ ok: boolean; msg: string } | null>(null)

  const [messages, setMessages] = useState<{ role: 'user' | 'assistant'; content: string; timestamp?: number; tools?: string[] }[] | null>(null)
  const [loadingMsgs, setLoadingMsgs] = useState(false)

  const detailsRef = useRef<HTMLDivElement>(null)

  // Click outside to dismiss floating details popover
  useEffect(() => {
    if (!showDetails) return
    function handleClickOutside(e: MouseEvent) {
      if (detailsRef.current && !detailsRef.current.contains(e.target as Node)) {
        setShowDetails(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showDetails])

  useEffect(() => {
    if (showDetails && messages === null && !loadingMsgs) {
      setLoadingMsgs(true)
      fetch(`/api/sessions/${encodeURIComponent(s.session_id)}/messages?harness=${encodeURIComponent(s.harness || 'claude')}&projectPath=${encodeURIComponent(s.project_path || '')}`)
        .then(r => r.ok ? r.json() : [])
        .then((msgs: any[]) => {
          if (Array.isArray(msgs)) setMessages(msgs)
          else setMessages([])
        })
        .catch(() => setMessages([]))
        .finally(() => setLoadingMsgs(false))
    }
  }, [showDetails, s.session_id, s.harness, s.project_path, messages, loadingMsgs])

  const mins = Math.max(0, Math.round((Date.now() - lastActivityMs(s)) / 60_000))
  const title = sessionLabel(s) || (s.project_path ? (s.project_path.split('/').filter(Boolean).pop() || '') : '') || s.session_id.slice(0, 8)

  async function handleSendPrompt(e?: React.FormEvent) {
    if (e) e.preventDefault()
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
          msg: pt ? 'Prompt enviado com sucesso para a sessão no terminal!' : 'Prompt sent successfully to session in terminal!',
        })
        setPromptText('')
      } else {
        setPromptFeedback({
          ok: false,
          msg: json.error || (pt ? 'Erro ao enviar prompt para a sessão.' : 'Failed to send prompt.'),
        })
      }
    } catch (err: any) {
      setPromptFeedback({
        ok: false,
        msg: err?.message || (pt ? 'Erro de rede ao enviar prompt.' : 'Network error.'),
      })
    } finally {
      setSendingPrompt(false)
      setTimeout(() => setPromptFeedback(null), 4000)
    }
  }

  // All four billed counters — the conversational pair alone is a fraction of a percent.
  const totalTokens = sessionTokenTotal(s)

  return (
    <div
      style={{
        position: 'relative',
        border: '1px solid var(--border)',
        borderRadius: 12,
        padding: '16px 18px',
        background: 'var(--bg-card)',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        boxShadow: '0 1px 3px rgba(0,0,0,0.03)',
        boxSizing: 'border-box',
        width: '100%',
        minWidth: 0,
        maxWidth: '100%',
      }}
    >
      {/* Header Row: Title on Left, Stacked Badges + Elapsed Time on Right */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        {/* Title & Project Path */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, flex: 1 }}>
          <div
            onClick={onOpen}
            style={{
              cursor: 'pointer',
              fontSize: 15,
              fontWeight: 600,
              color: 'var(--text-primary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={title}
          >
            {title}
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12,
              color: 'var(--text-tertiary)',
              minWidth: 0,
            }}
          >
            <Folder size={12} style={{ flexShrink: 0, color: 'var(--text-tertiary)' }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.project_path}>
              {s.project_path}
            </span>
            {central && s.user && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, marginLeft: 6, color: 'var(--text-secondary)' }}>
                <User size={12} />
                <span>{s.user}</span>
              </span>
            )}
          </div>
        </div>

        {/* Stacked Badges Cluster on Right */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <HarnessBadge harness={s.harness} />
            <StatusBadge activity={activity} pt={pt} />
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', display: 'flex', alignItems: 'center', gap: 4 }}>
            <Clock size={11} />
            <span>{pt ? `há ${mins} min` : `${mins} min ago`}</span>
          </div>
        </div>
      </div>

      {/* Command Box */}
      {cmd ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            padding: '8px 12px',
            borderRadius: 8,
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-subtle)',
            width: '100%',
            minWidth: 0,
            maxWidth: '100%',
            boxSizing: 'border-box',
            overflow: 'hidden',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1, overflow: 'hidden' }}>
            <Terminal size={13} style={{ color: 'var(--anthropic-orange)', flexShrink: 0 }} />
            <code
              style={{
                fontSize: 11,
                fontFamily: 'var(--font-mono, monospace)',
                color: 'var(--text-primary)',
                overflowX: 'auto',
                whiteSpace: 'nowrap',
                scrollbarWidth: 'none',
                maxWidth: '100%',
                display: 'block',
              }}
            >
              {cmd}
            </code>
          </div>

          <button
            onClick={() => {
              navigator.clipboard.writeText(cmd)
              setCopied(true)
              setTimeout(() => setCopied(false), 1800)
            }}
            title={pt ? 'Copiar comando para o terminal' : 'Copy command to terminal'}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '5px 10px',
              borderRadius: 6,
              border: copied ? '1px solid rgba(34, 197, 94, 0.4)' : '1px solid var(--border)',
              background: copied ? 'rgba(34, 197, 94, 0.1)' : 'var(--bg-card)',
              color: copied ? '#22c55e' : 'var(--text-secondary)',
              fontSize: 11,
              fontWeight: 500,
              cursor: 'pointer',
              flexShrink: 0,
              transition: 'all 0.15s ease',
              fontFamily: 'inherit',
            }}
          >
            {copied ? (
              <>
                <Check size={12} color="#22c55e" />
                <span>{pt ? 'Copiado!' : 'Copied!'}</span>
              </>
            ) : (
              <>
                <Copy size={12} />
                <span>{pt ? 'Copiar' : 'Copy'}</span>
              </>
            )}
          </button>
        </div>
      ) : central ? null : (
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', fontStyle: 'italic' }}>
          {pt ? 'Retomar não disponível para este harness.' : 'Resume not available for this harness.'}
        </div>
      )}

      {/* Machine Mode Explicit Controls: Detalhes Button & Short Prompt Form */}
      {!central && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            paddingTop: 8,
            borderTop: '1px solid var(--border-subtle)',
          }}
        >
          {/* Action Toolbar */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            {/* Detalhes Toggle Button */}
            <button
              onClick={() => setShowDetails(v => !v)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 12px',
                borderRadius: 6,
                border: showDetails ? '1px solid var(--anthropic-orange-dim, rgba(232,105,11,0.4))' : '1px solid var(--border)',
                background: showDetails ? 'rgba(232,105,11,0.08)' : 'var(--bg-card)',
                color: showDetails ? 'var(--anthropic-orange)' : 'var(--text-primary)',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: 'inherit',
                transition: 'all 0.15s ease',
              }}
            >
              <FileText size={13} />
              <span>{pt ? 'Detalhes' : 'Details'}</span>
              {showDetails ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            </button>

            {/* Quick link to open full drilldown modal */}
            <button
              onClick={onOpen}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                fontSize: 11,
                color: 'var(--text-tertiary)',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              <ExternalLink size={12} />
              <span>{pt ? 'Abrir no Modal' : 'Open in Modal'}</span>
            </button>
          </div>

          {/* Short Prompt Input Bar */}
          <form
            onSubmit={handleSendPrompt}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 8,
              padding: '4px 6px 4px 10px',
            }}
          >
            <input
              type="text"
              value={promptText}
              onChange={e => setPromptText(e.target.value)}
              placeholder={pt ? 'Enviar short prompt para a sessão...' : 'Send short prompt to session...'}
              style={{
                flex: 1,
                background: 'transparent',
                border: 'none',
                outline: 'none',
                fontSize: 12,
                color: 'var(--text-primary)',
                fontFamily: 'inherit',
              }}
            />
            <button
              type="submit"
              disabled={sendingPrompt || !promptText.trim()}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                padding: '5px 12px',
                borderRadius: 6,
                background: 'var(--anthropic-orange)',
                color: '#fff',
                border: 'none',
                fontSize: 11,
                fontWeight: 600,
                cursor: sendingPrompt || !promptText.trim() ? 'not-allowed' : 'pointer',
                opacity: sendingPrompt || !promptText.trim() ? 0.6 : 1,
                fontFamily: 'inherit',
                flexShrink: 0,
              }}
            >
              <Send size={11} />
              <span>{sendingPrompt ? (pt ? 'Enviando...' : 'Sending...') : (pt ? 'Enviar Prompt' : 'Send')}</span>
            </button>
          </form>

          {/* Prompt Feedback Toast */}
          {promptFeedback && (
            <div
              style={{
                fontSize: 11,
                padding: '4px 8px',
                borderRadius: 6,
                background: promptFeedback.ok ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
                color: promptFeedback.ok ? '#22c55e' : '#ef4444',
                border: promptFeedback.ok ? '1px solid rgba(34,197,94,0.2)' : '1px solid rgba(239,68,68,0.2)',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              {promptFeedback.ok ? <Check size={12} /> : <Info size={12} />}
              <span>{promptFeedback.msg}</span>
            </div>
          )}

          {/* Expandable Details Panel — Floating Popover in Grid View / Inline in List View */}
          {showDetails && (
            <div
              ref={detailsRef}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
                padding: '12px 14px',
                borderRadius: 10,
                background: 'var(--bg-elevated)',
                border: '1px solid var(--anthropic-orange-dim, rgba(232,105,11,0.4))',
                width: '100%',
                minWidth: 0,
                boxSizing: 'border-box',
                overflow: 'hidden',
                ...(viewMode === 'grid'
                  ? {
                      position: 'absolute',
                      top: '100%',
                      left: 0,
                      right: 0,
                      zIndex: 300,
                      marginTop: 6,
                      boxShadow: '0 12px 36px rgba(0,0,0,0.5)',
                      animation: 'ttyChatFadeIn 0.15s ease-out',
                    }
                  : {
                      marginTop: 6,
                    }),
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid var(--border-subtle)', paddingBottom: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
                  <MessageSquare size={13} style={{ color: 'var(--anthropic-orange)' }} />
                  <span>{pt ? 'Últimas mensagens da conversa' : 'Recent conversation messages'}</span>
                </div>
                {messages && messages.length > 0 && (
                  <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                    {pt ? `exibindo ${Math.min(4, messages.length)} de ${messages.length}` : `showing ${Math.min(4, messages.length)} of ${messages.length}`}
                  </span>
                )}
              </div>

              {loadingMsgs ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 0', fontSize: 12, color: 'var(--text-tertiary)' }}>
                  <Loader size={14} style={{ animation: 'spin 1s linear infinite' }} />
                  <span>{pt ? 'Carregando histórico do transcript...' : 'Loading transcript history...'}</span>
                </div>
              ) : messages && messages.length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 280, overflowY: 'auto', paddingRight: 4 }}>
                  {messages.slice(-4).map((m, idx) => {
                    const isUser = m.role === 'user'
                    const colour = HARNESS_COLORS[s.harness] ?? 'var(--anthropic-orange)'
                    const roleLabel = isUser ? (pt ? 'Você' : 'You') : (HARNESS_LABELS[s.harness] ?? s.harness)
                    return (
                      <div key={idx} style={{ display: 'flex', flexDirection: 'column', alignItems: isUser ? 'flex-end' : 'flex-start', gap: 2, width: '100%', minWidth: 0 }}>
                        <div style={{ fontSize: 10, fontWeight: 600, color: isUser ? 'var(--text-tertiary)' : colour }}>
                          {roleLabel}
                        </div>
                        <div
                          style={{
                            maxWidth: '96%',
                            minWidth: 0,
                            padding: '8px 10px',
                            borderRadius: isUser ? '10px 10px 2px 10px' : '10px 10px 10px 2px',
                            background: isUser ? 'rgba(59, 130, 246, 0.12)' : 'var(--bg-card)',
                            border: isUser ? '1px solid rgba(59, 130, 246, 0.25)' : `1px solid ${colour}44`,
                            fontSize: 12,
                            color: 'var(--text-primary)',
                            lineHeight: 1.5,
                            wordBreak: 'break-word',
                            overflowWrap: 'anywhere',
                            overflow: 'hidden',
                          }}
                        >
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm, remarkBreaks]}
                            components={{
                              p: ({ children }) => <span style={{ display: 'block', margin: '0 0 4px 0' }}>{children}</span>,
                              ul: ({ children }) => <ul style={{ margin: '2px 0 4px 0', paddingLeft: 18 }}>{children}</ul>,
                              ol: ({ children }) => <ol style={{ margin: '2px 0 4px 0', paddingLeft: 18 }}>{children}</ol>,
                              li: ({ children }) => <li style={{ margin: '1px 0' }}>{children}</li>,
                              code: ({ children, className }) => {
                                const isBlock = !!className
                                return isBlock
                                  ? <pre style={{ background: 'var(--bg-surface)', padding: '6px 8px', borderRadius: 4, overflowX: 'auto', margin: '4px 0', fontSize: 11, maxWidth: '100%' }}><code style={{ whiteSpace: 'pre', display: 'block' }}>{children}</code></pre>
                                  : <code style={{ background: 'var(--bg-surface)', padding: '1px 4px', borderRadius: 3, fontSize: 11 }}>{children}</code>
                              },
                              pre: ({ children }) => <>{children}</>,
                            }}
                          >
                            {m.content.length > 500 ? m.content.slice(0, 500) + '...' : m.content}
                          </ReactMarkdown>
                        </div>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <div style={{ fontSize: 12, color: 'var(--text-tertiary)', fontStyle: 'italic', padding: '6px 0' }}>
                  {pt ? 'Nenhuma mensagem recente encontrada nesta sessão.' : 'No recent messages found in this session.'}
                </div>
              )}

              <button
                onClick={onOpen}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                  padding: '6px 12px',
                  borderRadius: 6,
                  border: '1px solid var(--border-subtle)',
                  background: 'var(--bg-card)',
                  color: 'var(--anthropic-orange)',
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  marginTop: 4,
                  width: '100%',
                }}
              >
                <ExternalLink size={12} />
                <span>{pt ? 'Abrir Transcrição Completa e Métricas no Modal →' : 'Open Full Transcript & Metrics in Modal →'}</span>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function HarnessBadge({ harness }: { harness: HarnessId }) {
  const colour = HARNESS_COLORS[harness] ?? 'var(--text-tertiary)'
  return (
    <span style={{
      flexShrink: 0, fontSize: 10, fontWeight: 600, letterSpacing: 0.3, padding: '2px 6px',
      borderRadius: 999, color: colour, border: `1px solid ${colour}`, background: 'transparent',
      textTransform: 'uppercase', whiteSpace: 'nowrap',
    }}>{HARNESS_LABELS[harness] ?? harness}</span>
  )
}

function StartingCard({ p, pt }: { p: LiveProcess; pt: boolean }) {
  const label = HARNESS_LABELS[p.harness] ?? p.harness
  const colour = HARNESS_COLORS[p.harness] ?? 'var(--text-tertiary)'
  return (
    <div style={{ border: '1px dashed var(--border)', borderRadius: 10, padding: 12, background: 'var(--bg-card)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: colour, flexShrink: 0, opacity: 0.7 }} />
        <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{label}</span>
        {p.user && <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>· {p.user}</span>}
        <span style={{ fontSize: 11, color: 'var(--text-tertiary)', marginLeft: 'auto' }}>
          {pt ? 'sem conversa ainda' : 'no conversation yet'}
        </span>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.cwd}</div>
      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 6, fontStyle: 'italic' }}>
        {pt
          ? 'Rodando agora. Aparece com métricas assim que o primeiro turno for gravado.'
          : 'Running now. It appears with metrics once its first turn is written.'}
      </div>
    </div>
  )
}

import { AgentisticsLoader } from './AgentisticsLoader'
import React, { useState, useEffect, useRef, useLayoutEffect, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { ChevronLeft, ChevronDown, ChevronUp } from 'lucide-react'
import type { HarnessId } from '@agentistics/core'
import { HARNESS_LABELS, HARNESS_COLORS } from '../lib/harness'
import { splitInlinedHistory } from '../lib/transcriptSplit'
import { useIsMobile } from '../hooks/useIsMobile'

interface HarnessChatProps {
  harness: HarnessId
  lang: 'pt' | 'en'
  initialProject?: { path: string; name: string; encodedDir: string } | null
  initialSessionId?: string | null
  onStateChange?: (s: {
    projectPath: string | null
    projectName: string | null
    projectEncodedDir: string | null
    sessionId: string | null
  }) => void
}

type ProjectItem = {
  name: string
  path: string
  encodedDir: string
  sessionCount?: number
}

type SessionItem = {
  id: string
  title: string
  project?: string
  startTime?: string
  createdAt?: string
  updatedAt?: string
  messageCount?: number
  model?: string
}

export type TranscriptMessage = {
  role: 'user' | 'assistant'
  content: string
  timestamp?: number
  tools?: string[]
}

/** How many messages a Claude conversation opens with (its END); older pages load on demand. */
export const HISTORY_PAGE = 150
interface ClaudePage { messages: TranscriptMessage[]; start: number; total: number }
const EMPTY_PAGE: ClaudePage = { messages: [], start: 0, total: 0 }
function claudePageUrl(id: string, encodedDir: string, before?: number): string {
  return `/api/claude-sessions/${encodeURIComponent(id)}?encodedDir=${encodeURIComponent(encodedDir)}&limit=${HISTORY_PAGE}${before !== undefined ? `&before=${before}` : ''}`
}

function ToolsBlock({ tools, pt }: { tools: string[]; pt: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ marginTop: 6 }}>
      <button
        onClick={() => setOpen(v => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: 4, padding: '2px 8px',
          borderRadius: 4, border: '1px solid var(--border)',
          background: 'var(--bg-card)', color: 'var(--text-tertiary)',
          cursor: 'pointer', fontFamily: 'inherit', fontSize: 11, fontWeight: 500,
        }}
      >
        {open ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
        {tools.length} {pt ? 'ferramentas' : 'tools'}
      </button>
      {open && (
        <div style={{ marginTop: 4, padding: '6px 8px', borderRadius: 6, background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
          {tools.map((t, i) => (
            <div key={i} style={{ fontSize: 11, color: 'var(--text-tertiary)', padding: '1px 0' }}>{t}</div>
          ))}
        </div>
      )}
    </div>
  )
}

export function MessageBubble({ msg, harness, pt }: { msg: TranscriptMessage; harness: HarnessId; pt: boolean }) {
  const isUser = msg.role === 'user'
  const color = HARNESS_COLORS[harness]
  return (
    <div style={{
      marginBottom: 12,
      display: 'flex', flexDirection: 'column',
      alignItems: isUser ? 'flex-end' : 'flex-start',
    }}>
      <div style={{
        fontSize: 10, fontWeight: 600, marginBottom: 3,
        color: isUser ? 'var(--text-tertiary)' : color,
      }}>
        {isUser ? (pt ? 'Você' : 'You') : HARNESS_LABELS[harness]}
      </div>
      <div style={{
        maxWidth: '92%',
        minWidth: 0,
        padding: '8px 12px',
        borderRadius: isUser ? '12px 12px 4px 12px' : '12px 12px 12px 4px',
        background: isUser ? 'color-mix(in srgb, var(--accent-blue, #3b82f6) 15%, var(--bg-card))' : 'var(--bg-card)',
        border: isUser ? '1px solid color-mix(in srgb, var(--accent-blue, #3b82f6) 30%, transparent)' : `1px solid color-mix(in srgb, ${color} 25%, var(--border))`,
        fontSize: 13,
        color: 'var(--text-primary)',
        // NOTE: do NOT set white-space: pre-wrap here. react-markdown emits structural "\n"
        // text nodes between block elements (list items, paragraphs); pre-wrap would render each
        // as a visible line break, producing huge gaps between list items. remarkBreaks preserves
        // intentional single newlines as <br> instead, so prose line breaks still survive.
        wordBreak: 'break-word',
        overflowWrap: 'anywhere',
        lineHeight: 1.55,
        overflow: 'hidden',
      }}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkBreaks]}
          components={{
            p: ({ children }) => <span style={{ display: 'block', margin: '0 0 6px 0' }}>{children}</span>,
            ul: ({ children }) => <ul style={{ margin: '2px 0 6px 0', paddingLeft: 20 }}>{children}</ul>,
            ol: ({ children }) => <ol style={{ margin: '2px 0 6px 0', paddingLeft: 20 }}>{children}</ol>,
            li: ({ children }) => <li style={{ margin: '1px 0' }}>{children}</li>,
            code: ({ children, className }) => {
              const isBlock = !!className
              return isBlock
                ? <pre style={{ background: 'var(--bg-surface)', padding: '8px 10px', borderRadius: 6, overflowX: 'auto', margin: '6px 0', fontSize: 12, maxWidth: '100%' }}><code style={{ whiteSpace: 'pre', display: 'block' }}>{children}</code></pre>
                : <code style={{ background: 'var(--bg-surface)', padding: '1px 4px', borderRadius: 3, fontSize: 12, wordBreak: 'break-all' }}>{children}</code>
            },
            pre: ({ children }) => <>{children}</>,
          }}
        >
          {msg.content}
        </ReactMarkdown>
      </div>
      {msg.tools && msg.tools.length > 0 && (
        <div style={{ maxWidth: '92%', marginTop: 2 }}>
          <ToolsBlock tools={msg.tools} pt={pt} />
        </div>
      )}
      {msg.timestamp && (
        <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 3 }}>
          {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </div>
      )}
    </div>
  )
}

export function HarnessChat({ harness, lang, initialProject, initialSessionId, onStateChange }: HarnessChatProps) {
  const pt = lang === 'pt'
  const color = HARNESS_COLORS[harness]
  const isMobile = useIsMobile()

  type View = 'projects' | 'sessions' | 'transcript'
  const [view, setView] = useState<View>('projects')
  const [loading, setLoading] = useState(false)

  // Project picker state
  const [projects, setProjects] = useState<ProjectItem[]>([])
  const [search, setSearch] = useState('')
  const [selectedProject, setSelectedProject] = useState<ProjectItem | null>(null)

  // Session list state — for non-claude harnesses, holds ALL sessions (grouped later)
  const [allSessions, setAllSessions] = useState<SessionItem[]>([])
  const [sessions, setSessions] = useState<SessionItem[]>([])
  const [selectedSession, setSelectedSession] = useState<SessionItem | null>(null)

  // Transcript state
  const [transcript, setTranscript] = useState<TranscriptMessage[]>([])
  const transcriptRef = useRef<HTMLDivElement>(null)
  // PERF.1 step 3: a Claude conversation opens at its END (`HISTORY_PAGE` messages); older pages load
  // on demand. `olderStart` is the index of the first loaded message — above 0, there is more.
  const [olderStart, setOlderStart] = useState(0)
  const [loadingOlder, setLoadingOlder] = useState(false)
  /** scrollHeight before older messages were prepended, so the view stays where the reader was. */
  const prependFrom = useRef<number | null>(null)

  // Initial deep-link handling
  useEffect(() => {
    if (initialSessionId) {
      if (harness === 'claude' && initialProject) {
        // Have both project and session — fetch transcript directly
        const proj: ProjectItem = { name: initialProject.name, path: initialProject.path, encodedDir: initialProject.encodedDir }
        setSelectedProject(proj)
        setLoading(true)
        fetch(claudePageUrl(initialSessionId, initialProject.encodedDir))
          .then(r => r.ok ? r.json() : EMPTY_PAGE)
          .then((page: ClaudePage) => {
            setTranscript(page.messages)
            setOlderStart(page.start)
            setSelectedSession({ id: initialSessionId, title: initialSessionId, messageCount: page.total })
            setView('transcript')
          })
          .catch(() => { setView('transcript') })
          .finally(() => setLoading(false))
      } else if (harness !== 'claude') {
        // For non-claude deep-links: fetch transcript + full session list in parallel so
        // back-nav ("← Sessions") lands on the correct project's session list.
        setLoading(true)
        Promise.all([
          fetch(`/api/${harness}-sessions/${encodeURIComponent(initialSessionId)}`).then(r => r.ok ? r.json() : []),
          fetch(`/api/${harness}-sessions`).then(r => r.ok ? r.json() : []),
        ])
          .then(([msgs, allSess]: [TranscriptMessage[], SessionItem[]]) => {
            setTranscript(msgs)
            setAllSessions(allSess)
            // Resolve the project for this session so back-nav can filter
            const match = allSess.find(s => s.id === initialSessionId)
            const projectKey = match?.project ?? null
            if (projectKey) {
              const proj: ProjectItem = { name: projectKey, path: projectKey, encodedDir: projectKey }
              setSelectedProject(proj)
              setSessions(allSess.filter(s => (s.project ?? '(unknown)') === projectKey))
            }
            setSelectedSession({ id: initialSessionId, title: match?.title ?? initialSessionId, messageCount: msgs.length })
            setView('transcript')
          })
          .catch(() => { setView('transcript') })
          .finally(() => setLoading(false))
      }
    } else if (initialProject) {
      const proj: ProjectItem = { name: initialProject.name, path: initialProject.path, encodedDir: initialProject.encodedDir }
      setSelectedProject(proj)
      setView('sessions')
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Scroll transcript to bottom — except after older messages were PREPENDED, where the reader's
  // place is kept instead.
  useLayoutEffect(() => {
    const el = transcriptRef.current
    if (view !== 'transcript' || !el) return
    if (prependFrom.current !== null) { el.scrollTop += el.scrollHeight - prependFrom.current; prependFrom.current = null; return }
    el.scrollTop = el.scrollHeight
  }, [transcript, view])

  const loadOlder = useCallback(async () => {
    if (loadingOlder || olderStart <= 0 || !selectedSession || !selectedProject) return
    setLoadingOlder(true)
    try {
      const r = await fetch(claudePageUrl(selectedSession.id, selectedProject.encodedDir, olderStart))
      if (!r.ok) return
      const page = await r.json() as ClaudePage
      prependFrom.current = transcriptRef.current?.scrollHeight ?? null
      setTranscript(t => [...page.messages, ...t])
      setOlderStart(page.start)
    } catch { /* the loaded part stays; the button is still there */ } finally { setLoadingOlder(false) }
  }, [loadingOlder, olderStart, selectedSession, selectedProject])

  // Load projects
  useEffect(() => {
    if (view !== 'projects') return
    if (loading) return
    setLoading(true)
    if (harness === 'claude') {
      fetch('/api/projects-list')
        .then(r => r.ok ? r.json() : [])
        .then((data: Array<{ name: string; path: string; encodedDir: string; sessionCount?: number }>) => {
          setProjects(data.map(p => ({ name: p.name, path: p.path, encodedDir: p.encodedDir, sessionCount: p.sessionCount })))
        })
        .catch(() => {})
        .finally(() => setLoading(false))
    } else {
      fetch(`/api/${harness}-sessions`)
        .then(r => r.ok ? r.json() : [])
        .then((data: SessionItem[]) => {
          setAllSessions(data)
          // Group by project field
          const seen = new Map<string, ProjectItem>()
          for (const s of data) {
            const key = s.project ?? '(unknown)'
            if (!seen.has(key)) seen.set(key, { name: key, path: key, encodedDir: key, sessionCount: 0 })
            seen.get(key)!.sessionCount = (seen.get(key)!.sessionCount ?? 0) + 1
          }
          setProjects(Array.from(seen.values()))
        })
        .catch(() => {})
        .finally(() => setLoading(false))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, harness])

  // Load sessions for selected project
  useEffect(() => {
    if (view !== 'sessions' || !selectedProject) return
    if (harness === 'claude') {
      setLoading(true)
      fetch(`/api/claude-sessions?encodedDir=${encodeURIComponent(selectedProject.encodedDir)}`)
        .then(r => r.ok ? r.json() : [])
        .then((data: SessionItem[]) => setSessions(data))
        .catch(() => {})
        .finally(() => setLoading(false))
    } else {
      // Filter already-loaded sessions
      setSessions(allSessions.filter(s => (s.project ?? '(unknown)') === selectedProject.path))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, selectedProject])

  const openProject = (proj: ProjectItem) => {
    setSelectedProject(proj)
    setSessions([])
    setView('sessions')
    onStateChange?.({ projectPath: proj.path, projectName: proj.name, projectEncodedDir: proj.encodedDir, sessionId: null })
  }

  const openSession = async (sess: SessionItem) => {
    setSelectedSession(sess)
    setLoading(true)
    try {
      let url: string
      if (harness === 'claude' && selectedProject) {
        const r = await fetch(claudePageUrl(sess.id, selectedProject.encodedDir))
        const page: ClaudePage = r.ok ? await r.json() : EMPTY_PAGE
        setTranscript(page.messages)
        setOlderStart(page.start)
      } else {
        url = `/api/${harness}-sessions/${encodeURIComponent(sess.id)}`
        const r = await fetch(url)
        const msgs: TranscriptMessage[] = r.ok ? await r.json() : []
        setTranscript(msgs)
        setOlderStart(0)
      }
    } catch { setTranscript([]); setOlderStart(0) }
    finally { setLoading(false) }
    setView('transcript')
    onStateChange?.({
      projectPath: selectedProject?.path ?? null,
      projectName: selectedProject?.name ?? null,
      projectEncodedDir: selectedProject?.encodedDir ?? null,
      sessionId: sess.id,
    })
  }

  const backToProjects = () => {
    setSelectedProject(null)
    setSessions([])
    setSearch('')
    setView('projects')
    onStateChange?.({ projectPath: null, projectName: null, projectEncodedDir: null, sessionId: null })
  }

  const backToSessions = () => {
    setSelectedSession(null)
    setTranscript([])
    setView('sessions')
    onStateChange?.({
      projectPath: selectedProject?.path ?? null,
      projectName: selectedProject?.name ?? null,
      projectEncodedDir: selectedProject?.encodedDir ?? null,
      sessionId: null,
    })
  }

  const filteredProjects = search.trim()
    ? projects.filter(p => p.name.toLowerCase().includes(search.toLowerCase()))
    : projects

  // Render

  const containerStyle: React.CSSProperties = {
    display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden',
    background: 'var(--bg-surface)',
  }

  const headerStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: isMobile ? '10px 14px' : '8px 12px',
    borderBottom: '1px solid var(--border)',
    background: 'var(--bg-card)', flexShrink: 0,
    minHeight: isMobile ? 48 : 40,
    overflow: 'hidden',
  }

  const backBtnStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 3,
    padding: isMobile ? '6px 10px' : '3px 8px',
    borderRadius: 6, border: '1px solid var(--border)',
    background: 'transparent', color: 'var(--text-secondary)',
    cursor: 'pointer', fontFamily: 'inherit',
    fontSize: isMobile ? 13 : 11, fontWeight: 500,
    flexShrink: 0,
    whiteSpace: 'nowrap',
  }

  if (loading && view === 'projects' && projects.length === 0) {
    return (
      <div style={{ ...containerStyle, alignItems: 'center', justifyContent: 'center' }}>
        <AgentisticsLoader size={16} style={{ color }} />
      </div>
    )
  }

  if (view === 'projects') {
    return (
      <div style={containerStyle}>
        <div style={headerStyle}>
          <div style={{ width: 10, height: 10, borderRadius: '50%', background: color, flexShrink: 0 }} />
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>
            {HARNESS_LABELS[harness]}
          </span>
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)', marginLeft: 2 }}>
            — {projects.length} {pt ? 'projetos' : 'projects'}
          </span>
        </div>
        <div style={{ padding: '8px 12px', flexShrink: 0, borderBottom: '1px solid var(--border)' }}>
          <input
            type="text"
            placeholder={pt ? 'Buscar projeto…' : 'Search projects…'}
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{
              width: '100%', boxSizing: 'border-box',
              padding: '5px 10px', borderRadius: 6,
              border: '1px solid var(--border)', background: 'var(--bg-surface)',
              color: 'var(--text-primary)', fontFamily: 'inherit', fontSize: 12,
              outline: 'none',
            }}
          />
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '6px 8px' }}>
          {filteredProjects.length === 0 && !loading && (
            <div style={{ textAlign: 'center', padding: '30px 0', color: 'var(--text-tertiary)', fontSize: 12 }}>
              {pt ? 'Nenhum projeto encontrado' : 'No projects found'}
            </div>
          )}
          {filteredProjects.map((proj, i) => (
            <button
              key={i}
              onClick={() => openProject(proj)}
              style={{
                width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: isMobile ? '10px 12px' : '7px 10px',
                borderRadius: 8, border: '1px solid transparent',
                background: 'transparent', cursor: 'pointer', fontFamily: 'inherit',
                marginBottom: 3, gap: 8,
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-card)'; (e.currentTarget as HTMLButtonElement).style.border = `1px solid color-mix(in srgb, ${color} 20%, var(--border))` }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; (e.currentTarget as HTMLButtonElement).style.border = '1px solid transparent' }}
            >
              <span style={{ fontSize: isMobile ? 14 : 12, fontWeight: 500, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>
                {proj.name}
              </span>
              {proj.sessionCount != null && (
                <span style={{ fontSize: 10, color: 'var(--text-tertiary)', flexShrink: 0 }}>
                  {proj.sessionCount} {pt ? 'sessões' : 'sessions'}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
    )
  }

  if (view === 'sessions') {
    return (
      <div style={containerStyle}>
        <div style={headerStyle}>
          <button onClick={backToProjects} style={backBtnStyle}>
            <ChevronLeft size={11} />
            {pt ? 'Projetos' : 'Projects'}
          </button>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {selectedProject?.name}
          </span>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '6px 8px' }}>
          {loading && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '30px 0' }}>
              <AgentisticsLoader size={14} style={{ color }} />
            </div>
          )}
          {!loading && sessions.length === 0 && (
            <div style={{ textAlign: 'center', padding: '30px 0', color: 'var(--text-tertiary)', fontSize: 12 }}>
              {pt ? 'Nenhuma sessão' : 'No sessions'}
            </div>
          )}
          {sessions.map((sess, i) => {
            const dateStr = sess.createdAt ?? sess.startTime
            return (
              <button
                key={i}
                onClick={() => openSession(sess)}
                style={{
                  width: '100%', textAlign: 'left', display: 'flex', flexDirection: 'column',
                  padding: isMobile ? '10px 12px' : '7px 10px',
                  borderRadius: 8, border: '1px solid transparent',
                  background: 'transparent', cursor: 'pointer', fontFamily: 'inherit', marginBottom: 3,
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-card)'; (e.currentTarget as HTMLButtonElement).style.border = `1px solid color-mix(in srgb, ${color} 20%, var(--border))` }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; (e.currentTarget as HTMLButtonElement).style.border = '1px solid transparent' }}
              >
                <span style={{ fontSize: isMobile ? 14 : 12, fontWeight: 500, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>
                  {sess.title || sess.id}
                </span>
                <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
                  {dateStr && (
                    <span style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>
                      {new Date(dateStr).toLocaleDateString()}
                    </span>
                  )}
                  {sess.messageCount != null && (
                    <span style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>
                      {sess.messageCount} {pt ? 'msgs' : 'msgs'}
                    </span>
                  )}
                </div>
              </button>
            )
          })}
        </div>
      </div>
    )
  }

  // transcript view
  return (
    <div style={containerStyle}>
      <div style={{ ...headerStyle, borderLeft: `3px solid ${color}` }}>
        <button onClick={backToSessions} style={backBtnStyle}>
          <ChevronLeft size={11} />
          {pt ? 'Sessões' : 'Sessions'}
        </button>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
          {selectedSession?.title || selectedSession?.id || ''}
        </span>
        {transcript.length > 0 && (
          <span style={{ fontSize: 10, color: 'var(--text-tertiary)', flexShrink: 0 }}>
            {transcript.length} {pt ? 'msgs' : 'msgs'}
          </span>
        )}
      </div>
      <div ref={transcriptRef} onScroll={e => { if (e.currentTarget.scrollTop < 300) void loadOlder() }} style={{ flex: 1, overflowY: 'auto', padding: isMobile ? '10px 10px' : '12px 14px', overflowX: 'hidden' }}>
        {!loading && olderStart > 0 && (
          <div style={{ textAlign: 'center', padding: '4px 0 10px' }}>
            <button type="button" onClick={() => void loadOlder()} disabled={loadingOlder} style={{ fontSize: 11, color: 'var(--text-tertiary)', background: 'none', border: '1px solid var(--border)', borderRadius: 6, padding: '3px 10px', cursor: 'pointer' }}>
              {loadingOlder ? (pt ? 'Carregando…' : 'Loading…') : (pt ? `Carregar mensagens anteriores (${olderStart})` : `Load earlier messages (${olderStart})`)}
            </button>
          </div>
        )}
        {loading && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
            <AgentisticsLoader size={14} style={{ color }} />
          </div>
        )}
        {!loading && transcript.length === 0 && (
          <div style={{ textAlign: 'center', padding: '30px 0', color: 'var(--text-tertiary)', fontSize: 12 }}>
            {pt ? 'Nenhuma mensagem' : 'No messages'}
          </div>
        )}
        {transcript.flatMap((msg, i) =>
          splitInlinedHistory(msg.role, msg.content).map((split, j) => (
            <MessageBubble
              key={i + '-' + j}
              msg={{ ...msg, role: split.role, content: split.content }}
              harness={harness}
              pt={pt}
            />
          ))
        )}
      </div>
    </div>
  )
}

/**
 * ThreadsPanel — the task page's THREADS: an inbox of subjects beside the open thread, read as a
 * RECORD (owner's decision, 2026-10-04, approving A+C with one change).
 *
 * "I don't want 2 chat sources confusing where the information is." So:
 *  1. a thread is a record, not a chat — comments are notes (author, time, kind tag, text), never
 *     bubbles, and nothing here implies a pending answer;
 *  2. COMMENT is the default and it reaches no session; SEND is a separate, secondary, visible act
 *     ("Send to the N sessions", recipients listed) that delivers the text INTO each session's own
 *     chat — the one place conversations live — and the thread records only that it was sent, and to
 *     whom, with a link per session to its chat;
 *  3. a session's comment (a handback, a block) is a record with a link to that session's chat;
 *  4. the delivery machinery (verified identity, queue on reopen, refusal on an open dialog) is the
 *     server's, behind the send (`task-threads.ts`).
 *
 * On a phone the inbox is the page and an open thread is a full-screen view over it.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Ban, BellRing, Check, MessageSquarePlus, RotateCcw, Send, ExternalLink } from 'lucide-react'
import {
  deliverySummary, rowForParticipant, threadComments, threadInbox,
  type ChatAttachmentRef, type FleetRowLike, type ThreadParticipant, type ThreadSummary,
} from '@agentistics/core'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useFleet } from '../../lib/fleet'
import { sessionPath } from '../../lib/sessionRoute'
import { addComment, openThread, sendThread, threadVerb, type TaskComment, type TaskDetail, type TaskThread } from '../../lib/tasks'
import { HarnessMark } from '../sessions/HarnessMark'
import { CommentAttachments, CommentComposer } from './CommentComposer'
import { SESSION_STATE, button, field, fmtStamp } from './board'
import { threadCopy, type Lang } from './threadCopy'
import { participantState, replyReach } from './threadView'
import { RESOLVED_FLASH_MS, resolveView } from './resolveFlow'

/** Today: the time. Otherwise: day and month. An inbox row has room for one short stamp. */
function shortWhen(iso: string, lang: Lang): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const loc = lang === 'pt' ? 'pt-BR' : 'en-US'
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(loc, { day: '2-digit', month: 'short' })
}

/** The kind tag's colour: a block is the one that names a problem somebody has to solve. */
const KIND_COLOR: Record<string, { color: string; dim: string }> = {
  handback: { color: 'var(--accent-cyan)', dim: 'var(--accent-cyan-dim)' },
  block: { color: 'var(--accent-red)', dim: 'var(--accent-red-dim)' },
  decision: { color: 'var(--accent-green)', dim: 'var(--accent-green-dim)' },
}

export function ThreadsPanel({ id, detail, lang, reload, renderBody, loose }: {
  id: string
  detail: TaskDetail
  lang: Lang
  reload: () => void | Promise<void>
  /** How a comment body is drawn (markdown + file references) — the page's own renderer. */
  renderBody: (c: TaskComment) => ReactNode
  /** The loose comments view (comments in no thread) — the page's existing comments list. */
  loose: ReactNode
}) {
  const isMobile = useIsMobile()
  const t = threadCopy(lang)
  const { fleet } = useFleet(lang)
  const rows: FleetRowLike[] = useMemo(
    () => fleet.sessions.map(r => ({ id: r.id, state: r.state, actionable: r.actionable, ...(r.conversationId ? { conversationId: r.conversationId } : {}) })),
    [fleet.sessions],
  )
  const threads = detail.threads ?? []
  const inbox = useMemo(() => threadInbox(threads, detail.comments), [threads, detail.comments])
  const looseCount = detail.comments.filter(c => !c.threadId).length
  const [picked, setPicked] = useState<string | 'loose' | null>(null)
  // On a phone nothing is open until the person picks; on a desktop the newest open thread is.
  const selected = picked ?? (isMobile ? null : inbox.open[0]?.thread.id ?? inbox.resolved[0]?.thread.id ?? (looseCount > 0 ? 'loose' : null))
  const thread = threads.find(x => x.id === selected) ?? null

  const where = (th: TaskThread) => {
    const title = th.subtaskId ? detail.subtasks.find(s => s.id === th.subtaskId)?.title : undefined
    return title ? t.onTarget(title) : t.onTask
  }

  const [creating, setCreating] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const create = async () => {
    const title = newTitle.trim()
    if (!title) return
    const r = await openThread(id, title)
    setCreating(false); setNewTitle('')
    await reload()
    if (r.ok) setPicked(r.thread.id)
  }

  const item = (s: ThreadSummary<TaskComment>) => {
    const on = s.thread.id === selected
    const who = (c: TaskComment) => c.role === 'owner'
      ? t.you
      : (c.sessionId ? s.thread.participants.find(p => p.sessionId === c.sessionId)?.label : undefined) ?? c.author
    return (
      <button
        key={s.thread.id}
        onClick={() => setPicked(s.thread.id)}
        style={{
          display: 'grid', gap: 3, width: '100%', textAlign: 'left',
          padding: isMobile ? '12px 16px' : '10px 14px', minHeight: isMobile ? 64 : undefined,
          border: 'none', borderLeft: `2px solid ${on ? 'var(--anthropic-orange)' : 'transparent'}`,
          background: on ? 'var(--anthropic-orange-glow)' : 'transparent', cursor: 'pointer', fontFamily: 'inherit', color: 'inherit',
        }}
      >
        <span style={{
          fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          color: s.state === 'resolved' ? 'var(--text-secondary)' : 'var(--text-primary)',
        }}>
          {t.threadKind[s.thread.kind] ? <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--accent-cyan)', marginRight: 6 }}>{t.threadKind[s.thread.kind]}</span> : null}
          {s.thread.title}
        </span>
        {s.last && (
          <span style={{ fontSize: 12, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {who(s.last)}: {s.last.body.replace(/\s+/g, ' ')}
          </span>
        )}
        <span style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 11, color: 'var(--text-tertiary)', minWidth: 0 }}>
          {s.thread.participants.slice(0, 4).map(p => <HarnessMark key={p.sessionId} harness={p.harness ?? 'claude'} size={16} />)}
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
            {t.sessionsCount(s.thread.participants.length)} · {where(s.thread)}
          </span>
          <span style={{ marginLeft: 'auto', flex: '0 0 auto', whiteSpace: 'nowrap' }}>{shortWhen(s.last?.createdAt ?? s.thread.createdAt, lang)}</span>
        </span>
      </button>
    )
  }

  const heading = (label: string, n: number) => (
    <div style={{ fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 600, padding: '12px 14px 6px', color: 'var(--text-tertiary)' }}>
      {label} · {n}
    </div>
  )

  const inboxPane = (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      <div style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>
        {threads.length === 0 && (
          <div style={{ padding: 14, fontSize: 12.5, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>{t.noThreads}</div>
        )}
        {inbox.open.length > 0 && <div>{heading(t.open, inbox.open.length)}{inbox.open.map(item)}</div>}
        {inbox.resolved.length > 0 && <div>{heading(t.resolved, inbox.resolved.length)}{inbox.resolved.map(item)}</div>}
        {looseCount > 0 && (
          <div>
            {heading(t.loose, looseCount)}
            <button
              onClick={() => setPicked('loose')}
              style={{
                width: '100%', textAlign: 'left', padding: isMobile ? '12px 16px' : '10px 14px', minHeight: isMobile ? 52 : undefined,
                border: 'none', borderLeft: `2px solid ${selected === 'loose' ? 'var(--anthropic-orange)' : 'transparent'}`,
                background: selected === 'loose' ? 'var(--anthropic-orange-glow)' : 'transparent', color: 'var(--text-secondary)',
                fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
              }}
            >{t.looseHint}</button>
          </div>
        )}
      </div>
      <div style={{ padding: '10px 14px', borderTop: '1px solid var(--border)' }}>
        {creating ? (
          <form onSubmit={e => { e.preventDefault(); void create() }} style={{ display: 'grid', gap: 8 }}>
            <input
              autoFocus value={newTitle} onChange={e => setNewTitle(e.target.value)} placeholder={t.newThreadTitle}
              aria-label={t.newThreadTitle} style={{ ...field(isMobile), width: '100%' }}
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="submit" style={{ ...button(isMobile, 'primary'), flex: 1 }} disabled={!newTitle.trim()}>{t.create}</button>
              <button type="button" style={{ ...button(isMobile), flex: 1 }} onClick={() => { setCreating(false); setNewTitle('') }}>{t.cancel}</button>
            </div>
          </form>
        ) : (
          <button style={{ ...button(isMobile), width: '100%', justifyContent: 'center' }} onClick={() => setCreating(true)}>
            <MessageSquarePlus size={14} /> {t.newThread}
          </button>
        )}
      </div>
    </div>
  )

  const right = selected === 'loose'
    ? <div style={{ padding: isMobile ? 12 : 14, overflowY: 'auto', height: '100%' }}>{loose}</div>
    : thread
      ? <ThreadRecord key={thread.id} id={id} thread={thread} detail={detail} rows={rows} lang={lang}
          reload={reload} renderBody={renderBody} where={where(thread)} onBack={isMobile ? () => setPicked(null) : undefined} />
      : <div style={{ padding: 18, fontSize: 12.5, color: 'var(--text-tertiary)' }}>{threads.length > 0 ? '' : t.noThreads}</div>

  if (isMobile) {
    return (
      <>
        <div style={{ background: 'var(--bg-card)', borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)' }}>
          {inboxPane}
        </div>
        {selected && (
          <div
            role="dialog" aria-modal="true"
            style={{
              position: 'fixed', inset: 0, zIndex: 1000, background: 'var(--bg-card)', display: 'flex', flexDirection: 'column',
              paddingTop: 'var(--safe-top)',
            }}
          >
            {selected === 'loose' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderBottom: '1px solid var(--border)' }}>
                <button onClick={() => setPicked(null)} aria-label={t.back} style={{ ...button(true), width: 44, padding: 0, justifyContent: 'center' }}><ArrowLeft size={16} /></button>
                <b style={{ fontSize: 15 }}>{t.loose}</b>
              </div>
            )}
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>{right}</div>
          </div>
        )}
      </>
    )
  }
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '280px minmax(0, 1fr)', minHeight: 520, height: 'min(72vh, 820px)',
      background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden',
    }}>
      <div style={{ borderRight: '1px solid var(--border)', minHeight: 0 }}>{inboxPane}</div>
      <div style={{ minHeight: 0, display: 'flex', flexDirection: 'column' }}>{right}</div>
    </div>
  )
}

function KindTag({ kind, lang }: { kind?: string; lang: Lang }) {
  if (!kind || kind === 'note') return null
  const c = KIND_COLOR[kind] ?? { color: 'var(--text-secondary)', dim: 'var(--ag-tint-3)' }
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase',
      color: c.color, background: c.dim, padding: '1px 6px', borderRadius: 4,
    }}>{threadCopy(lang).commentKind[kind] ?? kind}</span>
  )
}

function ThreadRecord({ id, thread, detail, rows, lang, reload, renderBody, where, onBack }: {
  id: string
  thread: TaskThread
  detail: TaskDetail
  rows: FleetRowLike[]
  lang: Lang
  reload: () => void | Promise<void>
  renderBody: (c: TaskComment) => ReactNode
  where: string
  onBack?: () => void
}) {
  const isMobile = useIsMobile()
  const navigate = useNavigate()
  const t = threadCopy(lang)
  const comments = threadComments(detail.comments, thread.id)
  const muted = thread.mutedSessions ?? []
  const reach = replyReach(thread.participants, rows, muted)
  const recipients = thread.participants.filter(p => !muted.includes(p.sessionId))
  const [draft, setDraft] = useState('')
  const [attached, setAttached] = useState<ChatAttachmentRef[]>([])
  const [decision, setDecision] = useState(false)
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [verbPending, setVerbPending] = useState(false)
  const [flashing, setFlashing] = useState(false)
  useEffect(() => {
    if (!flashing) return
    const h = setTimeout(() => setFlashing(false), RESOLVED_FLASH_MS)
    return () => clearTimeout(h)
  }, [flashing])
  // A record reads oldest first; open on the newest entry, and follow a new one.
  const scroller = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [comments.length])

  const participant = (sid: string): ThreadParticipant | undefined => thread.participants.find(p => p.sessionId === sid)
  const labelOf = (sid: string) => participant(sid)?.label ?? sid.slice(0, 8)
  const harnessOf = (sid?: string) => (sid ? participant(sid)?.harness : undefined) ?? 'claude'
  /** The session's chat as it stands NOW — a reopen mints a new row for the same conversation. */
  const chatOf = (sid: string, conversationId?: string) => {
    const row = rowForParticipant({ sessionId: sid, ...(conversationId ? { conversationId } : {}) }, rows)
    return sessionPath(row?.id ?? sid)
  }

  const kind = decision ? 'decision' as const : undefined
  const done = () => { setDraft(''); setAttached([]); setDecision(false) }
  const comment = async () => {
    const body = draft.trim()
    if (!body && attached.length === 0) return
    setBusy(true); setRefusal(null)
    const r = await addComment(id, 'you', body, null, attached, { threadId: thread.id, ...(kind ? { kind } : {}) })
    setBusy(false)
    if (!r.ok) { setRefusal(r.message ?? t.failed); return }
    done(); await reload()
  }
  const send = async () => {
    const body = draft.trim()
    if (!body) return
    setBusy(true); setRefusal(null)
    const r = await sendThread(id, thread.id, body, lang, { attachments: attached, ...(kind ? { kind } : {}) })
    setBusy(false)
    if (!r.ok) { setRefusal(r.message ?? t.failed); return }
    done(); await reload()
  }
  const verb = async (action: 'resolve' | 'reopen' | 'mute' | 'unmute', sessionId?: string) => {
    if (action === 'resolve') setVerbPending(true)
    await threadVerb(id, thread.id, action, sessionId ? { sessionId } : {})
    await reload()
    if (action === 'resolve') { setVerbPending(false); setFlashing(true) }
  }
  const rv = resolveView({ resolvedAt: thread.resolvedAt, pending: verbPending, flashing })
  const cantSend = busy || !draft.trim() || reach.total === 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: isMobile ? '10px 12px' : '11px 16px', borderBottom: '1px solid var(--border)' }}>
        {onBack && (
          <button onClick={onBack} aria-label={t.back} style={{ ...button(true), width: 44, padding: 0, justifyContent: 'center', flex: '0 0 auto' }}>
            <ArrowLeft size={16} />
          </button>
        )}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 700, overflowWrap: 'anywhere' }}>{thread.title}</div>
          {!isMobile && <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{where} · {t.openedBy(thread.openedBy, fmtStamp(thread.createdAt, lang))}</div>}
        </div>
        {thread.resolvedAt && rv !== 'done' && (
          <span data-resolved-badge style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent-green)', background: 'var(--accent-green-dim)', borderRadius: 999, padding: '2px 9px', flex: '0 0 auto' }}>{t.resolvedBadge}</span>
        )}
        <button
          data-resolve-button data-resolve-view={rv}
          disabled={rv === 'working' || rv === 'done'}
          onClick={() => void verb(thread.resolvedAt ? 'reopen' : 'resolve')}
          style={{
            ...button(isMobile), flex: '0 0 auto', transition: 'background .25s, color .25s, border-color .25s',
            ...(rv === 'done' ? { background: 'var(--accent-green-dim)', color: 'var(--accent-green)', borderColor: 'var(--accent-green)' } : {}),
            ...(rv === 'working' ? { opacity: 0.7 } : {}),
          }}
          title={rv === 'reopen' ? t.reopen : t.resolve} aria-label={rv === 'done' ? t.resolvedNow : rv === 'reopen' ? t.reopen : t.resolve}
        >
          {rv === 'reopen' ? <RotateCcw size={14} /> : <Check size={14} />}
          {(!isMobile || rv === 'done') && (rv === 'done' ? t.resolvedNow : rv === 'reopen' ? t.reopen : t.resolve)}
        </button>
      </div>

      {rv === 'done' && (
        <div role="status" data-resolved-note style={{ padding: '6px 16px', fontSize: 12, color: 'var(--accent-green)', background: 'var(--accent-green-dim)' }}>{t.movedToResolved}</div>
      )}
      <div ref={scroller} style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', padding: isMobile ? '6px 12px' : '6px 16px' }}>
        {comments.map(c => {
          const mine = c.role === 'owner'
          const sum = deliverySummary(c.deliveries)
          return (
            <article key={c.id} style={{
              display: 'grid', gridTemplateColumns: '26px minmax(0, 1fr)', gap: 10, padding: '12px 0',
              borderBottom: '1px solid var(--border-subtle)',
            }}>
              {mine
                ? <span aria-hidden style={{ width: 26, height: 26, borderRadius: '50%', display: 'grid', placeItems: 'center', background: 'var(--ag-tint-4)', fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)' }}>{t.you.slice(0, 1)}</span>
                : <HarnessMark harness={harnessOf(c.sessionId)} size={26} />}
              <div style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-tertiary)' }}>
                  <b style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{mine ? t.you : (c.sessionId ? labelOf(c.sessionId) : c.author)}</b>
                  <span>{fmtStamp(c.createdAt, lang)}</span>
                  <KindTag kind={c.kind} lang={lang} />
                  {c.role === 'session' && c.sessionId && (
                    <button
                      onClick={() => navigate(chatOf(c.sessionId!, participant(c.sessionId!)?.conversationId))}
                      style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4, border: 'none', background: 'none', padding: isMobile ? '6px 0' : 0, color: 'var(--anthropic-orange-light)', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12 }}
                    ><ExternalLink size={12} /> {t.openChat}</button>
                  )}
                </div>
                <div style={{ marginTop: 4, fontSize: 13.5, lineHeight: 1.55, overflowWrap: 'anywhere', color: 'var(--text-primary)' }}>
                  {renderBody(c)}
                  {c.attachments && c.attachments.length > 0 && <CommentAttachments attachments={c.attachments} lang={lang} />}
                </div>
                {sum.total > 0 && (
                  <div style={{ marginTop: 8, display: 'grid', gap: 6 }}>
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)' }}>
                      <Send size={12} /> {t.sentTo(sum.delivered, sum.total)}
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {(c.deliveries ?? []).map(d => {
                        const color = d.state === 'delivered' ? 'var(--accent-green)' : d.state === 'queued' ? 'var(--anthropic-orange-light)' : 'var(--text-tertiary)'
                        const word = d.state === 'delivered' ? `✓ ${t.state.delivered}` : d.reason ? t.reason[d.reason] : t.state[d.state]
                        return (
                          <button
                            key={d.sessionId} title={d.detail ?? t.openChat}
                            onClick={() => navigate(chatOf(d.sessionId, d.conversationId))}
                            style={{
                              display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, padding: '2px 8px 2px 3px', borderRadius: 999,
                              background: 'var(--ag-tint-2)', border: '1px solid var(--border)', color, cursor: 'pointer', fontFamily: 'inherit',
                              minHeight: isMobile ? 32 : undefined,
                            }}
                          >
                            <HarnessMark harness={harnessOf(d.sessionId)} size={14} />{labelOf(d.sessionId)} · {word}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
            </article>
          )
        })}
      </div>

      <div style={{
        padding: isMobile ? '8px 10px calc(env(safe-area-inset-bottom, 0px) + 8px)' : '10px 14px 14px',
        borderTop: '1px solid var(--border)', display: 'grid', gap: 8,
      }}>
        <CommentComposer
          lang={lang}
          value={draft}
          onChange={setDraft}
          attachments={attached}
          onAttachments={setAttached}
          ariaLabel={t.placeholder}
          placeholder={t.placeholder}
          submitLabel={t.comment}
          busy={busy}
          refusal={refusal}
          onSubmit={() => { void comment() }}
        />
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)', minHeight: isMobile ? 44 : undefined, cursor: 'pointer' }}>
            <input type="checkbox" checked={decision} onChange={e => setDecision(e.target.checked)} />
            {t.asDecision}
          </label>
          <span style={{ flex: 1 }} />
          <button
            onClick={() => void send()}
            disabled={cantSend}
            title={reach.total === 0 ? t.noRecipients : undefined}
            style={{ ...button(isMobile), opacity: cantSend ? 0.55 : 1 }}
          ><Send size={14} /> {t.sendTo(reach.total)}</button>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--text-tertiary)' }}>
          {recipients.length === 0 && muted.length === 0
            ? <span>{t.noParticipants}</span>
            : recipients.map(p => {
              const st = participantState(p, rows)
              return (
                <span key={p.sessionId} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 6px 1px 2px', borderRadius: 999, background: 'var(--ag-tint-2)', border: '1px solid var(--border)' }}>
                  <HarnessMark harness={p.harness ?? 'claude'} size={14} />
                  {p.label ?? p.sessionId.slice(0, 8)}
                  <span style={{ color: st ? (SESSION_STATE[st]?.color ?? 'var(--text-tertiary)') : 'var(--text-tertiary)' }}>
                    · {st ? (SESSION_STATE[st]?.label ?? st) : (lang === 'pt' ? 'encerrada' : 'ended')}
                  </span>
                  <button
                    onClick={() => void verb('mute', p.sessionId)} title={t.mute} aria-label={t.mute}
                    style={{ display: 'grid', placeItems: 'center', width: isMobile ? 32 : 20, height: isMobile ? 32 : 20, border: 'none', background: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', padding: 0 }}
                  ><Ban size={11} /></button>
                </span>
              )
            })}
          {muted.map(sid => (
            <button
              key={sid} onClick={() => void verb('unmute', sid)} title={t.unmute} aria-label={t.unmute}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 8px', borderRadius: 999, border: '1px dashed var(--border)', background: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11.5, textDecoration: 'line-through', minHeight: isMobile ? 32 : undefined }}
            ><BellRing size={11} /> {labelOf(sid)}</button>
          ))}
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{t.sendHint(reach.queued)}</div>
      </div>
    </div>
  )
}

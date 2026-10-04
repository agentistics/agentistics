/**
 * ThreadsPanel — the task page's CONVERSATIONS: an inbox of topic threads beside the open thread,
 * read as a chat (owner's choice 2026-10-04, option C's centre on option A's cockpit).
 *
 * The rules are `@agentistics/core`'s `taskThreads.ts`; this file draws them. Four of them are
 * the owner's own and bind what is drawn here:
 *  1. a session that needs an answer asks in ITS OWN chat — the thread shows a MIRROR of that
 *     question (its last words, read from the fleet's own snapshot of the session, stored nowhere),
 *     and answering here or there is ONE answer, delivered once and shown in both places;
 *  2. a thread never blocks a session — the composer says so in words;
 *  3. no bell: "waiting on you" is a visual state of the inbox, never a notification;
 *  4. the reply goes to every participant at once (1:N), each delivery reported as what happened.
 *
 * On a phone the inbox is the page and an open thread is a full-screen view over it, the way the
 * other mobile chat surfaces work.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, BellOff, Bell, Check, RotateCcw, MessageSquarePlus } from 'lucide-react'
import {
  deliverySummary, threadComments, threadInbox, threadMirrors, type ChatAttachmentRef, type FleetRowLike,
  type ThreadSummary,
} from '@agentistics/core'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useFleet } from '../../lib/fleet'
import { sessionPath } from '../../lib/sessionRoute'
import { openThread, replyThread, threadVerb, type TaskComment, type TaskDetail, type TaskThread } from '../../lib/tasks'
import { HarnessMark } from '../sessions/HarnessMark'
import { CommentAttachments, CommentComposer } from './CommentComposer'
import { SESSION_STATE, button, field, fmtStamp } from './board'
import { threadCopy, type Lang } from './threadCopy'
import { lastAssistantText, participantState, replyReach } from './threadView'

const ORANGE_BORDER = 'rgba(217,119,6,.35)'

/** Today: the time. Otherwise: day and month. An inbox row has room for one short stamp. */
function shortWhen(iso: string, lang: Lang): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const loc = lang === 'pt' ? 'pt-BR' : 'en-US'
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(loc, { day: '2-digit', month: 'short' })
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
  const firstOpen = inbox.awaiting[0] ?? inbox.open[0]
  const [picked, setPicked] = useState<string | 'loose' | null>(null)
  // On a phone nothing is open until the person picks; on a desktop the newest live thread is.
  const selected = picked ?? (isMobile ? null : firstOpen?.thread.id ?? (threads.length === 0 && looseCount > 0 ? 'loose' : null))
  const thread = threads.find(x => x.id === selected) ?? null

  const subtaskTitle = (sid?: string) => (sid ? detail.subtasks.find(s => s.id === sid)?.title : undefined)
  const where = (th: TaskThread) => {
    const title = subtaskTitle(th.subtaskId)
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
    const muted = s.attention === 'resolved'
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
        <span style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: muted ? 'var(--text-secondary)' : 'var(--text-primary)' }}>
          {t.kind[s.thread.kind] ? <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--accent-cyan)', marginRight: 6 }}>{t.kind[s.thread.kind]}</span> : null}
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
          {s.thread.mutedSessions?.length ? <BellOff size={11} style={{ flex: '0 0 auto' }} /> : null}
          <span style={{ marginLeft: 'auto', flex: '0 0 auto', whiteSpace: 'nowrap' }}>{shortWhen(s.last?.createdAt ?? s.thread.createdAt, lang)}</span>
        </span>
      </button>
    )
  }

  const section = (label: string, list: ThreadSummary<TaskComment>[], attn = false) =>
    list.length === 0 ? null : (
      <div key={label}>
        <div style={{
          fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 600, padding: '12px 14px 6px',
          color: attn ? 'var(--anthropic-orange-light)' : 'var(--text-tertiary)',
        }}>{attn ? '● ' : ''}{label} · {list.length}</div>
        {list.map(item)}
      </div>
    )

  const inboxPane = (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      <div style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>
        {threads.length === 0 && (
          <div style={{ padding: 14, fontSize: 12.5, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>{t.noThreads}</div>
        )}
        {section(t.awaiting, inbox.awaiting, true)}
        {section(t.open, inbox.open)}
        {section(t.resolved, inbox.resolved)}
        {looseCount > 0 && (
          <div>
            <div style={{ fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 600, padding: '12px 14px 6px', color: 'var(--text-tertiary)' }}>
              {t.loose} · {looseCount}
            </div>
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
      ? <ThreadView key={thread.id} id={id} thread={thread} detail={detail} rows={rows} fleetRows={fleet.rows} lang={lang}
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

function ThreadView({ id, thread, detail, rows, fleetRows, lang, reload, renderBody, where, onBack }: {
  id: string
  thread: TaskThread
  detail: TaskDetail
  rows: FleetRowLike[]
  fleetRows: readonly { id: string; chatTurns?: { role: 'user' | 'assistant'; text: string }[]; lastLines?: string[] }[]
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
  const mirrors = threadMirrors(thread, comments, rows)
  const reach = replyReach(thread.participants, rows, muted)
  const [draft, setDraft] = useState('')
  const [attached, setAttached] = useState<ChatAttachmentRef[]>([])
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  // A conversation reads from the bottom: open on the newest word, and follow it as it arrives.
  const scroller = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [comments.length, mirrors.length])
  const labelOf = (sid: string) => thread.participants.find(p => p.sessionId === sid)?.label ?? sid.slice(0, 8)
  const harnessOf = (sid?: string) => (sid ? thread.participants.find(p => p.sessionId === sid)?.harness : undefined) ?? 'claude'

  const send = async (body: string, answerTo?: string, files: readonly ChatAttachmentRef[] = []) => {
    setBusy(true); setRefusal(null)
    const r = await replyThread(id, thread.id, body, lang, { ...(answerTo ? { answerTo } : {}), attachments: files })
    setBusy(false)
    if (!r.ok) { setRefusal(r.message ?? t.failed); return false }
    await reload()
    return true
  }
  const verb = async (action: 'resolve' | 'reopen' | 'mute' | 'unmute', sessionId?: string) => {
    await threadVerb(id, thread.id, action, sessionId ? { sessionId } : {})
    await reload()
  }

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
        <button
          onClick={() => void verb(thread.resolvedAt ? 'reopen' : 'resolve')}
          style={{ ...button(isMobile), flex: '0 0 auto' }}
          title={thread.resolvedAt ? t.reopen : t.resolve}
        >
          {thread.resolvedAt ? <RotateCcw size={14} /> : <Check size={14} />}{!isMobile && (thread.resolvedAt ? t.reopen : t.resolve)}
        </button>
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', padding: isMobile ? '8px 12px' : '9px 16px', borderBottom: '1px solid var(--border-subtle)', fontSize: 12, color: 'var(--text-secondary)' }}>
        {thread.participants.length === 0 ? <span>{t.noParticipants}</span> : <span>{t.participants}:</span>}
        {thread.participants.map(p => {
          const st = participantState(p, rows)
          const isMuted = muted.includes(p.sessionId)
          const word = st ? (SESSION_STATE[st]?.label ?? st) : (lang === 'pt' ? 'encerrada' : 'ended')
          return (
            <span key={p.sessionId} style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 4px 3px 4px', borderRadius: 999,
              background: 'var(--ag-tint-2)', border: '1px solid var(--border)', opacity: isMuted ? 0.6 : 1,
            }}>
              <HarnessMark harness={p.harness ?? 'claude'} size={16} />
              <button onClick={() => navigate(sessionPath(p.sessionId))} style={{ border: 'none', background: 'none', color: 'var(--text-primary)', cursor: 'pointer', padding: 0, fontFamily: 'inherit', fontSize: 12 }}>
                {p.label ?? p.sessionId.slice(0, 8)}
              </button>
              <span style={{ fontSize: 10.5, color: st ? (SESSION_STATE[st]?.color ?? 'var(--text-tertiary)') : 'var(--text-tertiary)' }}>· {isMuted ? t.muted : word}</span>
              <button
                onClick={() => void verb(isMuted ? 'unmute' : 'mute', p.sessionId)}
                title={isMuted ? t.unmute : t.mute} aria-label={isMuted ? t.unmute : t.mute}
                style={{ display: 'grid', placeItems: 'center', width: isMobile ? 32 : 22, height: isMobile ? 32 : 22, borderRadius: 999, border: 'none', background: 'transparent', color: 'var(--text-tertiary)', cursor: 'pointer' }}
              >{isMuted ? <Bell size={12} /> : <BellOff size={12} />}</button>
            </span>
          )
        })}
      </div>

      <div ref={scroller} style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', padding: isMobile ? '14px 12px' : '16px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {comments.map(c => {
          const mine = c.role === 'owner'
          const sum = deliverySummary(c.deliveries)
          return (
            <div key={c.id} style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: isMobile ? '92%' : '78%', display: 'grid', gridTemplateColumns: mine ? '1fr' : '26px 1fr', gap: 8 }}>
              {!mine && <HarnessMark harness={harnessOf(c.sessionId)} size={26} />}
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12, color: 'var(--text-tertiary)', textAlign: mine ? 'right' : 'left' }}>
                  <b style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{mine ? t.you : (c.sessionId ? labelOf(c.sessionId) : c.author)}</b>
                  {' · '}{fmtStamp(c.createdAt, lang)}
                  {mine && c.answerTo ? ` · → ${labelOf(c.answerTo)}` : ''}
                  {mine && c.via === 'session' ? ` · ${t.viaSessionChat}` : ''}
                </div>
                <div style={{
                  marginTop: 4, padding: '10px 13px', fontSize: 13.5, lineHeight: 1.55, minWidth: 0, overflowWrap: 'anywhere',
                  background: mine ? 'var(--anthropic-orange-dim)' : 'var(--bg-elevated)',
                  border: `1px solid ${mine ? ORANGE_BORDER : 'var(--border)'}`,
                  borderRadius: mine ? '14px 4px 14px 14px' : '4px 14px 14px 14px',
                }}>
                  {renderBody(c)}
                  {c.attachments && c.attachments.length > 0 && <CommentAttachments attachments={c.attachments} lang={lang} />}
                </div>
                {mine && sum.total > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'flex-end', marginTop: 6 }}>
                    {(c.deliveries ?? []).map(d => {
                      const color = d.state === 'delivered' ? 'var(--accent-green)' : d.state === 'queued' ? 'var(--anthropic-orange-light)' : 'var(--text-tertiary)'
                      const word = d.state === 'delivered' ? `✓ ${t.state.delivered}` : d.reason ? t.reason[d.reason] : t.state[d.state]
                      return (
                        <span key={d.sessionId} title={d.detail ?? ''} style={{
                          display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, padding: '2px 8px 2px 3px', borderRadius: 999,
                          background: 'var(--ag-tint-2)', border: '1px solid var(--border)', color,
                        }}>
                          <HarnessMark harness={harnessOf(d.sessionId)} size={14} />{labelOf(d.sessionId)} {word}
                        </span>
                      )
                    })}
                  </div>
                )}
                {mine && sum.total > 0 && (
                  <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', textAlign: 'right', marginTop: 4 }}>{t.deliveredTo(sum.delivered, sum.total)}</div>
                )}
              </div>
            </div>
          )
        })}

        {mirrors.map(m => {
          const row = fleetRows.find(r => r.id === m.rowId)
          const question = lastAssistantText(row?.chatTurns) ?? row?.lastLines?.filter(l => l.trim()).slice(-3).join('\n') ?? ''
          return (
            <MirrorCard
              key={m.sessionId} lang={lang} who={labelOf(m.sessionId)} harness={harnessOf(m.sessionId)}
              question={question} approval={m.approval} busy={busy}
              onOpen={() => navigate(sessionPath(m.rowId))}
              onAnswer={body => send(body, m.sessionId)}
            />
          )
        })}
      </div>

      <div style={{
        padding: isMobile ? '8px 10px calc(env(safe-area-inset-bottom, 0px) + 8px)' : '0 14px 14px',
        borderTop: isMobile ? '1px solid var(--border)' : 'none',
      }}>
        <CommentComposer
          lang={lang}
          value={draft}
          onChange={setDraft}
          attachments={attached}
          onAttachments={setAttached}
          ariaLabel={t.replyAll(reach.total)}
          placeholder={t.replyAll(reach.total)}
          submitLabel={t.send}
          busy={busy}
          refusal={refusal}
          onSubmit={() => {
            const body = draft.trim()
            if (!body && attached.length === 0) return
            void send(body, undefined, attached).then(ok => { if (ok) { setDraft(''); setAttached([]) } })
          }}
        />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 10px', fontSize: 11.5, color: 'var(--text-tertiary)', marginTop: 6 }}>
          <span>{t.goesTo(reach.total, reach.queued)}</span>
          <span>{t.notGate}</span>
        </div>
      </div>
    </div>
  )
}

/** A session's own question, mirrored: answer it once — here or in its chat. */
function MirrorCard({ lang, who, harness, question, approval, busy, onOpen, onAnswer }: {
  lang: Lang
  who: string
  harness: string
  question: string
  approval: boolean
  busy: boolean
  onOpen: () => void
  onAnswer: (body: string) => Promise<boolean>
}) {
  const isMobile = useIsMobile()
  const t = threadCopy(lang)
  const [answer, setAnswer] = useState('')
  return (
    <div style={{
      alignSelf: 'stretch', border: '1px dashed var(--anthropic-orange)', borderRadius: 12, padding: 12,
      background: 'var(--anthropic-orange-glow)', display: 'grid', gap: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, fontWeight: 600, color: 'var(--anthropic-orange-light)' }}>
        <HarnessMark harness={harness} size={18} /> {t.mirrorTitle(who)}
      </div>
      {question && (
        <div style={{ fontSize: 13, color: 'var(--text-primary)', whiteSpace: 'pre-wrap', maxHeight: 160, overflowY: 'auto', overflowWrap: 'anywhere' }}>{question}</div>
      )}
      {approval ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 12, color: 'var(--text-secondary)' }}>
          <span style={{ flex: 1, minWidth: 160 }}>{t.mirrorApproval}</span>
          <button style={button(isMobile, 'primary')} onClick={onOpen}>{t.mirrorOpen}</button>
        </div>
      ) : (
        <form
          onSubmit={e => { e.preventDefault(); const b = answer.trim(); if (b) void onAnswer(b).then(ok => { if (ok) setAnswer('') }) }}
          style={{ display: 'flex', gap: 8, flexWrap: isMobile ? 'wrap' : 'nowrap' }}
        >
          <input
            value={answer} onChange={e => setAnswer(e.target.value)} placeholder={t.mirrorAnswer} aria-label={t.mirrorAnswer}
            style={{ ...field(isMobile), flex: 1, minWidth: 0 }}
          />
          <button type="submit" disabled={busy || !answer.trim()} style={button(isMobile, 'primary')}>{t.send}</button>
          <button type="button" onClick={onOpen} style={button(isMobile)}>{t.mirrorOpen}</button>
        </form>
      )}
      <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{t.mirrorHint}</div>
    </div>
  )
}

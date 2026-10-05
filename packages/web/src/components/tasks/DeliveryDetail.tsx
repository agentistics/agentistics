/**
 * DeliveryDetail — ONE delivery, drawn the same way wherever it is opened.
 *
 * It was the body of `/tasks/:id` and nothing else, so the session's own Task tab could only ever
 * show a summary card with two buttons on it: the delivery's name, "Change" and "Unfile". Everything
 * that makes a delivery worth opening — its description, its parts, the sessions filed under them,
 * the comments with their attachments, the pull requests, what is blocking it, its status and its
 * claim — lived on a page you had to leave the session to reach.
 *
 * Reproducing that in the aside would have been a SECOND implementation of every one of those
 * gestures, which is the bug this codebase keeps paying for. So the body moved here and both
 * surfaces render it: the page, and the aside beside the conversation. **They are the same
 * component over the same `/api/tasks`, so "change it here and it changes there" is not a feature
 * that had to be built — it is what one implementation means.**
 *
 * `dense` is the only difference, and it is LAYOUT ONLY: the aside is a ~380px column, so the
 * two-column split (work | facts) becomes one column and the rail follows the tabs instead of
 * standing beside them. Nothing is dropped — a control that exists on the page and not in the
 * aside is exactly the asymmetry this move exists to end.
 */

import { useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import {
  ChevronDown, ChevronRight, ExternalLink, FileText, FileVideo, Paperclip,
  Pencil, Plus, Trash2, X,
} from 'lucide-react'
import { commentThread, type ChatAttachmentRef } from '@agentistics/core'
import { CommentAttachments, CommentComposer } from './CommentComposer'
import { commentAnchor, commentCandidates, sessionCandidates } from './commentMention'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useFleet } from '../../lib/fleet'
import { sessionPath } from '../../lib/sessionRoute'
import {
  bodyWithAttachments, looksLikeImage, looksLikeVideo, parseCommentBody,
  type CommentAttachment, type CommentPart,
} from '../../lib/commentBody'
import {
  NA, SESSION_STATE, button, field, fmtInt, fmtTokens,
  harnessColor, microLabel, numeric, pill, surface,
} from './board'
import { useMoney } from './money'
import { boardCopy, type Lang } from './copy'
import { RailSection } from './RailSection'
import { TaskChips, TaskMoreMenu } from './TaskChips'
import { SubtaskTable } from './SubtaskTable'
import { BlockedSubtaskResolve } from './BlockedSubtaskResolve'
import { useStagedFire } from './useStagedFire'
import { TaskFiles } from './TaskFiles'
import { ConfirmModal } from '../../pages/settings/primitives'
import { CommentThreadDialog } from './CommentThreadDialog'
import { ThreadsPanel } from './ThreadsPanel'
import { threadCopy } from './threadCopy'
import {
  addComment, addSubtask, attachSession, clearStagedSession, deleteFile,
  detachSession, editComment, editTask, fileUrl, fmtDuration,
  patchSubtask, removeComment, removeSubtask, saveStagedSession,
  uploadFile, useTaskActivity, useTaskStatuses,
  type AttemptRollup, type AttemptView, type Subtask, type TaskDetail,
  type TaskFile, type TaskListRow,
} from '../../lib/tasks'

/**
 * The PLAN half of a task: how urgent it is, and where it stands.
 *
 * It sits at the top of the rail because these are the fields that decide what happens NEXT, while
 * everything below them (cost, rounds, tokens) records what already happened. There is no owner
 * field and no claim/lease control here — a product owner asked for both to go: nobody is assigned
 * by name on this board, and "who is working on it right now" is answered by the sessions filed
 * under it, not by a separate hand-raised statement. `startedAt`/`deliveredAt` are the two dates
 * this card shows, and both are SYSTEM facts (see `Task.startedAt`'s own note) — there is nothing
 * to type, only something to read.
 */
/**
 * What has happened to THIS task, newest first.
 *
 * On a board several agents drive, "who moved this to blocked, and when" is not rhetorical — and
 * the answer cannot come from the task record, which only ever holds the latest value of each
 * field. A kind nobody has words for prints itself rather than vanishing.
 */
function ActivityTab({ id }: { id: string }) {
  const { events, loading } = useTaskActivity(id, 100)
  if (loading) {
    return <div style={{ ...surface, padding: 14, fontSize: 12.5, color: 'var(--text-tertiary)' }}>Loading…</div>
  }
  if (events.length === 0) {
    return (
      <div style={{ ...surface, padding: 14, fontSize: 12.5, color: 'var(--text-tertiary)' }}>
        Nothing recorded yet. Status moves, claims, priority changes and sessions filed under this
        task land here as they happen — including the ones an assistant makes over the API.
      </div>
    )
  }
  return (
    <div style={{ ...surface, padding: 14, display: 'grid', gap: 9 }}>
      {events.map(e => (
        <div key={e.id} style={{ display: 'flex', gap: 9, alignItems: 'baseline', fontSize: 12 }}>
          <span style={{ ...microLabel, fontSize: 10, whiteSpace: 'nowrap' }}>
            {new Date(e.at).toLocaleString()}
          </span>
          <span style={{ color: 'var(--text-secondary)' }}>
            <strong style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{e.actor}</strong>
            {' '}{e.kind === 'status' ? `moved ${e.from ?? '?'} → ${e.to ?? '?'}`
              : e.kind === 'claim' ? (e.detail === 'takeover' ? 'took over' : 'claimed it')
              : e.kind === 'release' ? 'released it'
              : e.kind === 'priority' ? `set priority ${e.from ?? '?'} → ${e.to ?? '?'}`
              : e.kind === 'assign' ? `set the owner to ${e.to || 'nobody'}`
              : e.kind === 'session' ? `filed a ${e.detail ?? ''} session`.trim()
              : e.kind === 'move' ? 'reordered it'
              : e.kind}
          </span>
        </div>
      ))}
    </div>
  )
}

// Exported for `SubtaskDetail.tsx` — the subtask-scoped sibling of this component reuses these
// small, purely presentational pieces (and `CommentsTab`, further down) unmodified rather than
// duplicating them; see §C.5 of docs/superpowers/specs/2026-09-11-alm-session-linking-ux.md.
export function Stat({ label, value, accent, title }: { label: string; value: string; accent?: boolean; title?: string }) {
  const absent = value === NA
  return (
    <div style={{ minWidth: 76 }} title={title}>
      <div style={microLabel}>{label}</div>
      <div style={{
        fontSize: 17, fontWeight: 650, fontVariantNumeric: 'tabular-nums',
        color: absent ? 'var(--text-tertiary)' : accent ? 'var(--anthropic-orange)' : 'var(--text-primary)',
      }}>{value}</div>
    </div>
  )
}

function Caveats({ r }: { r: AttemptRollup }) {
  const lines: string[] = []
  if (r.sessionsLinked < r.sessionsUsed) {
    lines.push(`cost covers ${r.sessionsLinked} of ${r.sessionsUsed} sessions — ${r.provenance.none} with no conversation link`)
  }
  if (r.costMeasuredSessions > 0 && r.costEstimatedSessions > 0) {
    lines.push(`${r.costMeasuredSessions} measured, ${r.costEstimatedSessions} estimated`)
  }
  if ((r.costUnpricedSessions ?? 0) > 0) lines.push(`${r.costUnpricedSessions} with usage of a model that has no price (+ unpriced usage / + uso sem preço) — the cost is a floor`)
  if (r.mixedCurrency) lines.push('mixes dollars and Copilot credits — there is no single total')
  if (lines.length === 0) return null
  return (
    <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
      {lines.map(l => <div key={l}>{l}</div>)}
    </div>
  )
}

export function Rollup({ r, lang }: { r: AttemptRollup; lang: Lang }) {
  const fmt = useMoney()
  const copy = boardCopy(lang)
  const money = r.mixedCurrency || (r.credits !== null && r.costUSD === null)
    ? `${r.credits!.premiumRequests} req`
    : fmt(r.costUSD, r.costByHarness)
  return (
    <>
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
        <Stat label={copy.cost} value={money} accent />
        <Stat label={copy.yourPrompts} value={fmtInt(r.rounds)} title={copy.yourPromptsTitle} />
        <Stat label={copy.sessions} value={String(r.sessionsUsed)} />
        <Stat label={copy.tokens} value={fmtTokens(r.tokens)} />
        <Stat label={copy.active} value={r.activeMinutes === null ? NA : `${r.activeMinutes}m`} />
      </div>
      <Caveats r={r} />
    </>
  )
}
function Bar({ label, value, of, color }: { label: string; value: number | null; of: number; color: string }) {
  const pct = value === null || of === 0 ? 0 : Math.round((value / of) * 100)
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ fontSize: 11.5, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
        <span style={{ ...numeric, fontSize: 11.5, flexShrink: 0 }}>{fmtTokens(value)}</span>
      </div>
      <div style={{ height: 5, borderRadius: 3, background: 'var(--bg-elevated)' }}>
        <div style={{ width: `${pct}%`, height: '100%', borderRadius: 3, background: color }} />
      </div>
    </div>
  )
}

function AttemptCard({ a, lang }: { a: AttemptView; lang: Lang }) {
  const copy = boardCopy(lang)
  const cfg = a.config
    ? [a.config.model, a.config.effort, a.config.method].filter(Boolean).join(' · ')
    : ''
  // `a.label` is a real, user-typed configuration name EXCEPT for the server's own sentinel for
  // a session filed with no named attempt at all — that one sentence is the one attempt label
  // this file may translate, the same way `statusLabel` translates a closed set of status ids
  // and leaves anything else exactly as the server sent it.
  const label = a.label === 'no attempt named' ? copy.noAttemptNamed : a.label
  const status = a.status === 'unattributed' ? copy.unattributed : a.status
  return (
    <div style={{ ...surface, padding: 13, minWidth: 0, display: 'grid', gap: 9 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{label}</span>
        {a.config && <span style={pill(harnessColor(a.config.harness))}>{a.config.harness}</span>}
        <span style={pill()}>{status}</span>
      </div>
      {cfg && <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{cfg}</div>}
      <Rollup r={a.rollup} lang={lang} />
    </div>
  )
}

/**
 * The task's sessions, joined against the LIVE fleet.
 *
 * The join happens here rather than on the server because the fleet is a 5s refcounted poll every
 * surface already shares: asking the task route to embed it would give the board a second, slower
 * copy of the same truth, and the two would disagree by a poll interval — which people report as
 * flicker. A row the fleet does not carry keeps its stored facts and says the state is unknown,
 * rather than claiming it finished.
 */
function SessionsTab({ detail }: { detail: TaskDetail }) {
  const money = useMoney()
  const { fleet } = useFleet('en')
  const live = useMemo(
    () => new Map((fleet.sessions ?? []).map(r => [r.id, r])),
    [fleet.sessions],
  )
  if (detail.sessions.length === 0) {
    return (
      <div style={{ ...surface, padding: 14, fontSize: 12.5, color: 'var(--text-tertiary)' }}>
        No session is filed under this task yet.
      </div>
    )
  }
  return (
    <div style={{ ...surface, overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 680 }}>
        <thead>
          <tr>{['Session', 'State', 'Harness', 'Where', 'Your prompts', 'Tokens', 'Cost', ''].map((h, i) => (
            <th key={i} style={{ ...microLabel, textAlign: 'left', padding: '8px 10px', fontWeight: 600 }}>{h}</th>
          ))}</tr>
        </thead>
        <tbody>
          {detail.sessions.map(row => {
            const l = live.get(row.id)
            const st = l ? SESSION_STATE[l.state] : undefined
            return (
              <tr key={row.id} style={{ borderTop: '1px solid var(--border)' }}>
                <td style={{ padding: '8px 10px', fontSize: 12.5, color: 'var(--text-primary)' }}>
                  {l?.title ?? row.label ?? row.id}
                </td>
                <td style={{ padding: '8px 10px' }}>
                  {st
                    ? <span style={pill(st.color)}>{st.label}</span>
                    // The fleet does not carry it: that is "we cannot see it now", not "it finished".
                    : <span style={pill()}>
                      {row.historical ? 'historical' : row.native ? 'native' : row.endedAt ? 'finished' : 'not in fleet'}
                    </span>}
                </td>
                <td style={{ padding: '8px 10px' }}><span style={pill(harnessColor(row.harness))}>{row.harness}</span></td>
                <td style={{ padding: '8px 10px', fontSize: 12, color: 'var(--text-tertiary)' }}>
                  {row.cwd.split('/').slice(-2).join('/')}
                </td>
                <td style={{ padding: '8px 10px', ...numeric }}>{fmtInt(row.rounds)}</td>
                <td style={{ padding: '8px 10px', ...numeric }}>{fmtTokens(row.tokens)}</td>
                <td style={{ padding: '8px 10px', ...numeric }}>{money(row.costUSD, row.costUSD === null ? null : { [row.harness]: row.costUSD })}</td>
                <td style={{ padding: '8px 10px' }}>
                  {/* A historical conversation has no session to open — its id names nothing the
                      Sessions workspace holds, so it gets no link rather than one that 404s. */}
                  {row.historical ? (
                    <span
                      title="Historical conversation: its numbers count here, but there is no session to open."
                      style={{ fontSize: 11.5, color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}
                    >no session</span>
                  ) : (
                  <a
                    href={sessionPath(row.id)}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5,
                      color: 'var(--anthropic-orange)', textDecoration: 'none', whiteSpace: 'nowrap',
                    }}
                  >Open <ExternalLink size={12} /></a>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/**
 * The comment thread.
 *
 * A comment can be corrected and it can be withdrawn — a board where a wrong note is permanent is
 * one people stop writing on. The EDIT changes the body only: `author` and `createdAt` are the
 * record of who said it and when, and rewriting either would turn a correction into a forgery.
 */
/**
 * A comment's body, with its attachments painted where they were written.
 *
 * A reference whose file is GONE renders as its NAME in plain text — never a broken image (which
 * reads as a failed load) and never silence (which would erase the fact that something was
 * attached). The same N/A-versus-a-confident-blank rule the dashboard applies to metrics.
 */
function CommentBody({ body, files }: { body: string; files: TaskFile[] }) {
  const parts = parseCommentBody(body)
  const known = new Set(files.map(f => f.id))
  const images = parts
    .filter((p): p is Extract<CommentPart, { kind: 'file' }> => p.kind === 'file')
    .filter(p => known.has(p.id) && looksLikeImage(p.name))
  const [lightbox, setLightbox] = useState<string | null>(null)

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {/* `.ag-chat-md` is the same markdown stylesheet ChatBubble uses — one set of rules for
          headings/lists/links/emphasis rather than a second copy for board text. Font size and
          colour are overridden inline (a description reads smaller than a chat bubble); the class
          supplies everything else (paragraph/list spacing, link colour, bold/italic/quote/rule). */}
      <div className="ag-chat-md" style={{ fontSize: 12.5, lineHeight: 1.6, color: 'var(--text-secondary)' }}>
        {parts.map((part, i) => {
          if (part.kind === 'text') {
            return part.text.trim() === ''
              ? null
              : <ReactMarkdown key={i} remarkPlugins={[remarkGfm, remarkBreaks]}>{part.text}</ReactMarkdown>
          }
          if (!known.has(part.id)) {
            return (
              <span key={i} style={{ ...microLabel, textTransform: 'none', letterSpacing: 0 }}>
                {part.name} (removed)
              </span>
            )
          }
          if (looksLikeImage(part.name)) return null
          return (
            <a
              key={i} href={fileUrl(part.id)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
            >{looksLikeVideo(part.name) ? <FileVideo size={12} /> : <FileText size={12} />} {part.name}</a>
          )
        })}
      </div>
      {images.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {images.map((img, i) => (
            <img
              key={i} src={fileUrl(img.id)} alt={img.name}
              onClick={() => setLightbox(img.id)}
              style={{
                maxWidth: 240, maxHeight: 180, objectFit: 'cover', cursor: 'zoom-in',
                borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
              }}
            />
          ))}
        </div>
      )}
      {lightbox && createPortal(
        <div
          onClick={() => setLightbox(null)}
          style={{
            position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.86)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 18,
          }}
        >
          <img src={fileUrl(lightbox)} alt="" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
        </div>,
        document.body,
      )}
    </div>
  )
}

/**
 * The explicit "attach a file" control — beside paste and drag-and-drop, never a replacement for
 * them. Not every input device can paste a file (a phone's on-screen keyboard has no
 * clipboard-file gesture), so the button is the one path that always works.
 */
function AttachButton({ onFiles, disabled, accept }: {
  onFiles: (files: File[]) => void
  disabled?: boolean
  /** Same shape as the native `accept` attribute — narrows the OS file picker, not a guarantee:
      drag-and-drop and paste bypass it, so the real filter still runs in `onFiles`. */
  accept?: string
}) {
  const isMobile = useIsMobile()
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <>
      <input
        ref={inputRef} type="file" multiple disabled={disabled} accept={accept}
        style={{ display: 'none' }}
        onChange={e => {
          const files = Array.from(e.target.files ?? [])
          // Reset so picking the SAME file twice in a row still fires `onChange`.
          e.target.value = ''
          if (files.length > 0) onFiles(files)
        }}
      />
      <button
        type="button" disabled={disabled} onClick={() => inputRef.current?.click()}
        title="Attach a file"
        style={{ ...button(isMobile), padding: isMobile ? undefined : '0 10px', flexShrink: 0 }}
      ><Paperclip size={13} /></button>
    </>
  )
}

/** A pending attachment, shown as a chip — the same shape a comment draft and the description
    editor both need, so the row is drawn once. */
function AttachmentChips({ attached, onRemove }: {
  attached: readonly CommentAttachment[]
  onRemove: (id: string) => void
}) {
  if (attached.length === 0) return null
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {attached.map(a => (
        <span
          key={a.id}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 6px',
            ...surface, background: 'var(--bg-base)',
          }}
        >
          {looksLikeImage(a.name)
            ? <img src={fileUrl(a.id)} alt={a.name} style={{ width: 34, height: 34, objectFit: 'cover', borderRadius: 4 }} />
            : looksLikeVideo(a.name)
              ? <FileVideo size={14} style={{ color: 'var(--text-tertiary)' }} />
              : <FileText size={14} style={{ color: 'var(--text-tertiary)' }} />}
          <span style={{ fontSize: 11.5, maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {a.name}
          </span>
          <button
            // Unpicking the REFERENCE only: the file stays on the task, where the Files tab can
            // delete it. Removing bytes because a draft changed its mind is a surprise.
            onClick={() => onRemove(a.id)} title="Not on this comment"
            style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', display: 'flex' }}
          ><X size={12} /></button>
        </span>
      ))}
    </div>
  )
}

/**
 * A description is read far more than it is written — one card at the top of every tab — so it is
 * bounded on both axes a chat message is not: a length (prose stays a description and never
 * becomes the story of the delivery, which belongs in comments/subtasks/activity) and a small,
 * named set of attachment kinds (one representative screenshot, recording and document, not an
 * evidence dump — that is what the Files tab is for).
 */
const DESCRIPTION_MAX_LENGTH = 4000
const DESCRIPTION_MAX_FILES = 3
const DESCRIPTION_ACCEPT = 'image/*,video/*,application/pdf'

/** Mirrors `DESCRIPTION_ACCEPT` for paste/drop, which never consult the input's `accept` filter. */
function isDescriptionFile(f: File): boolean {
  if (f.type) return f.type.startsWith('image/') || f.type.startsWith('video/') || f.type === 'application/pdf'
  // A dropped file can arrive with an empty `type` (some OS/browser combinations); fall back to
  // the extension rather than rejecting it outright.
  return looksLikeImage(f.name) || looksLikeVideo(f.name) || /\.pdf$/i.test(f.name)
}

/**
 * Splits a description on its own markdown headings — never on prose structure this file has to
 * guess at (bold lead-ins, paragraph breaks). `null` means the text has no heading at all, which is
 * the common case: this task's own description is four paragraphs of **bold** lead-ins and no `#`.
 *
 * Content before the first heading (if any) is the LEAD — read unfolded, because it is usually one
 * or two sentences of framing rather than a section of its own.
 */
const DESCRIPTION_HEADING_RE = /^(#{1,6})\s+(.+)$/

function splitDescriptionHeadings(
  text: string,
): { lead: string; sections: Array<{ title: string; body: string }> } | null {
  const lines = text.split('\n')
  const lead: string[] = []
  const sections: Array<{ title: string; body: string[] }> = []
  let current: { title: string; body: string[] } | null = null
  for (const line of lines) {
    const m = line.match(DESCRIPTION_HEADING_RE)
    if (m) {
      if (current) sections.push(current)
      current = { title: m[2]!.trim(), body: [] }
    } else if (current) {
      current.body.push(line)
    } else {
      lead.push(line)
    }
  }
  if (current) sections.push(current)
  if (sections.length === 0) return null
  return {
    lead: lead.join('\n').trim(),
    sections: sections.map(s => ({ title: s.title, body: s.body.join('\n').trim() })),
  }
}

/** How much of an un-headinged description shows before the reader has to ask for more. */
const DESCRIPTION_PREVIEW_LINES = 3

/**
 * A description with no heading to fold by — the common case — becomes ONE collapsed block: a
 * short preview plus a single toggle, never N sections invented from prose structure.
 */
function CollapsedDescription({ body, files, lang }: { body: string; files: TaskFile[]; lang: Lang }) {
  const copy = boardCopy(lang)
  const [expanded, setExpanded] = useState(false)
  const lines = body.split('\n')
  const hasMore = lines.length > DESCRIPTION_PREVIEW_LINES
  if (!hasMore) return <CommentBody body={body} files={files} />
  const shown = expanded ? body : lines.slice(0, DESCRIPTION_PREVIEW_LINES).join('\n')
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <CommentBody body={shown} files={files} />
      <button
        onClick={() => setExpanded(v => !v)}
        style={{
          justifySelf: 'start', background: 'none', border: 'none', cursor: 'pointer', padding: 0,
          fontSize: 11.5, fontWeight: 600, color: 'var(--anthropic-orange)',
        }}
      >{expanded ? copy.showLessDescription : copy.showAllDescription}</button>
    </div>
  )
}

/**
 * The description's READ-ONLY presentation. Editing (below) always works on the whole string as
 * one textarea — folding is how the same text is DISPLAYED, never a second data model.
 */
function DescriptionView({ body, files, lang }: { body: string; files: TaskFile[]; lang: Lang }) {
  const split = useMemo(() => splitDescriptionHeadings(body), [body])
  if (!split) return <CollapsedDescription body={body} files={files} lang={lang} />
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {split.lead && <CommentBody body={split.lead} files={files} />}
      {split.sections.map((s, i) => (
        <RailSection key={i} id={`description-section-${i}`} title={s.title} defaultOpen={i === 0}>
          <CommentBody body={s.body} files={files} />
        </RailSection>
      ))}
    </div>
  )
}

/**
 * The delivery's DESCRIPTION — what the whole thing is for, editable the same way a comment is
 * written: plain text plus files pasted, dropped or attached into it. `Task.detail` already carried
 * this shape (see `commentBody.ts`); it just had no editor, so the field could be set once at
 * creation and never touched again.
 */
function DescriptionEditor({ id, task, files, lang, onSaved }: {
  id: string
  task: TaskListRow['task']
  files: TaskFile[]
  lang: Lang
  onSaved: (detail: string) => void | Promise<void>
}) {
  const isMobile = useIsMobile()
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(task.detail ?? '')
  const [attached, setAttached] = useState<CommentAttachment[]>([])
  const [dropping, setDropping] = useState(false)
  const [busy, setBusy] = useState(false)
  const room = DESCRIPTION_MAX_FILES - attached.length

  const take = (fl: File[]) => {
    // Silently DROP what does not fit rather than refuse the whole batch — pasting a screenshot
    // alongside a stray text selection should keep the screenshot, and a caller cannot be expected
    // to pre-filter to exactly what this one field accepts.
    const accepted = fl.filter(isDescriptionFile).slice(0, room)
    if (accepted.length === 0) return
    setBusy(true)
    void (async () => {
      const minted: CommentAttachment[] = []
      for (const f of accepted) {
        // A screenshot on the clipboard has no filename; mint one from the moment so the record
        // never carries an empty name, which renders as a blank you cannot tell from a broken one.
        const named = f.name && f.name !== 'image.png'
          ? f
          : new File([f], `paste-${new Date().toISOString().replace(/[:.]/g, '-')}.${(f.type.split('/')[1] || 'bin')}`, { type: f.type })
        const fileId = await uploadFile(id, named, 'you')
        if (fileId) minted.push({ id: fileId, name: named.name })
      }
      if (minted.length > 0) setAttached(a => [...a, ...minted])
      setBusy(false)
    })()
  }

  if (!editing) {
    return task.detail
      ? (
        <div style={{ ...surface, padding: 14, display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <DescriptionView body={task.detail} files={files} lang={lang} />
          </div>
          <button
            onClick={() => { setText(task.detail ?? ''); setAttached([]); setEditing(true) }}
            title="Edit description"
            style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', display: 'flex', flexShrink: 0 }}
          ><Pencil size={13} /></button>
        </div>
      )
      : (
        <button
          style={{ ...button(isMobile), justifySelf: 'start' }}
          onClick={() => { setText(''); setAttached([]); setEditing(true) }}
        ><Plus size={13} /> Add a description</button>
      )
  }

  return (
    <div
      style={{
        ...surface, padding: 13, display: 'grid', gap: 9,
        outline: dropping ? '1px dashed var(--anthropic-orange)' : 'none',
      }}
      onDragOver={e => { e.preventDefault(); setDropping(true) }}
      onDragLeave={() => setDropping(false)}
      onDrop={e => {
        e.preventDefault(); setDropping(false)
        const fl = Array.from(e.dataTransfer?.files ?? [])
        if (fl.length > 0) take(fl)
      }}
    >
      <textarea
        autoFocus
        maxLength={DESCRIPTION_MAX_LENGTH}
        style={{ ...field(isMobile), minHeight: 90, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.6 }}
        value={text}
        placeholder="What is this task for? Markdown works. Paste a file, or attach one."
        onChange={e => setText(e.target.value)}
        onPaste={e => {
          const fl = Array.from(e.clipboardData?.files ?? [])
          if (fl.length === 0) return
          e.preventDefault()
          take(fl)
        }}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: -4 }}>
        <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)' }}>
          Markdown · up to {DESCRIPTION_MAX_FILES} files (image, video or PDF)
        </span>
        {/* Read as a countdown once it starts to matter — a bare running total nobody is close to
            is one more number on the screen, not information. */}
        <span style={{
          fontSize: 10.5, fontVariantNumeric: 'tabular-nums', flexShrink: 0,
          color: text.length >= DESCRIPTION_MAX_LENGTH
            ? 'var(--accent-red)'
            : text.length >= DESCRIPTION_MAX_LENGTH * 0.9 ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
        }}>{text.length} / {DESCRIPTION_MAX_LENGTH}</span>
      </div>
      <AttachmentChips attached={attached} onRemove={fid => setAttached(a => a.filter(x => x.id !== fid))} />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <AttachButton disabled={busy || room <= 0} onFiles={take} accept={DESCRIPTION_ACCEPT} />
        <span style={{ flex: 1 }} />
        <button
          style={button(isMobile, 'primary')} disabled={busy}
          onClick={() => void (async () => {
            await onSaved(bodyWithAttachments(text, attached))
            setEditing(false)
          })()}
        >Save</button>
        <button style={button(isMobile)} onClick={() => setEditing(false)}>Cancel</button>
      </div>
    </div>
  )
}

/**
 * One comment THREAD — the task's (`target` absent/null), a subtask GROUP's or a subtask's.
 *
 * Which comments a thread shows is `commentThread` (`@agentistics/core`), the one rule every
 * surface reads: it looks DOWNWARD only — a subtask shows its own, a group its own plus its
 * members' (each labelled with the member it lives on), the task everything (labelled by target).
 * Writing always lands on THIS thread's own target, so a reply typed in a group's thread is a
 * comment on the group; the label on a member's comment is what keeps that from misleading anyone.
 */
export function CommentsTab({ id, detail, onChanged, target, lang = 'en', looseOnly }: {
  id: string
  detail: TaskDetail
  onChanged: () => Promise<void> | void
  /** The subtask or group whose thread this is; absent/null = the task. */
  target?: string | null
  lang?: Lang
  /** Only comments in NO topic thread — the "loose comments" bucket beside the thread inbox. */
  looseOnly?: boolean
}) {
  const isMobile = useIsMobile()
  const pt = lang === 'pt'
  const threadId = target ?? null
  const entries = commentThread(looseOnly ? detail.comments.filter(c => !c.threadId) : detail.comments, detail.subtasks, threadId)
  const owner = threadId ? detail.subtasks.find(s => s.id === threadId) : undefined
  /** The server's own sentence when a write was refused (e.g. the subtask was deleted meanwhile). */
  const [refusal, setRefusal] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [attached, setAttached] = useState<ChatAttachmentRef[]>([])
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /**
   * Which EXISTING comments are showing their body — collapsed by default (product feedback,
   * 2026-09-21: "comentários também devem ser accordions e vêm minimizados por padrão apenas com
   * o início do comentário quem fez e quando"), so a long thread reads as a list of who-and-when
   * until the reader picks one to open. Never persisted, same reasoning as the subtask-group
   * accordion above it in this pass: a fresh mount of this tab starts every comment closed again.
   * The DRAFT composer at the foot of the list is unaffected — this only folds what was already said.
   */
  const [expandedComments, setExpandedComments] = useState<Set<string>>(new Set())
  const toggleComment = (cid: string) => setExpandedComments(prev => {
    const next = new Set(prev)
    next.has(cid) ? next.delete(cid) : next.add(cid)
    return next
  })

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); await fn(); await onChanged(); setBusy(false)
  }

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {entries.length === 0 && (
        <div style={{ ...surface, padding: 14, fontSize: 12.5, color: 'var(--text-tertiary)' }}>
          {owner
            ? (pt ? `Nada dito sobre “${owner.title}” ainda. Assistentes também podem escrever aqui, pela API.`
              : `Nothing said about “${owner.title}” yet. Assistants can write here too, over the API.`)
            : (pt ? 'Nada dito ainda. Assistentes também podem escrever aqui, pela API.'
              : 'Nothing said yet. Assistants can write here too, over the API.')}
        </div>
      )}
      {entries.map(({ comment: c, via }) => {
        const mine = editing?.id === c.id
        // Editing a comment always shows it — collapsing what you are actively rewriting would
        // hide your own draft the moment you started it.
        const open = mine || expandedComments.has(c.id)
        return (
          <div key={c.id} id={commentAnchor(c.id)} style={{ ...surface, padding: 13 }}>
            {/* The collapsed row IS the toggle: who commented and when, nothing else, until it is
                opened. A `<div>` rather than a `<button>` — the Edit/Delete controls sit inside it
                and a button may not nest inside another button. */}
            <div
              role="button"
              tabIndex={0}
              aria-expanded={open}
              onClick={() => toggleComment(c.id)}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleComment(c.id) } }}
              style={{
                display: 'flex', gap: 8, alignItems: 'center', marginBottom: open ? 6 : 0,
                cursor: 'pointer', minHeight: isMobile ? 44 : undefined,
              }}
            >
              {open
                ? <ChevronDown size={13} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
                : <ChevronRight size={13} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />}
              <span style={pill('var(--accent-blue)')}>{c.author}</span>
              {/* Where this comment LIVES, when that is not this thread — a member's comment read
                  from its group, or a subtask's read from the task. */}
              {via && via.id !== null && (
                <span
                  title={via.title}
                  style={{
                    ...pill('var(--text-tertiary)'), maxWidth: isMobile ? 120 : 220,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}
                >{via.kind === 'group' ? (pt ? 'grupo · ' : 'group · ') : ''}{via.title}</span>
              )}
              <span style={{ ...microLabel, textTransform: 'none', letterSpacing: 0 }}>
                {new Date(c.createdAt).toLocaleString()}
              </span>
              <span style={{ flex: 1 }} />
              {open && !mine && (
                <>
                  {/* Icon-only — `.ag-tap-icon` projects the mobile 44px hit area without
                      painting a 44x44 square onto this thin header row. */}
                  <button
                    onClick={e => { e.stopPropagation(); setEditing({ id: c.id, body: c.body }) }} disabled={busy}
                    title="Edit" className="ag-tap-icon"
                    style={{
                      background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}
                  ><Pencil size={13} /></button>
                  <button
                    onClick={e => { e.stopPropagation(); setRemoving(c.id) }}
                    disabled={busy} title="Delete" className="ag-tap-icon"
                    style={{
                      background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}
                  ><Trash2 size={13} /></button>
                </>
              )}
            </div>
            {open && (mine
              ? (
                <div style={{ display: 'grid', gap: 8 }}>
                  <textarea
                    autoFocus
                    style={{ ...field(isMobile), minHeight: 72, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.6 }}
                    value={editing.body}
                    onChange={e => setEditing({ id: c.id, body: e.target.value })}
                  />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      style={button(isMobile, 'primary')} disabled={busy || !editing.body.trim()}
                      onClick={() => void run(async () => {
                        await editComment(id, c.id, editing.body)
                        setEditing(null)
                      })}
                    >Save</button>
                    <button style={button(isMobile)} onClick={() => setEditing(null)}>Cancel</button>
                  </div>
                </div>
              )
              : (
                <>
                  {c.body && <CommentBody body={c.body} files={detail.files} />}
                  <CommentAttachments attachments={c.attachments ?? []} lang={lang} />
                </>
              ))}
          </div>
        )
      })}

      <CommentComposer
        lang={lang}
        value={draft}
        onChange={setDraft}
        attachments={attached}
        onAttachments={setAttached}
        busy={busy}
        refusal={refusal}
        sticky
        mentions={{ sessions: sessionCandidates(detail.sessions), comments: commentCandidates(detail.comments) }}
        ariaLabel={owner ? (pt ? `Comentar em ${owner.title}` : `Comment on ${owner.title}`) : (pt ? 'Comentar na tarefa' : 'Comment on the task')}
        placeholder={owner
          ? (pt ? `Comentar em “${owner.title}” — ou colar um arquivo` : `Comment on “${owner.title}” — or paste a file`)
          : (pt ? 'Escreva um comentário, ou cole um arquivo — um assistente também pode, pela API'
            : 'Write a comment, or paste a file — an assistant can too, over the API')}
        submitLabel={pt ? 'Comentar' : 'Comment'}
        onSubmit={() => void run(async () => {
          const res = await addComment(id, 'you', draft, threadId, attached)
          if (res.ok) { setDraft(''); setAttached([]); setRefusal(null); return }
          // Kept: the draft stays in the box, and the server's sentence says why it did not land.
          setRefusal(res.message ?? (pt ? 'O comentário não foi salvo.' : 'The comment was not saved.'))
        })}
      />
        <ConfirmModal
          open={removing !== null}
          title="Delete this comment?"
          message="It goes for everyone reading this task. Its attachments are removed from the comment, not from disk."
          confirmLabel="Delete"
          cancelLabel="Cancel"
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            const target = removing
            setRemoving(null)
            if (target) void run(() => removeComment(id, target))
          }}
        />
    </div>
  )
}

export type DeliveryTab = 'threads' | 'overview' | 'sessions' | 'comments' | 'subtasks' | 'files' | 'activity' | 'about'

export interface DeliveryDetailProps {
  id: string
  detail: TaskDetail
  lang: Lang
  /** Re-read the delivery after a write. The CALLER owns the fetch — see `useTaskDetail`. */
  reload: () => void | Promise<void>
  /** One column, for the session aside. Layout only; every control is present either way. */
  dense?: boolean
  /** Deleting the delivery leaves the caller with nothing to draw. Absent = no delete offered. */
  onDeleted?: () => void
  /** Controlled tab — the page's hero has an "About" button that must reach the same state. */
  tab?: DeliveryTab
  onTabChange?: (t: DeliveryTab) => void
}

export function DeliveryDetail({ id, detail, lang, reload, dense, onDeleted, tab: tabProp, onTabChange }: DeliveryDetailProps) {
  const isMobile = useIsMobile()
  const navigate = useNavigate()
  // The full page opens on the CONVERSATIONS (owner's choice, 2026-10-04); the dense panel in the
  // session aside keeps opening on the figures, which is what it is read for.
  const [innerTab, setInnerTab] = useState<DeliveryTab>(dense ? 'overview' : 'subtasks')
  const tab = tabProp ?? innerTab
  const setTab = onTabChange ?? setInnerTab
  const [, setBusy] = useState(false)
  /** A subtask's or group's comment thread, opened from its row in the Subtasks tab. */
  const [subThread, setSubThread] = useState<{ id: string; title: string } | null>(null)
  /** Set when a subtask's own `blockedBy` refused an attach — see `task-attach.ts`. */
  const [subtaskBlocked, setSubtaskBlocked] = useState<
    { subtaskId: string; sessionId: string; blockedBy: string[] } | null
  >(null)
  // The board's LIVE status list — fetched here rather than threaded from every caller (the page
  // and the session aside's Task tab both mount this component fresh).
  const { statuses } = useTaskStatuses()

  // FIRING a staged session — the one shared implementation (`useStagedFire`); a refused filing
  // reuses the EXACT dialog the ordinary session-filing flow already opens for this delivery.
  const fire = useStagedFire(lang, b => setSubtaskBlocked({ subtaskId: b.subtaskId, sessionId: b.sessionId, blockedBy: b.blockedBy }))
  const startFire = (t: Subtask) => fire.startFire({ taskId: id, subtask: t, files: detail.files, reload })
  const preparingFire = fire.preparingId

  const run = async (fn: () => Promise<unknown>) => { setBusy(true); await fn(); await reload(); setBusy(false) }
  const stats = detail.stats
  const duration = fmtDuration(stats.deliveryMs)
  const topTokens = Math.max(...stats.models.map(m => m.tokens ?? 0), ...stats.harnesses.map(h => h.tokens ?? 0), 1)
  const oneColumn = dense === true || isMobile

  const copy = boardCopy(lang)
  const tc = threadCopy(lang)
  const threadInboxCount = (detail.threads ?? []).length
  // The full page: conversations first, the description and the plan behind "About". The dense
  // panel keeps its old shape plus the loose comments tab, since it has no room for a thread view.
  const TABS: Array<[DeliveryTab, string, number]> = dense
    ? [
      ['overview', copy.tabs.overview, 0],
      ['sessions', copy.tabs.sessions, detail.sessions.length],
      ['comments', copy.tabs.comments, detail.comments.length],
      ['subtasks', copy.tabs.subtasks, detail.subtasks.length],
      ['files', copy.tabs.files, detail.files.length],
      ['activity', copy.tabs.activity, 0],
    ]
    : [
      ['subtasks', copy.tabs.subtasks, detail.subtasks.length],
      ['threads', tc.tabThreads, threadInboxCount],
      ['sessions', copy.tabs.sessions, detail.sessions.length],
      ['overview', tc.tabMetrics, 0],
      ['files', copy.tabs.files, detail.files.length],
      ['activity', copy.tabs.activity, 0],
      ['about', tc.tabAbout, 0],
    ]
  const descriptionEditor = (
    <DescriptionEditor
      id={id}
      task={detail.task}
      files={detail.files}
      lang={lang}
      onSaved={next => run(() => editTask(id, { detail: next }))}
    />
  )

  return (
    <>
      <div style={{ display: 'grid', gap: 12, minWidth: 0 }}>
          {dense && descriptionEditor}

          {/*
           * The session aside has no hero, so the task's header chips (status, priority, dates,
           * links, blockers, delete) stand above its tabs. On the page they are in `TaskHero`.
           */}
          {dense && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <TaskChips
                  id={id} detail={detail} lang={lang} statuses={statuses} reload={reload}
                  onFileSession={() => setTab('subtasks')}
                />
              </div>
              {onDeleted && <TaskMoreMenu id={id} task={detail.task} lang={lang} onDeleted={onDeleted} />}
            </div>
          )}

          {/*
           * UNDERLINE tabs (owner's choice, 2026-10-04): transparent, quiet text, and the brand
           * accent ONLY on the active tab's bottom edge — the orange-filled bar made the page's
           * loudest colour the one thing that never changes what you are looking at. The count is a
           * badge, not a suffix. On a phone the row scrolls sideways and each tab is a 44px target.
           */}
          <div
            role="tablist"
            style={{
              display: 'flex', gap: 2, overflowX: 'auto', borderBottom: '1px solid var(--border)',
              scrollbarWidth: 'none',
            }}
          >
            {TABS.map(([key, label, count]) => {
              const active = tab === key
              return (
                <button
                  key={key} role="tab" aria-selected={active} onClick={() => setTab(key)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
                    height: isMobile ? 44 : 36, padding: '0 12px', border: 'none',
                    borderBottom: `2px solid ${active ? 'var(--anthropic-orange)' : 'transparent'}`,
                    marginBottom: -1, background: 'transparent',
                    cursor: 'pointer', fontFamily: 'inherit', fontSize: 13,
                    fontWeight: active ? 600 : 500, whiteSpace: 'nowrap',
                    color: active ? 'var(--text-primary)' : 'var(--text-tertiary)',
                    transition: 'color 0.15s, border-color 0.15s',
                  }}
                >
                  {label}
                  {count > 0 && (
                    <span style={{
                      borderRadius: 999, background: 'var(--ag-tint-3)', color: 'var(--text-secondary)',
                      fontSize: 10.5, fontWeight: 600, padding: '1px 7px', fontVariantNumeric: 'tabular-nums',
                    }}>{count}</span>
                  )}
                </button>
              )
            })}
          </div>

          {tab === 'overview' && (
            <>
              <div style={{ ...surface, padding: 14 }}>
                <div style={{ ...microLabel, marginBottom: 9 }}>{copy.wholeDelivery}</div>
                <Rollup r={detail.rollup} lang={lang} />
              </div>
              {/*
               * The evidence that used to live in the rail's "ENTREGA"/"TOKENS" sections — moved
               * here rather than removed. A product owner asked for that duplicate, harder-to-scan
               * area to go, but the numbers it carried (delivery time, agent runs, commits, files,
               * tool errors, lines changed, and the raw token split) are still real facts about the
               * delivery, so they join the metrics area this tab already is instead of vanishing.
               */}
              <div style={{ ...surface, padding: 14, display: 'grid', gap: 10 }}>
                <div style={microLabel}>{copy.delivery}</div>
                <Stat label={copy.deliveryTime} value={duration ?? NA} />
                {duration === null && (
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: -8 }}>{copy.stillOpen}</div>
                )}
                <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
                  <Stat label={copy.agentRuns} value={fmtInt(stats.agentRuns)} />
                  <Stat label={copy.commits} value={fmtInt(stats.commits)} />
                </div>
                <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
                  <Stat label={copy.files} value={fmtInt(stats.filesModified)} />
                  <Stat label={copy.errors} value={fmtInt(stats.toolErrors)} />
                </div>
                <Stat
                  label={copy.lines}
                  value={stats.linesAdded === null && stats.linesRemoved === null
                    ? NA : `+${stats.linesAdded ?? 0} / −${stats.linesRemoved ?? 0}`}
                />
              </div>
              {stats.tokens && (
                <div style={{ ...surface, padding: 14, display: 'grid', gap: 8 }}>
                  <div style={microLabel}>Tokens</div>
                  {([['Input', copy.tokenInput, stats.tokens.input], ['Output', copy.tokenOutput, stats.tokens.output],
                     ['Cache read', copy.tokenCacheRead, stats.tokens.cacheRead],
                     ['Cache write', copy.tokenCacheWrite, stats.tokens.cacheWrite]] as const)
                    .map(([key, label, v]) => (
                      <div key={key} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}>
                        <span style={{ color: 'var(--text-tertiary)' }}>{label}</span>
                        <span style={numeric}>{v.toLocaleString()}</span>
                      </div>
                    ))}
                </div>
              )}
              <div style={{ display: 'grid', gap: 12, gridTemplateColumns: oneColumn ? '1fr' : 'repeat(auto-fit, minmax(230px, 1fr))' }}>
                <div style={{ ...surface, padding: 14, display: 'grid', gap: 9 }}>
                  <div style={microLabel}>{copy.models}</div>
                  {stats.models.length === 0
                    ? <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{copy.noModelReported}</div>
                    : stats.models.map(m => <Bar key={m.key} label={m.key} value={m.tokens} of={topTokens} color="var(--anthropic-orange)" />)}
                </div>
                <div style={{ ...surface, padding: 14, display: 'grid', gap: 9 }}>
                  {/* "Harnesses" is kept untranslated in PT throughout the app (e.g. BackupSettings) — a
                      technical term, not an English leftover. */}
                  <div style={microLabel}>Harnesses</div>
                  {stats.harnesses.map(h => (
                    <Bar key={h.key} label={h.key} value={h.tokens} of={topTokens} color={harnessColor(h.key)} />
                  ))}
                </div>
              </div>
              <div>
                <div style={{ ...microLabel, marginBottom: 8 }}>{copy.attemptsHeader}</div>
                <div style={{ display: 'grid', gap: 12, gridTemplateColumns: oneColumn ? '1fr' : 'repeat(auto-fit, minmax(260px, 1fr))' }}>
                  {detail.attempts.map(a => <AttemptCard key={a.id ?? 'loose'} a={a} lang={lang} />)}
                </div>
              </div>
            </>
          )}

          {tab === 'threads' && (
            <div style={isMobile ? { margin: '0 -12px' } : undefined}>
              <ThreadsPanel
                id={id}
                detail={detail}
                lang={lang}
                reload={reload}
                renderBody={c => <CommentBody body={c.body} files={detail.files} />}
                loose={<CommentsTab id={id} detail={detail} onChanged={reload} lang={lang} looseOnly />}
              />
            </div>
          )}

          {tab === 'about' && descriptionEditor}

          {tab === 'sessions' && <SessionsTab detail={detail} />}

          {tab === 'comments' && <CommentsTab id={id} detail={detail} onChanged={reload} lang={lang} />}

          {tab === 'subtasks' && (
            <SubtaskTable
              comments={detail.comments}
              onOpenComments={t => setSubThread({ id: t.id, title: t.title })}
              subtasks={detail.subtasks}
              sessions={detail.sessions}
              subtaskRollups={detail.subtaskRollups}
              lang={lang}
              statuses={statuses}
              onAdd={title => run(() => addSubtask(id, title))}
              onPatch={async (sid, patch) => {
                // Same shape as `run()`, but the RESULT reaches the caller — `SubtaskTable` needs
                // it to catch `done_needs_session`/`invalid_group`/`subtask_has_sessions`/
                // `group_field_conflict` and act on it instead of swallowing the refusal.
                setBusy(true)
                const result = await patchSubtask(id, sid, patch)
                await reload()
                setBusy(false)
                return result
              }}
              onRemove={sid => run(() => removeSubtask(id, sid))}
              onCreateGroup={async title => {
                // Same shape as `onPatch` above — the group menu needs the minted id back, and a
                // failure here (a bad ref) is reported the same way any other refusal is.
                setBusy(true)
                const newId = await addSubtask(id, title, { isGroup: true })
                await reload()
                setBusy(false)
                return newId
              }}
              onAttach={async (subtaskId, sessionId) => {
                setBusy(true)
                const result = await attachSession(id, sessionId, subtaskId)
                setBusy(false)
                if (!result.ok && result.reason === 'blocked') {
                  setSubtaskBlocked({ subtaskId, sessionId, blockedBy: result.blockedBy ?? [] })
                  return
                }
                await reload()
              }}
              onUnfile={sessionId => run(() => detachSession(id, sessionId))}
              onOpenSession={sid => navigate(sessionPath(sid))}
              taskFiles={detail.files}
              // A reload after — never before — returning the id: the compose wizard's own chip
              // reads `taskFiles` by id (see `StagedSessionCompose.tsx`'s `attached`), and without
              // this the freshly uploaded file uploaded fine (the id is real, the draft can still
              // reference it) but stayed invisible as a chip until some UNRELATED action happened to
              // reload the delivery — the same class of bug `onSaveStagedSession` below already
              // guards against for a saved draft.
              onUploadFile={f => uploadFile(id, f, 'you').then(fid => { void reload(); return fid })}
              onSaveStagedSession={(sid, d) => saveStagedSession(id, sid, d).then(r => { void reload(); return r })}
              onClearStagedSession={sid => run(() => clearStagedSession(id, sid))}
              onFireStagedSession={t => void startFire(t)}
              preparingStagedSessionId={preparingFire}
            />
          )}

          {tab === 'activity' && <ActivityTab id={id} />}

          {tab === 'files' && (
            <TaskFiles
              files={detail.files}
              onUpload={f => run(() => uploadFile(id, f, 'you'))}
              onRemove={fid => run(() => deleteFile(fid))}
            />
          )}
      </div>

      {subThread && (
        <CommentThreadDialog
          taskId={id}
          target={subThread.id}
          title={subThread.title}
          lang={lang}
          onClose={() => setSubThread(null)}
          onChanged={reload}
        />
      )}

      {subtaskBlocked && (
        <BlockedSubtaskResolve
          taskId={id}
          blockedSubtaskTitle={detail.subtasks.find(s => s.id === subtaskBlocked.subtaskId)?.title ?? ''}
          blockedBy={subtaskBlocked.blockedBy}
          subtasks={detail.subtasks}
          sessions={detail.sessions}
          lang={lang}
          onCancel={() => setSubtaskBlocked(null)}
          onResolved={async () => {
            // The attach that was refused a moment ago is RETRIED here, not merely dismissed — the
            // thing that was blocking it no longer does, so it now succeeds.
            const { subtaskId, sessionId } = subtaskBlocked
            setSubtaskBlocked(null)
            await run(() => attachSession(id, sessionId, subtaskId))
          }}
        />
      )}

      {fire.element}
    </>
  )
}

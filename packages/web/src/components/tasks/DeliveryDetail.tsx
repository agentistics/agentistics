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
  ChevronDown, ChevronRight, ExternalLink, FileText, FileVideo, Link2, MessageSquare, Paperclip,
  Pencil, Plus, Trash2, X, XCircle,
} from 'lucide-react'
import { PRIORITY_ORDER, composePromptWithPaths, type TaskPriorityId } from '@agentistics/core'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useFleet } from '../../lib/fleet'
import { sessionPath } from '../../lib/sessionRoute'
import { NewSessionModal } from '../sessions/NewSessionModal'
import {
  bodyWithAttachments, looksLikeImage, looksLikeVideo, parseCommentBody,
  type CommentAttachment, type CommentPart,
} from '../../lib/commentBody'
import {
  NA, PRIORITY, SESSION_STATE, button, field, fmtInt, fmtStamp, fmtTokens,
  harnessColor, microLabel, numeric, pill, statusStyle, surface,
} from './board'
import { useMoney } from './money'
import { boardCopy, statusLabel, type Lang } from './copy'
import { BetaTag } from '../BetaTag'
import { BlockedDialog } from './BlockedDialog'
import { DoneNeedsSessionDialog } from './DoneNeedsSessionDialog'
import { RailSection } from './RailSection'
import { StatusChip } from './StatusChip'
import { SubtaskTable } from './SubtaskTable'
import { BlockedSubtaskResolve } from './BlockedSubtaskResolve'
import { StagedSessionLaunchConfirm } from './StagedSessionLaunchConfirm'
import { TaskFiles } from './TaskFiles'
import { TaskProgressBar } from './TaskProgressBar'
import { ConfirmModal, Select } from '../../pages/settings/primitives'
import {
  addComment, addLink, addSubtask, attachSession, clearStagedSession, deleteFile,
  deleteTask, detachSession, editComment, editTask, fileUrl, fmtDuration, materializeStagedAttachments,
  markTask, patchSubtask, removeComment, removeLink, removeSubtask, saveStagedSession, setBlockedBy,
  uploadFile, useTaskActivity, useTaskDetail, useTaskList, useTaskStatuses,
  type AttemptRollup, type AttemptView, type Subtask, type TaskDetail, type TaskFieldPatch,
  type TaskFile, type TaskListRow, type TaskRecord, type TaskStatus,
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

/** `startedAt`/`deliveredAt` are system facts, not a date somebody typed — see their own note on
 *  `Task.startedAt` — so they are read as a full moment (date AND time), the same way the activity
 *  log already reads `TaskEvent.at`, never as a bare `yyyy-MM-dd` day. */
function PlanCard({ task, busy, lang, statuses, onPatch, onStatus }: {
  task: TaskRecord
  busy: boolean
  onPatch: (patch: TaskFieldPatch) => void | Promise<void>
  lang: 'pt' | 'en'
  /** The board's LIVE status list (`lib/tasks.ts`'s `useTaskStatuses`) — `null` while it loads. */
  statuses: ReturnType<typeof useTaskStatuses>['statuses']
  onStatus: (s: TaskStatus) => void | Promise<void>
}) {
  const copy = boardCopy(lang)

  return (
    <div style={{ ...surface, padding: 14, display: 'grid', gap: 11 }}>
      {/*
       * Status and priority as two PICKERS on one row, not two grids of chips.
       *
       * Seven statuses and five priorities as buttons wrapped to four rows and pushed the claim —
       * the control people actually reach for — below the fold. A picker states the current value
       * in one row and costs one click to change, which is the same number of clicks a chip grid
       * costs once you have found it.
       */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 120px', display: 'grid', gap: 5, minWidth: 0 }}>
          <span style={{ ...microLabel, fontSize: 9 }}>Status</span>
          {/* The SAME chip the table cell and the card draw — see `StatusChip`. This rail used to
              have a private copy of the control, which is how one feature came to have two status
              dropdowns that looked and behaved differently. */}
          <StatusChip
            value={task.status}
            lang={lang}
            statuses={statuses}
            {...(busy ? { disabled: true } : {})}
            onPick={(st: string) => void onStatus(st as TaskStatus)}
          />
        </div>
        <div style={{ flex: '1 1 120px', display: 'grid', gap: 5, minWidth: 0 }}>
          <span style={{ ...microLabel, fontSize: 9 }}>{copy.priority}</span>
          <ChipSelect
            value={task.priority ?? 'none'}
            disabled={busy}
            options={PRIORITY_ORDER.map(id => ({
              value: id, label: PRIORITY[id]!.label, color: PRIORITY[id]!.color, dim: PRIORITY[id]!.dim,
            }))}
            onPick={v => void onPatch({ priority: v as TaskPriorityId })}
          />
        </div>
      </div>

      {/*
       * `startedAt`/`deliveredAt` are SYSTEM facts, never a date somebody typed — see
       * `Task.startedAt`'s own note. There is no picker and no clear button here: a product owner
       * asked for these two to be observed, not scheduled, so the card only ever READS them.
       */}
      <div style={{ display: 'grid', gap: 5 }}>
        <span style={{ ...microLabel, fontSize: 9 }}>{copy.dates}</span>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          <span style={{ minWidth: 0 }}>
            <span style={{ ...microLabel, fontSize: 8, display: 'block' }}>{copy.started}</span>
            <span style={{
              fontSize: 12,
              color: task.startedAt ? 'var(--text-secondary)' : 'var(--text-tertiary)',
            }}>{fmtStamp(task.startedAt, lang)}</span>
          </span>
          <span style={{ minWidth: 0 }}>
            <span style={{ ...microLabel, fontSize: 8, display: 'block' }}>{copy.completed}</span>
            <span style={{
              fontSize: 12,
              color: task.deliveredAt ? 'var(--text-secondary)' : 'var(--text-tertiary)',
            }}>{fmtStamp(task.deliveredAt, lang)}</span>
          </span>
        </div>
      </div>

      {task.status === 'blocked' && task.blockedReason && (() => {
        // Asking for the reason and then not showing it would be theatre. It sits under the status
        // it belongs to, in the status's own colour, and goes when the task leaves `blocked`.
        const blockedStyle = statusStyle(statuses, 'blocked')
        return (
          <div style={{
            fontSize: 12, lineHeight: 1.5, padding: '8px 10px', borderRadius: 7,
            background: blockedStyle.dim, color: 'var(--text-secondary)',
            border: `1px solid ${blockedStyle.color}`,
          }}>
            <span style={{ ...microLabel, fontSize: 9, display: 'block', marginBottom: 3, color: blockedStyle.color }}>
              {copy.waitingOn}
            </span>
            {task.blockedReason}
          </div>
        )
      })()}

    </div>
  )
}

/**
 * A value that is a COLOURED WORD, chosen from a short closed list.
 *
 * Not the settings screens' `Select`: this one carries the status/priority colour into the trigger,
 * which is the whole legibility trick the board rests on — you learn a colour once and then read it
 * everywhere without reading the word.
 */
function ChipSelect({ value, options, disabled, onPick }: {
  value: string
  options: Array<{ value: string; label: string; color: string; dim: string }>
  disabled?: boolean
  onPick: (v: string) => void
}) {
  const isMobile = useIsMobile()
  const [open, setOpen] = useState(false)
  const current = options.find(o => o.value === value) ?? options[options.length - 1]!
  return (
    <div style={{ position: 'relative' }}>
      <button
        disabled={disabled}
        onClick={() => setOpen(v => !v)}
        style={{
          width: '100%', boxSizing: 'border-box', cursor: disabled ? 'default' : 'pointer',
          display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'space-between',
          padding: isMobile ? '10px 11px' : '6px 10px', borderRadius: 7,
          border: `1px solid ${current.color}`, background: current.dim, color: current.color,
          fontSize: 12, fontWeight: 600, minHeight: isMobile ? 44 : undefined,
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {current.label}
        </span>
        <ChevronDown size={12} style={{ flexShrink: 0, opacity: 0.8 }} />
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 60 }} />
          <div style={{
            position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 61, marginTop: 4,
            ...surface, background: 'var(--bg-elevated)', padding: 4, display: 'grid', gap: 2,
            boxShadow: 'var(--shadow-elevated)',
          }}>
            {options.map(o => (
              <button
                  // A MENU ROW pays its 44px in PAINT. `.ag-tap` is for controls whose smallness
                  // is their meaning; these sit in a `gap: 2` list, where a projected box covers
                  // the row above and its bottom band selects the row below.
                key={o.value}
                onClick={() => { setOpen(false); if (o.value !== value) onPick(o.value) }}
                style={{
                  border: 'none', cursor: 'pointer', textAlign: 'left', padding: '6px 9px',
                  minHeight: isMobile ? 44 : undefined,
                  borderRadius: 5, background: o.value === value ? o.dim : 'transparent',
                  color: o.color, fontSize: 11.5, fontWeight: 600,
                }}
              >{o.label}</button>
            ))}
          </div>
        </>
      )}
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

/** Links out — a PR, an issue, a doc. Only http(s) reaches here; the server refuses the rest. */
function LinksPanel({ id, task, onChanged, bare }: {
  id: string
  task: TaskListRow['task']
  onChanged: () => Promise<void> | void
  /** Drawn inside a `RailSection`, which already supplies the card and the heading. */
  bare?: boolean
}) {
  const isMobile = useIsMobile()
  const [url, setUrl] = useState('')
  const links = task.links ?? []
  const add = async () => {
    if (!url.trim()) return
    // A GitHub PR/issue URL names its own kind — nobody should have to say it twice.
    const kind = /\/pull\/\d+/.test(url) ? 'pr' : /\/issues\/\d+/.test(url) ? 'issue' : undefined
    await addLink(id, url.trim(), undefined, kind)
    setUrl('')
    await onChanged()
  }
  return (
    <div style={bare ? { display: 'grid', gap: 9 } : { ...surface, padding: 14, display: 'grid', gap: 9 }}>
      {!bare && <div style={microLabel}>Links</div>}
      {links.length === 0 && (
        <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>No PR or document linked.</div>
      )}
      {links.map(l => (
        <div key={l.id} style={{ display: 'flex', gap: 7, alignItems: 'center', minHeight: isMobile ? 34 : 22 }}>
          <Link2 size={13} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
          <a
            href={l.url} target="_blank" rel="noreferrer"
            style={{
              fontSize: 11.5, color: 'var(--anthropic-orange)', textDecoration: 'none',
              flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}
          >{l.label ?? l.url.replace(/^https?:\/\//, '')}</a>
          {l.kind && <span style={pill()}>{l.kind}</span>}
          <button
            onClick={() => void removeLink(id, l.id).then(onChanged)}
            style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', display: 'flex' }}
            title="Remove"
          ><XCircle size={13} /></button>
        </div>
      ))}
      <input
        style={field(isMobile)} value={url} placeholder="Paste a PR or doc URL, then Enter"
        onChange={e => setUrl(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') void add() }}
      />
    </div>
  )
}

/**
 * The blockers, Jira's "is blocked by".
 *
 * A blocker that is already closed is struck through rather than removed: the record of what held
 * the work up is part of the delivery's story, and silently dropping it rewrites that story.
 */
function BlockedBy({ id, task, lang, statuses, onChanged, bare }: {
  id: string
  task: TaskListRow['task']
  lang: Lang
  /** The board's LIVE status list (`lib/tasks.ts`'s `useTaskStatuses`) — `null` while it loads. */
  statuses: ReturnType<typeof useTaskStatuses>['statuses']
  onChanged: () => Promise<void> | void
  /** See `LinksPanel`. */
  bare?: boolean
}) {
  const isMobile = useIsMobile()
  const pt = lang === 'pt'
  const { rows } = useTaskList()
  const [picking, setPicking] = useState(false)
  const blockers = (task.blockedBy ?? [])
    .map(bid => rows?.find(r => r.task.id === bid))
    .filter((r): r is TaskListRow => r !== undefined)
  const openBlockers = blockers.filter(b => b.task.status !== 'done' && b.task.status !== 'abandoned')

  const set = async (ids: string[]) => { await setBlockedBy(id, ids); await onChanged() }

  return (
    <div style={bare ? { display: 'grid', gap: 9 } : { ...surface, padding: 14, display: 'grid', gap: 9 }}>
      {(!bare || openBlockers.length > 0) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {!bare && <span style={microLabel}>Blocked by</span>}
          {openBlockers.length > 0 && (
            <span style={pill('var(--accent-red)')}>{openBlockers.length} open</span>
          )}
        </div>
      )}
      {blockers.length === 0 && (
        <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>Nothing is blocking this.</div>
      )}
      {blockers.map(b => {
        const closed = b.task.status === 'done' || b.task.status === 'abandoned'
        return (
          <div key={b.task.id} style={{ display: 'flex', gap: 8, alignItems: 'center', minHeight: isMobile ? 34 : 22 }}>
            <span style={{
              fontSize: 11.5, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              textDecoration: closed ? 'line-through' : 'none',
              color: closed ? 'var(--text-tertiary)' : 'var(--text-secondary)',
            }}>{b.task.title}</span>
            <span style={pill(statusStyle(statuses, b.task.status).color)}>
              {statusLabel(b.task.status, lang, statuses)}
            </span>
            <button
              onClick={() => void set((task.blockedBy ?? []).filter(x => x !== b.task.id))}
              style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', display: 'flex' }}
              title="Remove"
            ><XCircle size={13} /></button>
          </div>
        )
      })}
      {picking
        ? (
          // The APPLICATION's picker, not the browser's. A bare `<select>` draws the OS menu: it
          // ignores this palette in both themes, it cannot search, and on a phone it is the one
          // control here that misses the 44px target. `Select` is the same control every settings
          // screen uses — searchable once the board has more than a handful of deliveries, which
          // is exactly when picking a blocker by scrolling stops working.
          <Select
            value=""
            placeholder={pt ? 'Escolher uma entrega…' : 'Pick a delivery…'}
            searchPlaceholder={pt ? 'Buscar…' : 'Search…'}
            options={(rows ?? [])
              // A task never blocks itself, and one already listed is not offered twice.
              .filter(r => r.task.id !== id && !(task.blockedBy ?? []).includes(r.task.id))
              .map(r => ({
                value: r.task.id,
                label: r.task.title,
                hint: statusLabel(r.task.status, lang, statuses),
              }))}
            onChange={v => {
              if (v) void set([...(task.blockedBy ?? []), v])
              setPicking(false)
            }}
          />
        )
        : (
          <button style={{ ...button(isMobile), justifySelf: 'start' }} onClick={() => setPicking(true)}>
            <Plus size={13} /> Add blocker
          </button>
        )}
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
                      {row.historical ? 'historical' : row.endedAt ? 'finished' : 'not in fleet'}
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
        placeholder="What is this delivery for? Markdown works. Paste a file, or attach one."
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

export function CommentsTab({ id, detail, onChanged }: {
  id: string
  detail: TaskDetail
  onChanged: () => Promise<void> | void
}) {
  const isMobile = useIsMobile()
  const [dropping, setDropping] = useState(false)
  const [draft, setDraft] = useState('')
  const [attached, setAttached] = useState<CommentAttachment[]>([])
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

  /**
   * A pasted or dropped file lands in the task's Files store AND is held as a pending reference on
   * the comment being written. Uploading without holding the reference is what made a pasted
   * screenshot disappear into the Files tab with nothing tying it to what was being said.
   */
  const take = (files: File[]) => run(async () => {
    const minted: CommentAttachment[] = []
    for (const f of files) {
      // A screenshot on the clipboard has no filename, so one is minted from the moment and the
      // mime type. Without it the record carries an empty name, which renders as a blank row you
      // cannot tell from a broken one.
      const named = f.name && f.name !== 'image.png'
        ? f
        : new File([f], `paste-${new Date().toISOString().replace(/[:.]/g, '-')}.${(f.type.split('/')[1] || 'bin')}`, { type: f.type })
      const fileId = await uploadFile(id, named, 'you')
      if (fileId) minted.push({ id: fileId, name: named.name })
    }
    if (minted.length > 0) setAttached(a => [...a, ...minted])
  })

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {detail.comments.length === 0 && (
        <div style={{ ...surface, padding: 14, fontSize: 12.5, color: 'var(--text-tertiary)' }}>
          Nothing said yet. Assistants can write here too, over the API.
        </div>
      )}
      {detail.comments.map(c => {
        const mine = editing?.id === c.id
        // Editing a comment always shows it — collapsing what you are actively rewriting would
        // hide your own draft the moment you started it.
        const open = mine || expandedComments.has(c.id)
        return (
          <div key={c.id} style={{ ...surface, padding: 13 }}>
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
                <CommentBody body={c.body} files={detail.files} />
              ))}
          </div>
        )
      })}

      <div
        style={{
          ...surface, padding: 13, display: 'grid', gap: 9,
          outline: dropping ? '1px dashed var(--anthropic-orange)' : 'none',
        }}
        onDragOver={e => { e.preventDefault(); setDropping(true) }}
        onDragLeave={() => setDropping(false)}
        onDrop={e => {
          e.preventDefault(); setDropping(false)
          const files = Array.from(e.dataTransfer?.files ?? [])
          if (files.length > 0) void take(files)
        }}
      >
        <textarea
          style={{ ...field(isMobile), minHeight: 76, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.6 }}
          value={draft}
          placeholder="Write a comment, or paste a file — an assistant can too, over the API"
          onChange={e => setDraft(e.target.value)}
          onPaste={e => {
            /*
             * A pasted file becomes an ATTACHMENT on this comment, not text.
             *
             * The paste is only intercepted when the clipboard actually holds a FILE; plain text
             * falls through untouched, or pasting a paragraph would silently upload nothing and
             * swallow the keystroke.
             */
            // `Array.from`, not spread: this lib target types FileList without an iterator.
            const files = Array.from(e.clipboardData?.files ?? [])
            if (files.length === 0) return
            e.preventDefault()
            void take(files)
          }}
        />
        <AttachmentChips attached={attached} onRemove={fid => setAttached(v => v.filter(x => x.id !== fid))} />
        <ConfirmModal
          open={removing !== null}
          title="Delete this comment?"
          message="It goes for everyone reading this task. Any file pasted into it stays on the task — the Files tab is where those are removed."
          confirmLabel="Delete"
          cancelLabel="Cancel"
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            const target = removing
            setRemoving(null)
            if (target) void run(() => removeComment(id, target))
          }}
        />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <AttachButton disabled={busy} onFiles={take} />
          <span style={{ flex: 1 }} />
          <button
            style={button(isMobile, 'primary')}
            disabled={busy || (!draft.trim() && attached.length === 0)}
            onClick={() => void run(async () => {
              await addComment(id, 'you', bodyWithAttachments(draft, attached))
              setDraft(''); setAttached([])
            })}
          >
            <MessageSquare size={14} /> Comment
          </button>
        </div>
      </div>
    </div>
  )
}

export type DeliveryTab = 'overview' | 'sessions' | 'comments' | 'subtasks' | 'files' | 'activity'

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
}

export function DeliveryDetail({ id, detail, lang, reload, dense, onDeleted }: DeliveryDetailProps) {
  const isMobile = useIsMobile()
  const navigate = useNavigate()
  const [tab, setTab] = useState<DeliveryTab>('overview')
  const [busy, setBusy] = useState(false)
  // The board's own dialog, never `window.confirm`: the browser's box carries the page's URL and
  // none of the app's words, and on a phone it is a system sheet that reads as a site error.
  const [confirmDelete, setConfirmDelete] = useState(false)
  /** Set while the task is on its way to `blocked` — see the list view's `toStatus`. */
  const [blocking, setBlocking] = useState(false)
  /** Set when a `done` write refused for having no session filed under this delivery yet. */
  const [doneRefusal, setDoneRefusal] = useState(false)
  /** Set when a subtask's own `blockedBy` refused an attach — see `task-attach.ts`. */
  const [subtaskBlocked, setSubtaskBlocked] = useState<
    { subtaskId: string; sessionId: string; blockedBy: string[] } | null
  >(null)
  // The other tasks, to offer as blockers. The board is small enough that this is the same list the
  // page already loads; a second endpoint for "what could block this" would be a second answer.
  const { rows: boardRows } = useTaskList()
  // The board's LIVE status list — fetched here rather than threaded from every caller (the page
  // and the session aside's Task tab both mount this component fresh), same pattern as `boardRows`
  // just above.
  const { statuses } = useTaskStatuses()

  /**
   * FIRING a staged session (t-918cc82233) — two paths, decided by whether the draft already names
   * BOTH a harness and a folder, exactly the split `SessionsPage.tsx`'s `selectPreset` draws for a
   * `SessionPreset`. `firing` is the direct-launch confirm; `firePrefillFor` opens the ordinary
   * wizard pre-filled with whatever the draft DOES have, seeded to auto-file under this exact
   * subtask once the session exists (`NewSessionModal`'s `initialTaskId`/`initialSubtaskId`).
   */
  const [firing, setFiring] = useState<Subtask | null>(null)
  const [fireBusy, setFireBusy] = useState(false)
  const [fireError, setFireError] = useState<string | null>(null)
  const [firePrefillFor, setFirePrefillFor] = useState<{ subtask: Subtask; prompt: string } | null>(null)
  /** The subtask id whose attachments are being materialized into real paths — a brief round trip
   *  through `/api/fleet/attach`, shown so the fire button does not look inert while it runs. */
  const [preparingFire, setPreparingFire] = useState<string | null>(null)

  async function startFire(t: Subtask) {
    const draft = t.stagedSession
    if (!draft) return
    setFireError(null)
    if (draft.harness && draft.cwd) {
      setFiring(t)
      return
    }
    // The wizard fallback needs the composed prompt UP FRONT: `initialPreset` seeds its textarea
    // once, and the wizard itself has no notion of a staged draft's attachments to weave in later.
    setPreparingFire(t.id)
    const paths = await materializeStagedAttachments(lang, draft.attachmentIds ?? [], detail.files)
    setPreparingFire(null)
    setFirePrefillFor({ subtask: t, prompt: composePromptWithPaths(paths, draft.prompt) })
  }

  async function confirmFire() {
    if (!firing) return
    const t = firing
    const draft = t.stagedSession!
    setFireBusy(true)
    setFireError(null)
    try {
      const paths = await materializeStagedAttachments(lang, draft.attachmentIds ?? [], detail.files)
      const finalPrompt = composePromptWithPaths(paths, draft.prompt)
      // The SAME route the wizard and the preset shelf call (`fleet-spawn.ts`'s `planFleetSpawn`) —
      // never a second, unvalidated path.
      const res = await fetch(`/api/fleet/new?lang=${lang}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          harness: draft.harness,
          cwd: draft.cwd,
          ...(draft.model ? { model: draft.model } : {}),
          ...(draft.effort ? { effort: draft.effort } : {}),
          prompt: finalPrompt,
          label: t.title,
        }),
      })
      const json = await res.json() as { ok: boolean; message: string; id?: string }
      if (!json.ok) {
        setFireError(json.message)
        setFireBusy(false)
        return
      }
      setFiring(null)
      setFireBusy(false)
      if (json.id) {
        // The session EXISTS now — the true first moment its filing can actually be attempted, the
        // same reasoning `NewSessionModal`'s own `subtaskTarget` attach applies. A `blocked` refusal
        // reuses the EXACT dialog the ordinary session-filing flow already opens for this delivery.
        const attach = await attachSession(id, json.id, t.id)
        if (!attach.ok && attach.reason === 'blocked') {
          setSubtaskBlocked({ subtaskId: t.id, sessionId: json.id, blockedBy: attach.blockedBy ?? [] })
        }
        await reload()
        navigate(sessionPath(json.id))
      }
    } catch {
      setFireError(lang === 'pt' ? 'Erro de rede ao falar com esta máquina.' : 'Network error talking to this machine.')
      setFireBusy(false)
    }
  }

  const run = async (fn: () => Promise<unknown>) => { setBusy(true); await fn(); await reload(); setBusy(false) }
  const stats = detail.stats
  const duration = fmtDuration(stats.deliveryMs)
  const topTokens = Math.max(...stats.models.map(m => m.tokens ?? 0), ...stats.harnesses.map(h => h.tokens ?? 0), 1)
  const oneColumn = dense === true || isMobile

  const copy = boardCopy(lang)
  const TABS: Array<[DeliveryTab, string, number]> = [
    ['overview', copy.tabs.overview, 0],
    ['sessions', copy.tabs.sessions, detail.sessions.length],
    ['comments', copy.tabs.comments, detail.comments.length],
    ['subtasks', copy.tabs.subtasks, detail.subtasks.length],
    ['files', copy.tabs.files, detail.files.length],
    ['activity', copy.tabs.activity, 0],
  ]

  return (
    <>
      <div style={{
        display: 'grid', gap: 14,
        // Jira's split: the work on the left, the facts on the right. One column on a phone.
        gridTemplateColumns: oneColumn ? '1fr' : 'minmax(0, 1fr) 280px',
        alignItems: 'start',
      }}>
        <div style={{ display: 'grid', gap: 12, minWidth: 0 }}>
          <DescriptionEditor
            id={id}
            task={detail.task}
            files={detail.files}
            lang={lang}
            onSaved={next => run(() => editTask(id, { detail: next }))}
          />

          {/*
           * A TAB-MENU, not an underline row — a filled pill for the active tab (the same
           * segmented-control shape the Chat/Terminal toggle uses elsewhere in the app), except the
           * active fill is the brand accent rather than a neutral one: this is the ONE place on the
           * board a person picks which part of a delivery they are looking at, so it earns the
           * loudest state in the app's palette. The text on it is the same near-black
           * `button(mobile, 'primary')` already uses on orange, not white — that pairing is the
           * app's own answer to "what reads best on this orange" and a second one here would be a
           * second answer to the same question.
           */}
          <div
            role="tablist"
            style={{
              display: 'flex', gap: 3, padding: 3, borderRadius: 10, overflowX: 'auto',
              background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)',
            }}
          >
            {TABS.map(([key, label, count]) => {
              const active = tab === key
              return (
                <button
                  key={key} role="tab" aria-selected={active} onClick={() => setTab(key)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0,
                    height: isMobile ? 44 : 32, padding: '0 12px', border: 'none', borderRadius: 8,
                    cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5,
                    fontWeight: active ? 700 : 500, whiteSpace: 'nowrap',
                    background: active ? 'var(--anthropic-orange)' : 'transparent',
                    color: active ? '#1a1008' : 'var(--text-tertiary)',
                    transition: 'background 0.15s, color 0.15s',
                  }}
                >
                  {label}{count > 0 ? ` ${count}` : ''}
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

          {tab === 'sessions' && <SessionsTab detail={detail} />}

          {tab === 'comments' && <CommentsTab id={id} detail={detail} onChanged={reload} />}

          {tab === 'subtasks' && (
            <SubtaskTable
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

        {/*
         * The facts column — Jira's right rail, FOLDED.
         *
         * Seven cards all open at once made the page a scroll whose bottom half you learn to skip,
         * and put the two controls people actually reach for (status, claim) below the fold. Plan
         * stays open because it is what you came to change; the rest state their name and their
         * count shut, and remember which of them you opened.
         */}
        <aside style={{ display: 'grid', gap: 10, minWidth: 0 }}>
          <PlanCard
            task={detail.task}
            busy={busy}
            lang={lang}
            statuses={statuses}
            onPatch={async patch => { await run(() => editTask(id, patch)) }}
            onStatus={async st => {
              if (st === 'blocked') { setBlocking(true); return }
              setBusy(true)
              const result = await markTask(id, st)
              setBusy(false)
              if (!result.ok && result.reason === 'done_needs_session') { setDoneRefusal(true); return }
              await reload()
            }}
          />

          <RailSection id="links" title={copy.links} badge={detail.task.links?.length ?? 0}>
            <LinksPanel id={id} task={detail.task} onChanged={reload} bare />
          </RailSection>

          <RailSection id="blocked" title={copy.blockedBy} badge={detail.task.blockedBy?.length ?? 0}>
            <BlockedBy id={id} task={detail.task} lang={lang} statuses={statuses} onChanged={reload} bare />
          </RailSection>

          {/*
            * `Mark delivered` and `Mark abandoned` used to live HERE, as two buttons doing what two
            * rows of the status chip above already did — a second place to set a status, in a
            * panel called Actions, three sections away from the chip. They are gone: the chip is
            * the one control, and it is at the top of this rail on every screen.
            */}
          {/* DELETING is offered only where the caller has somewhere to go afterwards. In the
              session aside there is nowhere: the delivery this panel is a view OF would be gone,
              and the panel would sit on a record that no longer answers. The board's own page
              navigates back to the list, which is why it passes `onDeleted`. */}
          {onDeleted && (
            <RailSection id="actions" title={copy.actions}>
              <button
                style={{ ...button(isMobile), color: 'var(--accent-red)' }} disabled={busy}
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 size={14} /> {copy.deleteDelivery}
              </button>
            </RailSection>
          )}
        </aside>
      </div>
      {blocking && (
        <BlockedDialog
          titles={[detail.task.title]}
          rows={(boardRows ?? []).filter(r => r.task.id !== id)}
          already={detail.task.blockedBy ?? []}
          onCancel={() => setBlocking(false)}
          onConfirm={async ({ reason, blockedBy }) => {
            setBlocking(false)
            await run(() => markTask(id, 'blocked', { reason, blockedBy }))
          }}
        />
      )}

      {doneRefusal && (
        <DoneNeedsSessionDialog
          title={detail.task.title}
          scope="task"
          lang={lang}
          onCancel={() => setDoneRefusal(false)}
          onFile={() => {
            // Every filing control this delivery owns lives on the Subtasks tab — there is no
            // second, separate "file a session" surface here to jump to instead.
            setDoneRefusal(false)
            setTab('subtasks')
          }}
        />
      )}

      <ConfirmModal
        open={confirmDelete}
        title="Delete this task?"
        message={`"${detail.task.title}" and its comments, subtasks, files and links go. The SESSIONS filed under it are kept — deleting a board entry never deletes work.`}
        confirmLabel="Delete task"
        cancelLabel="Keep it"
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false)
          void run(async () => { await deleteTask(id); onDeleted?.() })
        }}
      />

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

      {firing && (
        <StagedSessionLaunchConfirm
          lang={lang}
          subtaskTitle={firing.title}
          draft={firing.stagedSession!}
          attachmentNames={(firing.stagedSession!.attachmentIds ?? [])
            .map(fid => detail.files.find(f => f.id === fid)?.name)
            .filter((n): n is string => !!n)}
          busy={fireBusy}
          error={fireError}
          onCancel={() => setFiring(null)}
          onConfirm={() => void confirmFire()}
        />
      )}

      {firePrefillFor && (
        <NewSessionModal
          lang={lang}
          initialTaskId={id}
          initialSubtaskId={firePrefillFor.subtask.id}
          initialPreset={{
            ...(firePrefillFor.subtask.stagedSession?.harness
              ? { harness: firePrefillFor.subtask.stagedSession.harness } : {}),
            prompt: firePrefillFor.prompt,
            ...(firePrefillFor.subtask.stagedSession?.model
              ? { model: firePrefillFor.subtask.stagedSession.model } : {}),
            ...(firePrefillFor.subtask.stagedSession?.effort
              ? { effort: firePrefillFor.subtask.stagedSession.effort } : {}),
            label: firePrefillFor.subtask.title,
          }}
          onClose={() => setFirePrefillFor(null)}
          onStarted={() => { setFirePrefillFor(null); void reload() }}
        />
      )}
    </>
  )
}

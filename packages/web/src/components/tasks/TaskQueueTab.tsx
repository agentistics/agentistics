/**
 * TaskQueueTab — the "Fila" tab of a task (FILA.PRIORIDADE): this task's queue in the ORDER IT LEAVES, in full.
 *
 * One row per queued piece: its place, its priority (the same chip the board edits — changing it here changes the
 * task's priority and therefore the order everywhere), the subtask or group (members listed), the whole PRE-DISPATCH
 * (harness · model · effort · account · folder, the brief collapsed behind "ver tudo"), why it is not starting yet in
 * plain words (the slot gate's verdict, a leader's "não" with its reason, a scheduled hour, the open question), the
 * subtask's latest notes, and — once the queue has opened it — the link to the session. The actions are the leader's and
 * the owner's: start now, schedule, take it off the queue (with a reason), edit the pre-dispatch.
 *
 * Every figure comes from `GET /api/deliveries/queue/<taskId>` — the same view the Live card, `agentop flow fila` and the
 * MCP `agentistics_task_queue` read. Nothing here decides order or eligibility.
 */
import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { CalendarClock, Clock, ExternalLink, MessageSquareText, Pencil, Play, Users, X, Ban, ChevronDown, ChevronUp } from 'lucide-react'
import { PRIORITY_ORDER, type TaskPriorityId } from '@agentistics/core'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useDismissOverlay } from '../../lib/dismissOverlay'
import { overlayPadding } from '../../lib/mobileOverlay'
import { editTask, saveStagedSession, uploadFile, useTaskStatuses, type TaskDetail } from '../../lib/tasks'
import { sessionPath } from '../../lib/sessionRoute'
import { CenteredLoader } from '../CenteredLoader'
import { PRIORITY, button, field, microLabel, surface } from './board'
import { ChipSelect } from './ChipSelect'
import { statusLabel, type Lang } from './copy'
import { priorityWord } from './LivePriorityChip'
import { StagedSessionCompose } from './StagedSessionCompose'
import { actionRequest, briefPreview, predispatchLine, scheduleIso, shortCwd, stateLine, toLocalInput, type QueueAction, type QueueRow, type RowTone } from './queueModel'
import { postQueueAction, useTaskQueue } from './useTaskQueue'

const MUTED = 'var(--text-tertiary)'
const TONE: Record<RowTone, string> = { wait: 'var(--accent-yellow, #e5b341)', ask: 'var(--anthropic-orange-light)', hold: 'var(--text-secondary)', ready: 'var(--accent-green, #26b573)', approved: 'var(--accent-green, #26b573)' }

const T = (pt: boolean) => ({
  empty: pt ? 'A fila desta tarefa está vazia.' : 'This task\'s queue is empty.',
  emptyHint: pt ? 'Peças prontas para abrir sessão aparecem aqui, na ordem em que saem: prioridade e depois chegada.' : 'Pieces waiting to open a session show up here in the order they leave: priority, then arrival.',
  loading: pt ? 'Lendo a fila…' : 'Reading the queue…',
  stale: pt ? 'Não consegui atualizar a fila agora; mostrando a última leitura.' : 'Could not refresh the queue; showing the last reading.',
  order: pt ? 'Ordem de saída: prioridade, depois chegada. Mudar a prioridade muda a ordem.' : 'Leaving order: priority, then arrival. Changing a priority changes the order.',
  start: pt ? 'Iniciar agora' : 'Start now', schedule: pt ? 'Agendar' : 'Schedule', dequeue: pt ? 'Tirar da fila' : 'Take off the queue', edit: pt ? 'Editar pré-dispatch' : 'Edit pre-dispatch',
  seeAll: pt ? 'ver tudo' : 'see all', collapse: pt ? 'recolher' : 'collapse', notes: pt ? 'Anotações' : 'Notes', noNotes: pt ? 'sem anotações ainda' : 'no notes yet',
  seeAllNotes: (n: number) => (pt ? `ver todas (${n})` : `see all (${n})`),
  recent: pt ? 'Abertas pela fila (últimas 24 h)' : 'Opened by the queue (last 24 h)', openSession: pt ? 'abrir sessão' : 'open session',
  members: (n: number) => (pt ? `grupo · ${n} ${n === 1 ? 'membro' : 'membros'}` : `group · ${n} ${n === 1 ? 'member' : 'members'}`),
  auto: pt ? 'aberta sozinha (sem resposta em 10 min)' : 'opened by itself (no answer in 10 min)',
  by: (who: string) => (pt ? `por ${who}` : `by ${who}`),
  reason: pt ? 'Motivo' : 'Reason', when: pt ? 'Quando começa' : 'When it starts', cancel: pt ? 'Cancelar' : 'Cancel',
  scheduleTitle: pt ? 'Agendar esta peça' : 'Schedule this piece', dequeueTitle: pt ? 'Tirar da fila' : 'Take off the queue',
  scheduleHint: pt ? 'Ela continua na fila e só volta a ser candidata nessa hora. O motivo fica no cartão e em um comentário da subtarefa.' : 'It stays queued and is only a candidate again from that time. The reason shows on the card and as a comment on the subtask.',
  dequeueHint: pt ? 'A peça sai da fila e só volta se você preparar o pré-dispatch de novo. O motivo fica registrado.' : 'The piece leaves the queue and only returns if you stage it again. The reason is recorded.',
  needReason: pt ? 'Escreva o motivo.' : 'Write the reason.', needWhen: pt ? 'Escolha um horário no futuro.' : 'Pick a time in the future.',
  confirmSchedule: pt ? 'Agendar' : 'Schedule', confirmDequeue: pt ? 'Tirar da fila' : 'Take off',
  folder: pt ? 'pasta' : 'folder', global: (n: number) => (pt ? `${n}º na fila geral` : `${n} overall`),
  position: (n: number) => (pt ? `${n}º` : n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`),
  noBrief: pt ? 'sem brief ainda' : 'no brief yet',
})

export interface TaskQueueTabProps {
  taskId: string
  detail: TaskDetail
  lang: Lang
  /** Re-read the task after a write that touched it (a priority, a pre-dispatch). */
  reload: () => void | Promise<void>
  /** Opens the subtask's whole thread of notes. */
  onOpenNotes: (subtaskId: string, title: string) => void
  /** The caller's own queue, so the tab strip's count and the tab agree (one poll). */
  queueState: ReturnType<typeof useTaskQueue>
}

export function TaskQueueTab({ taskId, detail, lang, reload, onOpenNotes, queueState }: TaskQueueTabProps) {
  const pt = lang === 'pt'
  const t = T(pt)
  const mobile = useIsMobile()
  const { queue, error, reload: refetch } = queueState
  const { statuses } = useTaskStatuses()
  const [dialog, setDialog] = useState<{ kind: 'schedule' | 'dequeue'; row: QueueRow } | null>(null)
  const [editing, setEditing] = useState<QueueRow | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)
  const nowMs = Date.now()

  const after = async () => { await Promise.all([refetch(), Promise.resolve(reload())]) }
  const run = async (key: string, body: Record<string, unknown>, subtaskId: string, okText: string) => {
    setBusy(key); setMessage(null)
    const out = await postQueueAction(subtaskId, body)
    setBusy(null)
    setMessage(out.ok ? { tone: 'ok', text: out.warnings[0] ?? okText } : { tone: 'bad', text: out.sentence })
    await after()
    return out.ok
  }

  if (!queue) {
    return error
      ? <div data-queue-error style={{ ...surface, padding: 14, fontSize: 12.5, color: 'var(--accent-red, #ff5f5f)' }}>{t.stale} ({error})</div>
      : <CenteredLoader placement="area" label={t.loading} testId="queue-loading" />
  }

  return (
    <div data-queue-tab style={{ display: 'grid', gap: 10, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: MUTED, flexWrap: 'wrap' }}>
        <Clock size={12} aria-hidden /><span>{t.order}</span>
      </div>
      {error && <div data-queue-stale style={{ fontSize: 11.5, color: 'var(--accent-yellow, #e5b341)' }}>{t.stale}</div>}
      {message && <div data-queue-message role="status" style={{ fontSize: 12, color: message.tone === 'ok' ? 'var(--accent-green, #26b573)' : 'var(--accent-red, #ff5f5f)', overflowWrap: 'anywhere' }}>{message.text}</div>}

      {queue.items.length === 0 && (
        <div data-queue-empty style={{ ...surface, padding: 18, display: 'grid', gap: 4 }}>
          <b style={{ fontSize: 13 }}>{t.empty}</b>
          <span style={{ fontSize: 12, color: MUTED }}>{t.emptyHint}</span>
        </div>
      )}

      {queue.items.map(r => {
        const st = stateLine(r, nowMs, pt)
        const brief = briefPreview(r.predispatch.prompt)
        return (
          <QueueRowView
            key={r.subtaskId} r={r} pt={pt} mobile={mobile} state={st} brief={brief} statuses={statuses} lang={lang} busy={busy}
            onPriority={async p => { setBusy(`p:${r.subtaskId}`); await editTask(taskId, { priority: p as TaskPriorityId }); setBusy(null); await after() }}
            onStart={() => {
              const req = actionRequest('start', {})
              if ('body' in req) void run(`s:${r.subtaskId}`, req.body, r.subtaskId, pt ? 'Início pedido: a sessão abre assim que o portão de vaga passar.' : 'Start requested: the session opens as soon as the slot gate passes.')
            }}
            onSchedule={() => setDialog({ kind: 'schedule', row: r })}
            onDequeue={() => setDialog({ kind: 'dequeue', row: r })}
            onEdit={() => setEditing(r)}
            onNotes={() => onOpenNotes(r.subtaskId, r.title)}
          />
        )
      })}

      {queue.recent.length > 0 && (
        <section data-queue-recent style={{ display: 'grid', gap: 6 }}>
          <div style={microLabel}>{t.recent}</div>
          {queue.recent.map(x => (
            <div key={x.subtaskId} style={{ ...surface, padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 12.5 }}>
              <span style={{ fontWeight: 600, minWidth: 0, overflowWrap: 'anywhere' }}>{x.title}</span>
              <span style={{ color: MUTED, fontSize: 11.5 }}>{statusLabel(x.phase === 'executando' ? 'in_progress' : x.phase, lang, statuses)} · {x.auto ? t.auto : t.by(x.actor)}</span>
              {x.sessionId && (
                <a href={sessionPath(x.sessionId)} data-queue-session-link style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--anthropic-orange-light)', fontSize: 12, minHeight: mobile ? 44 : undefined }}>
                  <ExternalLink size={12} aria-hidden />{t.openSession}
                </a>
              )}
            </div>
          ))}
        </section>
      )}

      {dialog && (
        <QueueActionDialog
          kind={dialog.kind} row={dialog.row} pt={pt} mobile={mobile}
          onClose={() => setDialog(null)}
          onConfirm={async (reason, untilLocal) => {
            const req = dialog.kind === 'dequeue'
              ? actionRequest('dequeue', { reason })
              : actionRequest('schedule', { reason, ...(scheduleIso(untilLocal, Date.now()) ? { untilIso: scheduleIso(untilLocal, Date.now())! } : {}) })
            if (!('body' in req)) return req.error === 'when' ? t.needWhen : t.needReason
            const ok = await run(`${dialog.kind}:${dialog.row.subtaskId}`, req.body, dialog.row.subtaskId, dialog.kind === 'dequeue' ? (pt ? 'Saiu da fila.' : 'Taken off the queue.') : (pt ? 'Agendada.' : 'Scheduled.'))
            if (ok) setDialog(null)
            return null
          }}
        />
      )}

      {editing && (
        <StagedSessionCompose
          lang={lang}
          subtaskTitle={editing.title}
          {...(detail.subtasks.find(s => s.id === editing.subtaskId)?.stagedSession ? { initial: detail.subtasks.find(s => s.id === editing.subtaskId)!.stagedSession! } : {})}
          taskFiles={detail.files}
          onUpload={f => uploadFile(taskId, f, 'you')}
          onSave={async d => { await saveStagedSession(taskId, editing.subtaskId, d); setEditing(null); await after() }}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}

function QueueRowView(p: {
  r: QueueRow; pt: boolean; mobile: boolean; lang: Lang
  state: { text: string; tone: RowTone }
  brief: { short: string; cut: boolean }
  statuses: ReturnType<typeof useTaskStatuses>['statuses']
  busy: string | null
  onPriority: (p: string) => void | Promise<void>
  onStart: () => void; onSchedule: () => void; onDequeue: () => void; onEdit: () => void; onNotes: () => void
}) {
  const { r, pt, mobile } = p
  const t = T(pt)
  const [open, setOpen] = useState(false)
  const line = predispatchLine(r.predispatch, pt)
  const cwd = shortCwd(r.predispatch.cwd)
  const canStart = r.predispatch.ok && !r.ask?.approved
  const btn: React.CSSProperties = { ...button(mobile), gap: 6, minHeight: mobile ? 44 : 30, height: mobile ? 44 : 30, padding: '0 10px', fontSize: 12 }
  return (
    <article data-queue-row={r.subtaskId} data-priority={r.priority} style={{ ...surface, padding: mobile ? 12 : 14, display: 'grid', gap: 9, minWidth: 0 }}>
      <header style={{ display: 'flex', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
        <span data-queue-position title={t.global(r.globalPosition)} style={{ fontWeight: 700, fontSize: 13, minWidth: 28, fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)' }}>{t.position(r.position)}</span>
        <ChipSelect
          value={r.priority} compact block={false} disabled={p.busy === `p:${r.subtaskId}`}
          title={pt ? 'Prioridade da tarefa — muda a ordem de saída' : 'Task priority — changes the leaving order'}
          options={PRIORITY_ORDER.filter(pid => pid !== 'none').map(pid => ({ value: pid, label: priorityWord(pid, pt), color: PRIORITY[pid]!.color, dim: PRIORITY[pid]!.dim }))}
          onPick={v => void p.onPriority(v)}
        />
        <span data-queue-title style={{ flex: 1, minWidth: mobile ? '100%' : 160, fontWeight: 650, fontSize: 13.5, overflowWrap: 'anywhere', lineHeight: 1.3 }}>{r.title}</span>
        {r.group && <span data-queue-group style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: MUTED }}><Users size={12} aria-hidden />{t.members(r.group.members.length)}</span>}
      </header>

      {r.group && r.group.members.length > 0 && (
        <ul data-queue-members style={{ margin: 0, padding: '0 0 0 16px', display: 'grid', gap: 2, fontSize: 12, color: 'var(--text-secondary)' }}>
          {r.group.members.map(m => <li key={m.id} style={{ overflowWrap: 'anywhere' }}>{m.title} <span style={{ color: MUTED }}>· {statusLabel(m.status, p.lang, p.statuses)}</span></li>)}
        </ul>
      )}

      <div data-queue-state data-tone={p.state.tone} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: 12.5, color: TONE[p.state.tone], lineHeight: 1.35, overflowWrap: 'anywhere' }}>
        {p.state.tone === 'hold' ? <CalendarClock size={13} aria-hidden style={{ flexShrink: 0, marginTop: 1 }} /> : <Clock size={13} aria-hidden style={{ flexShrink: 0, marginTop: 1 }} />}
        <span>{p.state.text}</span>
      </div>

      <div data-queue-predispatch style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--text-secondary)', minWidth: 0 }}>
        <span style={{ overflowWrap: 'anywhere' }}>{line || (pt ? 'pré-dispatch ainda não preenchido' : 'pre-dispatch not filled in yet')}{cwd ? <span style={{ color: MUTED }}> · {t.folder} {cwd}</span> : null}</span>
        <span data-queue-brief style={{ color: MUTED, lineHeight: 1.4, overflowWrap: 'anywhere', whiteSpace: open ? 'pre-wrap' : 'normal' }}>
          {r.predispatch.prompt.trim() ? (open ? r.predispatch.prompt : p.brief.short) : t.noBrief}
        </span>
        {p.brief.cut && (
          <button type="button" data-queue-toggle onClick={() => setOpen(o => !o)} style={{ all: 'unset', cursor: 'pointer', color: 'var(--anthropic-orange-light)', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 3, minHeight: mobile ? 44 : undefined, width: 'fit-content' }}>
            {open ? <ChevronUp size={12} aria-hidden /> : <ChevronDown size={12} aria-hidden />}{open ? t.collapse : t.seeAll}
          </button>
        )}
      </div>

      <div data-queue-notes style={{ display: 'grid', gap: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={microLabel}>{t.notes}</span>
          {r.notes.total > 3 && <button type="button" onClick={p.onNotes} style={{ all: 'unset', cursor: 'pointer', color: 'var(--anthropic-orange-light)', fontSize: 11.5, minHeight: mobile ? 44 : undefined, display: 'inline-flex', alignItems: 'center' }}>{t.seeAllNotes(r.notes.total)}</button>}
        </div>
        {r.notes.last.length === 0
          ? <span style={{ fontSize: 11.5, color: MUTED }}>{t.noNotes}</span>
          : r.notes.last.map((n, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, fontSize: 11.5, color: 'var(--text-secondary)', alignItems: 'flex-start' }}>
              <MessageSquareText size={11} aria-hidden style={{ flexShrink: 0, marginTop: 2, color: MUTED }} />
              <span style={{ overflowWrap: 'anywhere' }}><b style={{ fontWeight: 600 }}>{n.author}</b> · {briefPreview(n.body, 160).short}</span>
            </div>
          ))}
      </div>

      <footer style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button type="button" data-queue-action="start" disabled={!canStart || p.busy === `s:${r.subtaskId}`} onClick={p.onStart} style={{ ...btn, background: 'var(--anthropic-orange)', color: '#1a1008', border: '1px solid transparent', opacity: canStart ? 1 : 0.5 }}><Play size={13} aria-hidden />{t.start}</button>
        <button type="button" data-queue-action="schedule" onClick={p.onSchedule} style={btn}><CalendarClock size={13} aria-hidden />{t.schedule}</button>
        <button type="button" data-queue-action="edit" onClick={p.onEdit} style={btn}><Pencil size={13} aria-hidden />{t.edit}</button>
        <button type="button" data-queue-action="dequeue" onClick={p.onDequeue} style={btn}><Ban size={13} aria-hidden />{t.dequeue}</button>
      </footer>
    </article>
  )
}

function QueueActionDialog(p: {
  kind: 'schedule' | 'dequeue'; row: QueueRow; pt: boolean; mobile: boolean
  onClose: () => void
  onConfirm: (reason: string, untilLocal: string) => Promise<string | null>
}) {
  const t = T(p.pt)
  const dismiss = useDismissOverlay(() => p.onClose())
  const [reason, setReason] = useState('')
  const [until, setUntil] = useState(() => toLocalInput(Date.now() + 2 * 3600_000))
  const [err, setErr] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const min = useMemo(() => toLocalInput(Date.now() + 60_000), [])
  const schedule = p.kind === 'schedule'
  return createPortal(
    <div {...dismiss} style={{ position: 'fixed', inset: 0, zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(3px)', padding: overlayPadding(p.mobile, 16) }}>
      <div role="dialog" aria-modal onClick={e => e.stopPropagation()} data-queue-dialog={p.kind} style={{ ...surface, boxShadow: '0 12px 48px rgba(0,0,0,0.5)', display: 'grid', gap: 12, padding: 18, ...(p.mobile ? { width: '100%', height: '100%', borderRadius: 0, overflowY: 'auto', alignContent: 'start' } : { width: '100%', maxWidth: 440, borderRadius: 12 }) }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <b style={{ flex: 1, fontSize: 15 }}>{schedule ? t.scheduleTitle : t.dequeueTitle}</b>
          <button type="button" aria-label={t.cancel} onClick={p.onClose} style={{ all: 'unset', cursor: 'pointer', color: MUTED, display: 'flex', minWidth: p.mobile ? 44 : undefined, minHeight: p.mobile ? 44 : undefined, alignItems: 'center', justifyContent: 'center' }}><X size={16} /></button>
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', overflowWrap: 'anywhere' }}><b>{p.row.title}</b></div>
        <p style={{ margin: 0, fontSize: 12, color: MUTED, lineHeight: 1.5 }}>{schedule ? t.scheduleHint : t.dequeueHint}</p>
        {schedule && (
          <label style={{ display: 'grid', gap: 5 }}>
            <span style={{ ...microLabel, fontSize: 9 }}>{t.when}</span>
            <input type="datetime-local" value={until} min={min} onChange={e => setUntil(e.target.value)} style={field(p.mobile)} />
          </label>
        )}
        <label style={{ display: 'grid', gap: 5 }}>
          <span style={{ ...microLabel, fontSize: 9 }}>{t.reason}</span>
          <textarea autoFocus={!p.mobile} value={reason} onChange={e => setReason(e.target.value)} style={{ ...field(p.mobile), minHeight: 72, resize: 'vertical', lineHeight: 1.5 }} />
        </label>
        {err && <span role="alert" style={{ fontSize: 12, color: 'var(--accent-red, #ff5f5f)' }}>{err}</span>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" onClick={p.onClose} style={button(p.mobile)}>{t.cancel}</button>
          <button type="button" data-queue-confirm disabled={sending} onClick={async () => { setSending(true); setErr(await p.onConfirm(reason, until)); setSending(false) }} style={button(p.mobile, 'primary')}>{schedule ? t.confirmSchedule : t.confirmDequeue}</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

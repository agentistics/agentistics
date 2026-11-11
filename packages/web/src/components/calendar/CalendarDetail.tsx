/**
 * CalendarDetail — what one click on the calendar opens: a popover beside the click on a desktop, a bottom sheet on a
 * phone. It states the facts the read model holds (date and hour, version, stage, model, the ETA with its confidence —
 * or the reason there is none) and leads to the task and to the Live line, where the card, its session and the
 * actions already are. Nothing here acts on a delivery, so there is no second controller for one gesture.
 */
import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { ExternalLink, X } from 'lucide-react'
import { brtDay, type CalMark, type CalPiece, type CalVersion } from '@agentistics/core'
import { clock, stamp } from '../../lib/calendarModel'
import { dialogButtonStyle } from '../../pages/settings/primitives'
import { HarnessBadges } from '../tasks/HarnessBadges'
import { CONFIDENCE_LABEL, NO_ESTIMATE_REASON, TEXT, pick } from './calendarText'
import { Confidence, PriorityFlag, StageChip, VersionTag } from './calendarUi'

export type CalSelection =
  | { kind: 'piece'; key: string }
  | { kind: 'version'; version: string }
  | { kind: 'mark'; mark: CalMark }

export interface Anchor { x: number; y: number }

function Kv({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl style={{ display: 'grid', gridTemplateColumns: '92px 1fr', gap: '6px 10px', margin: 0, fontSize: 12 }}>
      {rows.map(([k, v]) => <div key={k} style={{ display: 'contents' }}><dt style={{ color: 'var(--text-tertiary)' }}>{k}</dt><dd style={{ margin: 0, minWidth: 0, overflowWrap: 'anywhere' }}>{v}</dd></div>)}
    </dl>
  )
}

function etaRows(p: CalPiece, pt: boolean): React.ReactNode {
  if (p.publishedAtMs !== null) return <>{pick(TEXT.published, pt)} · {stamp(p.publishedAtMs, pt)}</>
  if (p.publishEta.kind === 'estimate') {
    return <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      ~{stamp(p.publishEta.atMs, pt)} <Confidence level={p.publishEta.confidence} pt={pt} />
      {p.publishEta.confidence && <span style={{ color: 'var(--text-tertiary)' }}>{pick(CONFIDENCE_LABEL[p.publishEta.confidence], pt)}</span>}
    </span>
  }
  return <>{pick(TEXT.noEstimate, pt)}{p.publishEta.reason && NO_ESTIMATE_REASON[p.publishEta.reason] ? <span style={{ color: 'var(--text-tertiary)' }}> · {pick(NO_ESTIMATE_REASON[p.publishEta.reason]!, pt)}</span> : null}</>
}

export function CalendarDetail({ selection, anchor, pieces, versions, marks, nowMs, pt, isMobile, onClose, onSelect }: {
  selection: CalSelection; anchor: Anchor | null; pieces: readonly CalPiece[]; versions: readonly CalVersion[]; marks: readonly CalMark[]
  nowMs: number; pt: boolean; isMobile: boolean; onClose: () => void; onSelect: (s: CalSelection) => void
}) {
  const navigate = useNavigate()
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  useEffect(() => { ref.current?.focus() }, [selection])

  let title = '', sub: React.ReactNode = null, body: React.ReactNode = null, taskId: string | null = null
  if (selection.kind === 'piece') {
    const p = pieces.find(x => x.key === selection.key)
    if (!p) return null
    taskId = p.taskId; title = p.title
    sub = <>{p.kind === 'owner-request' && <span style={{ marginRight: 6, color: 'var(--text-tertiary)', fontSize: 10 }}>{pt ? 'Pedido do dono' : "Owner's request"}</span>}{pick(TEXT.taskWord, pt)} · {p.taskTitle}</>
    if (p.leaderAvailabilityReasonCode) sub = <>{sub}<span data-cal-leader-reason style={{ display: 'block', color: 'var(--text-tertiary)', marginTop: 4 }}>{pt ? 'Sem líder · nenhum líder vivo nesta tarefa' : 'No leader · no live leader is filed on this task'}</span></>
    body = (
      <>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <StageChip stage={p.stage} pt={pt} />{p.version && <VersionTag version={p.version} />}<PriorityFlag priority={p.priority} pt={pt} />
          {p.late && <span style={{ fontSize: 10.5, color: 'var(--accent-red)', fontWeight: 600 }}>{pick(TEXT.late, pt)}</span>}
        </div>
        <Kv rows={[
          [pick(TEXT.eta, pt), etaRows(p, pt)],
          ...(p.overdueSinceMs != null ? [[pick(TEXT.overdueSince, pt), stamp(p.overdueSinceMs, pt)] as [string, React.ReactNode]] : []),
          [pick(TEXT.started, pt), p.startedAtMs !== null ? stamp(p.startedAtMs, pt) : '—'],
          [pick(TEXT.versionWord, pt), p.version ?? '—'],
          [pick(TEXT.model, pt), p.harness ? <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><HarnessBadges harnesses={[p.harness]} max={1} />{p.model}</span> : '—'],
          ...(p.dueDate ? [[pick(TEXT.dueWord, pt), p.dueDate] as [string, React.ReactNode]] : []),
        ]} />
      </>
    )
  } else if (selection.kind === 'version') {
    const v = versions.find(x => x.version === selection.version)
    if (!v) return null
    const published = v.state === 'published'
    title = v.version
    sub = published ? pick(TEXT.published, pt) : pick(TEXT.expected, pt)
    const ps = pieces.filter(p => v.pieceKeys.includes(p.key))
    body = (
      <>
        <Kv rows={[
          [pick(TEXT.dateTime, pt), v.atMs !== null ? `${published ? '' : '~'}${stamp(v.atMs, pt)}` : pick(TEXT.noEstimate, pt)],
          [pick(TEXT.versionWord, pt), pick(TEXT.bundled(v.pieceKeys.length), pt)],
          ...(!published ? [[pick(TEXT.eta, pt), v.confidence ? <span key="c" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><Confidence level={v.confidence} pt={pt} />{pick(CONFIDENCE_LABEL[v.confidence], pt)}{v.basis === 'partial' ? ` · ${pick(TEXT.expected, pt)}` : ''}</span> : pick(TEXT.noEstimate, pt)] as [string, React.ReactNode]] : []),
        ]} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {ps.map(p => (
            <button key={p.key} type="button" onClick={() => onSelect({ kind: 'piece', key: p.key })}
              style={{ display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left', padding: '4px 0', background: 'none', border: 0, cursor: 'pointer', font: 'inherit', fontSize: 12, color: 'var(--text-primary)', minHeight: isMobile ? 44 : undefined }}>
              <StageChip stage={p.stage} pt={pt} /><span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.title}</span>
            </button>
          ))}
        </div>
      </>
    )
  } else {
    const m = selection.mark
    if (m.kind === 'task-due') {
      taskId = m.taskId; title = `${pick(TEXT.due, pt)} · ${m.label}`; sub = m.day
      body = <Kv rows={[[pick(TEXT.dueWord, pt), m.day], [pick(TEXT.taskWord, pt), m.label]]} />
    } else {
      title = pick(TEXT.accountsRenew, pt); sub = null
      const day = brtDay(m.atMs)
      body = <Kv rows={marks.filter((x): x is Extract<CalMark, { kind: 'account-reset' }> => x.kind === 'account-reset' && brtDay(x.atMs) === day).sort((a, b) => a.atMs - b.atMs).map(x => [x.label, `${clock(x.atMs)} · ${x.window === '5h' ? '5h' : pt ? 'semana' : 'week'}`] as [string, React.ReactNode])} />
    }
  }

  const W = 330
  const pos: React.CSSProperties = isMobile
    ? { left: 0, right: 0, bottom: 0, borderRadius: 'var(--radius-xl) var(--radius-xl) 0 0', maxHeight: 'calc(70dvh / var(--ui-zoom, 1))', paddingBottom: 'calc(14px + env(safe-area-inset-bottom))' }
    : (() => {
      const vw = typeof window !== 'undefined' ? window.innerWidth : 1280, vh = typeof window !== 'undefined' ? window.innerHeight : 800
      const x = Math.max(8, Math.min((anchor?.x ?? vw / 2) + 14, vw - W - 8)), y = Math.max(8, Math.min((anchor?.y ?? 120) - 30, vh - 380))
      return { left: x, top: y, width: W, maxHeight: 'min(560px, calc(100dvh / var(--ui-zoom, 1) - 16px))', borderRadius: 'var(--radius-lg)' }
    })()

  return (
    <div ref={ref} role="dialog" aria-label={title} tabIndex={-1} data-cal-detail
      style={{ position: 'fixed', zIndex: 60, overflow: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 10, outline: 'none', ...pos,
        background: 'color-mix(in srgb, var(--bg-card) 88%, transparent)', backdropFilter: 'blur(16px) saturate(140%)', WebkitBackdropFilter: 'blur(16px) saturate(140%)',
        border: '1px solid var(--border)', boxShadow: 'var(--shadow-elevated)' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, overflowWrap: 'anywhere' }}>{title}</div>
          {sub && <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginTop: 2 }}>{sub}</div>}
        </div>
        <button type="button" onClick={onClose} aria-label={pick(TEXT.close, pt)} className={isMobile ? 'ag-tap-icon' : undefined}
          style={{ background: 'none', border: 0, cursor: 'pointer', color: 'var(--text-secondary)', display: 'inline-flex', width: 24, height: 24, alignItems: 'center', justifyContent: 'center', position: 'relative' }}><X size={16} /></button>
      </div>
      {body}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 2 }}>
        {taskId && (
          <button type="button" onClick={() => navigate(`/tasks/${encodeURIComponent(taskId!)}`)} style={{ ...dialogButtonStyle('primary', isMobile), display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <ExternalLink size={12} aria-hidden />{pick(TEXT.open, pt)}
          </button>
        )}
        <button type="button" onClick={() => navigate('/tasks/live')} style={dialogButtonStyle('secondary', isMobile)}>{pick(TEXT.openLive, pt)}</button>
      </div>
    </div>
  )
}

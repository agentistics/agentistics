/**
 * TaskHero — the task page's IDENTITY (owner's choice 2026-10-04: option A's cockpit on option C's
 * conversation-first layout). What the task IS, before any tab: how far it is (a ring), what state
 * it is in, who is working on it right now, what it has cost and how long, and which harnesses and
 * models did the work.
 *
 * It owns no numbers: cost and counts are the delivery's rollup (`detail.rollup`), the mix is
 * `detail.stats`, progress is `taskProgress`'s rule (subtasks done / total, rounded DOWN), and the
 * live count comes from the fleet poll the page already runs. A figure nobody measured renders
 * N/A — never a confident 0 — and a task nobody broke up draws no ring at all.
 */
import { useState } from 'react'
import { ArrowLeft, Pencil } from 'lucide-react'
import { groupStatus, taskProgress, type TaskStatusDef } from '@agentistics/core'
import { useIsMobile } from '../../hooks/useIsMobile'
import type { TaskDetail } from '../../lib/tasks'
import { BetaTag } from '../BetaTag'
import { NA, button, fmtInt, fmtTokens, harnessColor, statusStyle } from './board'
import { TaskChips, TaskMoreMenu } from './TaskChips'
import { RenameInput } from './RenameInput'
import { editTask } from '../../lib/tasks'
import { boardCopy } from './copy'
import { useMoney } from './money'
import { threadCopy, type Lang } from './threadCopy'
import { mixOf } from './threadView'
import { liveStatusOrder } from './board'
import { ProgressTooltip, progressTooltipModel } from './TaskProgressBar'

function fmtHours(minutes: number | null, lang: Lang): string {
  if (minutes === null) return NA
  const total = Math.round(minutes)
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h === 0) return lang === 'pt' ? `${m}min` : `${m}m`
  return m === 0 ? `${h}h` : `${h}h ${m}${lang === 'pt' ? 'min' : 'm'}`
}

export function ringLabelFontSize(size: number): number {
  return Math.max(9, Math.min(16, (size - 12) * 0.24))
}

function Ring({ done, inProgress, blocked, total, size, statuses, counts, titles, lang }: {
  done: number
  inProgress: number
  blocked: number
  total: number
  size: number
  statuses: readonly TaskStatusDef[] | null
  counts: Readonly<Record<string, number>>
  titles: readonly string[]
  lang: Lang
}) {
  const progress = taskProgress(done, total, inProgress, blocked, counts)
  const pct = progress.percent ?? 0
  const r = 36
  const c = 2 * Math.PI * r
  const statusCounts = progress.counts
  const segments = liveStatusOrder(statuses).map(id => ({ id, count: statusCounts[id] ?? 0, color: statusStyle(statuses, id).color, label: statusStyle(statuses, id).label }))
  const model = progressTooltipModel(progress.done, progress.total, pct, statusCounts, statuses, lang, titles)
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null)
  let offset = 0
  const labelSize = ringLabelFontSize(size)
  return (
    <div style={{ position: 'relative', width: size, height: size, flex: '0 0 auto' }} aria-label={`${pct}%`} onMouseEnter={e => { const r = e.currentTarget.getBoundingClientRect(); setTip({ x: r.left, y: r.top - 7 }) }} onMouseLeave={() => setTip(null)}>
      <svg width={size} height={size} viewBox="0 0 84 84" style={{ transform: 'rotate(-90deg)' }}>
        <circle cx="42" cy="42" r={r} fill="none" stroke="var(--ag-tint-3)" strokeWidth="8" />
        {segments.map(segment => {
          const length = progress.total === 0 ? 0 : c * (segment.count / progress.total)
          const currentOffset = offset
          offset += length
          return length > 0 ? (
            <circle
              key={segment.id}
              cx="42" cy="42" r={r} fill="none" stroke={segment.color} strokeWidth="8" strokeLinecap="butt"
              strokeDasharray={`${length} ${c - length}`} strokeDashoffset={-currentOffset}
              aria-label={`${segment.label}: ${segment.count}`}
            ><title>{`${segment.label}: ${segment.count}`}</title></circle>
          ) : null
        })}
      </svg>
      <b style={{
        position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
        fontSize: labelSize, fontWeight: 700, fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap', lineHeight: 1,
      }}>{pct}%</b>
      {tip && typeof document !== 'undefined' && <ProgressTooltip model={model} x={tip.x} y={tip.y} />}
    </div>
  )
}

export function TaskHero({ detail, lang, statuses, live, reload, onBack, onAbout, onDeleted, onFileSession }: {
  detail: TaskDetail
  lang: Lang
  statuses: readonly TaskStatusDef[] | null
  /** Sessions of this task running right now (fleet poll); `null` = the fleet is not known here. */
  live: number | null
  /** Re-read the task after a chip writes. The page owns the fetch — see `useTaskDetail`. */
  reload: () => void | Promise<void>
  onBack: () => void
  onAbout?: () => void
  /** Deleting leaves the page with nothing to draw; absent = no delete offered. */
  onDeleted?: () => void
  /** "File a session" from the done-needs-a-session refusal. */
  onFileSession?: () => void
}) {
  const isMobile = useIsMobile()
  const t = threadCopy(lang)
  const [renaming, setRenaming] = useState(false)
  const rename = boardCopy(lang).header.renameTask
  const money = useMoney()
  const task = detail.task
  const effectiveSubtasks = detail.subtasks.map(s => {
    if (!s.isGroup) return s
    const status = groupStatus(detail.subtasks.filter(m => m.parentGroupId === s.id).map(m => m.status))
    return { ...s, status, done: status === 'done' }
  })
  const subsDone = effectiveSubtasks.filter(s => s.done).length
  const subsTotal = effectiveSubtasks.length
  const subsInProgress = effectiveSubtasks.filter(s => s.status === 'in_progress').length
  const subsBlocked = effectiveSubtasks.filter(s => s.status === 'blocked').length
  const subtaskCounts = Object.fromEntries(effectiveSubtasks.reduce((m, s) => m.set(s.status, (m.get(s.status) ?? 0) + 1), new Map<string, number>()))
  const r = detail.rollup
  const cost = r.mixedCurrency || (r.credits !== null && r.costUSD === null)
    ? `${r.credits!.premiumRequests} req`
    : money(r.costUSD, r.costByHarness)
  const mix = mixOf(detail.stats.harnesses)
  const models = detail.stats.models.filter(m => (m.tokens ?? 0) > 0).slice(0, 3).map(m => m.key)

  const kpis: Array<[string, string, boolean]> = [
    [t.kpiCost, cost, false],
    [t.kpiSessions, fmtInt(r.sessionsUsed), false],
    [t.kpiActive, fmtHours(r.activeMinutes, lang), false],
    [t.kpiRounds, fmtInt(r.rounds), true],
    [t.kpiTokens, fmtTokens(r.tokens), true],
  ]

  // The cabeçalho's two buttons: "About" (the description editor) and ⋯ (delete). On a desktop they
  // stand at the card's right; on a phone the row has no room for them beside the chips, so they
  // sit at the end of the breadcrumb line.
  const actions = (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flex: '0 0 auto' }}>
      {onAbout && (
        <button
          onClick={onAbout}
          style={{ ...button(isMobile), height: isMobile ? 36 : 32, background: 'var(--ag-tint-2)', color: 'var(--text-primary)' }}
        >{t.about}</button>
      )}
      {onDeleted && <TaskMoreMenu id={task.id} task={task} lang={lang} onDeleted={onDeleted} onRename={() => setRenaming(true)} />}
    </div>
  )

  return (
    // The app's STANDARD card (`Section.tsx`): card background, 1px border, the large radius — no
    // glow, no coloured stripe. Status lives in the chip below, not in the frame.
    <section style={{
      position: 'relative', minWidth: 0, boxSizing: 'border-box',
      border: isMobile ? 'none' : '1px solid var(--border)',
      borderBottom: '1px solid var(--border)',
      borderRadius: isMobile ? 0 : 'var(--radius-lg)',
      padding: isMobile ? '14px 16px' : '16px 20px',
      background: 'var(--bg-card)',
    }}>
      <div style={{ display: 'flex', gap: isMobile ? 12 : 18, alignItems: isMobile ? 'flex-start' : 'center' }}>
        {subsTotal > 0 && (
          <Ring
            done={subsDone} inProgress={subsInProgress} blocked={subsBlocked} total={subsTotal}
            size={isMobile ? 56 : 68} statuses={statuses} counts={subtaskCounts}
            titles={effectiveSubtasks.filter(s => s.status === 'in_progress' || s.status === 'in_review').map(s => `${statusStyle(statuses, s.status).label}: ${s.title}`)} lang={lang}
          />
        )}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: 'var(--text-tertiary)', fontFamily: 'var(--mono, monospace)' }}>
            <button
              onClick={onBack} aria-label={t.back} title={t.back}
              style={{
                display: 'grid', placeItems: 'center', width: isMobile ? 36 : 26, height: isMobile ? 36 : 26,
                borderRadius: 7, border: '1px solid var(--border)', background: 'var(--ag-tint-2)',
                color: 'var(--text-secondary)', cursor: 'pointer', flex: '0 0 auto',
              }}
            ><ArrowLeft size={14} /></button>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>
              Agentask · {task.id}{subsTotal > 0 ? ` · ${t.subtasksOf(subsDone, subsTotal)}` : ''}
            </span>
            {isMobile && actions}
          </div>
          <h1 style={{
            margin: '6px 0 0', fontSize: isMobile ? 17 : 21, lineHeight: 1.2, fontWeight: 700, letterSpacing: '-0.01em',
            display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
          }}>
            {renaming ? (
              <span style={{ flex: '1 1 260px', minWidth: 0 }}>
                <RenameInput
                  value={task.title} ariaLabel={rename}
                  onCancel={() => setRenaming(false)}
                  onSave={async title => { await editTask(task.id, { title, actor: 'you' }); setRenaming(false); await reload() }}
                  style={{ fontSize: 'inherit', fontWeight: 'inherit' }}
                />
              </span>
            ) : (
              <>
                <span
                  data-task-title
                  title={rename}
                  onDoubleClick={() => setRenaming(true)}
                  style={{ minWidth: 0, overflowWrap: 'anywhere' }}
                >{task.title}</span>
                <button
                  type="button" data-rename-button onClick={() => setRenaming(true)} title={rename} aria-label={rename}
                  className="ag-tap-icon"
                  style={{ display: 'grid', placeItems: 'center', width: isMobile ? 32 : 22, height: isMobile ? 32 : 22, borderRadius: 6, border: 'none', background: 'transparent', color: 'var(--text-tertiary)', cursor: 'pointer', flex: '0 0 auto' }}
                ><Pencil size={13} /></button>
                <BetaTag what="Agentask" />
              </>
            )}
          </h1>
          <div style={{ marginTop: 8 }}>
            <TaskChips
              id={task.id} detail={detail} lang={lang} statuses={statuses} reload={reload}
              {...(onFileSession ? { onFileSession } : {})}
            >
              {live !== null && live > 0 && (
                <span style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6, height: 24, padding: '0 10px', borderRadius: 999,
                  fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap',
                  color: 'var(--accent-green)', background: 'var(--accent-green-dim)',
                }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor', boxShadow: '0 0 0 3px var(--accent-green-dim)' }} />
                  {t.liveNow(live)}
                </span>
              )}
            </TaskChips>
          </div>
        </div>
        {!isMobile && <div style={{ alignSelf: 'flex-start' }}>{actions}</div>}
      </div>

      <div style={{
        display: 'flex', flexWrap: 'wrap', marginTop: 14, border: '1px solid var(--border)', borderRadius: 9, overflow: 'hidden',
      }}>
        {kpis.filter(([, , desktopOnly]) => !(isMobile && desktopOnly)).map(([label, value], i) => (
          <div key={label} style={{
            flex: isMobile ? '1 1 33.3%' : '1 1 0', minWidth: 0, padding: isMobile ? '7px 10px' : '8px 14px',
            borderRight: '1px solid var(--border)', borderBottom: isMobile ? '1px solid var(--border)' : 'none',
            ...(isMobile && i === 2 ? { borderRight: 'none' } : {}),
          }}>
            <span style={{ display: 'block', fontSize: 10.5, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</span>
            <b style={{ fontSize: isMobile ? 14 : 16, fontWeight: 650, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{value}</b>
          </div>
        ))}
        <div style={{ flex: isMobile ? '1 1 100%' : '1.6 1 0', minWidth: 0, padding: isMobile ? '7px 10px' : '8px 14px' }}>
          <span style={{ display: 'block', fontSize: 10.5, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t.kpiMix}</span>
          {mix.length === 0
            ? <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{t.noMix}</span>
            : (
              <>
                <div style={{ display: 'flex', height: 6, borderRadius: 3, overflow: 'hidden', background: 'var(--ag-tint-3)', margin: '6px 0 4px' }}>
                  {mix.map(m => <i key={m.key} style={{ width: `${Math.max(m.pct, 0.6)}%`, background: harnessColor(m.key) }} />)}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 10px', fontSize: 11.5, color: 'var(--text-secondary)' }}>
                  {mix.map(m => (
                    <span key={m.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 2, background: harnessColor(m.key) }} />
                      {m.key} {m.pct.toLocaleString(lang === 'pt' ? 'pt-BR' : 'en-US')}%
                    </span>
                  ))}
                  {models.length > 0 && <span style={{ color: 'var(--text-tertiary)' }}>{models.join(' · ')}</span>}
                </div>
              </>
            )}
        </div>
      </div>
    </section>
  )
}

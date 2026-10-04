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
import { ArrowLeft } from 'lucide-react'
import type { TaskStatusDef } from '@agentistics/core'
import { useIsMobile } from '../../hooks/useIsMobile'
import type { TaskDetail } from '../../lib/tasks'
import { BetaTag } from '../BetaTag'
import { NA, PRIORITY, fmtInt, fmtTokens, harnessColor, statusStyle } from './board'
import { statusLabel } from './copy'
import { useMoney } from './money'
import { threadCopy, type Lang } from './threadCopy'
import { daysSince, mixOf } from './threadView'

function fmtHours(minutes: number | null, lang: Lang): string {
  if (minutes === null) return NA
  const total = Math.round(minutes)
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h === 0) return lang === 'pt' ? `${m}min` : `${m}m`
  return m === 0 ? `${h}h` : `${h}h ${m}${lang === 'pt' ? 'min' : 'm'}`
}

function Ring({ done, total, size }: { done: number; total: number; size: number }) {
  const pct = total === 0 ? 0 : Math.floor((done / total) * 100)
  const r = 36
  const c = 2 * Math.PI * r
  return (
    <div style={{ position: 'relative', width: size, height: size, flex: '0 0 auto' }} aria-label={`${pct}%`}>
      <svg width={size} height={size} viewBox="0 0 84 84" style={{ transform: 'rotate(-90deg)' }}>
        <circle cx="42" cy="42" r={r} fill="none" stroke="var(--ag-tint-3)" strokeWidth="8" />
        <circle
          cx="42" cy="42" r={r} fill="none" stroke="var(--anthropic-orange)" strokeWidth="8" strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - pct / 100)}
        />
      </svg>
      <b style={{
        position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
        fontSize: size > 60 ? 16 : 14, fontWeight: 700, fontVariantNumeric: 'tabular-nums',
      }}>{pct}%</b>
    </div>
  )
}

const pillBase = {
  display: 'inline-flex', alignItems: 'center', gap: 6, height: 24, padding: '0 10px', borderRadius: 999,
  fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' as const,
}

export function TaskHero({ detail, lang, statuses, live, onBack, onAbout }: {
  detail: TaskDetail
  lang: Lang
  statuses: readonly TaskStatusDef[] | null
  /** Sessions of this task running right now (fleet poll); `null` = the fleet is not known here. */
  live: number | null
  onBack: () => void
  onAbout?: () => void
}) {
  const isMobile = useIsMobile()
  const t = threadCopy(lang)
  const money = useMoney()
  const task = detail.task
  const st = statusStyle(statuses as TaskStatusDef[] | null, task.status)
  const pr = task.priority && task.priority !== 'none' ? PRIORITY[task.priority] : undefined
  const subsDone = detail.subtasks.filter(s => s.done).length
  const subsTotal = detail.subtasks.length
  const r = detail.rollup
  const cost = r.mixedCurrency || (r.credits !== null && r.costUSD === null)
    ? `${r.credits!.premiumRequests} req`
    : money(r.costUSD, r.costByHarness)
  const since = task.startedAt ?? task.createdAt
  const days = daysSince(since, Date.now())
  const mix = mixOf(detail.stats.harnesses)
  const models = detail.stats.models.filter(m => (m.tokens ?? 0) > 0).slice(0, 3).map(m => m.key)

  const kpis: Array<[string, string, boolean]> = [
    [t.kpiCost, cost, false],
    [t.kpiSessions, fmtInt(r.sessionsUsed), false],
    [t.kpiActive, fmtHours(r.activeMinutes, lang), false],
    [t.kpiRounds, fmtInt(r.rounds), true],
    [t.kpiTokens, fmtTokens(r.tokens), true],
  ]

  return (
    <section style={{
      position: 'relative', overflow: 'hidden',
      border: isMobile ? 'none' : '1px solid var(--border)',
      borderBottom: '1px solid var(--border)',
      borderRadius: isMobile ? 0 : 10,
      padding: isMobile ? '14px 16px' : '16px 20px',
      background: 'radial-gradient(120% 160% at 0% 0%, var(--anthropic-orange-glow), transparent 55%), var(--bg-card)',
    }}>
      <span aria-hidden style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: st.color }} />
      <div style={{ display: 'flex', gap: isMobile ? 12 : 18, alignItems: isMobile ? 'flex-start' : 'center' }}>
        {subsTotal > 0 && <Ring done={subsDone} total={subsTotal} size={isMobile ? 56 : 68} />}
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
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              Agentask · {task.id}{subsTotal > 0 ? ` · ${t.subtasksOf(subsDone, subsTotal)}` : ''}
            </span>
          </div>
          <h1 style={{
            margin: '6px 0 0', fontSize: isMobile ? 17 : 21, lineHeight: 1.2, fontWeight: 700, letterSpacing: '-0.01em',
            display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
          }}>
            <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{task.title}</span>
            <BetaTag what="Agentask" />
          </h1>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginTop: 8 }}>
            <span style={{ ...pillBase, color: st.color, background: st.dim }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'currentColor' }} />
              {statusLabel(task.status, lang, statuses as TaskStatusDef[] | null)}
            </span>
            {pr && <span style={{ ...pillBase, color: pr.color, background: pr.dim }}>{pr.label}</span>}
            {live !== null && live > 0 && (
              <span style={{ ...pillBase, color: 'var(--accent-green)', background: 'var(--accent-green-dim)' }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor', boxShadow: '0 0 0 3px var(--accent-green-dim)' }} />
                {t.liveNow(live)}
              </span>
            )}
            {days !== null && (
              <span style={{ ...pillBase, color: 'var(--text-secondary)', background: 'var(--ag-tint-2)', border: '1px solid var(--border)', fontWeight: 500 }}>
                {t.since(new Date(since).toLocaleDateString(lang === 'pt' ? 'pt-BR' : 'en-US', { day: '2-digit', month: '2-digit' }), days)}
              </span>
            )}
          </div>
        </div>
        {!isMobile && onAbout && (
          <button
            onClick={onAbout}
            style={{
              alignSelf: 'flex-start', height: 32, padding: '0 12px', borderRadius: 8, border: '1px solid var(--border)',
              background: 'var(--ag-tint-2)', color: 'var(--text-primary)', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
            }}
          >{t.about}</button>
        )}
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

/**
 * BoardOverviewView — the DEFAULT view of the board: what the work is costing.
 *
 * The kanban answers "which column is full", which is a tracking question. This answers "what is my
 * work costing me", which is the question the product exists for — so it opens here.
 *
 * Every card states TWO things, always: what the number MEANS (`help`, one line, always present —
 * the same rule `TOKEN_KINDS`'s `help` field applies to a token total, applied here to every KPI) and,
 * only when the population behind it is incomplete, WHY (`gap` — a task nobody could price, a metric
 * no linked session reported). A number with no account of what it counts reads as a fault; a gap left
 * unstated is a number that looks like a measurement and is not.
 *
 * Related metrics are grouped under a section heading (Delivery / Cost / Volume) rather than left as
 * one undifferentiated grid, and the whole screen — cards, chart and ranked lists — reflows to a
 * single narrow column under `useIsMobile()`, per this repo's mobile rule.
 */

import { useMemo, type ReactNode } from 'react'
import { useOutletContext } from 'react-router-dom'
import { CircleDashed, CircleCheck, CircleSlash, Coins, Timer, Activity } from 'lucide-react'
import {
  COLUMN_ORDER, NA, STATUS, fmtInt, fmtTokens, harnessColor, microLabel, numeric, surface,
} from './board'
import { useMoney } from './money'
import { fmtDuration, type BoardOverview, type Bucket } from '../../lib/tasks'
import { ActivityChart } from '../ActivityChart'
import { toBoardChartData } from '../../lib/boardActivity'
import { useIsMobile } from '../../hooks/useIsMobile'
import type { AppContext } from '../../lib/app-context'

/** A section heading over a group of related cards — bolder than a card's own `microLabel`, so the
 *  grouping reads at a glance instead of only through the gap between grids. */
const sectionLabel = {
  fontSize: 11,
  fontWeight: 650 as const,
  color: 'var(--text-secondary)',
  textTransform: 'uppercase' as const,
  letterSpacing: '0.04em',
}

function Big({ label, value, help, gap, icon, accent }: {
  label: string
  value: string
  /** One-line explanation of what this number measures — always shown, never omitted. */
  help: string
  /** A caveat about an incomplete population behind the number — shown only when there is one. */
  gap?: string
  icon?: React.ReactNode
  accent?: boolean
}) {
  const absent = value === NA
  return (
    <div style={{ ...surface, padding: 14, display: 'grid', gap: 4, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {icon}
        <span style={microLabel}>{label}</span>
      </div>
      <div style={{
        fontSize: 24, fontWeight: 650, fontVariantNumeric: 'tabular-nums', lineHeight: 1.1,
        color: absent ? 'var(--text-tertiary)' : accent ? 'var(--anthropic-orange)' : 'var(--text-primary)',
      }}>{value}</div>
      <div style={{ fontSize: 10.5, color: 'var(--text-tertiary)', lineHeight: 1.4 }}>{help}</div>
      {gap && (
        <div style={{ fontSize: 10.5, color: 'var(--text-secondary)', lineHeight: 1.4 }}>{gap}</div>
      )}
    </div>
  )
}

/** A heading over a group of `Big` cards, in the same responsive grid every group shares. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={sectionLabel}>{title}</div>
      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
        {children}
      </div>
    </div>
  )
}

function Ranked({ title, help, items, color }: {
  title: string
  help: string
  items: Bucket[]
  color?: (key: string) => string
}) {
  const top = Math.max(...items.map(i => i.tokens ?? 0), 1)
  return (
    <div style={{ ...surface, padding: 14, display: 'grid', gap: 10, minWidth: 0 }}>
      <div style={{ display: 'grid', gap: 3 }}>
        <div style={microLabel}>{title}</div>
        <div style={{ fontSize: 10.5, color: 'var(--text-tertiary)', lineHeight: 1.4 }}>{help}</div>
      </div>
      {items.length === 0
        ? <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>Nothing reported one.</div>
        : items.slice(0, 6).map(i => {
          const pct = i.tokens === null ? 0 : Math.round((i.tokens / top) * 100)
          return (
            <div key={i.key} style={{ display: 'grid', gap: 4 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span style={{
                  fontSize: 11.5, color: 'var(--text-secondary)', minWidth: 0,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>{i.key}</span>
                <span style={{ ...numeric, fontSize: 11.5, flexShrink: 0 }}>
                  {fmtTokens(i.tokens)}
                  <span style={{ color: 'var(--text-tertiary)' }}> · {i.sessions}s</span>
                </span>
              </div>
              <div style={{ height: 5, borderRadius: 3, background: 'var(--bg-elevated)' }}>
                <div style={{
                  width: `${pct}%`, height: '100%', borderRadius: 3,
                  background: color ? color(i.key) : 'var(--anthropic-orange)',
                }} />
              </div>
            </div>
          )
        })}
    </div>
  )
}

/**
 * The board's own activity-over-time chart — reuses `ActivityChart` (the same one the dashboard's
 * heatmap and repo/tag detail pages already draw) rather than a bespoke chart, per this repo's
 * "reuse, don't reinvent" rule. See `lib/boardActivity.ts` for why the three series are all plain
 * counts and never a dollar figure.
 *
 * On mobile the metric pills/Overlay/Axes/Legend toggle row is HIDDEN (`hideControls`) and every
 * series is drawn overlaid instead (`forcedOverlay`) — the same locked-compact mode
 * `componentCatalog.tsx`'s own catalog variants already use — because that toggle row's buttons
 * are well under the 44px mobile touch target and a phone-width column has no room for five of
 * them anyway. Overlaying loses nothing: all three series are still visible at once.
 */
function BoardActivity({ daily, isMobile }: { daily: BoardOverview['daily']; isMobile: boolean }) {
  const ctx = useOutletContext<AppContext | null>()
  const theme = ctx?.theme === 'light' ? 'light' : 'dark'
  const chartData = useMemo(() => toBoardChartData(daily), [daily])
  const labels = { value: 'Sessions started', sessions: 'Delivered', tools: 'Created' }

  return (
    <div style={{ ...surface, padding: 14, display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Activity size={13} style={{ color: 'var(--anthropic-orange)' }} />
        <span style={sectionLabel}>Board activity over time</span>
      </div>
      <div style={{ fontSize: 10.5, color: 'var(--text-tertiary)', lineHeight: 1.4 }}>
        Sessions started, tasks delivered and tasks created, by day, across every task on the board.
        A day with no board activity is left out of the chart rather than drawn as a false zero.
      </div>
      {isMobile ? (
        <ActivityChart data={chartData} theme={theme} height={160} forcedOverlay hideControls metricLabels={labels} />
      ) : (
        <ActivityChart data={chartData} theme={theme} height={220} metricLabels={labels} />
      )}
    </div>
  )
}

export function BoardOverviewView({ o }: { o: BoardOverview }) {
  const money = useMoney()
  const isMobile = useIsMobile()

  // The population behind "avg cost / task" and "total spent" is every task on the board; the
  // population behind "avg cost / delivery" is delivered tasks only. Conflating the two used to
  // caption both cards with the same board-wide count, which overstated the gap on the delivered
  // figure whenever an OPEN task (never priced because it never had sessions filed yet) was mixed in.
  const boardGap = o.tasksWithoutCost > 0
    ? `${o.tasksWithoutCost} of ${o.tasks} task${o.tasks === 1 ? '' : 's'} have no priced sessions and are excluded.`
    : undefined
  const deliveredGap = o.deliveredWithoutCost > 0
    ? `${o.deliveredWithoutCost} of ${o.delivered} delivered task${o.delivered === 1 ? '' : 's'} could not be priced.`
    : undefined

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <Section title="Delivery">
        <Big
          label="In flight" value={String(o.inFlight)}
          icon={<CircleDashed size={13} style={{ color: 'var(--anthropic-orange)' }} />}
          help="Open work — not yet delivered or abandoned."
          gap={`Out of ${o.tasks} task${o.tasks === 1 ? '' : 's'} on the board.`}
        />
        <Big
          label="Delivered" value={String(o.delivered)}
          icon={<CircleCheck size={13} style={{ color: 'var(--accent-green)' }} />}
          help="Tasks marked done."
          gap={o.abandoned > 0
            ? `${o.abandoned} more task${o.abandoned === 1 ? '' : 's'} abandoned — not counted as delivered.`
            : undefined}
        />
        <Big
          label="Avg delivery time" value={fmtDuration(o.avgDeliveryMs) ?? NA}
          icon={<Timer size={13} style={{ color: 'var(--accent-blue)' }} />}
          help="Mean wall-clock time from a task's creation to its delivery."
          gap={o.avgDeliveryMs === null ? 'Nothing delivered yet — an open task has no duration.' : undefined}
        />
      </Section>

      <Section title="Cost">
        <Big
          label="Avg cost / delivery" value={money(o.avgCostPerDelivered)} accent
          icon={<Coins size={13} style={{ color: 'var(--anthropic-orange)' }} />}
          help="Mean spend across delivered tasks that could be priced."
          gap={o.avgCostPerDelivered === null
            ? (o.delivered === 0 ? 'Nothing delivered yet.' : 'None of the delivered tasks could be priced.')
            : deliveredGap}
        />
        <Big
          label="Avg cost / task" value={money(o.avgCostPerTask)}
          icon={<Coins size={13} style={{ color: 'var(--text-tertiary)' }} />}
          help="Mean spend across every priced task, open or delivered."
          gap={boardGap}
        />
        <Big
          label="Total spent" value={money(o.totalCostUSD)}
          icon={<Coins size={13} style={{ color: 'var(--text-tertiary)' }} />}
          help={`Sum across every priced task — ${fmtTokens(o.totalTokens)} tokens in total.`}
          gap={boardGap}
        />
      </Section>

      <Section title="Volume">
        <Big
          label="Rounds / task" value={o.avgRoundsPerTask === null ? NA : o.avgRoundsPerTask.toFixed(1)}
          help="Mean user turns per task, counting only linked sessions that reported a turn count."
          gap={o.avgRoundsPerTask === null ? 'No linked session has reported a turn count yet.' : undefined}
        />
        <Big
          label="Sessions / task" value={o.avgSessionsPerTask === null ? NA : o.avgSessionsPerTask.toFixed(1)}
          help="Mean distinct conversations per task — above 1 means the work outgrew one conversation."
          gap={o.avgSessionsPerTask === null ? 'No task on the board yet.' : undefined}
        />
        <Big
          label="Sessions filed" value={fmtInt(o.totalSessions)}
          help="Distinct conversations filed across every task on the board, reopens counted once."
        />
      </Section>

      <div style={{ ...surface, padding: 14, display: 'grid', gap: 8 }}>
        <div style={microLabel}>Where the work stands</div>
        <div style={{ fontSize: 10.5, color: 'var(--text-tertiary)', lineHeight: 1.4 }}>
          How many tasks currently sit in each column. A column at zero is shown, dimmed, rather than
          left off the row.
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {COLUMN_ORDER.map(st => {
            const c = STATUS[st]
            const n = o.statusCounts[st] ?? 0
            return (
              <div key={st} style={{
                display: 'flex', alignItems: 'center', gap: 7, padding: '5px 11px', borderRadius: 8,
                background: n > 0 ? c.dim : 'transparent',
                border: `1px solid ${n > 0 ? c.color : 'var(--border)'}`,
                opacity: n > 0 ? 1 : 0.5,
              }}>
                <span style={{ fontSize: 11.5, color: n > 0 ? c.color : 'var(--text-tertiary)' }}>{c.label}</span>
                <span style={{ ...numeric, fontSize: 13, color: n > 0 ? c.color : 'var(--text-tertiary)' }}>{n}</span>
              </div>
            )
          })}
        </div>
      </div>

      <BoardActivity daily={o.daily} isMobile={isMobile} />

      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
        <Ranked
          title="Top models across tasks"
          help="Ranked by tokens across every linked session. Only sessions that reported a model are counted."
          items={o.topModels}
        />
        <Ranked
          title="Harnesses"
          help="Ranked by tokens across every linked session, grouped by harness."
          items={o.topHarnesses} color={harnessColor}
        />
      </div>

      {o.tasks === 0 && (
        <div style={{ ...surface, padding: 16, fontSize: 12.5, color: 'var(--text-tertiary)', display: 'flex', gap: 8, alignItems: 'center' }}>
          <CircleSlash size={15} /> No tasks yet — the numbers above are empty because there is
          nothing to measure, not because the measuring failed.
        </div>
      )}
    </div>
  )
}

/**
 * CronogramaTree — the ONE renderer of the Cronograma (week) and of the Day view: a tree task → group → subtask on the
 * left (connectors, ▼/▶ fold remembered per person) and a timeline on the right. Task and group rows carry the % and a
 * progress ring and NO checkbox (a task is not ticked, it is the sum of its subtasks); a subtask carries its phase chip
 * and a checkbox that is ticked once it is published. All the rules about what a bar covers live in
 * `lib/cronogramaTree.ts`; this file only draws them.
 */
import { useEffect, useMemo, useRef } from 'react'
import { brtDay, brtDayStartMs, type CalPiece } from '@agentistics/core'
import { addDays, DAY_MS, dowShort, weekdayMon0 } from '../../lib/calendarModel'
import { useCronogramaCollapsed } from '../../lib/cronogramaCollapsed'
import {
  buildTree, clipToAxis, dayAxis, dayFocusMs, dayHint, dayLeftOut, dayPieces, fillSplit, flattenTree, isDelivered, MIN_BAR_UNITS, overlayGone, pieceSpanOf, progressOf, spanOf, unitsAt, weekAxis, weekPieces,
  type Axis, type Span, type TreeRow,
} from '../../lib/cronogramaTree'
import { Ring } from '../tasks/TaskHero'
import { TEXT, pick } from './calendarText'
import { stageColor, stageName } from './calendarUi'
import './cronograma.css'

const WD_PT = ['S', 'T', 'Q', 'Q', 'S', 'S', 'D']
const WD_EN = ['M', 'T', 'W', 'T', 'F', 'S', 'S']

export const CRONO_TEXT = {
  weekHead: { pt: 'Tarefa · subtarefas', en: 'Task · subtasks' },
  dayHead: { pt: 'Hoje · tarefa e subtarefas', en: 'Today · task and subtasks' },
  dayHeadOther: { pt: 'Dia · tarefa e subtarefas', en: 'Day · task and subtasks' },
  noDate: { pt: 'sem data · fica na fila', en: 'no date · stays in queue' },
  expected: { pt: 'previsto', en: 'expected' },
  footWeek: { pt: 'Barras = datas reais de início e entrega. Subtarefa sem data não vira barra: fica marcada na coluna de hoje como “sem data”.', en: 'Bars = real start and delivery dates. A subtask with no date gets no bar: it is marked on today’s column as “no date”.' },
  footDay: { pt: 'Cada linha é uma peça com atividade hoje. Sem horário real, aparece só o chip “sem horário” — nunca um bloco de dia inteiro.', en: 'Each row is a piece with activity today. With no real time only the “no time” chip shows — never a whole-day block.' },
  footDayOther: { pt: 'Cada linha é uma peça com atividade neste dia. Sem horário real, aparece só o chip “sem horário” — nunca um bloco de dia inteiro.', en: 'Each row is a piece with activity that day. With no real time only the “no time” chip shows — never a whole-day block.' },
  leftOut: { pt: (n: number, today: boolean) => `${n} ${n === 1 ? 'peça sem atividade' : 'peças sem atividade'} ${today ? 'hoje' : 'neste dia'} ${n === 1 ? 'fica fora' : 'ficam fora'}.`, en: (n: number, today: boolean) => `${n} ${n === 1 ? 'piece' : 'pieces'} with no activity ${today ? 'today' : 'that day'} left out.` },
  fold: { pt: 'Recolher / expandir', en: 'Collapse / expand' },
} as const

interface Props {
  mode: 'week' | 'day'
  /** week: the anchor day (the Monday of its week starts the axis). day: the day. */
  anchor: string
  nowMs: number
  pieces: readonly CalPiece[]
  pt: boolean
  selected: string | null
  onOpenPiece: (key: string, e: React.MouseEvent) => void
}

const calc = (units: number, extra = '') => `calc(var(--DW) * ${units}${extra})`

export function CronogramaTree({ mode, anchor, nowMs, pieces, pt, selected, onOpenPiece }: Props) {
  const [collapsed, toggle] = useCronogramaCollapsed()
  const today = brtDay(nowMs)
  const mondayDay = addDays(anchor, -weekdayMon0(anchor))
  const tl = useRef<HTMLDivElement>(null)
  const { rows, axis, listed, leftOut, focusMs } = useMemo(() => {
    if (mode === 'week') {
      const ax = weekAxis(mondayDay)
      const list = weekPieces(pieces, ax, nowMs)
      return { rows: flattenTree(buildTree(list), collapsed), axis: ax, listed: list, leftOut: 0, focusMs: nowMs }
    }
    const list = dayPieces(pieces, anchor, nowMs, today)
    const spans = list.flatMap(p => { const s = pieceSpanOf(p, nowMs); return s ? [s] : [] })
    return { rows: flattenTree(buildTree(list), collapsed), axis: dayAxis(anchor, spans, nowMs), focusMs: dayFocusMs(anchor, spans, nowMs, dayAxis(anchor, spans, nowMs).startMs), listed: list, leftOut: dayLeftOut(pieces, anchor, nowMs, today) }
  }, [mode, anchor, mondayDay, pieces, nowMs, collapsed, today])

  // Open with "now" (week: today's column) in view: the first columns are usually the oldest, already-finished days.
  const focusUnits = axis.mode === 'week' ? Math.floor(unitsAt(axis, brtDayStartMs(today))) : unitsAt(axis, focusMs)
  useEffect(() => {
    const el = tl.current
    // Both views open with "now" mid-window like the prototype (the % and ring stay pinned beside the title column, so scrolling away from Monday costs nothing).
    if (!el || focusUnits < 0 || focusUnits > axis.units) return
    const dw = parseFloat(getComputedStyle(el.firstElementChild as Element).getPropertyValue('--DW')) || 96
    const lw = parseFloat(getComputedStyle(el.firstElementChild as Element).getPropertyValue('--LW')) || 330
    // Wide screens centre "now"; a narrow one puts today half a column from the title column, so today's "sem data" chip and forecast are not cut off on the right.
    const visible = el.clientWidth - lw
    el.scrollLeft = Math.max(0, focusUnits * dw - (axis.mode === 'week' && visible < 480 ? dw / 2 : visible / 2))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, anchor, listed.length === 0])

  // The sticky overlays (chip, checkbox, hint, %) may overflow their bar's end only while the bar is visible: mark a bar `data-gone`
  // as soon as it has slid under the title column, so no chip is left floating over empty timeline.
  useEffect(() => {
    const el = tl.current
    if (!el) return
    let raf = 0
    const sync = () => {
      raf = 0
      const lc = el.querySelector('.crono-hrow .crono-lc')
      if (!lc) return
      const lw = lc.getBoundingClientRect().right
      const bars = Array.from(el.querySelectorAll<HTMLElement>('.crono-bar'))
      const gone = bars.map(b => overlayGone(b.getBoundingClientRect().right, lw))
      bars.forEach((b, i) => { if (gone[i] !== b.hasAttribute('data-gone')) b.toggleAttribute('data-gone', gone[i]) })
    }
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(sync) }
    el.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    sync()
    return () => { el.removeEventListener('scroll', onScroll); window.removeEventListener('resize', onScroll); if (raf) cancelAnimationFrame(raf) }
  }, [rows, axis])

  if (listed.length === 0) {
    return <div data-cal-empty style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-tertiary)', fontSize: 12.5, padding: 20, textAlign: 'center' }}>{pick(TEXT.emptyTitle, pt)}</div>
  }

  const W = axis.mode === 'week'
  const nowUnits = unitsAt(axis, nowMs)
  const nowVisible = nowUnits >= 0 && nowUnits <= axis.units
  const todayUnits = W ? Math.floor(unitsAt(axis, brtDayStartMs(today))) : 0
  const todayIn = W && todayUnits >= 0 && todayUnits < axis.units
  const wd = pt ? WD_PT : WD_EN

  const head = W
    ? Array.from({ length: axis.units }, (_, i) => {
        const d = brtDay(axis.startMs + i * DAY_MS + 12 * 3600_000)
        const dow = weekdayMon0(d)
        return <div key={d} className="crono-col" data-cal-col={d} data-today={d === today ? '' : undefined} data-we={dow > 4 ? '' : undefined}><span title={dowShort(dow, pt)}>{wd[dow]}</span><b>{Number(d.slice(8))}</b></div>
      })
    : Array.from({ length: axis.units }, (_, i) => <div key={i} className="crono-col" data-hr="" data-cal-hour><span>{String(Math.round((axis.startMs - brtDayStartMs(anchor)) / 3_600_000) + i).padStart(2, '0')}h</span></div>)

  const weekend = W ? Array.from({ length: axis.units }, (_, i) => i).filter(i => weekdayMon0(brtDay(axis.startMs + i * DAY_MS + 12 * 3600_000)) > 4) : []

  return (
    <div className="crono" data-mode={axis.mode} data-cal-schedule={W ? '' : undefined} data-cal-day-view={W ? undefined : ''} data-cal-day={W ? undefined : anchor}>
      <div className="crono-head" data-cal-tree-head>
        <div className="crono-legend" data-cal-legend>
          <span><i aria-hidden className="crono-key" style={{ background: stageColor('running') }} />{pick(W ? TEXT.legendRunning : TEXT.legendDone, pt)}</span>
          {W && <span><i aria-hidden className="crono-key" style={{ background: stageColor('published') }} />{pick(TEXT.legendPublishedPiece, pt)}</span>}
          <span><i aria-hidden className={`crono-key ${W ? 'crono-sem' : 'crono-prev'}`} />{pick(TEXT.legendForecast, pt)}</span>
          {W
            ? <span><i aria-hidden className="crono-key" style={{ background: 'var(--navy2)' }} />{pick(TEXT.legendTaskGroup, pt)}</span>
            : <span><i aria-hidden className="crono-key crono-sem" />{pick(TEXT.noTime, pt)}</span>}
        </div>
      </div>
      <div className="crono-tl" data-cal-tree ref={tl}>
        <div className="crono-in">
          <div className="crono-hrow">
            <div className="crono-lc">{pick(W ? CRONO_TEXT.weekHead : anchor === today ? CRONO_TEXT.dayHead : CRONO_TEXT.dayHeadOther, pt)}</div>
            <div className="crono-cols">{head}</div>
          </div>
          {rows.map(r => <Row key={r.node.id} r={r} axis={axis} nowMs={nowMs} pt={pt} folded={collapsed.has(r.node.id)} onFold={() => toggle(r.node.id)}
            selected={selected} onOpenPiece={onOpenPiece} todayIn={todayIn} todayUnits={todayUnits} W={W} weekend={weekend} />)}
          {nowVisible && (!W || todayIn) && <div className="crono-now" data-cal-now aria-hidden style={{ left: `calc(var(--LW) + var(--DW) * ${nowUnits})` }} />}
        </div>
      </div>
      <div className="crono-foot" data-cal-foot>{pick(W ? CRONO_TEXT.footWeek : anchor === today ? CRONO_TEXT.footDay : CRONO_TEXT.footDayOther, pt)}{!W && leftOut > 0 && <> <span data-cal-left-out={leftOut}>{(pt ? CRONO_TEXT.leftOut.pt : CRONO_TEXT.leftOut.en)(leftOut, anchor === today)}</span></>}</div>
    </div>
  )
}

function Row({ r, axis, nowMs, pt, folded, onFold, selected, onOpenPiece, todayIn, todayUnits, W, weekend }: {
  r: TreeRow; axis: Axis; nowMs: number; pt: boolean; folded: boolean; onFold: () => void; selected: string | null
  onOpenPiece: (key: string, e: React.MouseEvent) => void; todayIn: boolean; todayUnits: number; W: boolean; weekend: number[]
}) {
  const n = r.node
  const d = r.guides.length
  const hasKids = n.children.length > 0
  const prog = n.kind === 'sub' ? null : progressOf(n)
  const span = spanOf(n, nowMs)
  const p = n.piece
  const done = p ? isDelivered(p) : false
  const guides: React.ReactNode[] = []
  for (let i = 0; i < d; i++) {
    guides.push(<span key={i} className="crono-g" data-g={i < d - 1 ? (r.guides[i] === 'line' ? 'line' : 'none') : r.last ? 'elb' : 'tee'} />)
  }
  const openable = n.kind === 'sub' && p
  return (
    <div className="crono-row" data-cal-row={n.id} data-kind={n.kind} data-done={done ? '' : undefined} data-cal-piece-row={p?.key}>
      <div className="crono-lc">
        {guides}
        <button type="button" className="crono-chev" data-cal-fold={n.id} data-nil={hasKids ? undefined : ''} aria-expanded={hasKids ? !folded : undefined} aria-label={pick(CRONO_TEXT.fold, pt)} onClick={onFold} tabIndex={hasKids ? 0 : -1}>{folded ? '▶' : '▼'}</button>
        <button type="button" className="crono-ttl" title={n.title} data-open={openable ? '' : undefined} onClick={e => { if (openable) onOpenPiece(p.key, e) }}>{n.title}</button>
        {prog && <span className="crono-n" data-cal-count>{prog.done}/{prog.total}</span>}
      </div>
      <div className="crono-track" style={{ width: calc(axis.units) }}>
        {weekend.map(i => <div key={i} className="crono-wk" style={{ left: calc(i), width: calc(1) }} />)}
        {span ? <BarFor r={r} span={span} axis={axis} nowMs={nowMs} pt={pt} prog={prog} selected={selected} onOpenPiece={onOpenPiece} />
          : n.kind === 'sub' && p && !isDelivered(p) ? (
            <span className="crono-semw" data-cal-semw><span className="crono-sem" data-cal-chip="no-date" style={{ marginLeft: W ? (todayIn ? calc(todayUnits, ' + 6px') : '6px') : '8px' }}>{pick(W ? CRONO_TEXT.noDate : TEXT.noTime, pt)}</span></span>
          ) : null}
      </div>
    </div>
  )
}

function BarFor({ r, span, axis, nowMs, pt, prog, selected, onOpenPiece }: {
  r: TreeRow; span: Span; axis: Axis; nowMs: number; pt: boolean; prog: { done: number; total: number; percent: number } | null
  selected: string | null; onOpenPiece: (key: string, e: React.MouseEvent) => void
}) {
  const n = r.node
  const clip = clipToAxis(axis, span)
  if (!clip) return null
  const W = axis.mode === 'week'
  const width = Math.max(MIN_BAR_UNITS, clip.to - clip.from)
  const geo = { left: calc(clip.from), width: calc(width, ' - 3px') }
  const hasForecast = span.endMs > nowMs && !span.delivered
  const day = brtDay(axis.startMs)
  const words = { since: pick(TEXT.since, pt), continues: pick(TEXT.continues, pt), now: pick(TEXT.now, pt) }
  const endKnown = span.delivered || hasForecast || (n.kind === 'sub' && n.piece!.stage === 'queue')
  const hint = !W ? dayHint(span, day, endKnown ? 'clock' : 'now', words, pt) : ''

  if (n.kind !== 'sub') {
    const pr = prog!
    const dayEndMs = axis.startMs + axis.units * axis.unitMs
    const hintText = `${hint}${span.endMs > nowMs && nowMs < dayEndMs ? ` ${pick(CRONO_TEXT.expected, pt)}` : ''}`
    return (
      <div className="crono-bar" data-kind={n.kind} data-cal-bar={n.kind} style={geo} title={n.title} aria-label={W ? undefined : `${n.title} · ${hint}`}>
        <span className="crono-pw" data-cal-pw style={{ ['--cw' as string]: `${W ? 62 : Math.round(hintText.length * 5.6 + 16)}px` }}>
          <span className="crono-pin" data-cal-pin>
            {W ? <>
              <span className="crono-pc" data-cal-pct>{pr.percent}%</span>
              <span className="crono-ring" data-cal-ring><Ring bare done={pr.done} inProgress={0} blocked={0} total={pr.total} size={15} statuses={null} counts={{}} titles={[]} lang={pt ? 'pt' : 'en'} /></span>
            </> : <span className="crono-hint" data-cal-hint style={{ marginLeft: 0 }}>{hintText}</span>}
          </span>
        </span>
      </div>
    )
  }
  const p = n.piece!
  const c = stageColor(p.stage)
  const plan = p.stage === 'queue'
  const done = isDelivered(p)
  const { solidPct, expectedPct: prevPct } = fillSplit(axis, span, nowMs, hasForecast && !plan)
  const hintSub = !W ? `${plan ? `${pick(CRONO_TEXT.expected, pt)} ` : ''}${hint}` : ''
  const chipW = Math.round(stageName(p.stage, pt).length * 5.9 + 18)
  return (
    <button type="button" className="crono-bar" data-kind="sub" data-cal-bar-piece={p.key} data-cal-bar="sub" data-done={done ? '' : undefined} data-plan={plan ? '' : undefined}
      style={{ ...geo, ['--c' as string]: c, outline: selected === p.key ? '1.5px solid var(--anthropic-orange)' : undefined }} title={n.title} aria-label={W ? undefined : `${n.title} · ${stageName(p.stage, pt)} · ${plan ? `${pick(CRONO_TEXT.expected, pt)} ` : ''}${hint}`} onClick={e => onOpenPiece(p.key, e)}>
      <span className="crono-clip" aria-hidden>
        {!plan && !done && <span className="crono-fill" style={{ width: `${solidPct}%` }} />}
        {prevPct > 0 && <span className="crono-prev" data-cal-seg="expected" style={{ width: `${prevPct}%` }} />}
      </span>
      {/* The in-flow copy keeps the layout; the visible chip floats in an overlay so it can stay whole at the visible start of the bar, overflowing right of a bar too narrow for it. */}
      <span className="crono-ph crono-phs" aria-hidden>{stageName(p.stage, pt)}</span>
      <span className="crono-phw" style={{ ['--cw' as string]: `${chipW + 20 + (hintSub ? Math.round(hintSub.length * 5.6 + 8) : 0)}px` }}>
        <span className="crono-stk" data-cal-stk>
          <span className="crono-ph" data-cal-phase={p.stage} data-sticky="">{stageName(p.stage, pt)}</span>
          <span className="crono-cb" data-cal-cb data-on={done ? '' : undefined}>{done ? '✓' : ''}</span>
          {hintSub && <span className="crono-hint" data-cal-hint style={{ marginLeft: 0 }}>{hintSub}</span>}
        </span>
      </span>
    </button>
  )
}

/**
 * Observed history by PIECE (subtask): the rows behind "Por tarefa" and "Por número de sessões".
 * PURE: plain data in, numbers out. Method: leader/metodo/ANALISE.md — a piece is a subtask `done` or
 * `in_review` with at least one linked session; size comes from the lines its sessions changed; cost is
 * tokens × price per session (never an allocation); everything that could not be measured is `null`,
 * and the coverage says how much of the pieces carry each figure. Observed and biased: no verdict here.
 */
import { percentile } from '../deliveryMetrics'

export type PieceSize = 'S' | 'M' | 'L'
export const SIZE_LINES = { mediumFrom: 100, largeFrom: 500 } as const
export const sizeOfLines = (lines: number | null): PieceSize | null =>
  lines === null ? null : lines >= SIZE_LINES.largeFrom ? 'L' : lines >= SIZE_LINES.mediumFrom ? 'M' : 'S'

/** Sessions per piece, in the buckets the owner asked for. */
export const BUCKETS = [
  { label: '1', min: 1, max: 1 }, { label: '2-3', min: 2, max: 3 }, { label: '4-6', min: 4, max: 6 }, { label: '7+', min: 7, max: null },
] as const

export interface HistorySession { id: string; harness: string; costUSD: number | null }
export interface HistoryPieceInput {
  id: string; taskId: string; title: string; status: string
  sessions: HistorySession[]
  /** Lines added + removed by the piece's sessions; null = no session reported any. */
  lines: number | null
  startMs: number | null; endMs: number | null
  /** QA rounds (rejections + 1); null = the piece has no recorded QA outcome. */
  qaRounds: number | null
  activeMs: number | null
}

export interface HistorySubtaskRow {
  id: string; title: string; status: string; size: PieceSize | null; sessions: number
  costUSD: number | null; costPartial: boolean; wallMs: number | null; activeMs: number | null
  qaRounds: number | null; reworked: boolean | null; lines: number | null
}
export interface HistoryTaskRow {
  id: string; title: string; status: string; size: PieceSize | null; pieces: number; sessions: number
  costUSD: number | null; costPartial: boolean; wallMs: number | null; activeMs: number | null
  qaRounds: number | null; reworkedPieces: number | null; lines: number | null
  subtasks: HistorySubtaskRow[]
}
export interface HistoryBucket {
  label: string; pieces: number
  costMedianUSD: number | null; nCost: number; wallMedianMs: number | null; nWall: number; reworkRate: number | null; nRework: number
}
export interface HistoryCoverage {
  pieces: number; withCost: number; withWall: number; withQa: number; withSize: number; withActive: number
  /** Share of pieces with a measured cost, 0–100; null with no pieces. */
  pctWithCost: number | null
  /** Harnesses none of whose linked sessions has a cost. */
  harnessesWithoutCost: string[]
  /** Harnesses with a cost for some sessions and not others. */
  harnessesPartialCost: string[]
}
export interface ObservedHistory {
  pieces: number
  tasks: HistoryTaskRow[]
  buckets: HistoryBucket[]
  coverage: HistoryCoverage
}

const sum = (v: number[]) => v.reduce((a, b) => a + b, 0)
const DONE = new Set(['done', 'in_review'])

function subtaskRow(p: HistoryPieceInput): HistorySubtaskRow {
  const priced = p.sessions.filter(s => s.costUSD !== null)
  return {
    id: p.id, title: p.title, status: p.status, size: sizeOfLines(p.lines), sessions: p.sessions.length,
    costUSD: priced.length ? sum(priced.map(s => s.costUSD!)) : null, costPartial: priced.length > 0 && priced.length < p.sessions.length,
    wallMs: p.startMs !== null && p.endMs !== null ? Math.max(0, p.endMs - p.startMs) : null, activeMs: p.activeMs,
    qaRounds: p.qaRounds, reworked: p.qaRounds === null ? null : p.qaRounds >= 2, lines: p.lines,
  }
}

export function buildHistory(input: { pieces: readonly HistoryPieceInput[]; tasks: readonly { id: string; title: string; status?: string }[]; filters?: { fromMs?: number; toMs?: number } }): ObservedHistory {
  const f = input.filters
  const kept = input.pieces.filter(p => DONE.has(p.status) && p.sessions.length > 0 && (
    (f?.fromMs === undefined || (p.endMs !== null && p.endMs >= f.fromMs)) && (f?.toMs === undefined || (p.endMs !== null && p.endMs <= f.toMs))))
  const rows = kept.map(p => ({ p, r: subtaskRow(p) }))

  const taskInfo = new Map(input.tasks.map(t => [t.id, t]))
  const byTask = new Map<string, typeof rows>()
  for (const x of rows) byTask.set(x.p.taskId, [...(byTask.get(x.p.taskId) ?? []), x])
  const tasks: HistoryTaskRow[] = [...byTask.entries()].map(([id, xs]) => {
    const rs = xs.map(x => x.r), ps = xs.map(x => x.p)
    const priced = rs.filter(r => r.costUSD !== null)
    const lines = ps.filter(p => p.lines !== null)
    const starts = ps.map(p => p.startMs).filter((v): v is number => v !== null), ends = ps.map(p => p.endMs).filter((v): v is number => v !== null)
    const actives = rs.map(r => r.activeMs).filter((v): v is number => v !== null)
    const qa = rs.filter(r => r.qaRounds !== null)
    const info = taskInfo.get(id)
    return {
      id, title: info?.title ?? id, status: info?.status ?? (rs.every(r => r.status === 'done') ? 'done' : 'in_review'),
      size: sizeOfLines(lines.length ? sum(lines.map(p => p.lines!)) : null), pieces: rs.length, sessions: sum(rs.map(r => r.sessions)),
      costUSD: priced.length ? sum(priced.map(r => r.costUSD!)) : null, costPartial: priced.length > 0 && (priced.length < rs.length || rs.some(r => r.costPartial)),
      wallMs: starts.length && ends.length ? Math.max(0, Math.max(...ends) - Math.min(...starts)) : null,
      activeMs: actives.length ? sum(actives) : null,
      qaRounds: qa.length ? sum(qa.map(r => r.qaRounds!)) : null, reworkedPieces: qa.length ? qa.filter(r => r.reworked).length : null,
      lines: lines.length ? sum(lines.map(p => p.lines!)) : null,
      subtasks: rs,
    }
  }).sort((a, b) => (b.costUSD ?? -1) - (a.costUSD ?? -1) || a.title.localeCompare(b.title))

  const buckets: HistoryBucket[] = BUCKETS.map(b => {
    const xs = rows.filter(x => x.r.sessions >= b.min && (b.max === null || x.r.sessions <= b.max)).map(x => x.r)
    const costs = xs.map(r => r.costUSD).filter((v): v is number => v !== null)
    const walls = xs.map(r => r.wallMs).filter((v): v is number => v !== null)
    const qa = xs.filter(r => r.reworked !== null)
    return {
      label: b.label, pieces: xs.length,
      costMedianUSD: percentile(costs, 0.5), nCost: costs.length, wallMedianMs: percentile(walls, 0.5), nWall: walls.length,
      reworkRate: qa.length ? qa.filter(r => r.reworked).length / qa.length : null, nRework: qa.length,
    }
  })

  const harness = new Map<string, { n: number; priced: number }>()
  for (const x of rows) for (const s of x.p.sessions) {
    const h = harness.get(s.harness) ?? { n: 0, priced: 0 }
    h.n++; if (s.costUSD !== null) h.priced++
    harness.set(s.harness, h)
  }
  const withCost = rows.filter(x => x.r.costUSD !== null).length
  const coverage: HistoryCoverage = {
    pieces: rows.length, withCost, withWall: rows.filter(x => x.r.wallMs !== null).length, withQa: rows.filter(x => x.r.qaRounds !== null).length,
    withSize: rows.filter(x => x.r.size !== null).length, withActive: rows.filter(x => x.r.activeMs !== null).length,
    pctWithCost: rows.length ? withCost / rows.length * 100 : null,
    harnessesWithoutCost: [...harness].filter(([, h]) => h.priced === 0).map(([k]) => k).sort(),
    harnessesPartialCost: [...harness].filter(([, h]) => h.priced > 0 && h.priced < h.n).map(([k]) => k).sort(),
  }
  return { pieces: rows.length, tasks, buckets, coverage }
}

const QA_LABEL = /^\s*(re-?)?QA(?![A-Za-z])|\bre-?QA\b/i

/**
 * QA rounds of a piece, read from the labels of its QA sessions — INDICATIVE: the delivery flow records no
 * structured QA verdict, so this is the only trace. Each QA session is a round, or the highest round a label
 * states (`rodada 3`, `r2`, `QA2`). No QA-labelled session = unknown (null), never zero.
 */
export function qaRoundsFromLabels(labels: readonly string[]): number | null {
  const qa = labels.filter(l => QA_LABEL.test(l))
  if (!qa.length) return null
  const stated = qa.map(l => {
    const m = /(?:rodada\s*|\br|^\s*(?:re-?)?QA)(\d{1,2})\b/i.exec(l)
    return m ? Number(m[1]) : 0
  })
  return Math.max(qa.length, ...stated)
}

/**
 * CALENDARIO.PRAZO-OBRIGATORIO — a piece a SESSION files without a due day still gets one.
 *
 * Measured 2026-11-23: leaders created subtasks carrying only a start date, so the calendar had nothing to plan them
 * by. The estimate is NOT a second estimator: it is `estimateEta` (task-live.ts, the forecast Live and the calendar
 * already use) asked for a piece that has not started, projected onto a BRT day. The result is stored flagged
 * `dueEstimated: true`; a typed due day replaces it and clears the flag, and a person filing from the screen is
 * never forced to have one.
 */
// No value import from task-live: it is a raw-writer-capable module and importing it would make this one a (forbidden) new importer.
// The forecast is injected — `estimateUnstartedAtMs` in task-live.ts is the one caller-supplied function.

const BRT = 'America/Sao_Paulo'

/** `yyyy-MM-dd` of an instant on the BRT clock (the calendar's own day rule). */
export function brtDayOf(ms: number): string {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: BRT })
}

/** PURE: the estimated due day (`yyyy-MM-dd`, BRT) of a piece filed at `nowMs`. Never a past day. */
export function estimateDueDay(nowMs: number, etaAtMs: (nowMs: number) => number): string {
  return brtDayOf(Math.max(nowMs, etaAtMs(nowMs)))
}

/** The sentence a session is told when the server filled the due day for it. */
export function estimatedDueNotice(dueDate: string): { dueEstimated: true; dueDate: string; notice: string } {
  return {
    dueEstimated: true, dueDate,
    notice: `prazo estimado: ${dueDate}; informe dueDate para fixar (estimated due date: ${dueDate}; pass dueDate to fix it)`,
  }
}

/** PURE: should the server fill a due day? Only for a session's write, only when none stands, never on closed work. */
export function needsEstimate(o: { bySession: boolean; dueDate: string | undefined; closed?: boolean }): boolean {
  return o.bySession && !o.dueDate && o.closed !== true
}

/** PURE: subtask id → the estimated day, for every open subtask that has none. A closed one is history, not plannable. */
export function planDueBackfill(
  subtasks: readonly { id: string; dueDate?: string; done: boolean; status: string }[], nowMs: number, etaAtMs: (nowMs: number) => number,
): Map<string, string> {
  const day = estimateDueDay(nowMs, etaAtMs)
  return new Map(subtasks.filter(s => !s.dueDate && !s.done && s.status !== 'abandoned').map(s => [s.id, day] as const))
}

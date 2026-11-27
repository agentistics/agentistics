/**
 * PERF.SERVIDOR-OCIOSO — PURE. "This piece had no slot, and NOTHING the slot depends on has changed since": the queue
 * flow (`fila-proximo`) ran the slot gate for every queued piece on every minute tick — registry + tmux list per piece,
 * a `deliveries.json` write per piece and a `fila-sem-vaga <id>` log line per piece, forever, with the same answer.
 *
 * The print holds EVERY input `judgeVaga` (gates.ts) decides on, reduced to what can flip the verdict (fase 3, QA R2:
 * the fase 2 print held only the sessions, so memory freed or a budget back under its ceiling waited out the 10 min
 * recheck): the live sessions with their harness, account, ROLE and MODEL (workers vs leaders, top-tier counts), the
 * phantoms, the piece (revision, harness, account, model), the free-memory BAND (over/under `MIN_FREE_BYTES`), whether
 * the piece's plan budget is fresh and under both ceilings, and the top-tier cap for its harness. Any of them changing
 * re-judges on the next tick (≤ 1 min, as on main). `RECHECK_MS` stays as a safety net for anything not modelled.
 */
// No import from `gates.ts` (a writer helper `doors.lint` pins): the gate's thresholds and the piece's resolved account
// are handed in by the caller (`service.ts`), which already reads them from there.
export interface BudgetRow { harness: string; account: string; fiveHourPct: number; weekPct: number; stale: boolean }
/** `judgeVaga`'s thresholds and the account it resolves for the piece (`stagedAccount`). */
export interface SlotRule { minFreeBytes: number; fiveHourCeiling: number; weekCeiling: number; account: string | undefined }

export const SLOT_RECHECK_MS = 10 * 60_000

export interface CapacitySession { id: string; alive: boolean; harness?: string; account?: string; role?: string; model?: string }
export interface CapacityPiece { revision?: number; harness?: string; account?: string; model?: string }
/** The machine and plan facts of the slot verdict, as the gate would read them this tick. */
export interface CapacityEnv { memoryBytes: number | null; budgets: readonly BudgetRow[]; topCap: number; rule: SlotRule }

/** The env facts reduced to what can flip `judgeVaga` for THIS piece: memory band, budget ok, top-tier cap. */
export function envPrint(env: CapacityEnv, piece: CapacityPiece): [string, string, number] {
  const r = env.rule
  const memory = env.memoryBytes === null ? 'unknown' : env.memoryBytes >= r.minFreeBytes ? 'ok' : 'low'
  const row = env.budgets.find(b => !b.stale && b.harness === piece.harness && b.account === r.account)
  const budget = !row ? 'none' : row.fiveHourPct < r.fiveHourCeiling && row.weekPct < r.weekCeiling ? 'ok' : 'full'
  return [memory, budget, env.topCap]
}

/** The facts a slot verdict rests on, as one string. Order-independent. */
export function capacityPrint(sessions: readonly CapacitySession[] | null, phantomIds: readonly string[], piece: CapacityPiece, env: CapacityEnv): string {
  const live = (sessions ?? []).filter(s => s.alive).map(s => `${s.id}:${s.harness ?? ''}:${s.account ?? ''}:${s.role ?? ''}:${s.model ?? ''}`).sort()
  return JSON.stringify([sessions === null ? 'unknown' : live, [...phantomIds].sort(), piece.revision ?? 0, piece.harness ?? '', piece.account ?? '', piece.model ?? '', envPrint(env, piece)])
}

export interface SlotMemoEntry { print: string; atMs: number }

/** Should the slot gate run again for this piece? `true` when there is no memo, the print changed, or it is stale. */
export function slotNeedsCheck(memo: SlotMemoEntry | undefined, print: string, nowMs: number): boolean {
  if (!memo) return true
  if (memo.print !== print) return true
  return nowMs - memo.atMs >= SLOT_RECHECK_MS || nowMs < memo.atMs
}

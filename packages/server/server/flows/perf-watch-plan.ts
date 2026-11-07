/**
 * perf-watch-plan.ts — PURE: the arithmetic of `vigia-desempenho` (APP.LENTO prevention).
 *
 * The owner, 06/11: "já monta DSL pra resolver esses problemas de lentidão pra não acontecerem". The
 * server had held ~98 % of a core for an hour before anybody could say why, and the only way to find
 * out was a throwaway copy and a profiler. So the server samples ITSELF on a schedule (the flow is the
 * schedule and the record; this module is the decision) and, when a budget stays broken, keeps a CPU
 * profile of THAT moment and says once which budget it was.
 *
 * Rules, each the cheaper side of a real mistake:
 * - A budget counts as broken only after `streak` CONSECUTIVE samples over it — one slow build or one
 *   cold request is not a regression, and a notice that cries wolf is one nobody reads.
 * - It FIRES ONCE per episode: a budget that stays broken does not notify again until it has
 *   RECOVERED — `RECOVER_SAMPLES` consecutive samples under it, because one good sample inside a
 *   busy-but-not-broken stretch is noise, not recovery (8 h of "6 over, 1 under" raised 137 notices).
 * - And never twice for one budget inside `NOTICE_GAP_MS`, whatever the episodes did: the notice is
 *   informational and a person reads one every half hour at most.
 * - A latency with no request in the window is `null` — "nobody asked" — never a 0 that would read as
 *   fast, and never a breach.
 * - It never restarts, stops or changes anything. It measures, keeps a profile and tells.
 */

export interface PerfSample {
  at: number
  /** Share of ONE core the process used since the previous sample, in %. */
  cpuPct: number
  rssMB: number
  /** Worst event-loop lag observed in the window, ms. */
  loopLagMaxMs: number
  /** p95 latency per watched route over the REAL requests of the window; null = no request. */
  routes: Record<string, number | null>
}

export interface PerfBudget {
  /** Ceiling; the sample is over it when strictly greater. */
  max: number
  /** Consecutive samples over the ceiling before it counts. */
  streak: number
}

export interface PerfBudgets {
  cpuPct: PerfBudget
  loopLagMaxMs: PerfBudget
  routes: Record<string, PerfBudget>
}

/** The host samples every 30 s (the flow folds them every few minutes): cpu 6 × 30 s = the brief's "CPU > 25 % for 3 min". */
export const SAMPLE_EVERY_MS = 30_000
export const DEFAULT_PERF_BUDGETS: PerfBudgets = {
  cpuPct: { max: 25, streak: 6 },
  loopLagMaxMs: { max: 200, streak: 3 },
  routes: {
    // Every screen polls these two; the release gate (scripts/perf/budgets.json) holds them at 500 ms
    // on a synthetic home, so a real one gets three times that before it counts.
    '/api/fleet': { max: 1500, streak: 3 },
    '/api/tasks': { max: 1500, streak: 3 },
    // Every other /api request, as one: what a click or a keystroke's request waits behind.
    '*': { max: 1000, streak: 3 },
  },
}

/** Consecutive samples under budget that end an episode (5 × 30 s = 2.5 min). */
export const RECOVER_SAMPLES = 5
/** Minimum gap between two notices for the same budget key. */
export const NOTICE_GAP_MS = 30 * 60_000

export interface PerfWatchState {
  /** Consecutive samples over budget, per budget key (`cpuPct`, `loopLagMaxMs`, `route:<path>`). */
  streaks: Record<string, number>
  /** Budget keys that have fired in the current episode (cleared when the budget recovers). */
  fired: string[]
  /** Consecutive samples under budget since a fired budget last broke; ends the episode at `RECOVER_SAMPLES`. */
  calm: Record<string, number>
  /** When each budget key last fired a notice (sample time, ms). */
  lastFire: Record<string, number>
}

export const emptyPerfWatchState = (): PerfWatchState => ({ streaks: {}, fired: [], calm: {}, lastFire: {} })

export interface PerfBreach { key: string; value: number; max: number; streak: number }

/** Fold one sample: the new state, every budget currently over (with its streak), and those that fire NOW. */
export function evaluatePerf(state: PerfWatchState, sample: PerfSample, budgets: PerfBudgets = DEFAULT_PERF_BUDGETS): {
  state: PerfWatchState
  over: PerfBreach[]
  fire: PerfBreach[]
} {
  const checks: { key: string; value: number | null; budget: PerfBudget }[] = [
    { key: 'cpuPct', value: sample.cpuPct, budget: budgets.cpuPct },
    { key: 'loopLagMaxMs', value: sample.loopLagMaxMs, budget: budgets.loopLagMaxMs },
    ...Object.entries(budgets.routes).map(([route, budget]) => ({ key: `route:${route}`, value: sample.routes[route] ?? null, budget })),
  ]
  const streaks: Record<string, number> = {}
  const fired = new Set(state.fired)
  const calm: Record<string, number> = { ...state.calm }
  const lastFire: Record<string, number> = { ...state.lastFire }
  const over: PerfBreach[] = []
  const fire: PerfBreach[] = []
  for (const { key, value, budget } of checks) {
    // No request in the window: the route says nothing either way — the streak is kept, not broken.
    if (value === null || !Number.isFinite(value)) { if (state.streaks[key]) streaks[key] = state.streaks[key]!; continue }
    if (value <= budget.max) {
      if (fired.has(key)) {
        const n = (calm[key] ?? 0) + 1
        if (n >= RECOVER_SAMPLES) { fired.delete(key); delete calm[key] } else calm[key] = n
      }
      continue
    }
    delete calm[key]
    const streak = (state.streaks[key] ?? 0) + 1
    streaks[key] = streak
    const breach = { key, value, max: budget.max, streak }
    over.push(breach)
    if (streak >= budget.streak && !fired.has(key) && sample.at - (lastFire[key] ?? -Infinity) >= NOTICE_GAP_MS) {
      fire.push(breach); fired.add(key); lastFire[key] = sample.at
    }
  }
  return { state: { streaks, fired: [...fired], calm, lastFire }, over, fire }
}

/** PURE: p95 of a window of latencies; null when empty. */
export function p95(xs: readonly number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  return Math.round(s[Math.min(s.length - 1, Math.floor(0.95 * s.length))]!)
}

/**
 * Which watched bucket a request path belongs to. Long-lived streams are NOT requests here — an SSE or
 * a WebSocket "takes" as long as it stays open — and neither are the static assets.
 */
export function routeBucket(pathname: string): string | null {
  if (!pathname.startsWith('/api/')) return null
  if (/\/(events|stream|input)(\/|$)/.test(pathname) || pathname.endsWith('-stream') || pathname === '/api/data-stream') return null
  if (pathname === '/api/fleet') return '/api/fleet'
  if (pathname === '/api/tasks') return '/api/tasks'
  return '*'
}

/** The sentence the notice and the run record carry, naming what broke. */
export function describeBreach(b: PerfBreach, lang: 'en' | 'pt'): string {
  const what = b.key === 'cpuPct' ? (lang === 'pt' ? 'CPU do servidor' : 'server CPU')
    : b.key === 'loopLagMaxMs' ? (lang === 'pt' ? 'atraso do laço de eventos' : 'event-loop lag')
      : b.key === 'route:*' ? (lang === 'pt' ? 'latência p95 das requisições' : 'p95 request latency')
        : `p95 ${b.key.slice('route:'.length)}`
  const unit = b.key === 'cpuPct' ? '%' : ' ms'
  return lang === 'pt'
    ? `${what} acima do orçamento: ${b.value}${unit} (máx. ${b.max}${unit}) em ${b.streak} amostras seguidas`
    : `${what} over budget: ${b.value}${unit} (max ${b.max}${unit}) for ${b.streak} samples in a row`
}

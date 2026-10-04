/**
 * spawn-admission.ts — PURE. May this machine start N more assistant sessions, yes or no.
 *
 * `memory-budget.ts` is a METER: it says how many sessions fit and colours the number. A meter
 * nobody is forced to read did not stop the freeze it was built for — sessions kept being started
 * by paths that never looked at it (`agentop session batch`, `/api/fleet/new`, the cockpit's wizard,
 * the web's new-session dialog). This module turns the same measurement into a GATE, and it is the
 * ONE rule every one of those paths calls: four spawn paths deciding for themselves is four chances
 * to disagree about whether a machine has room, which is the bug `task-reopen.ts` exists to have
 * fixed once for a different gesture.
 *
 * ## The rules, in the order they are applied
 *
 * 1. **An unmeasurable machine is ADMITTED, and the answer says it was not measured.** `/proc` is
 *    Linux-only; refusing on an absent measurement would make every spawn path unusable on macOS
 *    and Windows, while admitting silently would claim a check that never ran. `unmeasured: true`
 *    is what lets a surface say "memory could not be checked here" — the same absence-is-absence
 *    rule `memory-probe.ts` and `HARNESS_CAPABILITIES` follow.
 * 2. **A saturated CPU REFUSES** (`cpu`, `fits: 0`): a 1-minute load at `CPU_REFUSE_PER_CORE`× the
 *    core count. Memory room is no use to a machine that cannot schedule what it already runs.
 *    (Until RES.1 this rule was the SWAP alarm — refuse at 85% swap whatever RAM said. Measured
 *    2026-10-03 it refused with 6 GB of RAM available, because a swap page is reclaimed only when
 *    somebody touches it: swap stayed "full" long after the pressure was gone, and the gate kept
 *    saying no to a machine with room. MemAvailable already measures the pressure that matters, and
 *    `budget.left` now also holds back room for one heavy job — the real peaks.)
 * 3. **Asking for more than `left` REFUSES, and says how many WOULD fit.** `fits` is what
 *    `agentop session batch` needs: it refuses the batch WHOLE (half a batch is a plan nobody
 *    approved) and tells the user "3 of the 5 would fit" so they can resubmit a smaller one.
 *    `left` is already floored at zero by `memoryBudget`, so an over-committed machine (more running
 *    than the envelope can hold) refuses even a single session with `fits: 0`.
 * 4. Otherwise ADMIT.
 *
 * **`force` never makes a refusal disappear.** A forced spawn is admitted with `overridden: true`
 * AND the refusal it overrode, so a caller can say "started anyway — here is what the check said".
 * Nothing overrides silently: an override nobody can see afterwards is indistinguishable from a
 * gate that was never there. `force` on an unmeasured machine changes nothing — there is no refusal
 * to override.
 *
 * **A request that is not a positive integer THROWS** (`RangeError`). Zero, a fraction, a negative
 * or NaN is a caller's bug, never a user's input — every caller parses its own input first. Clamping
 * to 1 would admit a session nobody asked for; treating 0 as "fits" would let a broken caller read
 * a yes it never earned. Loud is the cheap direction here.
 *
 * The module is language-free except for the renderers at the bottom (`admissionMessage`,
 * `admissionOverrideNote`, `admissionUnmeasuredNote`). A surface may render its own words from the
 * reason CODE and the numbers on `AdmissionRefusal` — every figure a sentence needs is on it — or
 * pass the server's sentence through; the wire shape supports both.
 */

import type { MemoryBudget, MemorySample } from './memory-budget'
import { SWAP_ALARM_FRACTION } from './memory-budget'

/**
 * The process holding the most RAM + swap when a spawn is refused (RES.1): a refusal names the
 * culprit and its fix rather than saying "close a session". `fix` is the governor's, present only
 * for one of agentop's own processes.
 */
export interface Hog {
  pid: number
  label: string
  usedBytes: number
  fix?: { action: 'kill' | 'restart-server' | 'reopen-cockpit' | 'reconnect-session'; pid: number }
}

/** What `readSpawnBudget()` (memory-probe.ts) measures: the budget plus the raw figures behind it. */
export interface SpawnBudget {
  budget: MemoryBudget
  sample: MemorySample
  /** Room kept back for one heavy job, already subtracted inside `budget` (resources/heavy.ts). */
  heavyReserveBytes?: number
  /** 1-minute load average and CPU count; absent when unreadable. */
  load?: { load1: number; cores: number }
  hog?: Hog
}

/**
 * Why a spawn was refused. `no-room` — not enough MemAvailable after the floor and the heavy-job
 * reserve; `cpu` — the machine is already running more than it has cores for.
 *
 * `swap` is NO LONGER PRODUCED (RES.1, owner 2026-10-03: "stop refusing on swap %"). Swap filling
 * up is the SYMPTOM of what MemAvailable already measures, and refusing on it kept refusing long after
 * the pressure was gone — a swap page is only reclaimed when somebody touches it. It stays in the
 * type because the wire shape and the engine API carry it and an older client must still parse.
 */
export type AdmissionReason = 'swap' | 'no-room' | 'cpu'

/** Refuse when the 1-minute load is this many times the core count: the machine is saturated. */
export const CPU_REFUSE_PER_CORE = 2

/**
 * A refusal, with every number a sentence about it needs. JSON-safe (numbers and strings only), so
 * it is also the wire shape `/api/fleet/new` returns inside `AdmissionRefusalBody`.
 */
export interface AdmissionRefusal {
  reason: AdmissionReason
  /** How many sessions were asked for. */
  requested: number
  /** How many WOULD fit right now. Always 0 for `swap`; `budget.left` for `no-room`. */
  fits: number
  /** `MemAvailable`, in bytes. */
  availableBytes: number
  swapUsedBytes: number
  swapTotalBytes: number
  /** What one session is taken to cost, in bytes. */
  costBytes: number
  /** `measured` — averaged over the sessions running here; `assumed` — the declared fallback. */
  costBasis: 'measured' | 'assumed'
  /** Sessions running now. */
  used: number
  /** Sessions this machine can hold in total at `costBytes`. */
  max: number
  /** RES.1 — room held back for a heavy job, bytes (already out of `fits`). */
  heavyReserveBytes?: number
  /** RES.1 — the load that refused (`cpu`), or that was measured. */
  load1?: number
  cores?: number
  /** RES.1 — the biggest consumer, and its fix when agentop has one. */
  hog?: Hog
}

/** The decision. Discriminated on `admit`; an admitted result says HOW it was admitted. */
export type Admission =
  /** Nothing could be measured here; admitted without a check, and the surface must say so. */
  | { admit: true; requested: number; unmeasured: true; overridden: false }
  /** Measured and there was room. `fits` is `budget.left`, so a caller can say "N more would fit". */
  | { admit: true; requested: number; unmeasured: false; overridden: false; fits: number }
  /** Measured, refused, and forced through anyway. `refusal` is what was overridden. */
  | { admit: true; requested: number; unmeasured: false; overridden: true; refusal: AdmissionRefusal }
  | { admit: false; requested: number; refusal: AdmissionRefusal }

/**
 * The body a spawn route answers with when it refuses (409). `code` is fixed so a client can tell
 * this refusal from every other 409; `message` is the server's own sentence in the request's
 * language, for a client that would rather not render its own.
 */
/**
 * The wire code of a memory refusal. A RESPONSE code, not a notification code — named once here so
 * the routes compare against it rather than restating the literal (and so `notificationCoverage`'s
 * grep for emitted notification codes, which matches the `code: '<literal>'` shape, does not read it
 * as an event that needs toast text).
 */
export const ADMISSION_CODE = 'memory_budget' as const

export interface AdmissionRefusalBody {
  code: typeof ADMISSION_CODE
  refusal: AdmissionRefusal
  message: string
}

export interface AdmitOptions {
  /** Start anyway. The result still carries the refusal — see the header. */
  force?: boolean
}

/** The ONE admission rule. `input` is `null` when this machine could not be measured. */
export function admitSpawn(
  input: SpawnBudget | null,
  requested: number,
  opts: AdmitOptions = {},
): Admission {
  if (!Number.isInteger(requested) || requested < 1) {
    throw new RangeError(`admitSpawn: requested must be a positive integer, got ${requested}`)
  }
  if (!input) return { admit: true, requested, unmeasured: true, overridden: false }

  const { budget, sample } = input
  const refusalOf = (reason: AdmissionReason, fits: number): AdmissionRefusal => ({
    ...(input.heavyReserveBytes ? { heavyReserveBytes: input.heavyReserveBytes } : {}),
    ...(input.load ? { load1: input.load.load1, cores: input.load.cores } : {}),
    ...(input.hog ? { hog: input.hog } : {}),
    reason,
    requested,
    fits,
    availableBytes: sample.available,
    swapUsedBytes: sample.swapUsed,
    swapTotalBytes: sample.swapTotal,
    costBytes: budget.cost.bytes,
    costBasis: budget.cost.basis,
    used: budget.used,
    max: budget.max,
  })

  // RES.1: MemAvailable (with the heavy-job reserve, inside `budget.left`) and CPU decide; swap %
  // no longer does. A saturated CPU refuses first — memory room is no use to a machine that cannot
  // schedule what it already runs.
  const saturated = input.load !== undefined && input.load.cores > 0
    && input.load.load1 / input.load.cores >= CPU_REFUSE_PER_CORE
  const refusal = saturated
    ? refusalOf('cpu', 0)
    : requested > budget.left
      ? refusalOf('no-room', budget.left)
      : null

  if (!refusal) return { admit: true, requested, unmeasured: false, overridden: false, fits: budget.left }
  if (opts.force) return { admit: true, requested, unmeasured: false, overridden: true, refusal }
  return { admit: false, requested, refusal }
}

/** The refusal an admission carries, if any — refused or overridden. */
export function admissionRefusal(a: Admission): AdmissionRefusal | null {
  if (!a.admit) return a.refusal
  return a.overridden ? a.refusal : null
}

/** The 409 body for a refusal. */
export function admissionRefusalBody(refusal: AdmissionRefusal, lang: AdmissionLang): AdmissionRefusalBody {
  return { code: ADMISSION_CODE, refusal, message: admissionMessage(refusal, lang) }
}

// ── Rendering ────────────────────────────────────────────────────────────────────────────────────

export type AdmissionLang = 'en' | 'pt'

const GiB = 1024 * 1024 * 1024
const MiB = 1024 * 1024

/**
 * Fixed units, not `backup-size.ts`'s auto-scaling `formatBytes`: a refusal compares RAM against
 * swap against a per-session cost, and "4.2 GB available, 512.0 MB of swap used" makes the reader do
 * the unit conversion the sentence exists to spare them. Machine sizes in GB with one decimal, the
 * per-session cost in whole MB. Portuguese writes the decimal with a comma.
 */
function gb(bytes: number, lang: AdmissionLang): string {
  const s = (Math.max(0, bytes) / GiB).toFixed(1)
  return `${lang === 'pt' ? s.replace('.', ',') : s} GB`
}
function mb(bytes: number): string {
  return `${Math.round(Math.max(0, bytes) / MiB)} MB`
}
function swapPercent(r: AdmissionRefusal): number {
  return r.swapTotalBytes > 0 ? Math.round((r.swapUsedBytes / r.swapTotalBytes) * 100) : 0
}

function costPhrase(r: AdmissionRefusal, lang: AdmissionLang): string {
  if (lang === 'pt') {
    return r.costBasis === 'measured'
      ? `cada sessão custa cerca de ${mb(r.costBytes)} (medido sobre ${r.used} em execução)`
      : `cada sessão custa cerca de ${mb(r.costBytes)} (estimado — nenhuma em execução para medir)`
  }
  return r.costBasis === 'measured'
    ? `each session costs about ${mb(r.costBytes)} (measured over the ${r.used} running)`
    : `each session costs about ${mb(r.costBytes)} (assumed — nothing is running to measure)`
}

/** RES.1 — the biggest consumer, named; with the governor's fix when it is agentop's. */
function hogPhrase(r: AdmissionRefusal, lang: AdmissionLang): string {
  const h = r.hog
  if (!h) return ''
  const who = `${h.label} (pid ${h.pid}, ${gb(h.usedBytes, lang)})`
  const fix = !h.fix ? '' : lang === 'pt'
    ? ({ kill: ` — encerre-o (Hardware → Recursos, ou kill ${h.pid})`, 'restart-server': ' — reinicie-o: agentop restart server', 'reopen-cockpit': ' — feche-o (q) e abra de novo', 'reconnect-session': ' — reconecte o MCP na sessão dona (/mcp)' } as const)[h.fix.action]
    : ({ kill: ` — stop it (Hardware → Resources, or kill ${h.pid})`, 'restart-server': ' — restart it: agentop restart server', 'reopen-cockpit': ' — quit it (q) and open it again', 'reconnect-session': ' — reconnect the MCP in its session (/mcp)' } as const)[h.fix.action]
  return lang === 'pt' ? ` O maior consumidor é ${who}${fix}.` : ` The biggest consumer is ${who}${fix}.`
}

/** The facts half: what the check found, with the numbers. No advice. */
function admissionFacts(r: AdmissionRefusal, lang: AdmissionLang): string {
  return admissionFactsCore(r, lang) + hogPhrase(r, lang)
}

function admissionFactsCore(r: AdmissionRefusal, lang: AdmissionLang): string {
  const swap = `${gb(r.swapUsedBytes, lang)} / ${gb(r.swapTotalBytes, lang)}`
  const ram = gb(r.availableBytes, lang)
  const load = r.load1 !== undefined && r.cores ? `${r.load1.toFixed(1)} / ${r.cores}` : '?'
  const heavy = r.heavyReserveBytes ? gb(r.heavyReserveBytes, lang) : null
  if (r.reason === 'cpu') {
    return lang === 'pt'
      ? `A CPU está saturada (carga ${load} núcleos), então nenhuma sessão nova cabe agora.`
      : `The CPU is saturated (load ${load} cores), so no new session fits right now.`
  }
  if (lang === 'pt') {
    if (r.reason === 'no-room' && heavy) {
      const asked = r.requested === 1 ? 'mais uma sessão' : `${r.requested} sessões`
      const fits = r.fits === 0 ? 'não cabe nenhuma' : r.fits === 1 ? 'só cabe 1' : `só cabem ${r.fits}`
      return `Memória insuficiente para iniciar ${asked}: ${fits}. ${ram} de RAM disponível, com ${heavy} reservados para uma tarefa pesada; `
        + `${costPhrase(r, lang)}, ${r.used} de ${r.max} em uso.`
    }
    if (r.reason === 'swap') {
      return `O swap está ${swapPercent(r)}% cheio (${swap} usados), então a máquina já está sob pressão — `
        + `mesmo com ${ram} de RAM disponível, nenhuma sessão nova cabe; ${costPhrase(r, lang)}.`
    }
    const asked = r.requested === 1 ? 'mais uma sessão' : `${r.requested} sessões`
    const fits = r.fits === 0 ? 'não cabe nenhuma' : r.fits === 1 ? 'só cabe 1' : `só cabem ${r.fits}`
    return `Memória insuficiente para iniciar ${asked}: ${fits}. ${ram} de RAM disponível, swap ${swap} usado; `
      + `${costPhrase(r, lang)}, ${r.used} de ${r.max} em uso.`
  }
  if (r.reason === 'no-room' && heavy) {
    const asked = r.requested === 1 ? 'another session' : `${r.requested} sessions`
    const fits = r.fits === 0 ? 'none fit' : `only ${r.fits} fit${r.fits === 1 ? 's' : ''}`
    return `Not enough memory to start ${asked}: ${fits}. ${ram} of RAM available, with ${heavy} held back for one heavy job; `
      + `${costPhrase(r, lang)}, ${r.used} of ${r.max} in use.`
  }
  if (r.reason === 'swap') {
    return `Swap is ${swapPercent(r)}% full (${swap} used), so the machine is already under pressure — `
      + `even with ${ram} of RAM available, no new session fits; ${costPhrase(r, lang)}.`
  }
  const asked = r.requested === 1 ? 'another session' : `${r.requested} sessions`
  const fits = r.fits === 0 ? 'none fit' : `only ${r.fits} fit${r.fits === 1 ? 's' : ''}`
  return `Not enough memory to start ${asked}: ${fits}. ${ram} of RAM available, swap ${swap} used; `
    + `${costPhrase(r, lang)}, ${r.used} of ${r.max} in use.`
}

/** What to do about it — different per reason, because the fixes differ. */
function admissionAdvice(r: AdmissionRefusal, lang: AdmissionLang): string {
  if (lang === 'pt') {
    const smaller = r.reason === 'no-room' && r.fits > 0 && r.requested > 1
      ? `Peça no máximo ${r.fits}, feche uma sessão`
      : r.reason === 'swap' ? 'Espere o swap esvaziar ou feche uma sessão'
        : r.reason === 'cpu' ? 'Espere a carga baixar' : 'Feche uma sessão'
    return `${smaller}, ou inicie mesmo assim (--force / "iniciar mesmo assim").`
  }
  const smaller = r.reason === 'no-room' && r.fits > 0 && r.requested > 1
    ? `Ask for at most ${r.fits}, close a session`
    : r.reason === 'swap' ? 'Wait for swap to drain or close a session'
      : r.reason === 'cpu' ? 'Wait for the load to drop' : 'Close a session'
  return `${smaller}, or start anyway (--force / "start anyway").`
}

/** The refusal as one or two sentences: the numbers, then what to do. */
export function admissionMessage(refusal: AdmissionRefusal, lang: AdmissionLang): string {
  return `${admissionFacts(refusal, lang)} ${admissionAdvice(refusal, lang)}`
}

/**
 * For a FORCED admission: the sentence that says it was overridden and what the check had found.
 * `null` for anything that was not overridden — a clean admit has nothing to confess.
 */
export function admissionOverrideNote(a: Admission, lang: AdmissionLang): string | null {
  if (!a.admit || !a.overridden) return null
  return lang === 'pt'
    ? `Iniciada mesmo assim, ignorando a verificação de memória: ${admissionFacts(a.refusal, lang)}`
    : `Started anyway, overriding the memory check: ${admissionFacts(a.refusal, lang)}`
}

/** For an UNMEASURED admission: the check did not run, and a surface must not imply it did. */
export function admissionUnmeasuredNote(lang: AdmissionLang): string {
  return lang === 'pt'
    ? 'A memória não pôde ser verificada nesta máquina; a sessão foi iniciada sem essa verificação.'
    : 'Memory could not be checked on this machine; the session was started without that check.'
}

/** Re-exported so a surface rendering its own words can state the threshold the swap rule uses. */
export { SWAP_ALARM_FRACTION }

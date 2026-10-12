/**
 * journal/backfill.ts — the AUTOMATIC first `agentop journal import`, now that the journal and the
 * projections are on by default and every surface reads them (the journal-backfill item).
 *
 * A machine that turns the journal on holds only what the shadow writer feeds from then on: every
 * other harness, and every conversation older than that, is absent until an import runs. So the
 * server runs the existing import ONCE by itself, under constraints chosen for a machine that just had
 * a resource incident:
 *
 * - **Never on the startup path.** It is scheduled after the server is listening, after a delay, on
 *   an unref'd timer. Startup is already slow; this adds nothing to it.
 * - **Low priority.** It runs as a CHILD process (`agentop journal import --background`) under
 *   `nice -n 19` and `ionice -c 3` where those exist, with small batches and one replay at a time.
 * - **It pauses under REAL memory pressure.** Before every batch it reads memory (`memoryPressure`):
 *   RAM available under the gate's reserve, or swap over its alarm, means it waits and re-asks every
 *   `PAUSE_RECHECK_MS`, saying `paused` in its progress. The assistant-session count plays no part.
 *   An unmeasurable machine is admitted, as the gate does everywhere.
 * - **Resumable and idempotent**, because the import is: a record per source, `UNIQUE(event_id)`. A
 *   server that stops mid-import resumes it on its next start.
 * - **It says how far it got:** a progress file beside the journal, which `agentop journal status`
 *   and the web read.
 *
 * Until the progress file says COMPLETE for THIS journal file, the projection route answers
 * `projections_backfilling` and every surface falls back, item by item, to `/api/data`.
 */
import { readFileSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LEGACY_RECORD_VERSION } from './import-plan'
import { fileIdentity } from './shadow'
import { RESERVED_BYTES, SWAP_ALARM_FRACTION, type MemorySample } from '../sessions/memory-budget'

export interface BackfillProgress {
  v: 1
  /** The journal file this progress describes (`fileIdentity`). Another file inherits nothing. */
  identity: string | null
  state: 'running' | 'paused' | 'done' | 'interrupted' | 'failed'
  startedAt: string
  updatedAt: string
  /** Set once, when a whole import ran to its end. The ONE thing the projections wait for. */
  completedAt?: string
  /** The adapter version of each harness's integration when the import last ran to its end (METRICS.FIX). */
  adapterVersions?: Record<string, string>
  harness?: string
  phase?: 'artifacts' | 'store'
  done?: number
  total?: number
  written: number
  pausedReason?: string
  error?: string
}

export function readBackfillProgress(path: string): BackfillProgress | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as BackfillProgress
    return raw && raw.v === 1 ? raw : null
  } catch { return null }
}

export async function writeBackfillProgress(path: string, p: BackfillProgress): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(p), { mode: 0o600 })
  await rename(tmp, path)
}

/** Complete for THIS journal: a progress record that completed, written about the same file. */
export function backfillComplete(progress: BackfillProgress | null, journalIdentity: string | null): boolean {
  return progress !== null && progress.completedAt !== undefined && journalIdentity !== null && progress.identity === journalIdentity
}

/** Whether the projection route must wait: the journal is on and its first import has not completed. */
export function backfillPending(journalPath: string, progressPath: string): boolean {
  return !backfillComplete(readBackfillProgress(progressPath), fileIdentity(journalPath))
}

export type BackfillDecision =
  | { start: true }
  | { start: false; reason: 'journal-off' | 'central' | 'complete' | 'running-elsewhere' | 'opted-out' }

/**
 * PURE. Whether a COMPLETED import ran under other adapter versions than the ones running now, for a
 * harness whose events changed meaning (D8): the import then runs again, and replaces those sources.
 * A progress file from before `adapterVersions` existed counts as the legacy versions of those harnesses.
 */
export function adapterUpgradePending(progress: BackfillProgress | null, current: Record<string, string> | undefined): boolean {
  if (!progress || !current) return false
  for (const [harness, legacy] of Object.entries(LEGACY_RECORD_VERSION)) {
    const now = current[harness]
    if (now === undefined) continue
    if ((progress.adapterVersions?.[harness] ?? legacy) !== now) return true
  }
  return false
}

/** PURE. Should this server start the first import now? */
export function planAutoBackfill(o: {
  journalEnabled: boolean
  central: boolean
  /** `AGENTISTICS_JOURNAL_BACKFILL=0` turns the automatic import off; a person can still run it. */
  optedOut: boolean
  progress: BackfillProgress | null
  journalIdentity: string | null
  nowMs: number
  /** A `running`/`paused` record newer than this is another live import (a CLI run, a second server). */
  staleMs: number
  /** The running integrations' adapter versions by harness id; absent = unknown (no upgrade check). */
  adapterVersions?: Record<string, string>
}): BackfillDecision {
  if (!o.journalEnabled) return { start: false, reason: 'journal-off' }
  if (o.central) return { start: false, reason: 'central' }
  if (o.optedOut) return { start: false, reason: 'opted-out' }
  if (backfillComplete(o.progress, o.journalIdentity) && !adapterUpgradePending(o.progress, o.adapterVersions)) return { start: false, reason: 'complete' }
  const p = o.progress
  if (p && (p.state === 'running' || p.state === 'paused') && o.nowMs - Date.parse(p.updatedAt) < o.staleMs) {
    return { start: false, reason: 'running-elsewhere' }
  }
  return { start: true }
}

// ── The memory gate ─────────────────────────────────────────────────────────────────────────────

export const PAUSE_RECHECK_MS = 30_000

export type MemoryVerdict = { admit: true } | { admit: false; reason: string }

/**
 * `beforeBatch` for `runImport`: returns at once when the gate admits, otherwise reports `paused`
 * and waits, re-asking every `recheckMs`, until it does (or the signal aborts).
 */
export function memoryPause(o: {
  ask: () => Promise<MemoryVerdict>
  onPause: (reason: string) => void | Promise<void>
  onResume: () => void | Promise<void>
  sleep?: (ms: number) => Promise<void>
  recheckMs?: number
  signal?: AbortSignal
}): () => Promise<void> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  return async () => {
    let paused = false
    for (;;) {
      if (o.signal?.aborted) return
      const v = await o.ask().catch((): MemoryVerdict => ({ admit: true }))
      if (v.admit) {
        if (paused) await o.onResume()
        return
      }
      if (!paused) { paused = true; await o.onPause(v.reason) }
      await sleep(o.recheckMs ?? PAUSE_RECHECK_MS)
    }
  }
}

/**
 * Is this machine under REAL memory pressure: RAM available under the gate's reserve, or swap over its
 * alarm? The same two thresholds the session gate uses (`RESERVED_BYTES`, `SWAP_ALARM_FRACTION`), but
 * NOT its session count: a machine busy with assistant sessions and plenty of free memory would
 * otherwise never import (the leader's answer on the backfill item). Unmeasurable means admitted.
 */
export function memoryPressure(sample: MemorySample | null): MemoryVerdict {
  if (!sample) return { admit: true }
  if (sample.available < RESERVED_BYTES) return { admit: false, reason: 'ram' }
  if (sample.swapTotal > 0 && sample.swapUsed / sample.swapTotal >= SWAP_ALARM_FRACTION) return { admit: false, reason: 'swap' }
  return { admit: true }
}

/** The real reading, from `/proc/meminfo`. */
export async function askMemoryGate(): Promise<MemoryVerdict> {
  const { readMemory } = await import('../sessions/memory-probe')
  return memoryPressure(await readMemory())
}

// ── The child process ───────────────────────────────────────────────────────────────────────────

/** How THIS service re-invokes agentop: the compiled binary, or `bun <checkout>/bin/cli.ts`. */
export function cliArgv(execPath: string, mainScript: string | undefined, here: string): string[] {
  const fromSource = mainScript !== undefined && (mainScript.endsWith('.ts') || mainScript.endsWith('.js'))
  return fromSource ? [execPath, join(here, '..', '..', 'bin', 'cli.ts')] : [execPath]
}

/** PURE. The background import's command line, at the lowest CPU and I/O priority this OS offers. */
export function backgroundImportArgv(cli: readonly string[], o: { nice: string | null; ionice: string | null }): string[] {
  const prio: string[] = []
  if (o.nice) prio.push(o.nice, '-n', '19')
  if (o.ionice) prio.push(o.ionice, '-c', '3')
  return [...prio, ...cli, 'journal', 'import', '--background']
}

export interface AutoBackfillDeps {
  journalEnabled: boolean
  central: boolean
  journalPath: string
  progressPath: string
  /** The running integrations' adapter versions by harness id (`engineIntegrations()`), for the upgrade check. */
  adapterVersions?: Record<string, string>
  /**
   * The server's environment (the opt-out flag). Passed in: `journal/` never reads the process environment
   * itself — the engine's provider-secrets lint walks this directory (Guard 3).
   */
  env: Record<string, string | undefined>
  spawn?: (argv: string[]) => void
  now?: () => number
}

/** Decide, and when the answer is yes start the low-priority child. Never throws. */
export function maybeStartAutoBackfill(d: AutoBackfillDeps): BackfillDecision {
  const env = d.env
  const decision = planAutoBackfill({
    journalEnabled: d.journalEnabled,
    central: d.central,
    optedOut: ['0', 'false', 'off', 'no'].includes((env.AGENTISTICS_JOURNAL_BACKFILL ?? '').trim().toLowerCase()),
    progress: readBackfillProgress(d.progressPath),
    journalIdentity: fileIdentity(d.journalPath),
    nowMs: (d.now ?? Date.now)(),
    staleMs: 10 * 60_000,
    ...(d.adapterVersions ? { adapterVersions: d.adapterVersions } : {}),
  })
  if (!decision.start) return decision
  const argv = backgroundImportArgv(
    cliArgv(process.execPath, process.argv[1], import.meta.dir),
    { nice: Bun.which('nice'), ionice: Bun.which('ionice') },
  )
  try {
    if (d.spawn) d.spawn(argv)
    else {
      // No `env`: the child inherits this process's environment (Bun's default).
      const child = Bun.spawn(argv, { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
      child.unref()
    }
  } catch (err) {
    console.error('[journal] the automatic first import could not start:', err instanceof Error ? err.message : String(err))
  }
  return decision
}

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
 * - **It pauses under memory pressure.** Before every batch it asks the memory admission gate
 *   (`admitSpawn`, the rule every session spawn obeys). A refusal (swap alarm, no room) means it waits
 *   and re-asks every `PAUSE_RECHECK_MS`, saying `paused` in its progress. An unmeasurable machine is
 *   admitted, as the gate does everywhere.
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
import { fileIdentity } from './shadow'

export interface BackfillProgress {
  v: 1
  /** The journal file this progress describes (`fileIdentity`). Another file inherits nothing. */
  identity: string | null
  state: 'running' | 'paused' | 'done' | 'interrupted' | 'failed'
  startedAt: string
  updatedAt: string
  /** Set once, when a whole import ran to its end. The ONE thing the projections wait for. */
  completedAt?: string
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
}): BackfillDecision {
  if (!o.journalEnabled) return { start: false, reason: 'journal-off' }
  if (o.central) return { start: false, reason: 'central' }
  if (o.optedOut) return { start: false, reason: 'opted-out' }
  if (backfillComplete(o.progress, o.journalIdentity)) return { start: false, reason: 'complete' }
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

/** The real gate: the one `admitSpawn` rule, asked for ONE more slot. */
export async function askMemoryGate(): Promise<MemoryVerdict> {
  const [{ readSpawnBudget }, { admitSpawn }] = await Promise.all([
    import('../sessions/memory-probe'), import('../sessions/spawn-admission'),
  ])
  const a = admitSpawn(await readSpawnBudget(), 1)
  return a.admit ? { admit: true } : { admit: false, reason: a.refusal.reason }
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

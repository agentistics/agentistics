/**
 * cli-journal.ts — `agentop journal status [--json]`.
 *
 * A read-only look at the durable event journal (journal/types.ts, journal/journal.ts) from the
 * OUTSIDE — a person on a terminal, not the server process that actually writes it. Two rules this
 * file exists to honour:
 *
 *  1. **This verb must NEVER cause the journal to come into existence.** `openJournal` mkdirs the
 *     directory and creates the db file on first open — exactly right for the server, which is
 *     supposed to start writing, and exactly wrong for a status check, which would otherwise leave
 *     a machine that never turned the journal on believing it had one because somebody merely
 *     looked. So `collectJournalReport` checks `exists(path)` FIRST and returns `present: false`
 *     without ever touching `open`, `mkdirSync`, or anything else that writes.
 *  2. **A number this process cannot know is never printed as if it were the server's.** No process
 *     in this build opens the journal today — the server has no journal instance and no route for
 *     it — so "counters since the writing process booted" cannot be answered from here at all. A CLI
 *     invocation that opened its own connection would get its own fresh zeros, and printing those as
 *     "written: 0" would read as "the server has written nothing," which is not a fact this process
 *     is in a position to state. `sinceBoot` is therefore always `null` today, and the render says so
 *     in words rather than printing a confident zero. Same for `differential`: nothing computes one
 *     yet, so it is always `null` and the render says "no differential has been run."
 *
 * Everything this file DOES know it says plainly: whether the file exists, what filesystem its
 * directory is on, the state SQLite itself reports when the file is opened (open / disabled + why /
 * closed), its row count and byte size, and its first/last event timestamps. An EXISTING file is
 * opened through `openJournal` itself, so this verb sees exactly what the server would: that open
 * sets the pragmas and, on a file an older agentop wrote, migrates its schema — the same step the
 * server's next open would take, never an event written. It reads `status()` + `stats()` and
 * `close()`s (a close checkpoints the WAL, as every last close does). The counters `status()`
 * returns belong to the connection THIS process just opened, which is why they still cannot answer
 * "since the server booted" (rule 2 above) and are folded into the same `sinceBoot: null` sentence.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { JOURNAL_PATH } from './config'
import { openJournal, type OpenJournalOptions } from './journal/journal'
import { classifyJournalPath, defaultPathProbe, type PathProbe } from './journal/schema'
import type { JournalCounters, JournalDisabledReason, JournalStatus, JournalStats, RejectionReason } from './journal/types'

/** The path's directory, as THIS verb classifies it. `'network-refused'` names what `openJournal`
 *  itself would do with a file there — it never opens one, so nothing here ever reaches that path
 *  on a network filesystem either. */
export type ReportedPathKind = 'local' | 'network-refused' | 'unknown'

/** Counters covering the life of whichever process WROTE the journal. Always `null` today — see the
 *  module header, rule 2. */
export interface JournalSinceBoot {
  counters: JournalCounters
  /** `JournalCounters.rejected` is a single total, not broken out by `RejectionReason` — no writer
   *  in this build produces a per-reason breakdown yet, so this stays absent until one does. */
  rejectedByReason?: Partial<Record<RejectionReason, number>>
}

/** A differential's summary. No differential exists yet anywhere in this build — see the module
 *  header, rule 2 — so `JournalReport.differential` is always `null` and this shape is unused until
 *  one is implemented. */
export interface JournalDifferentialSummary {
  at: string
  fields: number
  equal: number
  explained: number
  unexplained: number
}

export interface JournalReport {
  path: string
  /** The db file exists. `false` = this machine has never had the journal on. */
  present: boolean
  pathKind: ReportedPathKind
  fsType?: string
  /** `AGENTISTICS_JOURNAL` as THIS SHELL sees it (`null` = unset) — not necessarily the server's;
   *  the server may be a different process with a different environment. */
  flag: string | null
  /** Present only when the file existed and was opened successfully. */
  status?: JournalStatus
  stats?: JournalStats
  /** Counters since the WRITING process booted. `null` = not obtainable from this process (always,
   *  today — see the module header). */
  sinceBoot: JournalSinceBoot | null
  /** `null` = no differential has been run. */
  differential: JournalDifferentialSummary | null
  /**
   * `true` when nothing feeds the journal: the writing process said so in its status file, or this
   * build carries no engine (or has it switched off). The normal state of a community build.
   */
  noIntegrations: boolean
  /** The first import's progress (`journal/backfill.ts`); `null` when none has ever run. */
  backfill?: { progress: import('./journal/backfill').BackfillProgress | null; complete: boolean }
}

export interface JournalCliDeps {
  /** Default `JOURNAL_PATH`. */
  path?: string
  /** Default `fs.existsSync`. */
  exists?: (p: string) => boolean
  /** Default `defaultPathProbe()`. */
  probe?: PathProbe
  /** Default `openJournal`. */
  open?: typeof openJournal
  /** Default `process.env`. */
  env?: Record<string, string | undefined>
  /** The shadow writer's status file (journal/shadow.ts): default `<journal path>.status.json` (config's `JOURNAL_STATUS_PATH` for the real one). */
  statusPath?: string
  /** Default `process.kill(pid, 0)`. Injected so a test can decide who is alive. */
  alive?: (pid: number) => boolean
  /** Default: whether this build's engine slot holds an engine (`engine/load.ts`). */
  buildHasEngine?: () => boolean
  /** The first import's progress file. Default `<journal path>.backfill.json`. */
  backfillPath?: string
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as { code?: string }).code === 'EPERM' }
}

/**
 * The writing process's own since-boot counters, from the file `journal/shadow.ts` keeps beside the
 * journal. `null` unless the file parses AND the process that wrote it is still alive: the numbers of
 * a process that has exited are not "since the writing process booted" of anything running now, and
 * printing them as such would be the confident answer this verb refuses to give.
 */
export function readSinceBoot(path: string, alive: (pid: number) => boolean): JournalSinceBoot | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
      v?: unknown; pid?: unknown; sinceBoot?: { counters?: JournalCounters; rejectedByReason?: Partial<Record<RejectionReason, number>> }
    }
    if (raw.v !== 1 || typeof raw.pid !== 'number' || !raw.sinceBoot?.counters) return null
    if (!alive(raw.pid)) return null
    const out: JournalSinceBoot = { counters: raw.sinceBoot.counters }
    if (raw.sinceBoot.rejectedByReason) out.rejectedByReason = raw.sinceBoot.rejectedByReason
    return out
  } catch {
    return null
  }
}

/** The writing process's `off` reason, when it is alive and reported one. */
export function readWriterOff(path: string, alive: (pid: number) => boolean): string | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { v?: unknown; pid?: unknown; off?: unknown }
    if (raw.v !== 1 || typeof raw.pid !== 'number' || !alive(raw.pid)) return null
    return typeof raw.off === 'string' ? raw.off : null
  } catch {
    return null
  }
}

/**
 * Read-only. Never mkdirs, never creates the db file, never throws.
 *
 * Order matters: the path is classified BEFORE the existence check (classification never creates
 * anything — it resolves through the nearest existing ancestor — so it is safe to run regardless),
 * then existence gates whether `open` is ever called at all.
 */
export async function collectJournalReport(deps: JournalCliDeps = {}): Promise<JournalReport> {
  const path = deps.path ?? JOURNAL_PATH
  const exists = deps.exists ?? existsSync
  const probe = deps.probe ?? defaultPathProbe()
  const open = deps.open ?? openJournal
  const env = deps.env ?? process.env

  let pathKind: ReportedPathKind = 'unknown'
  let fsType: string | undefined
  try {
    const cls = classifyJournalPath(dirname(path), probe)
    pathKind = cls.kind === 'network' ? 'network-refused' : cls.kind
    fsType = cls.fsType
  } catch {
    // Classification failing is not this verb's business to crash over — report 'unknown', the same
    // answer `classifyJournalPath` itself gives for a mount table it could not read.
  }

  const report: JournalReport = {
    path,
    present: false,
    pathKind,
    flag: env.AGENTISTICS_JOURNAL ?? null,
    sinceBoot: null,
    differential: null,
    noIntegrations: false,
  }
  if (fsType !== undefined) report.fsType = fsType

  let present: boolean
  try {
    present = exists(path)
  } catch {
    // Could not even stat it — treat as absent rather than guessing; the render says only what it
    // can support, and "present: false" never claims more than "nothing was found there".
    present = false
  }
  report.present = present
  const statusPath = deps.statusPath ?? `${path}.status.json`
  report.sinceBoot = readSinceBoot(statusPath, deps.alive ?? pidAlive)
  {
    const { readBackfillProgress, backfillComplete } = await import('./journal/backfill')
    const { fileIdentity } = await import('./journal/shadow')
    const progress = readBackfillProgress(deps.backfillPath ?? `${path}.backfill.json`)
    report.backfill = { progress, complete: backfillComplete(progress, fileIdentity(path)) }
  }
  report.noIntegrations = readWriterOff(statusPath, deps.alive ?? pidAlive) === 'no-integrations'
    || !(await (async () => {
      if (deps.buildHasEngine) return deps.buildHasEngine()
      const { buildHasEngine, engineDisabled } = await import('./engine/load')
      return buildHasEngine() && !engineDisabled(env)
    })())
  if (!present) return report

  // The file exists: open it to read status + stats (no event is ever appended), and always close
  // what was opened. `open` (openJournal) itself never throws by contract, but a caller-injected
  // stand-in might, so this is wrapped regardless — a failure here still yields an answerable
  // report (present: true, status/stats left unset; the render names that plainly).
  const opts: OpenJournalOptions = { path, probe }
  try {
    const j = await open(opts)
    try {
      report.status = j.status()
      report.stats = await j.stats()
    } finally {
      j.close()
    }
  } catch {
    // present is still true and known; status/stats are simply not obtainable from here right now.
  }

  return report
}

/** The one sentence for a journal nothing feeds. Information, never a fault. */
export const NO_INTEGRATIONS_TEXT =
  'this build has no integration to feed the journal — every surface keeps working off its existing data.'

const DISABLED_REASON_TEXT: Record<JournalDisabledReason, string> = {
  'network-filesystem': 'its directory is on a network filesystem, where WAL is not safe — the journal refuses to open there.',
  'no-sqlite': 'bun:sqlite could not be loaded (this is not a Bun runtime).',
  'open-failed': 'the file could not be created or opened.',
  'wal-unavailable': 'SQLite answered with a journal mode other than WAL on this filesystem.',
  'db-schema-too-new': 'the file was written by a newer agentop; this build will not write into it.',
  'migrate-failed': 'the file opened, but its schema could not be created or migrated.',
  'no-integrations': NO_INTEGRATIONS_TEXT,
}

function pathKindText(kind: ReportedPathKind, fsType?: string): string {
  const suffix = fsType ? ` (${fsType})` : ''
  switch (kind) {
    case 'local': return `local${suffix}`
    case 'network-refused': return `a network filesystem${suffix} — the journal refuses to open here`
    case 'unknown': return 'undetermined — could not classify this filesystem'
  }
}

function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n
  let u = -1
  do {
    v /= 1024
    u++
  } while (v >= 1024 && u < units.length - 1)
  return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10} ${units[u]}`
}

/** PURE. One line on the first import: what the projections are waiting for, and how far it got. */
export function backfillLine(p: import('./journal/backfill').BackfillProgress | null, complete: boolean): string {
  if (complete) return `complete (${p?.completedAt ?? 'recorded'}) — the surfaces read the projections`
  if (!p) return 'not run yet — the server starts it in the background; until it completes, the surfaces read /api/data'
  const where = p.harness ? ` · ${p.harness} ${p.phase ?? ''} ${p.done ?? 0}/${p.total ?? '?'}`.replace(/ {2,}/g, ' ') : ''
  const written = ` · ${p.written.toLocaleString('en-US')} events written`
  switch (p.state) {
    case 'running': return `running${where}${written} (updated ${p.updatedAt})`
    case 'paused': return `PAUSED — memory pressure (${p.pausedReason === 'ram' ? 'RAM available under the reserve' : p.pausedReason === 'swap' ? 'swap over its alarm' : 'pressure'})${where}${written}; it resumes by itself`
    case 'interrupted': return `interrupted${where}${written} — it resumes on the next server start, or run \`agentop journal import\``
    case 'failed': return `failed: ${p.error ?? 'unknown error'} — run \`agentop journal import\` to see why`
    case 'done': return 'done, but for another journal file — it runs again for this one'
  }
}

/** PURE. Human text, English. Answers in every case — never silent, never a confident 0 for
 *  something this process does not know. */
export function renderJournalStatus(r: JournalReport): string {
  const lines: string[] = []

  lines.push(`Journal: ${r.path}`)
  lines.push(`  Path: ${pathKindText(r.pathKind, r.fsType)}`)
  lines.push(`  AGENTISTICS_JOURNAL (this shell): ${r.flag ?? '(unset)'}`)
  if (r.noIntegrations) lines.push(`  Feeder: none — ${NO_INTEGRATIONS_TEXT}`)
  if (r.backfill) lines.push(`  First import: ${backfillLine(r.backfill.progress, r.backfill.complete)}`)
  lines.push('')

  if (!r.present) {
    lines.push(
      'No journal on this machine — it has never been written (AGENTISTICS_JOURNAL has never been ' +
        'on here, or it was deleted).',
    )
  } else if (!r.status) {
    lines.push(
      'The journal file exists, but it could not be opened to read its status from here — rows, ' +
        'bytes and event timestamps are unknown from this process right now.',
    )
  } else {
    const s = r.status
    if (s.state === 'open') {
      lines.push('State: open')
    } else if (s.state === 'disabled') {
      lines.push(`State: disabled — ${s.reason ? DISABLED_REASON_TEXT[s.reason] : 'no reason recorded.'}`)
    } else {
      lines.push(`State: ${s.state}`)
    }

    if (r.stats) {
      lines.push(`Rows: ${r.stats.rows.toLocaleString('en-US')}`)
      lines.push(`Bytes: ${humanBytes(r.stats.bytes)} (${r.stats.bytes.toLocaleString('en-US')} bytes)`)
      lines.push(r.stats.firstAt && r.stats.lastAt
        ? `Events: ${r.stats.firstAt} .. ${r.stats.lastAt}`
        : 'Events: no events yet')
    } else {
      lines.push('Rows/bytes/events: could not be read')
    }
  }

  lines.push('')
  lines.push('Since boot (the writing process\'s):')
  if (r.sinceBoot === null) {
    lines.push(
      '  Not available from here. These counters live in the process that WRITES the journal (the ' +
        'server), and no writing process is reporting them (the shadow writer is off, or has exited) — a connection opened by this CLI ' +
        'call would only have its own fresh zeros, which are not the server\'s numbers, so none are ' +
        'printed.',
    )
  } else {
    const c = r.sinceBoot.counters
    lines.push(`  Written: ${c.written}`)
    lines.push(`  Deduped (duplicates): ${c.duplicates}`)
    if (r.sinceBoot.rejectedByReason) {
      lines.push(`  Rejected: ${c.rejected}`)
      for (const [reason, count] of Object.entries(r.sinceBoot.rejectedByReason)) {
        lines.push(`    ${reason}: ${count}`)
      }
    } else {
      lines.push(`  Rejected: ${c.rejected} (breakdown by reason unavailable)`)
    }
    lines.push(`  Dropped: ${c.dropped}`)
    lines.push(`  Failed appends: ${c.failedAppends}`)
    lines.push(`  Failed reads: ${c.failedReads}`)
  }

  lines.push('')
  lines.push('Differential:')
  lines.push(r.differential === null
    ? '  No differential has been run.'
    : `  At ${r.differential.at}: ${r.differential.fields} fields, ${r.differential.equal} equal, ` +
      `${r.differential.explained} explained, ${r.differential.unexplained} unexplained.`)

  return lines.join('\n')
}

const USAGE = `Usage:
  agentop journal status [--json]
  agentop journal import [--harness <id>…] [--from <yyyy-MM-dd>] [--dry-run] [--background] [--json]
                         [--batch-size <n>] [--concurrency <n>]

status  A read-only look at the durable event journal from outside the process that writes it. It
        never creates the journal — a machine that has never had it on stays reporting "no
        journal", never a silent 0.
import  Replays this machine's history into the journal (mode 'replayed'): every harness's own
        files first, then the consolidate store for conversations whose files are gone (a coarse
        run + totals). Resumable (a cursor per source, beside the journal) and idempotent — run it
        twice and the second adds nothing. Ctrl-C stops between batches with progress saved.
        --harness   limit to these harnesses (repeat it, or comma-separate)
        --from      only conversations that started on or after this UTC day
        --dry-run   write nothing; report what would be written`

export async function runJournal(argv: string[], deps?: JournalCliDeps): Promise<number> {
  const cmd = argv[0]
  if (cmd === undefined || cmd === 'help' || cmd === '-h' || cmd === '--help') {
    console.log(USAGE)
    return 0
  }
  if (cmd === 'import') return runJournalImport(argv.slice(1))
  if (cmd === 'status') {
    const json = argv.includes('--json')
    const report = await collectJournalReport(deps)
    console.log(json ? JSON.stringify(report, null, 2) : renderJournalStatus(report))
    return 0
  }
  console.error(USAGE)
  return 1
}

/**
 * `agentop journal import`. The engine is `journal/import.ts`; this is the terminal around it:
 * flags, live progress on stderr, SIGINT → stop between batches (a second one exits at once), the
 * report on stdout. Exit 0 when it ran (failures are REPORTED, by reason), 130 when interrupted,
 * 1 on a usage error or a journal that cannot be opened.
 */
export async function runJournalImport(
  argv: string[],
  deps: {
    run?: typeof import('./journal/import').runImport
    integrations?: import('./journal/shadow').JournalRegistry
    /** Default `JOURNAL_BACKFILL_PATH`. */
    progressPath?: string
  } = {},
): Promise<number> {
  const { parseImportArgs, renderImportReport } = await import('./journal/import-plan')
  const parsed = parseImportArgs(argv)
  if (!parsed.ok) {
    console.error(`agentop journal import: ${parsed.error}\n\n${USAGE}`)
    return 1
  }
  const args = parsed.args
  const run = deps.run ?? (await import('./journal/import')).runImport
  // The integrations are the ENGINE's; the journal imports none. A community build replays nothing
  // and the report says so per harness.
  const integrations = deps.integrations ?? await (async () => {
    const { loadEngine, engineIntegrations } = await import('./engine/load')
    await loadEngine()
    return engineIntegrations()
  })()
  const controller = new AbortController()
  let signals = 0
  const onSigint = () => {
    signals++
    if (signals > 1) process.exit(130)
    controller.abort()
    process.stderr.write('\n[import] stopping after the current batch — progress is saved (Ctrl-C again to exit now)\n')
  }
  process.on('SIGINT', onSigint)
  // The background import is a child of the server: a stopping server stops it between batches.
  if (args.background) process.on('SIGTERM', onSigint)
  const tty = process.stderr.isTTY === true
  // Every REAL import records its progress beside the journal (`backfill.ts`): its completion is what
  // the projections wait for, whether the server started it or a person did.
  const progress = args.dryRun ? null : await importProgressRecorder(deps.progressPath)
  try {
    const result = await run({
      harnesses: args.harnesses,
      integrations,
      ...(args.from !== undefined ? { from: args.from } : {}),
      dryRun: args.dryRun,
      // The background import's constraints: small batches, one replay at a time, small flushes.
      ...(args.background ? { batchSize: args.batchSize ?? 4, concurrency: args.concurrency ?? 1, flushEvents: 200 } : {}),
      ...(!args.background && args.batchSize !== undefined ? { batchSize: args.batchSize } : {}),
      ...(!args.background && args.concurrency !== undefined ? { concurrency: args.concurrency } : {}),
      ...(args.background && progress ? { beforeBatch: progress.memoryPause(controller.signal) } : {}),
      signal: controller.signal,
      onProgress: p => {
        progress?.onProgress(p)
        const mb = p.bytes !== undefined ? ` · ${(p.bytes / 1e6).toFixed(1)} MB (${(p.bytes / 1e6 / Math.max(0.001, p.ms / 1000)).toFixed(1)} MB/s)` : ''
        const line = `[import] ${p.harness} ${p.phase} ${p.done}/${p.total} · ${p.events.toLocaleString('en-US')} events · ${p.written.toLocaleString('en-US')} ${args.dryRun ? 'would write' : 'written'}${mb} · ${(p.ms / 1000).toFixed(1)} s`
        process.stderr.write(tty ? `\r\x1b[2K${line}` : `${line}\n`)
      },
    })
    if (tty) process.stderr.write('\n')
    if (!result.ok) {
      await progress?.finish({ state: 'failed', error: result.error })
      console.error(`agentop journal import: ${result.error}`)
      return 1
    }
    await progress?.finish(result.report.interrupted ? { state: 'interrupted' } : { state: 'done', complete: true })
    console.log(args.json ? JSON.stringify(result.report, null, 2) : renderImportReport(result.report))
    return result.report.interrupted ? 130 : 0
  } finally {
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigint)
  }
}

/**
 * The progress file a real import keeps up to date: `running` with its counts (at most every 2 s),
 * `paused` while the memory gate refuses, and the end state, `completedAt` only for an import that ran
 * to its end. Bound to the journal file's identity, read when written (the import creates the file).
 */
async function importProgressRecorder(path?: string) {
  const [{ JOURNAL_BACKFILL_PATH, JOURNAL_PATH: journalPath }, backfill, { fileIdentity }] = await Promise.all([
    import('./config'), import('./journal/backfill'), import('./journal/shadow'),
  ])
  const file = path ?? JOURNAL_BACKFILL_PATH
  const startedAt = new Date().toISOString()
  let rec: import('./journal/backfill').BackfillProgress = {
    v: 1, identity: fileIdentity(journalPath), state: 'running', startedAt, updatedAt: startedAt, written: 0,
  }
  let lastWrite = 0
  const save = async (force = false) => {
    const now = Date.now()
    if (!force && now - lastWrite < 2_000) return
    lastWrite = now
    rec = { ...rec, identity: fileIdentity(journalPath), updatedAt: new Date(now).toISOString() }
    await backfill.writeBackfillProgress(file, rec).catch(() => {})
  }
  await save(true)
  return {
    onProgress(p: { harness: string; phase: 'artifacts' | 'store'; done: number; total: number; written: number }) {
      rec = { ...rec, state: 'running', harness: p.harness, phase: p.phase, done: p.done, total: p.total, written: p.written }
      void save()
    },
    memoryPause(signal: AbortSignal) {
      return backfill.memoryPause({
        ask: backfill.askMemoryGate,
        onPause: async reason => { rec = { ...rec, state: 'paused', pausedReason: reason }; await save(true) },
        onResume: async () => { const { pausedReason: _r, ...rest } = rec; rec = { ...rest, state: 'running' }; await save(true) },
        signal,
      })
    },
    async finish(end: { state: 'done' | 'interrupted' | 'failed'; complete?: boolean; error?: string }) {
      const { pausedReason: _r, ...rest } = rec
      rec = { ...rest, state: end.state, ...(end.complete ? { completedAt: new Date().toISOString() } : {}), ...(end.error ? { error: end.error } : {}) }
      await save(true)
    },
  }
}

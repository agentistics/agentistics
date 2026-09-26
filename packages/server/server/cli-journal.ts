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
  report.sinceBoot = readSinceBoot(deps.statusPath ?? `${path}.status.json`, deps.alive ?? pidAlive)
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

const DISABLED_REASON_TEXT: Record<JournalDisabledReason, string> = {
  'network-filesystem': 'its directory is on a network filesystem, where WAL is not safe — the journal refuses to open there.',
  'no-sqlite': 'bun:sqlite could not be loaded (this is not a Bun runtime).',
  'open-failed': 'the file could not be created or opened.',
  'wal-unavailable': 'SQLite answered with a journal mode other than WAL on this filesystem.',
  'db-schema-too-new': 'the file was written by a newer agentop; this build will not write into it.',
  'migrate-failed': 'the file opened, but its schema could not be created or migrated.',
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

/** PURE. Human text, English. Answers in every case — never silent, never a confident 0 for
 *  something this process does not know. */
export function renderJournalStatus(r: JournalReport): string {
  const lines: string[] = []

  lines.push(`Journal: ${r.path}`)
  lines.push(`  Path: ${pathKindText(r.pathKind, r.fsType)}`)
  lines.push(`  AGENTISTICS_JOURNAL (this shell): ${r.flag ?? '(unset)'}`)
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

A read-only look at the durable event journal from outside the process that writes it. It never
creates the journal — a machine that has never had it on stays reporting "no journal", never a
silent 0.`

export async function runJournal(argv: string[], deps?: JournalCliDeps): Promise<number> {
  const cmd = argv[0]
  if (cmd === undefined || cmd === 'help' || cmd === '-h' || cmd === '--help') {
    console.log(USAGE)
    return 0
  }
  if (cmd === 'status') {
    const json = argv.includes('--json')
    const report = await collectJournalReport(deps)
    console.log(json ? JSON.stringify(report, null, 2) : renderJournalStatus(report))
    return 0
  }
  console.error(USAGE)
  return 1
}

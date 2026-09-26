/**
 * journal-budget-ingest.child.ts — ONE build, in a fresh process, for `journal-budget-ingest.test.ts`.
 *
 * Not a test and not imported by anything. The parent spawns it with the environment already set
 * (`AGENTISTICS_DIR`, `AGENTISTICS_JOURNAL_DIR`, `AGENTISTICS_JOURNAL`), because `config.ts` reads
 * every one of those at IMPORT time — so a build under a different flag or a different journal can
 * only ever be a different process. That is also what "a fresh process per build" means in the
 * method A2.3 and A2.5 used: no parse cache, no transcript walk and no replay walk carried over.
 *
 * It times `buildApiResponse()` (what a dashboard waits for) and then, when the flag is on, waits
 * for the NOT-awaited shadow ingest that build started to finish, reading its result off the status
 * file the shadow writes for `agentop journal status` — the same file a live machine would be read
 * from, so the bench measures what production reports rather than a number of its own. The result is
 * printed as ONE line prefixed `INGEST_BENCH ` for the parent to parse.
 */
import { readFileSync } from 'node:fs'
import { JOURNAL_ENABLED, JOURNAL_STATUS_PATH } from '../config'
import { buildApiResponse } from '../data'
import type { ShadowStatusFile } from './shadow'

/** A first ingest of a large store has been measured near a minute; this only bounds a hang. */
const SHADOW_WAIT_MS = 20 * 60_000

function readStatus(): ShadowStatusFile | null {
  try {
    const s = JSON.parse(readFileSync(JOURNAL_STATUS_PATH, 'utf8')) as ShadowStatusFile
    return s.pid === process.pid ? s : null
  } catch {
    return null
  }
}

const t0 = Bun.nanoseconds()
const data = await buildApiResponse()
const buildMs = (Bun.nanoseconds() - t0) / 1e6

let shadow: ShadowStatusFile['lastRun'] | 'timeout' | null = null
let waitedMs = 0
if (JOURNAL_ENABLED) {
  const w0 = Bun.nanoseconds()
  for (;;) {
    const s = readStatus()
    if (s && s.runs >= 1) { shadow = s.lastRun; break }
    if ((Bun.nanoseconds() - w0) / 1e6 > SHADOW_WAIT_MS) { shadow = 'timeout'; break }
    await Bun.sleep(100)
  }
  waitedMs = (Bun.nanoseconds() - w0) / 1e6
}

console.log('INGEST_BENCH ' + JSON.stringify({
  flag: JOURNAL_ENABLED,
  buildMs: Math.round(buildMs),
  sessions: data.sessions.length,
  shadow,
  /** Wall time between the build resolving and the shadow's status file landing. */
  shadowTailMs: Math.round(waitedMs),
}))
process.exit(0)

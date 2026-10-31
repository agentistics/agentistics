/**
 * opencode-run-log.ts — the IO in front of the pure `opencode-run-link.ts`: read opencode's own
 * `<data>/log/opencode.log` (read-only), and pair each running opencode TUI with the `ses_…` it drives.
 *
 * Cheap on purpose — `scanLinuxProcesses` runs every fleet poll: the parse is memoized on the log's
 * (mtime, size), only the last `MAX_TAIL_BYTES` are read (a run that started before that window loses its
 * opening line and simply gets no link, which `parseOpencodeRuns` already refuses), and nothing is read at
 * all when no opencode process is running. Every failure is an absent link, never a throw.
 */
import { open, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { OPENCODE_DIR } from '../config'
import { linkOpencodeProcesses, parseOpencodeRuns, type OpencodeProcessRef, type OpencodeRun } from './opencode-run-link'

export const MAX_TAIL_BYTES = 4 * 1024 * 1024

export function opencodeLogPath(dir: string = OPENCODE_DIR): string {
  return join(dir, 'log', 'opencode.log')
}

const memo = new Map<string, { mtimeMs: number; size: number; runs: Map<string, OpencodeRun> }>()

async function runsOf(path: string): Promise<Map<string, OpencodeRun> | null> {
  try {
    const st = await stat(path)
    const hit = memo.get(path)
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.runs
    const from = Math.max(0, st.size - MAX_TAIL_BYTES)
    const fh = await open(path, 'r')
    let text: string
    try {
      const buf = Buffer.alloc(st.size - from)
      await fh.read(buf, 0, buf.length, from)
      text = buf.toString('utf-8')
    } finally { await fh.close() }
    const runs = parseOpencodeRuns(text)
    if (memo.size > 8) memo.clear()
    memo.set(path, { mtimeMs: st.mtimeMs, size: st.size, runs })
    return runs
  } catch { return null }
}

/** The session each opencode process is driving, by pid. Empty when the log cannot be read. */
export async function readOpencodeProcessSessions(
  procs: readonly OpencodeProcessRef[],
  logPath: string = opencodeLogPath(),
  taken: ReadonlySet<string> = new Set(),
): Promise<Map<number, string>> {
  if (procs.length === 0) return new Map()
  const runs = await runsOf(logPath)
  return runs ? linkOpencodeProcesses(procs, runs, undefined, taken) : new Map()
}

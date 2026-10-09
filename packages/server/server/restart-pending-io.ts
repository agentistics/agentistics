/** IO half of restart-pending.ts: stat the binary, run `--version` on it once per file state. */
import { readlinkSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { CURRENT_VERSION } from './version'
import { diskMayDiffer, parseBinaryVersion } from './restart-pending'

const PROCESS_START_MS = Date.now() - process.uptime() * 1000
let memo: { key: string; version: string | null } | null = null

/** The path this process was started from, without the kernel's ` (deleted)` marker. */
export function cleanExecPath(execPath: string): string {
  return execPath.replace(/ \(deleted\)$/, '')
}

/** Version of the binary on disk at `execPath`, or `null` when it cannot be told. Memoized per mtime+size. */
export function readDiskVersion(execPath: string = process.execPath, runVersion = defaultRun): string | null {
  const bin = cleanExecPath(execPath)
  let exeReplaced = false
  try { exeReplaced = readlinkSync('/proc/self/exe').endsWith(' (deleted)') } catch { /* not Linux */ }
  let st: { mtimeMs: number; size: number }
  try { st = statSync(bin) } catch { return null }
  if (!diskMayDiffer({ exeReplaced, diskMtimeMs: st.mtimeMs, processStartMs: PROCESS_START_MS })) return CURRENT_VERSION
  const key = `${bin}:${st.mtimeMs}:${st.size}`
  if (memo?.key === key) return memo.version
  const version = parseBinaryVersion(runVersion(bin))
  memo = { key, version }
  return version
}

function defaultRun(bin: string): string {
  try {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 8_000, env: { ...process.env, AGENTISTICS_NO_UPDATE_CHECK: '1' } })
    return r.stdout ?? ''
  } catch { return '' }
}

export function resetDiskVersionMemo(): void { memo = null }

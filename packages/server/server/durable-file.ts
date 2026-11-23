/**
 * Durable writes for state that cannot be regenerated (the board, the session registry).
 *
 * WHY: on 2026-11-21 the disk went read-only after an I/O error and two files came back ENTIRELY
 * zero-filled at their original size — tmp-then-rename alone is atomic against a crashed PROCESS,
 * not against a lost page cache: the rename can reach the disk before the data does. So the order
 * is data -> fsync(file) -> rename -> fsync(directory), and a rotated last-good copy (`.bak`)
 * means a file that still comes back unreadable costs minutes of work, not the whole history.
 */
import { open, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import * as fsp from 'node:fs/promises'
import { basename, dirname } from 'node:path'

let seq = 0

/**
 * The fs calls the ordering depends on, injectable so a test can SPY on the order (fsync before rename, dir after).
 * Resolved through the module namespace at CALL time, so a `spyOn(fs, 'rename')` elsewhere (the delivery guard
 * sweep counts the board's renames) still observes a durable write.
 */
const realOps = {
  open: (...a: Parameters<typeof open>) => fsp.open(...a),
  rename: (...a: Parameters<typeof rename>) => fsp.rename(...a),
  rm: (...a: Parameters<typeof rm>) => fsp.rm(...a),
}
let ops: typeof realOps = realOps
export function __setDurableOpsForTest(o: Partial<typeof realOps> | null): void { ops = o ? { ...realOps, ...o } : realOps }

/** Write `data` to `file` so that a crash leaves either the old bytes or the complete new ones. */
export async function durableWrite(file: string, data: string, mode?: number): Promise<void> {
  const tmp = `${file}.tmp.${process.pid}.${(seq += 1)}`
  try {
    const fh = await ops.open(tmp, 'w', mode)
    try {
      await fh.writeFile(data, 'utf8')
      await fh.sync()
    } finally {
      await fh.close()
    }
    await ops.rename(tmp, file)
    await fsyncDir(dirname(file))
  } catch (err) {
    await ops.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

/** fsync a directory so the rename itself is durable. Best effort: some platforms refuse it. */
async function fsyncDir(dir: string): Promise<void> {
  try {
    const fh = await ops.open(dir, 'r')
    try { await fh.sync() } finally { await fh.close() }
  } catch { /* Windows/NFS cannot fsync a directory; the file data is already synced */ }
}

export const BAK_EVERY_MS = 5 * 60_000

export function bakPath(file: string): string { return `${file}.bak` }

/**
 * Refresh the last-good copy of `file` (already written and valid) when the current copy is older
 * than `everyMs`. A 20 MB board is therefore doubled at most once per interval, not per comment.
 * Never throws: a failed backup must not fail the write it protects.
 */
export async function refreshLastGood(file: string, data: string, now = Date.now(), everyMs = BAK_EVERY_MS, isEmpty = false): Promise<boolean> {
  try {
    const st = await stat(bakPath(file)).catch(() => null)
    if (st && now - st.mtimeMs < everyMs) return false
    // An EMPTY state (nothing in it) never replaces a copy that holds data: that is how the one good
    // copy was lost once a read came back empty by mistake.
    if (isEmpty && st && st.size > data.length) return false
    await durableWrite(bakPath(file), data)
    return true
  } catch (err) {
    console.error('[durable] could not refresh last-good copy of', file, String(err))
    return false
  }
}

/** The last-good copy's text when it exists and `valid` accepts it, else null. */
export async function readLastGood(file: string, valid: (text: string) => boolean): Promise<string | null> {
  try {
    const text = await readFile(bakPath(file), 'utf8')
    return valid(text) ? text : null
  } catch { return null }
}

/**
 * The state file is MISSING or EMPTY (0 bytes / whitespace — the classic ext4 crash result) while a valid
 * last-good copy exists: that is a loss, not a fresh install. Returns the copy's text (and says which
 * it was) or null when this really is nothing to recover (no file and no copy, or a non-empty file).
 */
export async function recoverVanished(file: string, text: string | null, valid: (t: string) => boolean): Promise<{ good: string; empty: boolean } | null> {
  if (text !== null && text.trim()) return null
  const good = await readLastGood(file, valid)
  return good === null ? null : { good, empty: text !== null }
}

/** True when `<file>.corrupt-*` siblings exist: this state was lost once, so "empty" is not "new". */
export async function hasQuarantine(file: string): Promise<boolean> {
  try {
    const prefix = `${basename(file)}.corrupt-`
    return (await readdir(dirname(file))).some(n => n.startsWith(prefix))
  } catch { return false }
}

/** Raise the owner-visible alert for a quarantined state file. Lazy import keeps this module pure of the server. */
const alertedFiles = new Set<string>()
type AlertSink = (n: { type: 'warning' | 'error'; title: string; message: string }) => void
let alertSink: AlertSink | null = null
export function __setAlertSinkForTest(sink: AlertSink | null): void { alertSink = sink; alertedFiles.clear() }
export async function alertQuarantined(file: string, restored: boolean): Promise<void> {
  if (alertedFiles.has(file)) return
  alertedFiles.add(file)
  console.error(`[durable] ${file} was unreadable and was quarantined; ${restored ? 'restored from the last good copy' : 'NO good copy — starting empty'}`)
  try {
    const send: AlertSink = alertSink ?? (await import('./sse')).broadcastNotification as AlertSink
    send({
      type: restored ? 'warning' : 'error',
      title: restored ? 'State file recovered from backup' : 'State file lost',
      message: `${basename(file)} was unreadable (disk fault?). ${restored ? 'Restored from the last good copy; recent changes may be missing.' : 'No good copy was found; it restarted empty. Restore from an agentop backup.'}`,
    })
  } catch { /* alerting never fails a read */ }
}


/** `writeFile(path, data, { mode })` that also fsyncs — for callers whose rename is a separate, injectable step. */
export async function writeFileSynced(path: string, data: string, o: { mode?: number } = {}): Promise<void> {
  const fh = await open(path, 'w', o.mode)
  try { await fh.writeFile(data, 'utf8'); await fh.sync() } finally { await fh.close() }
}

/** `rename` followed by an fsync of the directory, so the rename itself survives a crash. */
export async function renameSynced(from: string, to: string): Promise<void> {
  await rename(from, to)
  await fsyncDir(dirname(to))
}

/**
 * Server start: remove `<name>.tmp.<pid>.<n>` temp files `durableWrite` left behind when its process was
 * killed mid-write (a board temp is 20 MB). Only files older than `maxAgeMs` whose pid is not ours.
 * Never throws; returns how many it removed.
 */
export async function sweepStaleDurableTmps(dir: string, maxAgeMs = 10 * 60_000, now = Date.now(), ownPid = process.pid): Promise<number> {
  let removed = 0
  const names = await readdir(dir).catch(() => [] as string[])
  for (const name of names) {
    const m = /\.tmp\.(\d+)\.\d+$/.exec(name)
    if (!m || Number(m[1]) === ownPid) continue
    const path = `${dir}/${name}`
    const st = await stat(path).catch(() => null)
    if (!st?.isFile() || now - st.mtimeMs < maxAgeMs) continue
    if (await rm(path, { force: true }).then(() => true, () => false)) removed++
  }
  return removed
}

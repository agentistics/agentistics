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
import { basename, dirname } from 'node:path'

let seq = 0

/** Write `data` to `file` so that a crash leaves either the old bytes or the complete new ones. */
export async function durableWrite(file: string, data: string): Promise<void> {
  const tmp = `${file}.tmp.${process.pid}.${(seq += 1)}`
  try {
    const fh = await open(tmp, 'w')
    try {
      await fh.writeFile(data, 'utf8')
      await fh.sync()
    } finally {
      await fh.close()
    }
    await rename(tmp, file)
    await fsyncDir(dirname(file))
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

/** fsync a directory so the rename itself is durable. Best effort: some platforms refuse it. */
async function fsyncDir(dir: string): Promise<void> {
  try {
    const fh = await open(dir, 'r')
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
export async function refreshLastGood(file: string, data: string, now = Date.now(), everyMs = BAK_EVERY_MS): Promise<boolean> {
  try {
    const st = await stat(bakPath(file)).catch(() => null)
    if (st && now - st.mtimeMs < everyMs) return false
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

/** True when `<file>.corrupt-*` siblings exist: this state was lost once, so "empty" is not "new". */
export async function hasQuarantine(file: string): Promise<boolean> {
  try {
    const prefix = `${basename(file)}.corrupt-`
    return (await readdir(dirname(file))).some(n => n.startsWith(prefix))
  } catch { return false }
}

/** Raise the owner-visible alert for a quarantined state file. Lazy import keeps this module pure of the server. */
const alertedFiles = new Set<string>()
export async function alertQuarantined(file: string, restored: boolean): Promise<void> {
  if (alertedFiles.has(file)) return
  alertedFiles.add(file)
  console.error(`[durable] ${file} was unreadable and was quarantined; ${restored ? 'restored from the last good copy' : 'NO good copy — starting empty'}`)
  try {
    const { broadcastNotification } = await import('./sse')
    broadcastNotification({
      type: restored ? 'warning' : 'error',
      title: restored ? 'State file recovered from backup' : 'State file lost',
      message: `${basename(file)} was unreadable (disk fault?). ${restored ? 'Restored from the last good copy; recent changes may be missing.' : 'No good copy was found; it restarted empty. Restore from an agentop backup.'}`,
    })
  } catch { /* alerting never fails a read */ }
}


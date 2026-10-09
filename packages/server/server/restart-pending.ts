/**
 * restart-pending.ts — PURE: is the binary on disk NEWER than the process answering?
 *
 * 2026-10-09: ~/.local/bin/agentop was already v2.112.2 while the running server was v2.112.1.
 * "Install now" found nothing to download (`agentop upgrade` saw the disk already current), restarted
 * nothing, and the page waited forever for a version change. The fix is to name that state — the
 * update is INSTALLED, the process is just old — so the route restarts instead of downloading and
 * `/api/version` can say so.
 */

import { compareVersions } from './version'

/** `agentop v2.112.2\n…` → `2.112.2`; anything else → `null`. */
export function parseBinaryVersion(stdout: string): string | null {
  const m = /^agentop v(\d+(?:\.\d+)*)\s*$/m.exec(stdout)
  return m ? m[1]! : null
}

export type DiskComparison = 'newer' | 'same' | 'older' | 'unknown'

/** Disk binary against the running process. `null`/unparseable on either side is `unknown`, never "same". */
export function compareDisk(running: string, disk: string | null): DiskComparison {
  if (!disk || !/^\d+(\.\d+)*$/.test(disk) || !/^\d+(\.\d+)*$/.test(running)) return 'unknown'
  const d = compareVersions(disk, running)
  return d > 0 ? 'newer' : d < 0 ? 'older' : 'same'
}

/**
 * Could the disk binary differ from the running one at all? A cheap pre-check so the probe (which
 * runs the binary) is not paid on every poll: the file was replaced (`/proc/self/exe` says
 * ` (deleted)`) or is newer than the process.
 */
export function diskMayDiffer(o: { exeReplaced: boolean; diskMtimeMs: number | null; processStartMs: number }): boolean {
  if (o.exeReplaced) return true
  return o.diskMtimeMs !== null && o.diskMtimeMs > o.processStartMs + 1000
}

/** Apply a pending restart to what `/api/version` reports: the update is real and installable. */
export function withRestartPending<T extends { current: string; latest: string; hasUpdate: boolean }>(
  info: T, disk: string | null,
): T & { restartNeeded: boolean; diskVersion: string | null } {
  if (compareDisk(info.current, disk) !== 'newer' || !disk) return { ...info, restartNeeded: false, diskVersion: disk }
  const latest = compareVersions(disk, info.latest) > 0 ? disk : info.latest
  return { ...info, latest, hasUpdate: true, restartNeeded: true, diskVersion: disk }
}

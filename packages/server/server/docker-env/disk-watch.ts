/**
 * DOCKER.AMBIENTES S2 — the disk watchdog's decision (SPEC-r3 §11.2). PURE.
 *
 * Every 15 s the launcher measures the session's volumes (`docker system df -v`) and the writable bind mounts
 * (`du`), plus the free space where Docker keeps its data. Over the session's ceiling, or Docker's disk under the
 * floor, the command is killed. It is NOT a hard quota (a `local` volume on ext4/overlay has none): the worst
 * overshoot is the write rate times the interval, and the message says so.
 */

export const DISK_WATCH_EVERY_MS = 15_000
export const SESSION_DISK_MAX_BYTES = 4 * 1024 ** 3
export const DOCKER_FREE_FLOOR_BYTES = 2 * 1024 ** 3

export interface DiskSample {
  /** Bytes used by this session's volumes + its writable bind mounts. */
  sessionBytes: number
  /** Free bytes on the file system holding `DockerRootDir`; null = unknown (never a reason to kill). */
  dockerFreeBytes: number | null
}

const gb = (b: number) => (b / 1024 ** 3).toFixed(2)

export function diskVerdict(s: DiskSample, limits: { sessionMax: number; freeFloor: number; everyMs: number } = { sessionMax: SESSION_DISK_MAX_BYTES, freeFloor: DOCKER_FREE_FLOOR_BYTES, everyMs: DISK_WATCH_EVERY_MS }): { kill: false } | { kill: true; code: 'disco_sessao' | 'disco_cheio'; message: string } {
  const window = `${Math.round(limits.everyMs / 1000)} s`
  if (s.sessionBytes > limits.sessionMax) {
    return { kill: true, code: 'disco_sessao', message: `agentop run: the environment used ${gb(s.sessionBytes)} GB, over its ${gb(limits.sessionMax)} GB ceiling; the command was stopped. This is checked every ${window}, so it can overshoot by up to ${window} of writing.` }
  }
  if (s.dockerFreeBytes !== null && s.dockerFreeBytes < limits.freeFloor) {
    return { kill: true, code: 'disco_cheio', message: `agentop run: only ${gb(s.dockerFreeBytes)} GB free where Docker keeps its data (floor ${gb(limits.freeFloor)} GB); the command was stopped.` }
  }
  return { kill: false }
}

/** `docker system df -v --format '{{json .}}'` -> bytes per volume name (sizes like "12.3MB", "1.2GB", "0B"). */
export function volumeSizes(dfJson: string): Map<string, number> {
  const out = new Map<string, number>()
  let j: any
  try { j = JSON.parse(dfJson) } catch { return out }
  for (const v of Array.isArray(j?.Volumes) ? j.Volumes : []) {
    const m = /^([\d.]+)\s*([kKMGT]?i?B)$/.exec(String(v.Size ?? '').trim())
    if (!m) continue
    const unit = m[2]!.toUpperCase().replace('I', '')
    const mult = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 }[unit] ?? 1
    out.set(String(v.Name), Math.round(Number(m[1]) * mult))
  }
  return out
}

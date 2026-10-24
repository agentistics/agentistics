import { collectOwnPids, escalateKill, procIO, type EscalateIO, type PidRef } from './kill-escalate'

/** End only the process tree observed on this row. No cwd or conversation lookup is needed. */
export async function endExternalProcess(
  pid: number,
  collect: (pid: number) => Promise<PidRef[]> = collectOwnPids,
  io: EscalateIO = procIO(),
  terminate: (pid: number) => void = pid => { process.kill(pid, 'SIGTERM') },
): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return false
  const refs = await collect(pid)
  // Without a captured identity we cannot confirm an external process was ended.
  if (!refs.some(r => r.pid === pid)) return false
  for (const ref of [...refs].reverse()) {
    if (io.alive(ref)) { try { terminate(ref.pid) } catch { /* escalation confirms survivors */ } }
  }
  return (await escalateKill(refs, io)).stuck.length === 0
}

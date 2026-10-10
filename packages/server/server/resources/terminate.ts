/**
 * resources/terminate.ts — end a process for real: SIGTERM, wait, SIGKILL, and say whether it is gone.
 *
 * A bare SIGTERM was reported as "stopped" even when the target ignores it (a `__structured-relay`
 * whose child already exited returns early from its handler and lives forever). The answer here is
 * the OBSERVED exit, never the signal being sent.
 */
export interface TerminateDeps {
  kill: (pid: number, sig: NodeJS.Signals | 0) => void
  alive: (pid: number) => boolean
  sleep: (ms: number) => Promise<void>
  graceMs?: number
  pollMs?: number
}

/** `true` only when the pid is confirmed gone. `gone` is distinguished: it was never there to end. */
export async function terminateAndConfirm(pid: number, d: TerminateDeps): Promise<{ ended: boolean; signal: 'SIGTERM' | 'SIGKILL' | 'none' }> {
  const grace = d.graceMs ?? 3000
  const poll = d.pollMs ?? 100
  const waitDead = async (ms: number): Promise<boolean> => {
    for (let t = 0; t < ms; t += poll) {
      if (!d.alive(pid)) return true
      await d.sleep(poll)
    }
    return !d.alive(pid)
  }
  try { d.kill(pid, 'SIGTERM') } catch { return { ended: !d.alive(pid), signal: 'none' } }
  if (await waitDead(grace)) return { ended: true, signal: 'SIGTERM' }
  try { d.kill(pid, 'SIGKILL') } catch { /* raced to exit */ }
  return { ended: await waitDead(1500), signal: 'SIGKILL' }
}

/**
 * The exit code `agentop server` uses when it refuses to start because ANOTHER server already
 * holds this data directory (or its port).
 *
 * It is its own number for one reason: a service manager must be able to tell it apart from a
 * crash. `Restart=on-failure` restarts on any non-zero exit, so a unit whose start was refused
 * restarted every five seconds, loaded the whole application each time, was refused again — 190
 * times in one night, until the machine had no memory left to open a session
 * (docs/incidents/2026-10-03-restart-loop.md). The unit names this code in
 * `RestartPreventExitStatus=`, so the refusal STOPS the unit instead of looping it.
 *
 * 75 is `EX_TEMPFAIL` in sysexits.h: "try again later" — which is exactly the situation, and
 * a number no crash path of this program produces by accident.
 */
export const EXIT_INSTANCE_HELD = 75

/**
 * Did a listen fail because the port is taken? Reads the error CODE as well as the message: Bun's
 * message is `Failed to start server. Is port 47291 in use?` and never says `EADDRINUSE`, so the
 * message-only check `index.ts` had missed it, rethrew, and the unit exited 1 — a failure — and was
 * restarted again.
 */
export function isAddressInUse(err: unknown): boolean {
  if (err && typeof err === 'object' && (err as { code?: unknown }).code === 'EADDRINUSE') return true
  const msg = err instanceof Error ? err.message : String(err ?? '')
  return msg.includes('EADDRINUSE') || msg.includes('already in use') || /is port \d+ in use/i.test(msg)
}

/**
 * daemon-plan.ts — PURE. What `agentop server` starts BESIDE the HTTP server, by where it runs.
 *
 * `agentop server` is the server plus the in-process daemon (`otel-watcher.ts`, which also hosts the
 * session-event producer and the scheduled backup) plus a one-line update banner. That is the right
 * set for a MACHINE run natively, which is what the command was written for. It is the wrong set in
 * a CONTAINER (`AGENTISTICS_CONTAINER=1`, set by the Dockerfile): it cannot reach the host's tmux
 * socket and must not upgrade itself — it is replaced by pulling or rebuilding its image. Its
 * `~/.agentistics` is the host's own directory mounted in, so a scheduled backup from inside it
 * would be a second backup of the same files beside the host's. The OTel export stays: it only runs
 * when OTEL_EXPORTER_OTLP_ENDPOINT is set, which is an explicit ask. The update banner goes: it says
 * "run agentop upgrade", which is false inside an image.
 *
 * One function, read by `cli.ts` (whether to load the daemon and the banner) and by `otel-watcher.ts`
 * (which of its riders to start), so the two can never disagree about the same process.
 */

export interface DaemonPlan {
  /** Load `otel-watcher.ts` at all. */
  watcher: boolean
  /** The session-event producer (events/daemon.ts). */
  eventProducer: boolean
  /** The scheduled backup (backup/daemon.ts). */
  scheduledBackup: boolean
  /** The "new version available — run agentop upgrade" banner at startup. */
  updateBanner: boolean
}

export function serverDaemonPlan(o: { container: boolean }): DaemonPlan {
  if (o.container) {
    return { watcher: true, eventProducer: false, scheduledBackup: false, updateBanner: false }
  }
  return { watcher: true, eventProducer: true, scheduledBackup: true, updateBanner: true }
}

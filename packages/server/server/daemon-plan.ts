/**
 * daemon-plan.ts — PURE. What `agentop server` starts BESIDE the HTTP server, by where it runs.
 *
 * `agentop server` is the server plus the in-process daemon (`otel-watcher.ts`, which also hosts the
 * session-event producer and the scheduled backup) plus a one-line update banner. That is the right
 * set for a MACHINE run natively, which is what the command was written for. It is the wrong set in
 * two places this binary now also runs, because the published image runs `agentop server` too:
 *
 *   - A CENTRAL has no host sessions. The event producer polls this host's tmux fleet for state
 *     transitions; on a central there is no fleet to poll, and its heartbeat would report a producer
 *     "watching" a machine nobody works on. The OTel snapshot reads this host's `~/.claude`, which a
 *     central does not have, and the scheduled backup carries a MACHINE's history — a central's data
 *     is its database. So a central starts none of the daemon, natively or in a container.
 *   - A CONTAINER (`AGENTISTICS_CONTAINER=1`, set by the Dockerfile) cannot reach the host's tmux
 *     socket and must not upgrade itself: it is replaced by pulling or rebuilding its image. Its
 *     `~/.agentistics` is the host's own directory mounted in (docker/machine.yml), so a scheduled
 *     backup from inside it would be a second backup of the same files beside the host's. The OTel
 *     export stays: it only runs when OTEL_EXPORTER_OTLP_ENDPOINT is set, which is an explicit ask.
 *     The update banner goes: it says "run agentop upgrade", which is false inside an image.
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

export function serverDaemonPlan(o: { central: boolean; container: boolean }): DaemonPlan {
  if (o.central) {
    return { watcher: false, eventProducer: false, scheduledBackup: false, updateBanner: !o.container }
  }
  if (o.container) {
    return { watcher: true, eventProducer: false, scheduledBackup: false, updateBanner: false }
  }
  return { watcher: true, eventProducer: true, scheduledBackup: true, updateBanner: true }
}

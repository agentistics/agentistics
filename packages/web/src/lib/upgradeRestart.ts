/** Pure restart/readiness state machine for an in-place update. */
export type RestartPhase = 'updating' | 'restarting' | 'waiting-new-version' | 'ready' | 'swap'

export type RestartEvent =
  | { type: 'submitted' }
  | { type: 'poll'; version: 'old' | 'new' | 'down'; serviceWorkerReady?: boolean; bundleReady?: boolean }
  | { type: 'swap' }

export function restartStep(phase: RestartPhase, event: RestartEvent): RestartPhase {
  if (event.type === 'submitted') return phase === 'updating' ? 'restarting' : phase
  if (event.type === 'swap') return phase === 'ready' ? 'swap' : phase
  if (phase === 'restarting' && (event.version === 'down' || event.version === 'old')) return 'waiting-new-version'
  if ((phase === 'restarting' || phase === 'waiting-new-version') && event.version === 'new') {
    return event.serviceWorkerReady !== false && event.bundleReady !== false ? 'ready' : 'waiting-new-version'
  }
  return phase
}

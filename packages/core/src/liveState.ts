/** States that represent a session which can receive work right now. */
export const LIVE_SESSION_STATES = ['working', 'waiting', 'waiting-approval', 'idle'] as const

export function isLiveState(state: string | undefined): boolean {
  return state === 'working' || state === 'waiting' || state === 'waiting-approval' || state === 'idle'
}

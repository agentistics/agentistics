import type { HandoffLevel } from '@agentistics/core'

/** The four faces the header's leader indicator can wear (option B, owner 2026-10-23): the crown's
 *  circle and the token figure beside it are both painted in the state's colour, and that colour is
 *  the ONLY thing that says the state — there is no outer capsule.
 *
 *  `none` is "no reading": the server knows this is a leader but has no context gauge for it yet.
 *  It is drawn (grey, with a dash) rather than hidden, because a leader whose meter vanishes reads
 *  as a session that stopped being a leader — and `null` is not zero. */
export type LeaderMeterState = 'normal' | 'attention' | 'critical' | 'none'

/** `near` warns; `due` (the cut) and `overdue` both ask for action now. */
export function leaderMeterState(level: HandoffLevel, contextTokens: number | null): LeaderMeterState {
  if (contextTokens === null) return 'none'
  return level === 'normal' ? 'normal' : level === 'near' ? 'attention' : 'critical'
}

/** The app's own colour tokens — no hand-picked hex. `none` uses the secondary text colour because
 *  the tertiary one is too faint to carry a filled circle in either theme. */
export const LEADER_METER_TONE: Record<LeaderMeterState, string> = {
  normal: 'var(--accent-green)',
  attention: 'var(--anthropic-orange-light)',
  critical: 'var(--accent-red)',
  none: 'var(--text-secondary)',
}

export function leaderMeterStateLabel(state: LeaderMeterState, pt: boolean): string {
  return ({
    normal: pt ? 'Normal' : 'Normal',
    attention: pt ? 'Atenção' : 'Attention',
    critical: pt ? 'Crítico' : 'Critical',
    none: pt ? 'Sem leitura' : 'No reading',
  })[state]
}

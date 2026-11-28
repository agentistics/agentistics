/**
 * Why a session is ended. `final`: a person's or leader's kill/retire, or fechar-entregue. The others
 * recreate it in the SAME directory (`account-switch`, `mode-migration`, `handoff`) or are the engine
 * ending a session it delegated (`delegation`); none of them may clean its worktree.
 */
export const KILL_END_REASONS = ['final', 'account-switch', 'mode-migration', 'handoff', 'delegation'] as const
export type KillEndReason = (typeof KILL_END_REASONS)[number]

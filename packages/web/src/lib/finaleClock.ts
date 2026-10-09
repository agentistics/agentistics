/**
 * finaleClock.ts — the finale's timeline advances with FRAMES THAT WERE PAINTED, not with the wall
 * clock. A fresh bundle boots on a busy main thread (parsing, the first fetches); a wall-clock `t`
 * kept running through those stalls, so the first painted frame could already be past the suction
 * (`SUCK_S`) and the person saw only the burst. Each frame contributes at most `MAX_FRAME_S`.
 */
export const MAX_FRAME_S = 0.064

export function advanceFinaleClock(t: number, dtMs: number): number {
  return t + Math.min(MAX_FRAME_S, Math.max(0, dtMs / 1000))
}

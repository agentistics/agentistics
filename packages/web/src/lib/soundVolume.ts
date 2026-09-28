/**
 * soundVolume.ts — the ONE arithmetic rule behind every synthesized sound this dashboard plays:
 * how a volume preference (0..1) becomes the gain a Web Audio graph actually plays at, and whether
 * a gated sound may play at all.
 *
 * THE BUG THIS EXISTS FOR. `sessionNotifications.ts`'s `playNotificationSound` already scaled its
 * output correctly through a master `GainNode` — but `chatSounds.ts` (the Nay chat widget's reply
 * "ding") had no volume parameter anywhere: every preset hardcoded its peak gain
 * (`gain.gain.linearRampToValueAtTime(0.18, …)` and friends) and connected straight to
 * `ctx.destination`, so the ONE volume slider in the whole app (Settings → Notifications → Sound
 * Effects) never touched it — reported as "even when I lower the volume it stays loud". And the
 * chat sound's only switch was its own `chatSoundEnabled` toggle in Settings → Chat, never the
 * "Efeitos Sonoros Globais" ("Sound Effects" — deliberately titled GLOBAL) toggle right next to
 * that slider, so turning sound off there left the chat ding playing — "even when disabled it
 * still notifies".
 *
 * `clampVolume` is the one place that decides what a missing or malformed value reads as, so both
 * sound engines clamp identically instead of each guessing its own edge cases.
 */
export function clampVolume(volume: number | undefined, fallback: number): number {
  const v = volume ?? fallback
  if (!Number.isFinite(v)) return fallback
  return Math.max(0, Math.min(1, v))
}

/**
 * Whether the chat reply sound may play.
 *
 * Chat keeps its OWN switch (`chatSoundEnabled`, Settings → Chat) because it names a distinct
 * feature from the fleet's Live Session alerts — but it is synthesized through the very same
 * "Sound Effects" engine the Notifications screen's GLOBAL toggle and volume slider govern, so it
 * may only ever NARROW what that section allows, never re-enable a sound the user turned off
 * there. Same shape as `chat-gate.ts`'s `chatAllowed(capable, preference)`: a capability/global
 * switch on one side, a feature-local preference on the other, ANDed.
 */
export function chatSoundActive(input: { globalSoundEnabled: boolean; chatSoundEnabled: boolean }): boolean {
  return input.globalSoundEnabled && input.chatSoundEnabled
}

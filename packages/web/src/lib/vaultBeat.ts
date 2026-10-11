/**
 * VAULT.V2: one page beat. Only a browser-originated gesture counts (a script can dispatch events too), and
 * the page re-arms its heartbeat token ONLY when the server said `activity-token` — never on any other refusal
 * (`activity-too-soon`, `vault-locked`, …), which would turn every refusal into an arm attempt.
 */
export interface BeatDeps {
  heartbeat: () => Promise<{ json: Record<string, unknown> } | null>
  armHeartbeat: () => Promise<{ json: Record<string, unknown> } | null>
}

export async function pageBeat(event: { isTrusted: boolean }, deps: BeatDeps): Promise<'ignored' | 'beat' | 'rearmed' | 'arm-refused'> {
  if (!event.isTrusted) return 'ignored'
  const r = await deps.heartbeat()
  if (r?.json.code !== 'activity-token') return 'beat'
  const armed = await deps.armHeartbeat()
  if (!armed?.json.ok) return 'arm-refused'
  await deps.heartbeat()
  return 'rearmed'
}

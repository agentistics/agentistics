/**
 * accountMutations.ts — PURE-ish: one PATCH at a time PER ACCOUNT.
 *
 * Two requests in flight for the same account both answer with a full snapshot, and whichever lands
 * last would overwrite the newer state on screen — so a second request for an account that already
 * has one in flight is refused (`busy`) instead of racing it. The caller disables the controls while
 * `inFlight` holds the id. An unidentified account (id '') has no route to PATCH and is refused.
 */
export type PatchBody = { available?: boolean; nickname?: string }

export type PatchResult<A> =
  | { status: 'ok'; account: A }
  | { status: 'failed' }
  | { status: 'busy' }
  | { status: 'unsupported' }

export function createAccountMutator<A>(
  send: (id: string, body: PatchBody) => Promise<{ ok: boolean; json: () => Promise<{ account: A }> }>,
) {
  const inFlight = new Set<string>()
  return {
    has: (id: string) => inFlight.has(id),
    async patch(id: string, body: PatchBody): Promise<PatchResult<A>> {
      if (id === '') return { status: 'unsupported' }
      if (inFlight.has(id)) return { status: 'busy' }
      inFlight.add(id)
      try {
        const r = await send(id, body)
        if (!r.ok) return { status: 'failed' }
        return { status: 'ok', account: (await r.json()).account }
      } catch {
        return { status: 'failed' }
      } finally {
        inFlight.delete(id)
      }
    },
  }
}

/** After a save: keep the user's newer edits, otherwise show what the server actually stored. */
export function reconcileNickname(draft: string, rawSubmittedDraft: string, stored: string | undefined): string {
  return draft === rawSubmittedDraft ? (stored ?? '') : draft
}

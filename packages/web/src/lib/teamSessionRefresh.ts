/**
 * teamSessionRefresh.ts — what a `/api/team/session` read does with what it got back, pulled out of
 * `App.tsx` so the one rule that matters is testable without rendering a component tree.
 *
 * `App.tsx` reads this endpoint once at boot to resolve `AppContext.editorEnabled` (through
 * `editorGate.ts`) and every other team-session field. The Studio's own settings screen used to be
 * unable to make that resolved flag catch up after flipping the preference — the fix is to call the
 * same read again once the PUT that changed the preference has landed, so the SERVER'S combination of
 * capability and preference (never re-derived here) is what reaches every consumer, in both
 * directions of the switch.
 *
 * A REFRESH IS NOT THE FIRST READ, and the two must not resolve a failure the same way. Before
 * anything is known (`previous === undefined`, `App.tsx`'s very first mount) a failed or absent read
 * has to fall back to SOME defined state, or `teamSession === undefined` — the app's own "still
 * resolving" gate — would hold the boot loader up forever over one bad response. Once something is
 * already known, the same failure must keep it: a refresh that could not read anything is a fact
 * about the network at that moment, not a retraction of `central`, `capabilities` or every other
 * field the first read already established — the same rule `refreshDeniedRepoLabels` follows for the
 * hidden-repo badge ("a failed refresh keeps the last-known map — never wipes the badges").
 */
export function resolveTeamSessionRefresh<T>(previous: T | undefined, fetched: T | null, bootDefault: T): T {
  if (fetched !== null) return fetched
  return previous ?? bootDefault
}

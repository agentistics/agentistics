/**
 * modelKeyMatch.ts — PURE. Which row of a model table a model id from ANOTHER source belongs to.
 *
 * Two readers name the same OpenCode model differently: the legacy adapter keys it by its ROUTE
 * (`upx/fable-5.1`, `opencodeModel` in the server's opencode-parse.ts) while the projection (the replay)
 * keys it by OpenCode's raw `modelID` (`fable-5.1`). A route is always `<provider>/<raw id>`, and a raw
 * id can itself carry a slash (`openrouter/anthropic/claude-x` → `anthropic/claude-x`), so the rule is:
 * the exact key, else the LONGEST key the id ends with after a `/`. A partial segment never matches
 * (`upx/fable-5.10` is not `fable-5.1`), and no match is `null` — a model is never filed under a guess.
 */
export function matchModelKey(id: string, keys: Iterable<string>): string | null {
  let best: string | null = null
  for (const k of keys) {
    if (k === id) return k
    if (k && id.endsWith(`/${k}`) && (best === null || k.length > best.length)) best = k
  }
  return best
}

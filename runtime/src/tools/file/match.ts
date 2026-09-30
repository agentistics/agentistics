/**
 * tools/file/match.ts — the three-tier context locator (spec §2 D-T1 / §4): a hunk's context+
 * removed lines are found in the file by CONTENT, never by a line number, tried exact → ignoring
 * trailing whitespace → ignoring leading+trailing whitespace, in that order. Nothing here is
 * vendored: OpenCode/Cline's fuzzy diff-apply was the suggested source (spec §2), but this
 * three-tier rule is small enough, and different enough from a general fuzzy diff, to write
 * directly — see the handback for why nothing is attributed.
 *
 * A tier is accepted only when it matches EXACTLY ONCE. More than one match at a tier is
 * `ambiguous` there and then — a looser tier is never tried after an ambiguous one, because a
 * snippet that already matches twice will not become less ambiguous by relaxing whitespace
 * further. Zero matches at every tier is `no-match`.
 */

export type MatchTier = 'exact' | 'trailing-ws' | 'surrounding-ws'

export const MATCH_TIERS: readonly MatchTier[] = ['exact', 'trailing-ws', 'surrounding-ws']

export interface MatchFound {
  ok: true
  tier: MatchTier
  /** 0-based line index into the haystack where the needle begins. */
  start: number
}

export interface MatchNoMatch {
  ok: false
  reason: 'no-match'
}

export interface MatchAmbiguous {
  ok: false
  reason: 'ambiguous'
  tier: MatchTier
  /** How many places matched at that tier — for the refusal sentence. */
  count: number
}

export type LocateOutcome = MatchFound | MatchNoMatch | MatchAmbiguous

function normalize(line: string, tier: MatchTier): string {
  if (tier === 'exact') return line
  if (tier === 'trailing-ws') return line.replace(/[ \t]+$/, '')
  return line.trim()
}

/** Every 0-based start index where `needle` occurs contiguously in `haystack` under `tier`. */
export function findAll(haystack: readonly string[], needle: readonly string[], tier: MatchTier): number[] {
  if (needle.length === 0 || needle.length > haystack.length) return []
  const normNeedle = needle.map(l => normalize(l, tier))
  const starts: number[] = []
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    let matched = true
    for (let j = 0; j < needle.length; j++) {
      if (normalize(haystack[i + j]!, tier) !== normNeedle[j]) {
        matched = false
        break
      }
    }
    if (matched) starts.push(i)
  }
  return starts
}

/** Locates `needle` inside `haystack`, trying the three tiers in order (see module header). */
export function locateSnippet(haystack: readonly string[], needle: readonly string[]): LocateOutcome {
  if (needle.length === 0) return { ok: false, reason: 'no-match' }
  for (const tier of MATCH_TIERS) {
    const starts = findAll(haystack, needle, tier)
    if (starts.length === 1) return { ok: true, tier, start: starts[0]! }
    if (starts.length > 1) return { ok: false, reason: 'ambiguous', tier, count: starts.length }
  }
  return { ok: false, reason: 'no-match' }
}

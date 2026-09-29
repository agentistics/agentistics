/**
 * usage-dedupe.ts — PURE. One billed API response is counted ONCE.
 *
 * Claude Code writes an assistant turn as SEVERAL transcript lines when its content has several
 * blocks (text, then a `tool_use`, then another), and every one of those lines repeats the SAME
 * `message.usage` object. Summing per LINE therefore counts one API response two or three times.
 *
 * Measured on real transcripts on 2026-09-08, by recounting the raw files independently and
 * comparing against what the store had written:
 *
 *   session 4c3a96ac   148 usage lines / 79 distinct message ids   stored 17.845.286   true 10.381.785
 *   session b9665719                                               stored 609.681.868  true 352.623.940
 *   session aabe988b                                               stored 317.397.822  true 199.430.863
 *
 * The stored figure matched the per-line sum EXACTLY in all three, so this is not an estimate of a
 * defect, it is the defect. Every Claude session in the product over-reported tokens by 60-90 %,
 * and the cost with it — `calcCost` prices whatever these counters say.
 *
 * The key is `message.id`, which is Anthropic's own id for one API response, and one response is
 * one billing event. **The LAST record for an id wins**: where the repeats are byte-identical
 * (which is what every sample showed) it makes no difference, and if a future format ever writes a
 * partial usage first and the final one after, the last is the complete one. Taking the first
 * would silently under-report in exactly that case — and on 2026-09-26 that turned out to be
 * exactly what `resolveUsage`'s predecessor (`countUsage`, a first-wins boolean gate) did for every
 * caller: see the dated note below.
 *
 * A record with NO id is counted, always: it is a line this rule cannot pair with anything, and
 * dropping it would trade an over-count for an under-count. `HARNESS_CAPABILITIES`'s rule applied
 * to a line instead of a metric — what cannot be shown to be a duplicate is not one.
 *
 * The same trap is already documented for Kimi (`usage.record` beside a nested `step.end` carrying
 * the identical numbers) and for Antigravity (a tool REQUEST beside its EXECUTION). Three harnesses,
 * one shape: **when a transcript states one fact in two places, decide which one you count.**
 *
 * ---
 *
 * **2026-09-26 — `countUsage` was first-wins despite this file's own doc.** It returned `true` only
 * the FIRST time an id was seen and `false` on every repeat, which a resumable, single-pass walk
 * (`jsonl.ts`'s `foldClaudeParse`, `subagent-parse.ts`'s `summarizeSubagentTranscript`) used as a
 * gate on whether to ADD a line's usage — so a repeat was silently SKIPPED rather than replacing
 * what the first occurrence contributed. Where the repeats are byte-identical (every MAIN transcript
 * measured here) first-wins and last-wins produce the same total, which is exactly why the defect
 * was invisible from the main-transcript numbers. It is not invisible in SUBAGENT transcripts: an
 * independent differential over this machine's real subagent files found 460 of the invocation rows
 * and 41 of the session totals disagreeing with a from-scratch recount, every one of them a
 * transcript whose first line for some id carried a PARTIAL usage (`output_tokens: 5`, say) and a
 * later line the FINAL one (`276`) — first-wins kept the 5.
 *
 * `resolveUsage` replaces the boolean gate with the caller's own id → last-applied-contribution map,
 * so a repeat is reported as `{ replace: true, previous }` instead of silently dropped: the caller
 * RETRACTS `previous` from every sink that contribution fed (the four counters, a day bucket, the
 * cache-creation TTL split, …) and then adds the new record, which is what makes a resumable fold
 * sound — folding lines `1..n` and then `n+1..m` must equal folding `1..m` in one pass, and a fold
 * that can only ADD would double-count the moment a superseded id's contribution needed removing
 * mid-walk. The context-tokens GAUGE needed no such bookkeeping: it is reassigned, never summed, so
 * running its assignment on every usage-bearing line (dedup or not) already lands on the true last
 * reading in file order — dedup only ever mattered for the four ACCUMULATED counters.
 */

/** The four billed counters one `message.usage` record carries. */
export interface UsageRecord {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

/** What one counted id contributed — the minimum a caller needs to RETRACT it later. A caller with
 *  more sinks than the four base counters (a day bucket, a TTL split, a model id, …) extends this
 *  with its own fields; `resolveUsage` only ever reads and returns the record whole. */
export type UsageContribution = UsageRecord

/** What the caller must do about this line's usage. */
export type UsageDecision<T extends UsageContribution> =
  | { replace: false }
  | { replace: true; previous: T }

/**
 * Record this line's usage against `seen` (the caller's own id → last-applied-contribution map,
 * mutated here) and say what the caller must do about it:
 *
 * - No id, or a malformed one: `{ replace: false }` — always counted, never paired with anything.
 * - The first sighting of an id: `{ replace: false }` — nothing to retract, just add `next`.
 * - A REPEAT of an id already seen: `{ replace: true, previous }` — the id's LAST record wins, so
 *   the caller must retract `previous` from every sink it fed before adding `next`.
 *
 * `seen` is mutated unconditionally to `next` (even on `{ replace: false }`), so the NEXT repeat of
 * this id retracts THIS contribution, not an older one — the walk is a single pass over a file that
 * can be hundreds of megabytes, so the alternative (collect every record, then reduce) would hold
 * the whole file in memory to answer a question one map lookup can; one small record per DISTINCT
 * id is what this costs instead.
 */
export function resolveUsage<T extends UsageContribution>(
  messageId: unknown,
  seen: Map<string, T>,
  next: T,
): UsageDecision<T> {
  if (typeof messageId !== 'string' || !messageId) return { replace: false }
  const previous = seen.get(messageId)
  seen.set(messageId, next)
  return previous ? { replace: true, previous } : { replace: false }
}

/**
 * The four counters of the records that should be counted, for a whole list — the same rule as
 * `resolveUsage`, in the shape a test (or a one-off audit) wants.
 *
 * LAST wins per id, which is why this cannot be expressed as a filter over the input order alone.
 */
export function dedupeUsage(
  entries: readonly { id?: unknown; usage?: UsageRecord }[],
): UsageRecord {
  const byId = new Map<string, UsageRecord>()
  const anonymous: UsageRecord[] = []
  for (const e of entries) {
    if (!e.usage) continue
    if (typeof e.id === 'string' && e.id) byId.set(e.id, e.usage)
    else anonymous.push(e.usage)
  }
  const out: Required<UsageRecord> = {
    input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
  }
  for (const u of [...byId.values(), ...anonymous]) {
    out.input_tokens += u.input_tokens ?? 0
    out.output_tokens += u.output_tokens ?? 0
    out.cache_read_input_tokens += u.cache_read_input_tokens ?? 0
    out.cache_creation_input_tokens += u.cache_creation_input_tokens ?? 0
  }
  return out
}

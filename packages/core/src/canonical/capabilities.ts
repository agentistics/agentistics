/**
 * canonical/capabilities.ts — per-harness capability, expressed in the canonical vocabulary.
 *
 * `HARNESS_CAPABILITIES` (`../types`) stays the source every reader uses today, UNTOUCHED — it
 * drives "N/A vs a confident 0" across the whole product and nothing here changes that. This table
 * is DERIVED beside it: a projection of the same booleans into a richer state that can eventually
 * say WHY a capability is missing and how sure a `true` should be read, rather than a bare boolean.
 * Nothing reads `CAPABILITY_STATES` yet — this is a contract with no consumer, same status as
 * `entities.ts` — so there is no behaviour change anywhere in the product from adding this file.
 *
 * Spec refs: docs/superpowers/specs/2026-09-19-runtime-p1-canonical-journal.md §1.2 and §3, and the
 * master spec's §16 (the per-harness capability table, with its `source` provenance shape). Owner
 * decision D17 (docs/superpowers/specs/2026-09-25-owner-decisions.md): `Confidence` is the SAME
 * vocabulary for a capability's exactness as it is for an event's provenance — there is exactly one
 * scale for "how sure", and this module imports it from `./event` rather than inventing a second one.
 * D17's own worked example is `cost`: every harness prices through `calcCost()` × `MODEL_PRICING`
 * (a table lookup, not a provider-stated figure), so a legacy `cost: true` migrates to `estimated`,
 * never `exact` — `SUPPORTED_EXACTNESS` is where that single exception lives.
 *
 * A legacy `false` migrates to `unknown` unless a reason has been RECORDED for it in
 * `LEGACY_FALSE_NOTES`. It is never `not_supported` by default: `not_supported` and
 * `not_applicable` are claims about WHY a harness cannot produce a metric, and the boolean carries
 * none. Master §16 assumes a comment already exists beside every false; it does not — of today's 30,
 * several are explained only in `HARNESS_INFO`, CLAUDE.md or the master spec, and some nowhere. Composing a
 * reason from the flag's name would be an invented sentence attributed to nobody; `unknown` says
 * plainly that the reason has not been transcribed, and `NO_RECORDED_REASON` is that sentence,
 * verbatim, everywhere it applies. `source` EXTENDS master §16's shape (which has only `reason`):
 * it names where the sentence backing a state was copied from, so a reader can always trace a claim
 * back to the comment or doc that made it.
 *
 * `partial` is likewise never produced by `fromLegacyCapabilities` — a boolean has no way to express
 * "supported, but narrower than the metric's name suggests" (e.g. agy's `gitLines` counting only
 * additions), so that state is left for whoever eventually re-derives these entries from richer
 * evidence than one bit per cell.
 */

import type { Confidence } from './event'
import { HARNESS_CAPABILITIES, type HarnessCapabilities, type HarnessId } from '../types'

/** Every metric `HarnessCapabilities` declares — the keys `HARNESS_CAPABILITIES` is keyed on. */
export type CapabilityMetric = keyof HarnessCapabilities

/** `CapabilityMetric`, enumerated. Derived from `HARNESS_CAPABILITIES.claude` — claude declares
 *  every capability `HarnessCapabilities` has, so its own keys are the complete metric list. */
export const CAPABILITY_METRICS: readonly CapabilityMetric[] = Object.keys(
  HARNESS_CAPABILITIES.claude,
) as CapabilityMetric[]

export type CapabilityStateName = 'supported' | 'partial' | 'not_supported' | 'not_applicable' | 'unknown'

/**
 * One cell of the capability table, in the canonical vocabulary. `supported` and `partial` carry an
 * `exactness` (`Confidence` — the SAME scale `EventProvenance.confidence` uses, per D17); the other
 * three carry a `reason` instead, because there is nothing to be confident ABOUT when the harness
 * cannot produce the metric at all.
 */
export type CapabilityState =
  | { state: 'supported'; exactness: Confidence }
  | { state: 'partial'; exactness: Confidence; limit: string }
  | { state: 'not_supported'; reason: string; source: string }
  | { state: 'not_applicable'; reason: string; source: string }
  | { state: 'unknown'; reason: string; source: string | null }

/**
 * A recorded reason for one legacy `false`. `source` names where the sentence was copied from — a
 * doc comment in `types.ts`, a spec section, a dated measurement — so the claim can be traced back
 * to whoever made it rather than standing as an assertion this module invented.
 */
export interface LegacyFalseNote {
  state: 'not_supported' | 'not_applicable'
  reason: string
  source: string
}

export type LegacyFalseNotes = Partial<Record<HarnessId, Partial<Record<CapabilityMetric, LegacyFalseNote>>>>

/** Exactness a legacy `true` migrates to, per metric. Absent from this table means `'exact'`.
 *  `cost` is the one recorded exception (D17): every harness prices through `calcCost()` against
 *  `MODEL_PRICING`, a table lookup rather than a provider-stated figure, so it can never be `exact`. */
export const SUPPORTED_EXACTNESS: Partial<Record<CapabilityMetric, Confidence>> = {
  cost: 'estimated',
}

// Sources, named once so every note says where its sentence was copied from.
const TYPES = 'packages/core/src/types.ts'
const INFO = 'packages/web/src/lib/harness.ts HARNESS_INFO'
const MASTER = 'docs/superpowers/specs/2026-09-19-agentistics-runtime-master.md'

// Shared sentences, copied from the `HarnessCapabilities` field docstrings (trimmed, never extended).
const COMPACTION: LegacyFalseNote = {
  state: 'not_supported',
  reason: 'Claude Code writes a compact_boundary system line; no other harness has an equivalent marker, so the compaction figures are absent rather than zero.',
  source: `${TYPES} HarnessCapabilities.compaction docstring`,
}
const SKILLS: LegacyFalseNote = {
  state: 'not_applicable',
  reason: 'Claude Code writes a Skill tool_use naming the skill; no other harness has the concept at all, so skills are absent rather than an empty map.',
  source: `${TYPES} HarnessCapabilities.skills docstring`,
}

/**
 * The recorded reasons for today's legacy `false` cells. A reason is here only when a sentence
 * ALREADY EXISTED for it — a field docstring or entry comment in `types.ts`, a `HARNESS_INFO`
 * `missing` entry, the master spec — and `source` names which. A `false` with no such sentence has
 * NO entry and therefore reads as `unknown`; that is deliberate for seven cells today
 * (`dynamicWorkflows` on all five non-Claude harnesses — every source says only that it is
 * Claude-only, never that the others lack an orchestration tool; gemini `contextWindow` — its only
 * written reason says gemini carries no token data, which the table itself contradicts; antigravity
 * `skills` — the docstring's "no other harness has the concept" is contradicted by agy's own skill
 * directories in `sessions/skill-source.ts`). `capabilities.test.ts` pins the whole classification.
 *
 * `not_applicable` is used for one metric only, `skills`, because it is the only one whose source
 * says the CONCEPT is absent rather than that its record is. `compaction` is `not_supported`: the
 * source denies a MARKER, not that these harnesses compact.
 */
export const LEGACY_FALSE_NOTES: LegacyFalseNotes = {
  codex: {
    agents: { state: 'not_supported', reason: 'Codex does not record per-subagent breakdowns in its transcripts.', source: `${INFO}.codex.missing (Subagent metrics)` },
    gitLines: { state: 'not_supported', reason: 'Git line counts are not present in Codex transcripts.', source: `${INFO}.codex.missing (Git line counts)` },
    compaction: COMPACTION,
    skills: SKILLS,
    mcpServers: { state: 'not_supported', reason: 'Codex records no MCP tool at all, so the MCP server cannot be read back off tool_counts.', source: `${TYPES} HarnessCapabilities.mcpServers docstring` },
  },
  gemini: {
    agents: { state: 'not_supported', reason: 'Gemini CLI does not record per-subagent breakdowns.', source: `${INFO}.gemini.missing (Subagent metrics)` },
    gitLines: { state: 'not_supported', reason: "Gemini's tool calls name the file they touched but carry no diff counters.", source: `${TYPES} HARNESS_CAPABILITIES entry comment (gemini)` },
    compaction: COMPACTION,
    skills: SKILLS,
    mcpServers: { state: 'not_supported', reason: 'Gemini records no MCP tool at all, so the MCP server cannot be read back off tool_counts.', source: `${TYPES} HarnessCapabilities.mcpServers docstring` },
  },
  copilot: {
    agents: { state: 'not_supported', reason: 'Sub-agent metrics are not available in Copilot local event logs.', source: `${INFO}.copilot.missing (Sub-agent metrics)` },
    contextWindow: { state: 'not_supported', reason: "Copilot's only token report is a cumulative one written at shutdown, and a cumulative total is not a context size.", source: `${TYPES} HarnessCapabilities.contextWindow docstring` },
    compaction: COMPACTION,
    skills: SKILLS,
    mcpServers: { state: 'not_supported', reason: 'Copilot keeps MCP names in mcp_tool_names and never records the server.', source: `${TYPES} HarnessCapabilities.mcpServers docstring` },
  },
  antigravity: {
    agents: { state: 'not_supported', reason: 'An invoke_subagent child is a whole conversation of its own instead of an agent invocation recorded on the parent, so there is no per-invocation list to show.', source: `${INFO}.antigravity.missing (Sub-agent table)` },
    gitLines: { state: 'not_supported', reason: 'agy has no git integration, and its transcript only lets us count added lines; removals need the replaced blob (TargetContent), which agy does not write for its normal edit path.', source: `${TYPES} HARNESS_CAPABILITIES entry comment (antigravity)` },
    compaction: COMPACTION,
    mcpServers: { state: 'not_supported', reason: 'Antigravity writes MCP tools as mcp_ with one underscore and call_mcp_tool, so the MCP server cannot be read back off tool_counts.', source: `${TYPES} HarnessCapabilities.mcpServers docstring` },
  },
  kimi: {
    agents: { state: 'not_supported', reason: "Kimi's agent tree is merged into one set of session totals with no per-agent breakdown.", source: `${MASTER} §5` },
    gitLines: { state: 'not_supported', reason: 'Kimi records the Edit/Write strings but no diff counters.', source: `${TYPES} HARNESS_CAPABILITIES entry comment (kimi)` },
    compaction: COMPACTION,
    skills: SKILLS,
  },
}

/** The one sentence used for every legacy `false` with no entry in `LEGACY_FALSE_NOTES`. */
export const NO_RECORDED_REASON = 'no reason recorded — needs review'

/**
 * Projects today's `Record<HarnessId, HarnessCapabilities>` (a boolean per metric) into the
 * canonical `CapabilityState` vocabulary. Pure: neither argument is mutated, and every value
 * returned is a fresh object.
 *
 * - `true`  -> `{ state: 'supported', exactness: SUPPORTED_EXACTNESS[metric] ?? 'exact' }`. A note
 *   recorded against a `true` cell is ignored — `LegacyFalseNote` only ever explains a `false`.
 * - `false` with a matching note -> that note's `state`/`reason`/`source`, verbatim.
 * - `false` with no note -> `{ state: 'unknown', reason: NO_RECORDED_REASON, source: null }`.
 * - Never produces `'partial'` — a boolean cannot express a narrower-than-it-sounds capability.
 */
export function fromLegacyCapabilities(
  legacy: Record<HarnessId, HarnessCapabilities>,
  notes: LegacyFalseNotes = LEGACY_FALSE_NOTES,
): Record<HarnessId, Record<CapabilityMetric, CapabilityState>> {
  const result = {} as Record<HarnessId, Record<CapabilityMetric, CapabilityState>>

  for (const harnessId of Object.keys(legacy) as HarnessId[]) {
    const harnessCaps = legacy[harnessId]
    const harnessNotes = notes[harnessId]
    const states = {} as Record<CapabilityMetric, CapabilityState>

    for (const metric of Object.keys(harnessCaps) as CapabilityMetric[]) {
      const supported = harnessCaps[metric]

      if (supported) {
        states[metric] = { state: 'supported', exactness: SUPPORTED_EXACTNESS[metric] ?? 'exact' }
        continue
      }

      const note = harnessNotes?.[metric]
      if (note) {
        states[metric] = { state: note.state, reason: note.reason, source: note.source }
      } else {
        states[metric] = { state: 'unknown', reason: NO_RECORDED_REASON, source: null }
      }
    }

    result[harnessId] = states
  }

  return result
}

/** `true` for `supported` and `partial` — the two states that mean "this metric has a real value". */
export function capabilitySupported(s: CapabilityState): boolean {
  return s.state === 'supported' || s.state === 'partial'
}

/** The explanatory string on a cell: the `limit` on `partial`, the `reason` on the three absence
 *  states, and `null` on a plain `supported` cell, which has nothing to explain. */
export function capabilityReason(s: CapabilityState): string | null {
  switch (s.state) {
    case 'supported':
      return null
    case 'partial':
      return s.limit
    case 'not_supported':
    case 'not_applicable':
    case 'unknown':
      return s.reason
  }
}

/** `HARNESS_CAPABILITIES`, projected once at module load — the default table every future reader
 *  reads unless it has its own notes to apply. */
export const CAPABILITY_STATES: Record<HarnessId, Record<CapabilityMetric, CapabilityState>> =
  fromLegacyCapabilities(HARNESS_CAPABILITIES)

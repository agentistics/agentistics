/**
 * contextWindows.ts — PURE. How large a model's context window is, and where that number came from.
 *
 * This is the second half of the context gauge, and it is the half that can lie. The measurement
 * ("212.959 tokens were sent on the last turn") is read off the transcript and is a fact. The
 * PERCENTAGE is that fact divided by a window, and the same 212.959 is 106% of a 200k window and
 * 21% of a 1M one — the same session, the same measurement, two confident and incompatible answers.
 * So the window is never guessed: it is looked up here or the bar is not drawn at all.
 *
 * The rule is `MODEL_PRICING`'s, applied to a different number. `CatalogPrice` requires
 * `verifiedAt` + `source` so a price cannot exist without provenance; `ContextWindow` requires the
 * same, so a window cannot either. A model nobody has verified is ABSENT from this table, and an
 * absent model draws no bar — which is visible, where a wrong percentage is not.
 *
 * Two things deliberately NOT here:
 *
 *  - **Models without a citable input limit.** Codex REPORTS its own window per session
 *    (`model_context_window`), which outranks any table. Gemini 3.8 Flash now has a citable input
 *    limit (checked 2026-10-20); its parser retains the per-response prompt level. Copilot has no
 *    current-context measurement. Antigravity and Kimi may state their own windows; otherwise
 *    their models draw no bar until a verified figure is available here.
 *  - **A guess for the harness's own cap.** Claude Code can run `claude-opus-5` under a 200k
 *    session cap (its `opus[1m]` model picker), and the transcript records only `claude-opus-5` —
 *    no suffix, no window field, checked across a whole transcript. This table therefore reports
 *    the MODEL's documented maximum, which is what the id can actually be resolved to. A session
 *    deliberately running the smaller cap reads low; that is a stated limitation of the reading,
 *    not a number invented to cover the gap.
 */

/** One model's context window, with the provenance that makes it usable. */
export interface ContextWindow {
  /** Maximum input tokens the model accepts. */
  tokens: number
  /** ISO date the figure was checked against `source`. */
  verifiedAt: string
  /** Where the figure came from. A window with no source may not be added. */
  source: string
}

const ANTHROPIC_DOCS = 'platform.claude.com/docs/en/about-claude/models/overview'

/**
 * Verified context windows, keyed by model id.
 *
 * Keys are the BARE ids (no date suffix), because `resolveContextWindow` matches a longer id
 * against them by prefix — `claude-haiku-4-5-20251001` and Antigravity's `claude-opus-4-6-thinking`
 * both resolve that way without needing their own rows.
 */
export const CONTEXT_WINDOWS: Record<string, ContextWindow> = {
  'gemini-3.8-flash': { tokens: 1_048_576, verifiedAt: '2026-10-20', source: 'ai.google.dev/gemini-api/docs/models/gemini-3.8-flash' },
  'claude-fable-5':    { tokens: 1_000_000, verifiedAt: '2026-08-14', source: ANTHROPIC_DOCS },
  'claude-mythos-5':   { tokens: 1_000_000, verifiedAt: '2026-08-14', source: ANTHROPIC_DOCS },
  'claude-opus-5':     { tokens: 1_000_000, verifiedAt: '2026-08-14', source: ANTHROPIC_DOCS },
  'claude-opus-4-8':   { tokens: 1_000_000, verifiedAt: '2026-08-14', source: ANTHROPIC_DOCS },
  'claude-opus-4-7':   { tokens: 1_000_000, verifiedAt: '2026-08-14', source: ANTHROPIC_DOCS },
  'claude-opus-4-6':   { tokens: 1_000_000, verifiedAt: '2026-08-14', source: ANTHROPIC_DOCS },
  'claude-sonnet-5':   { tokens: 1_000_000, verifiedAt: '2026-08-14', source: ANTHROPIC_DOCS },
  'claude-sonnet-4-6': { tokens: 1_000_000, verifiedAt: '2026-08-14', source: ANTHROPIC_DOCS },
  'claude-haiku-4-5':  { tokens:   200_000, verifiedAt: '2026-08-14', source: ANTHROPIC_DOCS },
}

/**
 * The window for a model id — PURE, and `null` when nothing verified matches.
 *
 * Deliberately NOT `getModelPrice`'s matcher. That one tries `startsWith` in BOTH directions, which
 * is right for a price (an unknown id taking a near neighbour's rate is a small error, and there is
 * a documented fallback anyway) and wrong here: the reverse direction lets a short id claim a
 * longer key's window — `gpt-5` would match a hypothetical `gpt-5.4` row and inherit a number
 * belonging to a different model. Matching is therefore exact first, then LONGEST key that is a
 * prefix of the id, and never the other way round.
 */
export function resolveContextWindow(modelId: string | undefined): ContextWindow | null {
  const id = (modelId ?? '').trim()
  if (id === '') return null
  const exact = CONTEXT_WINDOWS[id]
  if (exact) return exact

  let best: { key: string; win: ContextWindow } | null = null
  for (const [key, win] of Object.entries(CONTEXT_WINDOWS)) {
    if (!id.startsWith(key)) continue
    if (!best || key.length > best.key.length) best = { key, win }
  }
  return best?.win ?? null
}

/** How full the window was, as a FRACTION — `null` when either half is unknown or unusable. */
export function contextFraction(
  used: number | undefined,
  window: number | undefined,
): number | null {
  if (used === undefined || window === undefined) return null
  if (!Number.isFinite(used) || !Number.isFinite(window)) return null
  // A non-positive window is not a window. Dividing by it yields Infinity or a negative percentage,
  // both of which render as a confident number — the exact failure this module exists to prevent.
  if (window <= 0 || used < 0) return null
  return used / window
}

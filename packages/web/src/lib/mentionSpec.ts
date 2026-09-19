/**
 * mentionSpec.ts — PURE. How to write a file reference into a message, per harness.
 *
 * Three gestures feed one function: dragging a tree row onto the composer, the tree's "Mencionar
 * na conversa", and "Mencionar seleção" in the editor. All three end up here, because the FORMAT a
 * harness reads reliably is a fact about that harness's own CLI, not about which gesture produced
 * the path — the same reason `rename-spec.ts` and `attention-rules.ts` are one table apiece rather
 * than one per caller.
 *
 * `Record<HarnessId, MentionSpec | null>`, not a `Partial`: a harness added to `HarnessId` must
 * fail the build until someone decides, exactly as `RENAME_SPECS` and `HARNESS_CAPABILITIES` do.
 * `null` is the decision, and it means the PLAIN form — a backtick-quoted path a person would type
 * by hand — never an `@` a harness might read as something else. Guessing an `@` for an unverified
 * harness is exactly the mistake this file exists to rule out: `claude`'s own `@` opens a file
 * autocomplete in the TUI, so an unverified harness's own `@`-adjacent syntax (if it has one) could
 * just as easily swallow the Enter or substitute a highlighted suggestion for what was typed.
 *
 * ## claude — verified against a live probe, not assumed
 *
 * Probed 2026-09-12 against `claude 2.1.270`, on a THROWAWAY session (`agentop session claude --bg
 * --cwd <tmp dir with a 6-line sample.ts>`), sending text through the real composer path
 * (`POST /api/fleet/act` → `fleet-web.ts`'s `prompt` case → `promptSession` → `sendTextTo`, the
 * exact route the web composer's Send button uses) and reading the pane back with
 * `tmux -L agentop capture-pane`:
 *
 *   sent: `@sample.ts what is on line 4? Reply with just that line, verbatim.`
 *   pane: `❯ @sample.ts what is on line 4? Reply with just that line, verbatim.` (submitted whole,
 *         nothing swallowed, nothing substituted) → `⎿  Read sample.ts (6 lines)` →
 *         `● export function four() { return 4 }` — exact line 4, verbatim.
 *
 *   sent: `@sample.ts#L3-5 quote exactly the lines you were pointed at, each on its own line,
 *         nothing else.`
 *   pane: submitted whole → `⎿  Read sample.ts (6 lines)` →
 *         `● export function three() { return 3 }` / `export function four() { return 4 }` /
 *         `export function five() { return 5 }` — exactly lines 3–5, nothing outside the range.
 *
 * So `@<path>` and `@<path>#L<a>-<b>` both submit cleanly and both resolve to the right file and
 * the right range — the `#L` form needs no fallback to `@<path> (linhas a–b)`.
 *
 * Every other harness is `null` until someone runs the same probe against it.
 */

import type { HarnessId } from '@agentistics/core'

export interface MentionSpec {
  /** The text for a whole-file reference. */
  file(path: string): string
  /** The text for a line-range reference within a file. `startLine`/`endLine` are 1-based, inclusive. */
  range(path: string, startLine: number, endLine: number): string
  /** Where and when this was verified — the CLI version, the probe method and the date. */
  verified: string
}

function plainFile(path: string): string {
  return `\`${path}\``
}

function plainRange(path: string, startLine: number, endLine: number): string {
  return `\`${path}:${startLine}-${endLine}\``
}

/** The universally-readable form used for every harness with no verified spec. Never an `@`. */
export const PLAIN_MENTION_SPEC: MentionSpec = {
  file: plainFile,
  range: plainRange,
  verified: 'unverified — plain backtick form, safe for any harness',
}

export const MENTION_SPECS: Record<HarnessId, MentionSpec | null> = {
  claude: {
    file: path => `@${path}`,
    range: (path, startLine, endLine) => `@${path}#L${startLine}-${endLine}`,
    verified: 'claude 2.1.270, probed 2026-09-12 via a throwaway session and the real prompt route',
  },
  codex: null,
  gemini: null,
  copilot: null,
  kimi: null,
  antigravity: null,
}

/** The spec for a harness, or the plain fallback — never `null` to a caller, so nothing has to re-check. */
export function mentionSpecFor(harness: HarnessId | undefined): MentionSpec {
  const found = harness ? MENTION_SPECS[harness] : undefined
  return found ?? PLAIN_MENTION_SPEC
}

export interface MentionTarget {
  /** Repo-relative path (relative to the session's cwd — the tree root). */
  path: string
  /** A 1-based, inclusive line range, when the mention is of a selection rather than a whole file. */
  lines?: { start: number; end: number }
}

/**
 * The text to insert for one reference. `harness` is the session's own — `undefined` (an external
 * row, or a harness id the fleet has not reported yet) gets the plain form, same as any harness
 * with no verified spec.
 */
export function mentionFor(harness: HarnessId | undefined, target: MentionTarget): string {
  const spec = mentionSpecFor(harness)
  return target.lines ? spec.range(target.path, target.lines.start, target.lines.end) : spec.file(target.path)
}

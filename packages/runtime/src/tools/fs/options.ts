/**
 * tools/fs/options.ts — the tuning knobs of `createFsTools` (`./index.ts`). None of these are on
 * the model-facing input schema (the catalogue's `{ pattern, root? }` / `{ pattern, root?, glob?,
 * caseInsensitive?, contextLines?, maxMatches? }`, §3) — they are the runtime's own bounds (result
 * count, file size, output bytes, wall time), overridable per host and per test so a test can, say,
 * shrink `grepMaxFileBytes` to a few bytes instead of writing a real multi-megabyte fixture.
 */

import { MINIMAL_TOOL_ENV, type ToolEnv } from '../env.ts'
export interface FsToolsOptions {
  /** `fs.glob`: how many matches to return when the call does not say (spec: 200). */
  globMaxResultsDefault?: number
  /** `fs.glob`: the most a call may ever ask for (spec: "hard cap e.g. 2000"). */
  globMaxResultsHardCap?: number
  /** `fs.grep`: how many matches to return when the call does not say (spec: 200). */
  grepMaxMatchesDefault?: number
  /** `fs.grep`: the most a call may ever ask for. */
  grepMaxMatchesHardCap?: number
  /** `fs.grep`: a matched (or displayed) line longer than this is truncated with a marker. */
  grepMaxLineLength?: number
  /** `fs.grep`: a file larger than this is skipped and counted, never read. */
  grepMaxFileBytes?: number
  /** `fs.grep`: the call stops adding matches to the reply once this many bytes have been spent
   *  on them (it keeps COUNTING matches past this point — see `grep.ts`'s "true totals" rule). */
  grepMaxTotalOutputBytes?: number
  /** `fs.grep`: the whole call's wall-clock budget — the catastrophic-regex-time guard (D-T2). */
  grepBudgetMs?: number
  /** `fs.grep`: bytes sniffed from the start of a file to decide whether it is binary. */
  binarySniffBytes?: number
  /** What the `git` that lists candidates sees. Default `MINIMAL_TOOL_ENV` (`../env.ts`). */
  env?: ToolEnv
}

export type ResolvedFsToolsOptions = Required<FsToolsOptions>

const DEFAULTS: ResolvedFsToolsOptions = {
  env: MINIMAL_TOOL_ENV,
  globMaxResultsDefault: 200,
  globMaxResultsHardCap: 2000,
  grepMaxMatchesDefault: 200,
  grepMaxMatchesHardCap: 2000,
  grepMaxLineLength: 500,
  grepMaxFileBytes: 2_000_000,
  grepMaxTotalOutputBytes: 200_000,
  grepBudgetMs: 4_000,
  binarySniffBytes: 8_000,
}

export function resolveFsToolsOptions(opts: FsToolsOptions = {}): ResolvedFsToolsOptions {
  return { ...DEFAULTS, ...opts }
}

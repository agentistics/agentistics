/**
 * harnessToolTimeout.ts — how long each harness waits for ONE MCP tool call before it gives up
 * (NAVEGADOR S3, spec §1.6 / §2 / §7a item 4).
 *
 * The browser padlock (`browser-lock.ts`) HOLDS a model's action while the person drives the browser,
 * and a held call that outlives the harness's own tool timeout is cut by the harness with an error the
 * model cannot act on. So the hold is `min(10 min, timeout − 5 s)`, and that needs the timeout.
 *
 * Every row is a MEASUREMENT with its date and how it was taken (sonda P4, `PROBES.md`), the rule
 * `MODEL_PRICING` and `contextWindows.ts` follow: a figure nobody measured is `null`, never a guess,
 * and `null` takes the prudent default (`TOOL_TIMEOUT_UNKNOWN_MS`). The rows still `null` are measured
 * by the engine's S7 (accounts paused or global config needed when P4 ran).
 *
 * `kind`:
 * - `limit` — the harness cut the call at about this many ms (the real ceiling, measured by a failure);
 * - `floor` — a call this long SUCCEEDED and no failure was found; the true limit is at least this.
 */
import type { HarnessId } from './types'

export interface HarnessToolTimeout {
  ms: number
  kind: 'limit' | 'floor'
  /** Does a `notifications/progress` from the server reset the timer? `null` = not measured. */
  progressResets: boolean | null
  verifiedAt: string
  source: string
}

/** What an unmeasured harness is assumed to allow (P4: the lowest real limit found was 60 s). */
export const TOOL_TIMEOUT_UNKNOWN_MS = 55_000

export const HARNESS_TOOL_TIMEOUT: Record<HarnessId, HarnessToolTimeout | null> = {
  claude: {
    ms: 130_000, kind: 'floor', progressResets: null, verifiedAt: '2026-11-14',
    source: 'P4: Claude Code 2.1.325 -p, MCP tool sleeping 130 s with progress every 20 s returned ok (138 s wall); no failure found',
  },
  opencode: {
    ms: 60_000, kind: 'limit', progressResets: true, verifiedAt: '2026-11-14',
    source: 'P4: OpenCode 1.19.5, 70 s without progress → MCP error -32001 Request timed out; 100 s with progress every 20 s → ok',
  },
  codex: null, // P4: account paused; `tool_timeout_sec` default (doc: 60 s) not measured — S7
  gemini: null, // P4: model answered 404 on every attempt — S7
  copilot: null, // P4: monthly quota exceeded — S7
  kimi: null, // P4: would need the real ~/.kimi-code/mcp.json — S7
  antigravity: null, // P4: `agy mcp add` writes the real global config — S7
  hermes: null, // P7: not installed here; MCP support documented only — S7
}

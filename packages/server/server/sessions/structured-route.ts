/**
 * structured-route.ts — PURE: where a spawn runs (ENGINE.MAP F2.0, owner decision 11 Q1 + 09/10).
 *
 * - `structured`: a WEB-born session, flag `adapter-chat` ON, and a READY driver for its harness —
 *   the official protocol is the session's primary source.
 * - `acp-legacy`: A5.4 exactly as before — the person opted the harness into ACP
 *   (`preferences.acpHarnesses`) and the engine drives it over `Engine.acp`. Untouched by the flag, so
 *   flag OFF is byte-for-byte today's behaviour.
 * - `tmux`: everything else. A terminal-born session is ALWAYS a TUI (unless A5.4's opt-in says
 *   otherwise, as it did before), and "open in terminal" on a structured one is a TUI resume of the same
 *   conversation id.
 *
 * A refusal from either structured route falls back to tmux with the same request (the composite's job).
 */
import type { CanonicalMode, HarnessId, StructuredAnswer, StructuredAttention, StructuredDriverId } from '@agentistics/engine-api'
import type { StructuredIntent } from './types'

/** Where a spawn came from. Absent = not the web (the cockpit, `agentop session`, a reopen from a TUI). */
export type SpawnOrigin = 'web' | 'terminal'

export type SpawnRoute = 'structured' | 'acp-legacy' | 'tmux'

export interface RouteInput {
  flagOn: boolean
  origin?: SpawnOrigin
  harness: HarnessId | null
  /** The READY structured driver for this harness (null: none, or only a stub). */
  driver: StructuredDriverId | null
  /** `Engine.acp` drives this harness (A5.4). */
  acpDriven: boolean
  /** `preferences.acpHarnesses`. */
  acpOptIn: readonly string[]
  /** MODE.EVERYWHERE — the canonical mode asked for (absent = the harness's default). */
  mode?: CanonicalMode
  /**
   * MODE.EVERYWHERE — the canonical modes the READY driver can start in (`declares(h).startModes`). A mode
   * outside it is not a structured session: the TUI carries it. Absent = a driver that states no modes,
   * which can start only in the harness's default.
   */
  startModes?: readonly CanonicalMode[]
}

/**
 * THE ONE-LINE SWITCH (owner decision, F2/F3 integration, 09/10): a harness listed here has a structured
 * driver that is BUILT and tested but is NOT routed to — its web sessions run as a TUI + the adapter, the
 * same as flag OFF. Delete the entry to turn the driver on. The value is the reason, cited.
 *
 * Empty since MODE.EVERYWHERE (owner decision 2026-10-09): antigravity — whose stream-json carries no
 * permission request — is no longer switched off whole; its driver declares `startModes: ['no-questions']`,
 * so it runs structured ONLY in "no questions" and every asking mode stays a TUI (`modeRoutable`).
 */
export const STRUCTURED_ROUTE_OFF: Readonly<Partial<Record<HarnessId, string>>> = {}

/** PURE. The READY driver a harness would be routed to, or null when its route is switched off here. */
export function routableDriver(harness: HarnessId, driver: StructuredDriverId | null): StructuredDriverId | null {
  return STRUCTURED_ROUTE_OFF[harness] ? null : driver
}

/** PURE (MODE.EVERYWHERE). Whether a driver that declares `startModes` can start in `mode`. */
export function modeRoutable(mode: CanonicalMode | undefined, startModes: readonly CanonicalMode[] | undefined): boolean {
  const want = mode ?? 'default'
  return startModes ? startModes.includes(want) : want === 'default'
}

export function routeSpawn(i: RouteInput): SpawnRoute {
  if (!i.harness) return 'tmux'
  if (i.flagOn && i.origin === 'web' && i.driver && modeRoutable(i.mode, i.startModes)) return 'structured'
  if (i.acpDriven && i.acpOptIn.includes(i.harness)) return 'acp-legacy'
  return 'tmux'
}

/**
 * PURE. Whether a REOPEN is a web-born spawn: only when the browser asked AND the row it replaces ran
 * structured. A terminal-born row reopened from the web stays a TUI (owner, 11 Q1): the web never
 * turns a TUI session into a structured one behind the person's back.
 */
export function structuredReopenOrigin(origin: SpawnOrigin | undefined, previousDriver: string | undefined): boolean {
  return origin === 'web' && !!previousDriver
}

/**
 * PURE. The spawn, in a structured driver's terms. The prompt is the person's ALONE (the TUI plan may
 * prepend the context to it for a first-message harness; a driver chooses its own channel from its
 * declaration), and the opening context travels as `instructions` on a fresh session only. The
 * agentistics MCP rides along so a structured session gets it from the protocol, not a config file.
 */
export function structuredIntentOf(
  req: { harness: HarnessId; origin?: SpawnOrigin; resumeId?: string; prompt?: string; mode?: CanonicalMode },
  o: {
    model?: string | undefined
    effort?: string | undefined
    conversationId?: string
    ctx?: { text: string; block: string }
    mcp?: { command: string; args: readonly string[]; env?: Readonly<Record<string, string>> }
  },
): StructuredIntent {
  return {
    harness: req.harness,
    ...(req.origin ? { origin: req.origin } : {}),
    ...(o.model ? { model: o.model } : {}),
    ...(o.effort ? { effort: o.effort } : {}),
    ...(o.conversationId && !req.resumeId ? { conversationId: o.conversationId } : {}),
    ...(req.resumeId ? { resumeId: req.resumeId } : {}),
    ...(req.mode && req.mode !== 'default' ? { mode: req.mode } : {}),
    ...(req.prompt ? { prompt: req.prompt } : {}),
    ...(o.ctx && !req.resumeId ? { instructions: { text: o.ctx.text, block: o.ctx.block } } : {}),
    ...(o.mcp ? { mcp: [{ name: 'agentistics', command: o.mcp.command, args: [...o.mcp.args], ...(o.mcp.env ? { env: o.mcp.env } : {}) }] } : {}),
  }
}

/**
 * PURE. The person's pick, as the answer a driver takes — the screen path's refusals, kept: nothing
 * open → `not-asking`; options and no choice → `needs-choice`; a free-text option with no words →
 * `needs-text`; a number past the end → `gone` (the request changed since it was shown). Text rides
 * only with a free-text option, or alone where the request takes free text.
 */
export function answerStructured(
  open: StructuredAttention | null,
  choice: number | undefined,
  text: string | undefined,
): { ok: true; answer: StructuredAnswer; said: string } | { ok: false; why: 'not-asking' | 'needs-choice' | 'needs-text' | 'gone' } {
  if (!open) return { ok: false, why: 'not-asking' }
  const words = text ?? ''
  if (choice === undefined) {
    if (open.freeText && words.trim()) return { ok: true, answer: { requestId: open.requestId, text: words }, said: words }
    return { ok: false, why: open.options.length > 0 ? 'needs-choice' : 'needs-text' }
  }
  const picked = open.options[choice - 1]
  if (!Number.isInteger(choice) || !picked) return { ok: false, why: 'gone' }
  if (picked.freeText) {
    if (!words.trim()) return { ok: false, why: 'needs-text' }
    return { ok: true, answer: { requestId: open.requestId, choice, text: words }, said: words }
  }
  return { ok: true, answer: { requestId: open.requestId, choice }, said: picked.label }
}

/**
 * PURE (MODE.EVERYWHERE). Why a spawn whose mode only a protocol can set was not started: the harness's
 * terminal has no flag for it and its structured route was not available (the adapter flag off, a session
 * not started from the web, or the driver refused).
 */
export function modeNeedsProtocolSentence(harness: HarnessId | null, mode: CanonicalMode): string {
  return `${harness ?? 'this harness'} can start in "${mode}" only over its protocol (its terminal has no flag for it), and this session could not start that way — choose another mode, or start it from the web with the adapter on.`
}

/**
 * structured-route.ts — PURE: where a spawn runs (ENGINE.MAP F2.0, owner decision 11 Q1 + 09/10).
 *
 * - `structured`: a session NOBODY HOLDS IN A TERMINAL — web-born, or started in the background
 *   (`agentop session --bg`, a leader's worker, a hand-off, a background reopen) — with flag
 *   `adapter-chat` ON and a READY driver for its harness: the official protocol is its primary source.
 * - `acp-legacy`: A5.4 exactly as before — the person opted the harness into ACP
 *   (`preferences.acpHarnesses`) and the engine drives it over `Engine.acp`. Untouched by the flag, so
 *   flag OFF is byte-for-byte today's behaviour.
 * - `tmux`: everything else. A session a person starts ATTACHED in a terminal is ALWAYS a TUI (unless
 *   A5.4's opt-in says otherwise, as it did before), and "open in terminal" on a structured one is a TUI
 *   resume of the same conversation id.
 *
 * Owner decision 2026-10-23 (superseding 11 Q1's "terminal-born is always a TUI" for the background
 * case): with the adapter live, a leader-spawned session, a reopen and a session on another account
 * must not fall back to the old tmux mode. They used to, because only `origin: 'web'` was routable and
 * `agentop session --bg`, the hand-off and the reopen never carried it.
 *
 * A refusal from either structured route falls back to tmux with the same request (the composite's job).
 */
import type { CanonicalMode, HarnessId, StructuredAnswer, StructuredAttention, StructuredDriverId } from '@agentistics/engine-api'
import type { StructuredIntent } from './types'

/**
 * Where a spawn came from. `background`: no person holds it in a terminal (`--bg`, a hand-off, a
 * background reopen). Absent or `terminal`: a person attached to it (the cockpit, `agentop session`).
 */
export type SpawnOrigin = 'web' | 'terminal' | 'background'

/** PURE. Whether an origin may run structured: nobody is sitting in front of its terminal. */
export function structuredOrigin(origin: SpawnOrigin | undefined): boolean {
  return origin === 'web' || origin === 'background'
}

/**
 * PURE. The origin a spawn routes as. An explicit one is kept; a spawn with none that nobody ATTACHES to
 * (`attach: false` — `--bg`, a leader's worker, a hand-off) is `background`; an attached one stays a TUI.
 */
export function spawnOriginOf(origin: SpawnOrigin | undefined, attach: boolean): SpawnOrigin | undefined {
  if (origin) return origin
  return attach ? undefined : 'background'
}

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
  if (i.flagOn && structuredOrigin(i.origin) && i.driver && modeRoutable(i.mode, i.startModes)) return 'structured'
  if (i.acpDriven && i.acpOptIn.includes(i.harness)) return 'acp-legacy'
  return 'tmux'
}

/**
 * PURE. The origin a REOPEN routes as. A reopen starts a NEW process for a conversation whose old one is
 * gone, so there is no TUI to turn into anything: the browser's reopen is `web`, and one nobody attaches
 * to is `background` (`spawnOriginOf`). Only a reopen a person ATTACHES to in a terminal is a TUI.
 * (Before 2026-10-23 a web reopen ran structured only when the row it replaced had — owner 11 Q1 — so a
 * conversation once started in tmux was reopened in tmux forever.)
 */
export function reopenOrigin(origin: SpawnOrigin | undefined, attach: boolean): SpawnOrigin | undefined {
  return spawnOriginOf(origin === 'terminal' ? undefined : origin, attach)
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

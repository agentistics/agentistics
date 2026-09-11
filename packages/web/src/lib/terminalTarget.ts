/**
 * terminalTarget.ts — PURE. WHICH terminal a surface is showing, and everything that follows from
 * the answer.
 *
 * There are two panes behind one session and they are not interchangeable: the CLI's own screen
 * (an assistant running under tmux, resolved against `managed-sessions.json`) and the utility SHELL
 * the person opened themselves (its own tmux socket, resolved against `shells.json`). Handing one
 * channel the other's id is precisely the mistake `terminalEndpoint.ts` splits the scopes to make
 * impossible — so the target decides the SCOPE and the ID together, here, rather than at each of
 * the three surfaces that draw a terminal.
 *
 * **Why this module exists at all.** The header used to carry a `Conversa | Terminal` toggle and the
 * dedicated screen a second `Assistente | Shell` one: two controls for one decision, in two places,
 * with different words. The toggle is gone — the conversation is what a session opens on, and the
 * BAND at the foot of the panel is the door to both terminals — so there is now exactly one
 * question ("which terminal") asked in exactly one vocabulary.
 *
 * **The CLI pane is named after its HARNESS.** "Assistente" named a concept the reader has to
 * translate; `Claude Code` names the thing that is on the screen. Reported as "invés de assistant
 * coloca algo que dê a entender mais fácil". Where the harness cannot be named the label falls back
 * to words rather than to a blank segment — the same rule every N/A in this product follows.
 */

import { HARNESS_LABELS } from './harness'
import type { TerminalScope } from './terminalEndpoint'

/** `cli` first: it is the session's own screen, and the shell is the thing you add beside it. */
export const TERMINAL_TARGETS = ['cli', 'shell'] as const
export type TerminalTarget = (typeof TERMINAL_TARGETS)[number]

/** ABSENT READS AS `shell`: the band has been the shell's since phase 2, and a stored preference
 *  that cannot be read must not silently move somebody to the other pane. */
export function readTarget(raw: unknown): TerminalTarget {
  return raw === 'cli' ? 'cli' : 'shell'
}

/** Which of the two channels this target speaks. Never inferred from an id — an id is opaque. */
export function targetScope(target: TerminalTarget): TerminalScope {
  return target === 'cli' ? 'fleet' : 'shell'
}

/**
 * The id to stream, or `null` when there is nothing to stream yet.
 *
 * A CLI pane always has one — it IS the session. A shell has one only once it has been opened, and
 * `null` is what makes the band ask for it rather than streaming a blank.
 */
export function targetStreamId(
  target: TerminalTarget,
  ids: { sessionId: string; shellId: string | null },
): string | null {
  return target === 'cli' ? ids.sessionId : ids.shellId
}

/**
 * `harness` is a plain STRING on purpose: it arrives from `ControlSession.harness`, which is what a
 * row reports, and a harness this build has no label for must fall back to words rather than fail
 * to type-check into a blank segment.
 */
export function targetLabel(
  target: TerminalTarget,
  harness: string | undefined,
  lang: 'pt' | 'en',
): string {
  if (target === 'shell') return 'Shell'
  const named = harness ? (HARNESS_LABELS as Record<string, string | undefined>)[harness] : undefined
  return named ?? (lang === 'pt' ? 'Sessão CLI' : 'CLI session')
}

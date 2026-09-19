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

/**
 * A `'shell'` READING IS UNUSABLE ONCE THE SHELL SWITCH IS OFF — `shellEnabled` (`CAPS.localShell`
 * AND the user's own switch, see `ShellBand`'s own prop of the same name). Read `'cli'` instead —
 * the session's own harness terminal, which is never gated by it and is always there.
 *
 * `readTarget`'s own default is `'shell'`, so a fresh session with no stored preference at all
 * would otherwise resolve to a pane that cannot open the moment the switch is off — the exact bug
 * `ShellBand`'s `shellEnabled` prop exists to close. Applied on the way IN only (a fresh mount, a
 * `bottomOccupant` naming `'shell'`); `ShellBand` handles the band ALREADY showing `'shell'` when
 * the switch narrows underneath it with its own effect, deliberately not through this function —
 * see that component's own doc comment on why the narrowing must never overwrite the STORED
 * preference (`chooseTarget` is never called for it).
 */
export function usableTarget(want: TerminalTarget, shellEnabled: boolean): TerminalTarget {
  return want === 'shell' && !shellEnabled ? 'cli' : want
}

/**
 * Is the CURRENT target `'shell'` while the shell is unusable — the exact condition the
 * disabled-shell empty state (`ShellBand`'s own header) renders on.
 *
 * This is `usableTarget`'s own clamp condition, kept as a NAMED predicate rather than inlined,
 * because `ShellBand` no longer calls `usableTarget` to silently fall back to `'cli'` the moment
 * the switch is off — see that component's header for why a silent fallback there is the bug this
 * pass replaces. The docked band keeps `target === 'shell'` even while disabled (so the person's
 * own choice survives a switch flip and a re-enable needs no re-pick), and this is what tells the
 * render which of the two panes — the real shell, or the sentence explaining why not — belongs in
 * that box right now.
 */
export function shellTargetUnavailable(target: TerminalTarget, shellEnabled: boolean): boolean {
  return target === 'shell' && !shellEnabled
}

/**
 * WHAT THE DOCKED BAND OPENS ON, at a fresh mount — the one place `usableTarget`'s old silent
 * clamp is replaced rather than simply dropped.
 *
 * `bottomOccupant` (an explicit slot placement) and a LITERALLY stored `'shell'` preference are
 * both genuine records that a person put the shell there; `readTarget`'s own absent-reads-as-shell
 * DEFAULT (see that function's header) is not — it is what a brand-new session gets when nobody
 * has ever chosen anything. Treating that default as "the shell was desired" would draw the
 * disabled-shell empty state on EVERY fresh session on a machine with the switch off, not only on
 * the ones design item 2 describes ("the person had the shell open, then turned it off") — so the
 * default is clamped to `'cli'` exactly as `usableTarget` always clamped it, and only a genuine
 * record survives being unusable, to be rendered as the empty state instead of silently swapped.
 */
export function resolveDockedTarget(
  bottomOccupant: TerminalTarget | null, storedTarget: unknown, shellEnabled: boolean,
): TerminalTarget {
  const wanted = bottomOccupant ?? readTarget(storedTarget)
  const chosen = bottomOccupant === 'shell' || storedTarget === 'shell'
  return wanted === 'shell' && !shellEnabled && !chosen ? 'cli' : wanted
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

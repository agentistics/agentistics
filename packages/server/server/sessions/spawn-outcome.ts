/**
 * spawn-outcome.ts — PURE. Did the thing we just started actually START?
 *
 * ## The bug this exists for, reported and reproduced
 *
 * A conversation was showing as `closed` while it was in fact running as a background agent. Every
 * press of Reopen spawned `claude --resume <id>`, and Claude Code REFUSED — the conversation was
 * already open elsewhere:
 *
 * ```
 * Session 581deab7-… is currently running as a background agent (bg).
 * Use `claude agents` to find and attach to it, or add --fork-session to branch off a copy.
 * Pane is dead (status 1, Sat Aug 15 01:31:03 2026)
 * ```
 *
 * The spawn "succeeded" — tmux created the session, the call returned — so a row was written. The
 * program inside had already exited. Pressing Reopen again made another one. The user finished with
 * **three rows called MAIN**, all dead, and the real conversation still not opened.
 *
 * **`spawn` returning without throwing is not evidence that anything is running.** tmux's contract
 * is "I made you a session", not "your program is alive"; with `remain-on-exit on` — which agentop
 * sets deliberately, so a crash can be read instead of vanishing — a dead pane looks exactly like a
 * live one to `list()`. The screen is the only thing that knows.
 *
 * ## What is read, and what is deliberately not
 *
 * `Pane is dead` is tmux's own words for "your program exited", and it carries the status. That is
 * the DECISION. Everything above it is the program's last words, and they are what the user needs —
 * "it did not start" is not actionable, "it refused because the conversation is already open" is.
 *
 * The message is never interpreted, only carried. A harness may refuse for reasons nobody here has
 * seen, and inventing a category for each would be a table that goes stale in silence; passing the
 * words through is correct for every refusal, including the ones that do not exist yet.
 */

/** What a freshly spawned session's screen says about itself. */
export interface SpawnOutcome {
  /** True when tmux reports the program exited. */
  died: boolean
  /** The exit status tmux named, when it named one. */
  status?: number
  /** The program's own last words, trimmed — what the user is shown. Empty when it said nothing. */
  message: string
}

/**
 * tmux's dead-pane notice, e.g. `Pane is dead (status 1, Sat Aug 15 01:31:03 2026)`.
 *
 * The status is optional in the pattern because the notice is tmux's and its shape is not ours to
 * depend on: a build that words it differently must still be read as DEAD, with the status simply
 * absent. Losing the number is a smaller error than concluding the program is running.
 */
const DEAD_PANE = /Pane is dead(?:\s*\(status\s+(\d+))?/i

/**
 * Read a just-spawned session's frame — PURE.
 *
 * `frame` is the captured pane, newest last.
 */
export function spawnOutcome(frame: readonly string[]): SpawnOutcome {
  let deadAt = -1
  let status: number | undefined
  for (let i = frame.length - 1; i >= 0; i--) {
    const m = DEAD_PANE.exec(frame[i] ?? '')
    if (!m) continue
    deadAt = i
    if (m[1] !== undefined) status = Number(m[1])
    break
  }
  if (deadAt < 0) return { died: false, message: '' }

  // The program's words are the last lines with CONTENT above the notice, however far up they are —
  // not the lines immediately before it. Measured: tmux leaves the notice on the pane's last row and
  // the message on its first, with 33 blank rows between, so a fixed window of the preceding lines
  // collected nothing at all and the user was told only "exited (status 1)".
  //
  // Bounded, because a crash can print a whole stack trace and this ends up on one line of a CLI.
  const said: string[] = []
  for (let i = deadAt - 1; i >= 0 && said.length < MESSAGE_LINES; i--) {
    const line = (frame[i] ?? '').trim()
    if (line) said.push(line)
  }
  return { died: true, ...(status !== undefined ? { status } : {}), message: said.reverse().join(' ').trim() }
}

/** How many lines above the notice count as the program's message. */
export const MESSAGE_LINES = 6

/**
 * How long to keep asking before believing a session started — milliseconds.
 *
 * **Measured, because the obvious guess was wrong.** The first version of this waited 700ms on the
 * reasoning that a refusal is immediate — parse the arguments, print, exit. It is not. Timed against
 * the real refusal on this machine:
 *
 * ```
 *  300ms  pane empty
 *  700ms  pane empty          ← a 700ms check reports "started" and writes the row
 * 1500ms  two lines, alive
 * 3000ms  dead
 * ```
 *
 * The harness loads, resolves the conversation, and only then refuses. A guessed timeout would have
 * missed the exact case this exists for while looking like it worked.
 *
 * Paired with `POLL_MS`: the wait ENDS the moment the pane dies, so a refusal costs about as long as
 * it takes, and only a healthy session pays the full deadline — which is why `batch` runs its checks
 * in one parallel pass rather than serially.
 */
export const SETTLE_MS = 5_000

/** How often to re-read the pane while waiting. */
export const POLL_MS = 250

/**
 * Whether a death at spawn reads as "the binary could not be EXECUTED" — PURE.
 *
 * With a multi-word argv tmux calls `execvp` itself, and a failed exec `_exit(1)`s WITHOUT printing
 * anything, so a harness missing from the PATH leaves exactly `Pane is dead (status 1)` and no
 * words. A single-word argv goes through the shell instead, which answers `bash: codex: command
 * not found` and 127. Both were rendered as "the session exited immediately (status 1)" — true, and
 * useless, since the one thing that fixes it is the PATH nobody was shown.
 *
 * Status 1 with WORDS is the harness refusing (the conversation is open elsewhere, a bad flag), and
 * is never reinterpreted: those words are the actionable part.
 */
export function execFailed(outcome: SpawnOutcome, bin: string): boolean {
  if (!outcome.died) return false
  if (outcome.message === '') return outcome.status === 1 || outcome.status === 127
  const escaped = bin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\b${escaped}: (?:command not found|not found|No such file or directory)`).test(outcome.message)
}

/**
 * The shorter window `spawnManaged` waits — milliseconds.
 *
 * What it exists to catch is an exec that FAILED, which kills the pane before tmux has returned;
 * four polls see it. The harness's own slower refusal (`SETTLE_MS`) stays the CLI's check: on the
 * browser's path every healthy session pays the whole window, and `reopenEntries` pays it per row.
 */
export const LAUNCH_SETTLE_MS = 1_000

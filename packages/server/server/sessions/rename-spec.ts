/**
 * rename-spec.ts — PURE. How to rename a session INSIDE its harness, and when that may be tried.
 *
 * A session can be named in two places. `pickTitle` (`harness-session-file.ts`) already settles a
 * disagreement between them; this module is the other half of the same story — making the two
 * AGREE, by carrying a rename typed in agentop through to the harness itself.
 *
 * The reverse direction has always worked: a `/rename` inside the session is written to the
 * harness's own record and read back by `harness-sessions.ts`. Only the agentop-to-harness
 * direction was missing, so a row renamed here kept whatever the harness went on calling itself,
 * and the harness's name won the moment it was the more recent of the two.
 *
 * ## Why this is a typed line and not an API call
 *
 * Three routes were tried against claude 2.1.233 on 2026-08-15 and two were REJECTED by measurement,
 * not by preference:
 *
 *   - **The messaging socket** (`messagingSocketPath` in `~/.claude/sessions/<pid>.json`, the one
 *     `events/peer-client.ts` already authenticates to). The binary does carry a control request
 *     `{subtype: 'rename_session', title}`, and it is in the accepted-subtype set — but that set
 *     belongs to the SDK's stdio transport. Sent over the peer socket with a valid token and a
 *     distinct title, the session's own record did not change: no response, no rename. That is the
 *     route this module would prefer, and it is not open.
 *   - **A CLI subcommand.** `claude --help` lists no session-rename command in 2.1.233.
 *   - **Writing the harness's own record.** Rejected on principle as well as on odds: it is another
 *     tool's private, undocumented state file, held open and rewritten by a live process on every
 *     status change, so our bytes would be overwritten within seconds while the running session went
 *     on showing the old name — a rename that reports success and did nothing.
 *
 * What is left is the interface the harness actually publishes to its user: the slash command. Read
 * from claude 2.1.233's own command table, not from memory of what it prints:
 *
 *   `name: "rename", aliases: ["name"], description: "Rename the current conversation",
 *    immediate: true, argumentHint: "[name]"`
 *
 * `immediate` is the load-bearing word — the command runs on submit rather than becoming a turn, so
 * this costs the session nothing and does not appear as work it was asked to do.
 *
 * ## Consequences of that route, stated rather than hidden
 *
 * Typing is only possible into a session agentop HOSTS. An `external` row — a harness someone
 * started beside agentop — has no pane to type into, so its harness half is skipped and SAID to be
 * skipped. Same for a row that is not running: `lost` and `exited` rows keep their agentop label and
 * nothing else, because there is no process left to tell.
 *
 * `Record<HarnessId, … | null>` and not a `Partial`: a harness added to `HarnessId` must fail the
 * build until someone decides, the same rule `SPAWN_SPECS`, `ATTENTION_RULES`, `APPROVAL_SPECS` and
 * `HARNESS_CAPABILITIES` follow. `null` is that decision, and the five nulls here are findings —
 * each was looked for on 2026-08-15 and the result recorded on its row.
 */

import type { HarnessId } from '@agentistics/core'

export interface RenameSpec {
  /**
   * The line to type into a live session to rename it, given the title the user chose.
   *
   * A LINE, not a key: the backend's `sendText` types it and submits it, which is exactly what a
   * person does. Nothing here presses anything else.
   */
  line(title: string): string
  /** Where this was read from — the CLI version and the date, as `attention-rules.ts` records its patterns. */
  verified: string
}

/**
 * How to rename inside each harness. `null` means nobody has found a way, and the row then keeps
 * the agentop label alone and says so.
 *
 * Every entry below was probed on 2026-08-15 against the installed CLI:
 *
 *   claude       `/rename [name]` — in the command table, `immediate`, aliased `name`.  ✔
 *   copilot      `renameSession(name)` exists, but as an in-process SDK method on the session
 *                object. There is no channel from outside to call it, and no slash command was
 *                found in the bundle. Its file (`workspace.yaml`) is written by the live process,
 *                so the file route is the one rejected above.
 *   kimi         `state.json` carries `title` + `isCustomTitle`, and `renameSession()` exists —
 *                again as its own UI's internal call over that file. No external channel.
 *   codex        No rename anywhere in the CLI, and a rollout file records no user-facing name at
 *                all: there is nothing in codex for a rename to change.
 *   gemini       Nothing matching `rename` in the bundle.
 *   antigravity  Nothing matching `rename` in the binary.
 *
 * Four of those five are "the harness has no such thing"; copilot and kimi are "it has one and does
 * not expose it". The distinction is why each carries its own sentence rather than a shared `null`
 * with no explanation — the day one of them opens a channel, the row says what to look for.
 */
export const RENAME_SPECS: Record<HarnessId, RenameSpec | null> = {
  claude: { line: title => `/rename ${title}`, verified: 'claude 2.1.233, probed 2026-08-15' },
  codex: null,
  gemini: null,
  copilot: null,
  kimi: null,
  antigravity: null,
  // No spawn-spec support (CLAUDE.md step 4, skipped by scope): unprobed.
  opencode: null,
}

/** The spec for a harness, or `null` when there is none — including for an unknown harness id. */
export function renameSpecFor(harness: HarnessId | undefined): RenameSpec | null {
  return harness ? RENAME_SPECS[harness] ?? null : null
}

/** Whether renaming inside the harness is possible AT ALL for this harness. Drives what the UI offers. */
export function harnessRenameSupported(harness: HarnessId | undefined): boolean {
  return renameSpecFor(harness) !== null
}

/**
 * Why the harness half of a rename did not happen.
 *
 * Each is a DIFFERENT sentence to the user, which is the whole reason this is an enum and not a
 * boolean: "this harness cannot be renamed from outside" and "your session is sitting on a
 * permission prompt" send someone to two different places, and collapsing them into "could not
 * rename" sends them to neither.
 */
export type RenameSkipReason =
  /** The harness publishes no way to rename from outside. Permanent, and about the TOOL. */
  | 'unsupported'
  /** agentop did not start this session, so there is no pane to type into. */
  | 'external'
  /** Nothing is running — a `lost`, `exited` or `finished` row. */
  | 'not-running'
  /** A dialog is open. Typing now would answer it. See below. */
  | 'dialog'
  /** The title cannot be typed as one line, so it cannot be sent as one command. */
  | 'untypable'

export type RenamePlan =
  | { kind: 'send'; line: string }
  | { kind: 'skip'; reason: RenameSkipReason }

export interface RenamePlanInput {
  harness: HarnessId | undefined
  /** The title the user typed, already trimmed by the caller. */
  title: string
  /** Whether agentop hosts this session — i.e. whether there is a pane at all. */
  managed: boolean
  /** Whether the backend reports it alive RIGHT NOW, not whether a poll once did. */
  running: boolean
  /**
   * Whether the screen, re-read at this instant, is showing a blocking dialog.
   *
   * The caller decides this with `rulesFor(harness).approval` over a fresh capture, exactly as
   * `promptSession` does. It is passed in rather than derived here so this module stays pure and the
   * two paths cannot drift into two different readings of "is a dialog open".
   */
  dialogOpen: boolean
}

/**
 * What to do about the harness half of a rename.
 *
 * The order of the checks is the order of the sentences worth saying. `unsupported` comes first
 * because it is a fact about the harness that holds whatever the session is doing — telling someone
 * their codex session is "not running" would send them to restart it in the hope of a rename that
 * can never work.
 *
 * The dialog check is last and is the one that must never be dropped. A `/rename` typed into an open
 * permission prompt does not rename anything: the text goes into the dialog's own filter and the
 * submit takes whichever option is highlighted. That is the accident this codebase has already had
 * once, from the other direction, and it is why `promptSession` refuses on a dialog too.
 */
export function planHarnessRename(input: RenamePlanInput): RenamePlan {
  const spec = renameSpecFor(input.harness)
  if (!spec) return { kind: 'skip', reason: 'unsupported' }
  if (!input.managed) return { kind: 'skip', reason: 'external' }
  if (!input.running) return { kind: 'skip', reason: 'not-running' }
  if (!typableTitle(input.title)) return { kind: 'skip', reason: 'untypable' }
  if (input.dialogOpen) return { kind: 'skip', reason: 'dialog' }
  return { kind: 'send', line: spec.line(input.title) }
}

/**
 * Whether a title can be typed as ONE command line.
 *
 * A newline would submit the command early and leave the remainder sitting in the composer as a
 * prompt nobody wrote — the harness would be renamed to half the title and then asked a question. A
 * carriage return does the same. Empty is refused because `/rename` with no argument is a different
 * command (it opens the harness's own prompt), and an empty agentop label is refused upstream anyway.
 *
 * Everything else is allowed through, including a leading `/`: the harness gets what the user typed,
 * and inventing a sanitiser that silently changes somebody's chosen name is worse than the rename
 * landing verbatim.
 */
export function typableTitle(title: string): boolean {
  return title.trim().length > 0 && !/[\r\n]/.test(title)
}

/**
 * backend-tmux.ts — the Unix SessionBackend. Thin on purpose: every decision it could get wrong
 * lives in the pure `tmux-cli.ts` beside it.
 */

import { ensureSessionIdentityKey } from './session-identity'
import { FOCUS_ATTEMPTS, inputFocusOf } from './input-focus'
import { highlightedRow, parseRewindMenu, REWIND_MAX_STEPS, rewindRowMatches } from './claude-rewind'
import type { RewindOutcome } from './types'
import {
  attachArgs, capturePaneArgs, capturePaneAnsiArgs, idFromTmuxName, isSessionGoneError,
  killSessionArgs, listSessionsArgs, paneInfoArgs, parsePaneInfo, parsePrefix, parseTmuxList,
  tmuxListIsEmptyState,
  resolveDefaultTerminal, resolveTruecolorTerm, spawnArgs, sendKeysNamedArgs, sendKeysLiteralArgs, sendKeysNamedSequenceArgs,
  clearHistoryArgs, pasteBufferName, setBufferArgs, pasteBufferArgs,
  showPrefixArgs, trimCapture, listPanePidsArgs, parsePanePids,
  type TerminalProfile,
} from './tmux-cli'
import { dependencyCommandLine } from './dependency-plan'
import { probeDependency } from './dependency-probe'
import { sessionEnv } from './login-env'
import { planPromptDelivery } from './initial-prompt'
import { frameChanged, needsSecondReturn } from './submit-check'
import { planCodexSend } from './codex-send'
import { writeToPane } from './pane-writer'
import {
  SEND_NOW_FIRM_MS, SEND_NOW_GENTLE_MS, SEND_NOW_POLL_MS, hasQueuedMessages, sanitizePasteText,
  type SendNowOutcome,
} from '@agentistics/core'
import type {
  BackendInitialPrompt, BackendSession, BackendSpawn, SessionBackend, TerminalCapture,
} from './types'

/** How often to re-read the pane while waiting for the harness to be ready to receive the prompt. */
const DELIVER_POLL_MS = 400
/**
 * How long to keep trying to deliver the initial prompt before giving up.
 *
 * Robust to a SLOW start (a big CLAUDE.md, MCP servers loading) — the old fixed 1200ms lost the
 * keys to a pane that had not drawn its prompt yet. Bounded so a session stuck on an unrecognised
 * dialog cannot block a batch forever. Overridable for tests.
 */
const DELIVER_DEADLINE_MS = Number(process.env.AGENTISTICS_DELIVER_DEADLINE_MS) > 0
  ? Number(process.env.AGENTISTICS_DELIVER_DEADLINE_MS)
  : 15_000
/** How much of the pane to read to judge readiness — enough for the input box and its footer. */
const DELIVER_CAPTURE_LINES = 40

/** Locale for every command this backend starts. tmux formats are parsed as text and must not vary
 * with the service manager's locale (systemd commonly starts us without LANG/LC_ALL). */
export function utf8LocaleEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  return {
    ...Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)) as Record<string, string>,
    LANG: env.LANG || 'C.UTF-8',
    LC_ALL: env.LC_ALL || 'C.UTF-8',
  }
}

/**
 * The gap between typing a prompt and submitting it, and how long the submit is given to show.
 *
 * The gap exists because the two `send-keys` calls were back to back, microseconds apart, and a
 * terminal UI reading a burst that size has every reason to treat the `\r` at the end of it as part
 * of the same burst rather than as a person pressing return.
 *
 * The wait is what makes the CHECK possible at all: a pane captured the instant after `Enter` has
 * not repainted yet, so it always looks unchanged and every send would retry.
 */
const SUBMIT_SETTLE_MS = 120
/** How long to keep looking for the submit to show, and how often to look. */
const SUBMIT_SHOW_MS = 600
const SUBMIT_POLL_MS = 60

/** True when this host has the named terminfo entry (`infocmp` exits 0). Never throws. */
async function terminfoHas(name: string): Promise<boolean> {
  try {
    const p = Bun.spawn(['infocmp', name], { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore', env: utf8LocaleEnv() })
    return (await p.exited) === 0
  } catch {
    // No infocmp on PATH — treat every entry as absent, so agentop leaves tmux's own default rather
    // than naming a terminfo entry it could not confirm exists.
    return false
  }
}

let profileCache: TerminalProfile | null = null

/**
 * Resolve the colour profile once per process: the terminfo entries do not change under us, and the
 * invoking terminal's env (`TERM` / `COLORTERM`) is fixed for this run. The pure resolvers in
 * `tmux-cli.ts` decide; this only does the IO they cannot.
 */
async function terminalProfile(): Promise<TerminalProfile> {
  if (profileCache) return profileCache
  const [tmux256color, screen256color] = await Promise.all([
    terminfoHas('tmux-256color'),
    terminfoHas('screen-256color'),
  ])
  profileCache = {
    defaultTerminal: resolveDefaultTerminal({ tmux256color, screen256color }),
    truecolorTerm: resolveTruecolorTerm({ TERM: process.env.TERM, COLORTERM: process.env.COLORTERM }),
  }
  return profileCache
}

async function tmux(args: string[]): Promise<{ code: number; out: string; err: string }> {
  try {
    const p = Bun.spawn(['tmux', ...args], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', env: utf8LocaleEnv() })
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
    return { code: await p.exited, out, err }
  } catch {
    // tmux is not on PATH. 127 is what a shell reports for that, and `unavailable()` is what
    // callers are meant to consult — no throw, so a missing tmux never crashes a caller.
    return { code: 127, out: '', err: '' }
  }
}

/**
 * PURE. The argv that starts the tmux SERVER in a cgroup of its own, or `null` to start it plainly.
 *
 * A tmux client starts the server as its own child when none is running, so the server — and every
 * session it hosts — landed in the cgroup of whoever ran that first command: the `agentop-server`
 * unit, when the server runs as a service. The fleet then shared the unit's fate: a stop, or an OOM
 * kill of one heavy session process under `OOMPolicy=stop`, took every session at once (2026-10-02,
 * the whole fleet gone at ~11:00 with the server still up). A transient `--scope` of its own makes
 * the fleet independent of the service. Only on Linux with a reachable user manager; anything else
 * starts it the old way.
 */
export function coldStartArgv(args: string[], env: { platform: string; runtimeDir?: string; hasUserBus: boolean }, now = Date.now()): string[] | null {
  if (env.platform !== 'linux' || !env.runtimeDir || !env.hasUserBus) return null
  return ['systemd-run', '--user', '--scope', '--quiet', '--collect', `--unit=agentop-tmux-${now}`, '--', 'tmux', ...args]
}

/** Is a tmux server already up on the fleet socket? A server that is up keeps its own cgroup. */
async function tmuxServerUp(): Promise<boolean> {
  const { code, out, err } = await tmux(listSessionsArgs())
  // The same rule `list()` uses: only "no such socket" / "no server running" is a server that is
  // down. A socket this process cannot connect to is a server that is UP and unreachable, and
  // cold-starting a second one over it is the wrong answer.
  return !tmuxListIsEmptyState(code, out, err) || code === 0
}

/** Runs `tmux <args>`, starting the server in its own scope when this call is what starts it. */
async function tmuxStartingServer(args: string[]): Promise<{ code: number; out: string; err: string }> {
  if (!(await tmuxServerUp())) {
    const runtimeDir = process.env.XDG_RUNTIME_DIR
    const hasUserBus = !!runtimeDir && (await Bun.file(`${runtimeDir.replace(/\/$/, '')}/bus`).exists().catch(() => false))
    const argv = coldStartArgv(args, { platform: process.platform, runtimeDir, hasUserBus })
    if (argv) {
      try {
        const p = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', env: utf8LocaleEnv() })
        const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
        const code = await p.exited
        // systemd-run itself could not run the scope (no manager, no permission): tmux never ran,
        // so fall back to the plain start below. A tmux error is tmux's answer and stands.
        const scopeFailed = code !== 0 && /failed to (connect|start transient|create)|systemd-run/i.test(err)
        if (!scopeFailed) return { code, out, err }
      } catch { /* systemd-run missing — plain start below */ }
    }
  }
  return tmux(args)
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/**
 * What `sendPaste` sends, and the text it sanitizes to — PURE, so the argv shape, the sanitizer,
 * and the buffer deletion can all be proven (`backend-tmux.test.ts`) without spawning tmux or going
 * through the pane's write lock. `sendPaste` below is the thin IO wrapper around this.
 */
export function pasteWriteArgs(id: string, text: string): { setArgs: string[]; pasteArgs: string[]; text: string } {
  const name = pasteBufferName(id)
  const safe = sanitizePasteText(text)
  return { setArgs: setBufferArgs(name, safe), pasteArgs: pasteBufferArgs(id, name), text: safe }
}

/**
 * Type text and submit it, as two separate `send-keys` calls — UNDER THE PANE'S WRITE LOCK.
 *
 * The lock is what stops two overlapping sends interleaving inside one input box: everything below
 * happens between two `send-keys` calls, and a second prompt arriving in that window used to land
 * in the first one's unsubmitted line, so the Enter submitted BOTH AS ONE MESSAGE with every image
 * of both at its front. See `pane-writer.ts`.
 *
 *
 * `-l` (literal) for the text so a prompt containing `;` or `C-c` is typed rather than interpreted,
 * then the named `Enter` — which is why they cannot be one call.
 *
 * The submit is only sent once the text was accepted. Half a prompt followed by an unconditional
 * Enter is a blank turn sent to an assistant, which is the exact accident this feature exists to
 * avoid.
 *
 * A free function rather than a method on the object below, because `spawn` calls it: reaching it
 * through `this` would break the moment a caller spread or destructured the backend, and `index.ts`
 * spreads it.
 */
async function sendTextTo(id: string, text: string, harness?: string): Promise<boolean> {
  return writeToPane(id, () => harness === 'codex' ? pasteAndSubmitCodex(id, text) : typeAndSubmit(id, text))
}

/**
 * Bring the keyboard focus back to the input box before typing — see `input-focus.ts`.
 *
 * With background agents running, one ↓ in claude's terminal moves the focus into the agents list;
 * a prompt typed then is lost and its Enter opens an agent's detail view, while this function used
 * to report it delivered. Esc was measured to return the focus without interrupting a running
 * turn. Nothing is sent when the focus is already on the input — an Esc there is not harmless.
 * `false` when the focus could not be brought back, so the caller says "not delivered" instead of
 * typing into a screen that will swallow it.
 */
async function focusInput(id: string): Promise<boolean> {
  for (let attempt = 0; attempt < FOCUS_ATTEMPTS; attempt++) {
    if (inputFocusOf(await captureFrame(id)) === 'input') return true
    if ((await tmux(sendKeysNamedArgs(id, 'Escape'))).code !== 0) return false
    await sleep(SUBMIT_SETTLE_MS)
  }
  return inputFocusOf(await captureFrame(id)) === 'input'
}

/**
 * Empty the input box — one `C-u` per line, since claude's `C-u` deletes the CURRENT line only
 * (measured: a two-line input needed two). It stops as soon as a press changes nothing, which also
 * ends it on claude's grey prompt SUGGESTION: that is drawn in the box, reads exactly like typed text
 * on a capture, and no key deletes it — nor does it need deleting, since typing replaces it.
 */
async function clearInput(id: string): Promise<void> {
  let before = await captureFrame(id)
  for (let i = 0; i < 12; i++) {
    if ((await tmux(sendKeysNamedArgs(id, 'C-u'))).code !== 0) return
    await sleep(SUBMIT_POLL_MS)
    const after = await captureFrame(id)
    if (!frameChanged(before, after)) return
    before = after
  }
}

/** See `SessionBackend.rewindTo` and `claude-rewind.ts`. Runs under the pane's write lock. */
async function rewindDriver(id: string, text: string, occurrence: number): Promise<RewindOutcome> {
  if (!(await focusInput(id))) return 'failed'
  await clearInput(id)
  // ONE burst — two Esc sent 300 ms apart did not open the menu in the measurement.
  if ((await tmux(sendKeysNamedSequenceArgs(id, ['Escape', 'Escape']))).code !== 0) return 'failed'
  await sleep(SUBMIT_SETTLE_MS * 2)
  let menu = parseRewindMenu(await captureFrame(id))
  if (!menu) return 'no-menu'
  let seen = 0
  for (let step = 0; step < REWIND_MAX_STEPS; step++) {
    if ((await tmux(sendKeysNamedArgs(id, 'Up'))).code !== 0) break
    await sleep(SUBMIT_POLL_MS)
    const next = parseRewindMenu(await captureFrame(id))
    if (!next) { await tmux(sendKeysNamedArgs(id, 'Escape')); return 'unexpected' }
    const row = highlightedRow(next)
    // The top of the list: the cursor did not move and nothing is hidden above it.
    const stuck = row !== null && highlightedRow(menu) === row && next.cursor === menu.cursor && !next.moreAbove
    menu = next
    if (row !== null && rewindRowMatches(row, text)) {
      if (seen === occurrence) {
        if ((await tmux(sendKeysNamedArgs(id, 'Enter'))).code !== 0) return 'failed'
        await sleep(SUBMIT_SETTLE_MS * 3)
        // Still a menu of some kind after the choice: a screen nobody measured. Cancel, never guess.
        const after = await captureFrame(id)
        if (parseRewindMenu(after) || /Enter to continue · Esc to cancel/.test(after.join('\n'))) {
          await tmux(sendKeysNamedArgs(id, 'Escape'))
          await sleep(SUBMIT_POLL_MS)
          await tmux(sendKeysNamedArgs(id, 'Escape'))
          return 'unexpected'
        }
        // The restored prompt is put back in the box; the next message must not be typed after it.
        await clearInput(id)
        return 'done'
      }
      seen++
    }
    if (stuck) break
  }
  await tmux(sendKeysNamedArgs(id, 'Escape'))
  return 'not-found'
}

/**
 * SEND NOW, and CHECK that it went — see `@agentistics/core`'s `sendNow.ts` for the measurement.
 *
 * It used to press `C-x C-s` and answer "sent". Claude's send-now is a REQUEST to a scheduler that
 * waits whenever the turn has no safe point, so the answer was true of the keystroke and false of
 * the message. Now: the keyboard is given to the input box first (a key pressed into the agents list
 * lands nowhere), claude's own send-now is tried and the SCREEN is watched for the queue to drain,
 * and only if it does not drain in `SEND_NOW_GENTLE_MS` is the turn interrupted with Esc — which,
 * with a queue pending, claude answers by submitting the queue as the next turn.
 */
async function sendNowDriver(id: string): Promise<SendNowOutcome> {
  if (!(await focusInput(id))) return 'no-focus'
  if (!hasQueuedMessages(await captureFrame(id))) return 'nothing'
  if ((await tmux(sendKeysNamedArgs(id, 'C-x'))).code !== 0) return 'failed'
  await sleep(SUBMIT_POLL_MS)
  if ((await tmux(sendKeysNamedArgs(id, 'C-s'))).code !== 0) return 'failed'
  if (await queueDrains(id, SEND_NOW_GENTLE_MS)) return 'sent'
  // The gentle step's scheduler may be holding the keyboard's focus somewhere else by now; Esc from
  // the agents list only returns the focus, so it is brought back before the Esc that interrupts.
  if (!(await focusInput(id))) return 'no-focus'
  if (!hasQueuedMessages(await captureFrame(id))) return 'sent'
  if ((await tmux(sendKeysNamedArgs(id, 'Escape'))).code !== 0) return 'failed'
  return (await queueDrains(id, SEND_NOW_FIRM_MS)) ? 'interrupted' : 'stuck'
}

/** Has the queue left the screen within the budget? Returns as soon as it has. */
async function queueDrains(id: string, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  for (;;) {
    await sleep(SEND_NOW_POLL_MS)
    if (!hasQueuedMessages(await captureFrame(id))) return true
    if (Date.now() >= deadline) return false
  }
}

async function typeAndSubmit(id: string, text: string): Promise<boolean> {
  if (!(await focusInput(id))) return false
  const typed = await tmux(sendKeysLiteralArgs(id, text))
  if (typed.code !== 0) return false

  // Let the burst end before the return key, then look at what the typing produced — that frame is
  // the thing the submit has to change. See `submit-check.ts` for why the check is the SCREEN and
  // not the prompt's own words.
  await sleep(SUBMIT_SETTLE_MS)
  const typedFrame = await captureFrame(id)

  // DOES THIS PANE REPAINT ON ITS OWN? Two captures with nothing sent between them, which is the
  // only way to find out. A session mid-turn advances its spinner glyph, its elapsed timers and its
  // token counter, so the post-return comparison below answered `true` however the submit went —
  // on exactly the sessions the retry exists for. See `needsSecondReturn` for the measurement.
  await sleep(SUBMIT_POLL_MS)
  const settleFrame = await captureFrame(id)
  const animating = frameChanged(typedFrame, settleFrame)

  if ((await tmux(sendKeysNamedArgs(id, 'Enter'))).code !== 0) return false

  // The comparison is only SPENT where it can answer, and it is made against the LAST pre-return
  // capture — against `typedFrame` the animation between the two would count as movement all over
  // again. On an animating pane it is skipped outright: it would return true on the first poll and
  // cost a poll to learn nothing, so a busy send now gets faster rather than slower.
  //
  // POLLED, not slept. A fixed wait spends its whole budget on every message — measured at ~820ms
  // per send, which a person feels on every keystroke of a conversation ("DEMORA MUITO pra enviar
  // as mensagens"). The pane usually moves within one or two frames, so the common case costs one
  // poll and the budget is only spent when the submit genuinely did not show.
  const moved = animating ? false : await paneMoved(id, settleFrame)

  if (needsSecondReturn(animating, moved)) {
    // Settled first, for the reason the gap above exists at all: two returns microseconds apart are
    // one burst to a terminal UI reading them, and the second would be swallowed with the first.
    await sleep(SUBMIT_SETTLE_MS)
    // NOT proof the submit was swallowed — a screen that redraws identically looks the same either
    // way — so this buys one more return rather than a verdict. An extra return on an emptied input
    // does nothing; a missing one strands the message until somebody opens the terminal.
    await tmux(sendKeysNamedArgs(id, 'Enter'))
  }
  // THE ENTER MAY HAVE OPENED A SCREEN INSTEAD OF SENDING. The movement check above cannot tell —
  // opening a detail view moves the frame too — so the focus is read once more: a detail view open
  // now is this Enter's doing. It is closed again and the send is reported as NOT delivered, which
  // is the truth; "delivered" over a message that reached nobody is the defect being fixed.
  if (inputFocusOf(await captureFrame(id)) === 'overlay') {
    await tmux(sendKeysNamedArgs(id, 'Escape'))
    return false
  }
  return true
}

/** Codex needs the paste chip to be visible before its submit return is sent. */
async function pasteAndSubmitCodex(id: string, text: string): Promise<boolean> {
  if (!(await focusInput(id))) return false
  if (planCodexSend('before-paste', await captureFrame(id), text) === 'blocked') return false
  const pasted = await pasteBufferArgsFor(id, text)
  if (pasted.code !== 0) return false

  const pastedDeadline = Date.now() + SUBMIT_SHOW_MS
  for (;;) {
    const frame = await captureFrame(id)
    const action = planCodexSend('after-paste', frame, text)
    if (action === 'blocked') return false
    if (action !== 'wait') break
    if (Date.now() >= pastedDeadline) return false
    await sleep(SUBMIT_POLL_MS)
  }

  await sleep(SUBMIT_SETTLE_MS)
  if ((await tmux(sendKeysNamedArgs(id, 'Enter'))).code !== 0) return false
  await sleep(SUBMIT_SETTLE_MS)
  const first = planCodexSend('after-enter', await captureFrame(id), text)
  if (first === 'blocked') return false
  if (first === 'retry-enter') {
    await sleep(SUBMIT_SETTLE_MS)
    if ((await tmux(sendKeysNamedArgs(id, 'Enter'))).code !== 0) return false
    await sleep(SUBMIT_SETTLE_MS)
    return planCodexSend('after-retry', await captureFrame(id), text) === 'delivered'
  }
  return first === 'delivered'
}

async function pasteBufferArgsFor(id: string, text: string): Promise<{ code: number }> {
  const { setArgs, pasteArgs } = pasteWriteArgs(id, text)
  if ((await tmux(setArgs)).code !== 0) return { code: 1 }
  return tmux(pasteArgs)
}

/** Did the pane change within the budget? Returns as soon as it did. */
async function paneMoved(id: string, before: readonly string[]): Promise<boolean> {
  const deadline = Date.now() + SUBMIT_SHOW_MS
  for (;;) {
    await sleep(SUBMIT_POLL_MS)
    if (frameChanged(before, await captureFrame(id))) return true
    if (Date.now() >= deadline) return false
  }
}

async function captureFrame(id: string): Promise<string[]> {
  const { code, out } = await tmux(capturePaneArgs(id, DELIVER_CAPTURE_LINES))
  if (code !== 0) return []
  return trimCapture(out.split('\n'))
}

/**
 * Deliver the initial prompt once the harness is genuinely ready to receive it — see
 * `initial-prompt.ts` for the WHY. This is the impure half: it polls the pane, hands each frame to
 * the pure `planPromptDelivery`, and does exactly what it says. It NEVER submits into a startup or
 * approval dialog (the pure planner never returns an action for one), so the "press Enter too early
 * and select No, exit" accident cannot happen.
 */
async function deliverInitialPrompt(id: string, d: BackendInitialPrompt): Promise<void> {
  const deadline = Date.now() + DELIVER_DEADLINE_MS
  let readyStreak = 0
  while (Date.now() < deadline) {
    const frame = await captureFrame(id)
    const step = planPromptDelivery({ frame, mode: d.mode, readyStreak, ...(d.rules ? { rules: d.rules } : {}) })
    readyStreak = step.readyStreak
    if (step.action === 'done') return // a positional prompt that already auto-submitted
    if (step.action === 'type') { await sendTextTo(id, d.text ?? ''); return }
    if (step.action === 'submit') { await tmux(sendKeysNamedArgs(id, 'Enter')); return }
    await sleep(DELIVER_POLL_MS)
  }
  // Timed out. For a `type` harness, fall back to the old best-effort so a slow-but-eventually-up
  // harness still gets its prompt (never worse than before). For `submit`, do nothing: the text is
  // in the field, the CLI may still auto-submit, and a blind Enter now could land on a dialog we
  // never confirmed had cleared.
  if (d.mode === 'type') await sendTextTo(id, d.text ?? '')
}

let tmuxPresent: boolean | null = null
/** The install sentence, computed once — same cost as the presence check it already memoized. */
let tmuxMissingReason: string | null = null

/**
 * Why tmux is missing, and what would fix it — NAMING the manager and showing the exact command,
 * never a generic "install it" that leaves the reader to go find one themselves.
 *
 * `dependency-plan.ts` decides what to say; this only turns its three honest refusals into the one
 * sentence every caller of `unavailable()` already knows how to show (a plain string, dimmed under
 * the CLI's usage text, or a banner in the cockpit's Sessions tab).
 */
async function explainMissingTmux(): Promise<string> {
  const plan = await probeDependency('tmux')
  switch (plan.reason) {
    case 'windows':
      return 'tmux is not installed, and there is no Windows session backend — use WSL to manage background sessions.'
    case 'no-manager':
      return 'tmux is not installed, and no recognised package manager was found — install it yourself to manage background sessions.'
    default: {
      const line = dependencyCommandLine(plan)
      return line
        ? `tmux is not installed — install it with ${plan.manager}: ${line}`
        : 'tmux is not installed — install it to manage background sessions'
    }
  }
}

export const tmuxBackend: SessionBackend = {
  id: 'tmux',

  async unavailable() {
    if (tmuxPresent === null) {
      const { code } = await tmux(['-V'])
      tmuxPresent = code === 0
      if (!tmuxPresent) tmuxMissingReason = await explainMissingTmux()
    }
    return tmuxPresent ? undefined : tmuxMissingReason ?? 'tmux is not installed — install it to manage background sessions'
  },

  async spawn(req: BackendSpawn) {
    // Options and `new-session` go in ONE chained invocation. They must be set BEFORE the session
    // exists — `remain-on-exit` afterwards is a race the fast-failing case always wins,
    // `history-limit` afterwards does not apply to this pane at all, and `default-terminal` (the
    // colour fix) keeps tmux's 8-colour `screen` default for the life of a pane created before it.
    // Applied as SEPARATE pre-flight calls they were lost on a cold socket, because `set-option`
    // does not start a server — see `spawnArgs`.
    const profile = await terminalProfile()
    // Re-resolved from the login shell (60 s memo) so a tool installed a minute ago is found with
    // no restart. See `login-env.ts`.
    // VAULT.PERSONAL §8.3: the session's OWN id, so a Claude Code hook inside it can name the grant it
    // acts under. Not a secret (the id is on every fleet row); a value never travels this way — tmux
    // `-e` is visible in `ps`.
    const env: Record<string, string> = { ...utf8LocaleEnv(await sessionEnv()), AGENTOP_MANAGED_ID: req.id, ...(req.env ?? {}) }
    // The same id is what an Agentask comment proves it came from (`session-identity.ts`): the MCP
    // derives the proof from a 0600 key file, so no token is ever put on a command line. The key is
    // created here, before the first session that could need it exists.
    await ensureSessionIdentityKey()
    // The first session of a cold socket also starts the tmux SERVER — in a scope of its own, so the
    // fleet does not live and die with this service's cgroup. See `coldStartArgv`.
    const { code, out } = await tmuxStartingServer(
      spawnArgs(profile, { id: req.id, cwd: req.cwd, argv: req.argv, path: env.PATH ?? process.env.PATH, env }),
    )
    if (code !== 0) throw new Error(out.trim() || `tmux new-session failed (code ${code})`)
    if (req.initialPrompt) {
      // Deliver the prompt only once the harness is READY — polled, not a fixed sleep — so a slow
      // start does not lose it and a startup dialog is never submitted into. See `deliverInitialPrompt`.
      //
      // NOT AWAITED. The session EXISTS the moment tmux has it, which is what `spawn` promises and
      // what the caller acts on; the prompt is a follow-up to a session that is already there.
      // Awaiting it held every caller for as long as the harness took to draw its input box — up to
      // `DELIVER_DEADLINE_MS`, which is fifteen seconds — so "create session" in the browser spun
      // for the whole of claude's startup with a session that had been running since millisecond
      // seven. Reported as creating a session taking VERY long. Nothing downstream needs the
      // delivery to have happened: the pane is watched live, a `batch` starts its sessions in
      // parallel instead of one startup after another, and delivery was already best-effort with
      // its own fallback and deadline.
      //
      // The promise is returned so a caller that genuinely must wait can, and is caught here so a
      // caller that does not never sees an unhandled rejection.
      const delivery = deliverInitialPrompt(req.id, req.initialPrompt)
        .catch(e => { console.error(`[session] ${req.id} initial prompt not delivered:`, e) })
      return { delivery }
    }
    return {}
  },

  sendText: sendTextTo,
  sendTextReliable: (id: string, text: string, harness: string) => sendTextTo(id, text, harness),

  /**
   * Pick a numbered option, then WRITE INTO THE FIELD it opens, then submit.
   *
   * The three keystrokes a person would make by hand, with the wait between them that a person
   * takes without noticing — and that wait is the whole reason this is one backend call rather than
   * three from the caller.
   *
   * MEASURED. Driven by hand with a pause, the digit moved the cursor onto `Type something.`, the
   * literal text turned the row into `3. capivara`, and Enter submitted it. Sent as one burst from
   * the caller, the very same three steps produced the answer **`3jabuticaba`**: the dialog was
   * still switching from list mode to field mode when the text arrived, so the digit landed in the
   * field with it. The failure is invisible at the API — it answered `ok` — and only shows up in
   * what the session recorded.
   *
   * So the text waits for the pane to MOVE, which is the same signal `sendTextTo` already uses to
   * know a submit showed. A frame that never moves still gets the text: the budget is spent, not
   * the answer, exactly as it is there.
   */
  /**
   * Type the digit, LOOK at what it did, and only then type the words.
   *
   * The lock is the whole reason this lives in the backend rather than as three calls from the
   * caller: `writeToPane` serialises writes per pane, and three separate locked calls leave two
   * gaps a keystroke from another surface can land in — which is the collision `pane-writer.ts`
   * exists to prevent, and which its own note names this method as the harder version of.
   *
   * The CHECK is the caller's, passed in as `opened`, because deciding whether a field appeared
   * needs the harness's approval rules and its dialog parser — neither of which belongs down here.
   * It runs INSIDE the lock, on a frame captured after the digit, so nothing can have written
   * between the look and the words.
   *
   * WHY IT IS CHECKED AT ALL. `paneMoved` says the pane changed, not that a FIELD opened, and the
   * digit does not open one on every dialog — on some it only moves the highlight. Typing then puts
   * the words wherever the session is listening and the return submits whatever is under the
   * cursor. So a frame that does not look like a field yields `no-field` and NOTHING further is
   * sent.
   */
  async sendChoiceText(
    id: string, key: string, text: string, opened: (frame: string[]) => boolean,
  ): Promise<'sent' | 'no-field' | 'failed'> {
    return writeToPane(id, async () => {
      const before = await captureFrame(id)
      if ((await tmux(sendKeysNamedArgs(id, key))).code !== 0) return 'failed'
      // The option turning into a field IS a frame change; waiting for it is waiting for the mode
      // to switch. Bounded, because a pane that will not move must not hold the request open.
      await paneMoved(id, before)
      await sleep(SUBMIT_SETTLE_MS)
      if (!opened(await captureFrame(id))) return 'no-field'
      if ((await tmux(sendKeysLiteralArgs(id, text))).code !== 0) return 'failed'
      await sleep(SUBMIT_SETTLE_MS)
      return (await tmux(sendKeysNamedArgs(id, 'Enter'))).code === 0 ? 'sent' : 'failed'
    })
  },

  /**
   * Move the cursor, LOOK, then confirm — the numberless dialog's answer.
   *
   * The look is the point. Everything else here is an assumption: that the widget wraps or does not,
   * that one press moves one row, that the list has not been redrawn since the poll. `landed` tests
   * the only thing that settles it — where the cursor IS, in the frame as it stands a moment before
   * the confirm — so a miscount costs a refusal instead of the wrong answer to a question about
   * somebody's folder. Nothing is sent after a failed look.
   */
  async sendMoveChoice(
    id: string, keys: readonly string[], confirmKey: string, landed: (frame: string[]) => boolean,
  ): Promise<'sent' | 'wrong-row' | 'failed'> {
    return writeToPane(id, async () => {
      for (const key of keys) {
        const before = await captureFrame(id)
        if ((await tmux(sendKeysNamedArgs(id, key))).code !== 0) return 'failed'
        // A moved highlight IS a frame change; waiting for it is waiting for the widget to redraw.
        // Bounded, exactly like `sendChoiceText`: a pane that will not move must not hold the
        // request open, and the look below is what decides the outcome either way.
        await paneMoved(id, before)
      }
      await sleep(SUBMIT_SETTLE_MS)
      if (!landed(await captureFrame(id))) return 'wrong-row'
      return (await tmux(sendKeysNamedArgs(id, confirmKey))).code === 0 ? 'sent' : 'failed'
    })
  },

  async sendTextRaw(id: string, text: string) {
    // Literal only, NO Enter — the first half of `sendTextTo`. This is what the browser's key-by-key
    // channel needs: a character appears without submitting a turn. Locked like every other write:
    // a keystroke arriving mid-prompt is the same collision as a second prompt.
    return writeToPane(id, async () => {
      const ok = (await tmux(sendKeysLiteralArgs(id, text))).code === 0
      if (ok && (text.trim() === 'clear' || text.includes('clear\r') || text.includes('clear\n') || text.includes('\x0c'))) {
        await tmux(clearHistoryArgs(id))
      }
      return ok
    })
  },

  async rewindTo(id: string, text: string, occurrence: number) {
    return writeToPane(id, () => rewindDriver(id, text, occurrence))
  },

  async sendQueuedNow(id: string): Promise<SendNowOutcome> {
    return writeToPane(id, () => sendNowDriver(id))
  },

  async sendKey(id: string, key: string) {
    return writeToPane(id, async () => {
      const ok = (await tmux(sendKeysNamedArgs(id, key))).code === 0
      if (ok && (key === 'C-l' || key === 'Ctrl+L')) {
        await tmux(clearHistoryArgs(id))
      }
      return ok
    })
  },

  // LOCKED like every other write: a keystroke landing mid-paste is the same collision
  // `pane-writer.ts` exists to prevent. `set-buffer` first, THEN `paste-buffer -d` — a failed
  // set never pastes stale content from a previous buffer of the same name.
  //
  // `sanitizePasteText` runs AGAIN here, even though `input-protocol.ts` (`parseInputMessage`)
  // already sanitized everything that reaches this call through the WS write channel. This is the
  // actual PRIMITIVE that writes into a tmux buffer and pastes it into a live pane — the second
  // boundary the C1 fix applies to, same reasoning as `redact.ts`'s two boundaries: the check that
  // matters is the one at the place doing the dangerous thing, not only the one a caller is
  // expected to have already made. A future caller of this backend that forgot to route through
  // `input-protocol.ts` gets the same guarantee for free.
  async sendPaste(id: string, text: string) {
    return writeToPane(id, async () => {
      const { setArgs, pasteArgs } = pasteWriteArgs(id, text)
      if ((await tmux(setArgs)).code !== 0) return false
      return (await tmux(pasteArgs)).code === 0
    })
  },

  async list(): Promise<BackendSession[]> {
    // "no server running on …" is the ordinary empty state, not an error: exit code 1 with no
    // sessions is what tmux reports before anything has been started. EVERY OTHER non-zero exit is
    // a failure and THROWS — see `tmuxListIsEmptyState`. Swallowing them made a tmux that could not
    // be reached report every session as gone, which is the one answer a fleet monitor must never
    // give by accident.
    const { code, out, err } = await tmux(listSessionsArgs())
    // BOTH streams: with no server tmux says nothing on stdout and puts its reason on stderr, so a
    // stdout-only test would call the ordinary first-run state a failure. See `tmuxListIsEmptyState`.
    if (!tmuxListIsEmptyState(code, out, err)) {
      const said = (err.trim() || out.trim()).split('\n')[0]
      throw new Error(said || `tmux list-sessions failed (code ${code})`)
    }
    return parseTmuxList(out)
  },

  async capture(id: string, lines: number) {
    const { code, out } = await tmux(capturePaneArgs(id, lines))
    if (code !== 0) return []
    return trimCapture(out.split('\n'))
  },

  async captureTerminal(id: string, lines: number): Promise<TerminalCapture | null> {
    // Content FIRST: a non-zero capture is how we learn the session is gone, and there is no point
    // asking for its geometry once it is. `-e` keeps the colours; the frame is NOT trailing-trimmed
    // because a full-screen TUI's blank rows are part of its layout, not padding to discard.
    const cap = await tmux(capturePaneAnsiArgs(id, lines))
    if (cap.code !== 0) return null // tmux no longer has this session — the caller ends the stream
    // A trailing '' from the final newline is not a real row; drop only that one.
    const raw = cap.out.split('\n')
    if (raw.length && raw[raw.length - 1] === '') raw.pop()

    const meta = await tmux(paneInfoArgs(id))
    const info = meta.code === 0 ? parsePaneInfo(meta.out) : null
    if (!info) {
      // The pane exists (capture succeeded) but display-message could not be read or parsed. Rather
      // than ship a confident-wrong cursor, fall back to a minimal honest geometry: the browser
      // emulator sizes itself, so `cols: 0` is a "don't know" the client can ignore, and `alive` is
      // true because the capture just worked. Never a throw.
      return { lines: raw, info: { cols: 0, rows: raw.length, cursorX: 0, cursorY: 0, alive: true, historySize: 0 } }
    }
    return { lines: raw, info }
  },

  async kill(id: string) {
    const { code, err } = await tmux(killSessionArgs(id))
    // A non-zero exit that ISN'T "already gone" leaves the session running — reporting success
    // anyway is exactly the bug this return value exists to prevent (see types.ts).
    return code === 0 || isSessionGoneError(err)
  },

  attachCommand(id: string) {
    return attachArgs(id)
  },

  async detachHint() {
    const { out } = await tmux(showPrefixArgs())
    return parsePrefix(out)
  },

  async listPanePids(): Promise<Map<string, number>> {
    const { out } = await tmux(listPanePidsArgs())
    return parsePanePids(out)
  },
}

/**
 * cli-session.ts — the `agentop session …` handlers.
 *
 * Every decision is already made by a pure module: `parseSessionArgs` says what was asked,
 * `planSpawn` says what to run, `resolveSessionRef` says which session was meant, and
 * `reconcileSessions` says what exists. This file does I/O and prints.
 */

import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { structuredIntentOf } from './structured-route'
import { agentisticsMcpLaunch } from '../mcp-launch'
import { managedProcessLogPath } from './process-conversation'
import { HARNESS_ORDER, hasRolePrefix, type HarnessId } from '@agentistics/core'
// `GROUPINGS` and never a list typed into the usage text: the help is the only place a person can
// read what `--group` accepts, and a second copy of that list drifts silently — the CLI would go on
// accepting an arrangement its own help says nothing about. Same rule `cli-parse.ts` already applies
// to its error message.
import { GROUPINGS, sessionRunning } from '@agentistics/tui/control/sessions'
import { controlStrings, sessionWordBook } from '@agentistics/tui/control/i18n'
import { wrapText } from '@agentistics/tui/control/surface'
import { parseSessionArgs, LS_DEFAULT, type BatchSpec, type SessionCommand } from './cli-parse'
import { cliStrings } from '../cli-i18n'
import { resolveLang, type CliLang } from '../cli-lang'
import { readPreferences } from '../preferences'
import { muteAtSpawn } from './session-notify-web'
import {
  admitSpawn, admissionMessage, admissionOverrideNote, admissionRefusalBody, type Admission,
} from './spawn-admission'
import { readSpawnBudget } from './memory-probe'
import { toControlSession } from './control-session'
import { recordedRepo, repoFacts } from './repo-facts'
import { emptyReason, renderSessionTable, resolveWidth } from './session-table'
import { SPAWN_SPECS, planSpawn } from './spawn-spec'
import { spawnCapabilities } from './codex-capabilities'
import { readHarnessVersion } from './harness-version'
import { buildSpawnContext, pendingContextFor, parentLinkOf, resolveContextAway, resolveContextParent, resolveContextRole, resolveContextTask, resolveContextTaskByRef, resolveSpawnAwayFor, writeContextFile } from './spawn-context'
import { rulesFor } from './attention-rules'
// The harness half of a rename. Shared with the cockpit's Rename verb — see `rename.ts`.
import { renameInHarness, renameMessage } from './rename'
import { reconcileSessions, resolveSessionRef, type ReconciledSession, type RefCandidate } from './session-ref'
import { inheritedIdentity, inheritedLaunch } from './reopen-inherit'
import { configureSpawn, configurationPendingMessage } from './spawn-configuration'
import { handoffSpawnDefaults, handoffTitle } from './handoff-inherit'
import { addSession, newSessionId, patchSession, readRegistry, removeSession, retireFallenSessions, killAndRetireSession } from './registry'
import { callerHoldsIdentity, callerProof, callerSessionFromTree, type CallerProof } from './session-identity'
import { spawnParentLink } from './team-links'
import { decideSpawnAccount, spawnAccountMessage } from './spawn-account'
import { newestRowOfConversation, recordedSpawnAccount, spawnAccountContext } from './spawn-account-io'
import { liveIdsOf, planReopenCwd, planSpawnFilingSafe } from './spawn-filing-io'
import type { FilingPlan } from './spawn-filing'
import { filingJson, filingRow, refusalText, spawnRole, WARNING_TEXT } from './spawn-row'
import { loadConversations } from './conversations'
import { callerIsLeader, fileInFolder, folderLineText, folderTree, NO_FOLDER_WARNING, resolveFolders } from './cli-folder'
import { exactLinksOnDisk } from './reopen-link'
import { reopenTargetFor } from './reopen-target'
import { resolveBackend } from './index'
import { scanProcesses } from '../live-sessions'
import { loadHarnessSessions } from './harness-sessions'
import { createSessionsPoller, type SessionSnapshot } from './sessions-host'
import { loadNativeFleet, resolveNativeRef, runNativeVerb } from './native-fleet'
import { isServerProcess, readServerSnapshot } from './shared-snapshot'
import { needsAttention, type SessionView } from './session-view'
import { planTaskReopen, taskReopenSucceeded } from './task-reopen'
import { AGENTISTICS_DATA_DIR, TASKS_FILE, PORT } from '../config'
import { createTaskStore } from './task-store'
import { newAttemptId, newTaskId, type Attempt, type Task } from './task-model'
import { liveConversationHolders } from './live-claims'
import { conversationHeldBy } from './conversation-claim'
import { withConversationResumeLock } from './conversation-resume-lock'
import { codexStartupFailure, execFailed } from './spawn-outcome'
import { spawnDeath } from './spawn-check'
import { reportFreshSpawn } from './spawn-report'
import { readHarnessAgents } from './harness-agents-io'
import { planTakeover, type TakeoverRefusal } from './takeover'
import { applyRoleTitle, deliverStoredRole, ensureSpawnRole, markRoleDelivered, rekeyStoredRole, spawnRoleOriginFor } from './session-roles'
import type { BackendInitialPrompt, ManagedSession, SessionBackend, SpawnPlan, SpawnPlanError } from './types'

/**
 * The initial-prompt argument for `backend.spawn`, with the harness's screen RULES attached so the
 * backend can gate delivery on readiness without importing the harness table. Absent when the plan
 * carries no prompt to deliver. One helper for both spawn sites — the rules must never be forgotten
 * on one of them.
 */
function spawnPromptArg(plan: SpawnPlan, harness: HarnessId): { initialPrompt?: BackendInitialPrompt } {
  if (!plan.initialPrompt) return {}
  const rules = rulesFor(harness)
  return { initialPrompt: { ...plan.initialPrompt, ...(rules ? { rules } : {}) } }
}

/** Derived from the specs, never a second hand-written list — the two could not then disagree. */
const STARTABLE: HarnessId[] = HARNESS_ORDER.filter(h => SPAWN_SPECS[h] !== null)

const USAGE = `Usage:
  agentop session <harness> [-p "prompt"] [--bg] [--model <id>] [--effort <level>] [--mode <default|accept-edits|plan|no-questions>] [--cwd <path>] [--name "label"] [--notify on|off] [--folder <folder>] [--task <id|title>] [--subtask <id|title>] [--shared-cwd] [--away|--no-away] [--handoff] [--account <acc_…>] [--force]
  agentop session ls     [--all] [--group ${GROUPINGS.join('|')}] [--json]
  agentop session list
  agentop session attach <id|name>
  agentop session kill   <id|name> [--folder <folder>]
  agentop session retire <id|name> [--cancel] [--quiet-for 60s] [--deadline 30m] [--folder <folder>] [--json]
  agentop session folders [--json]
  agentop session rename <id|name> "label"
  agentop session switch-account <id|name> [<account-id>] [--harness <h>] [--resend]
                                  Continue the session on another account of its harness (no
                                  account: list the ones it can move to). --resend re-sends the
                                  message a usage limit refused.
  agentop session note   <id|name> "text"
  agentop session archive|unarchive|delete <ses_…>

  A NATIVE Agentistics session (\`ses_…\`, the engine's own) takes \`kill\` (end), \`rename\`, and the
  three above; a prefix is enough when it is unique. \`archive\` and \`delete\` need it ended first —
  \`delete\` is permanent.

  \`ls\` is the table a PERSON reads: aligned columns, one section per project, and only what is
  running — \`--all\` adds the finished, lost and closed conversations, \`--group\` changes the
  sections. \`list\` stays the tab-separated dump a script can read line by line; both take
  \`--json\` and print the same data.

  \`--force\` starts anyway when this machine cannot hold another assistant session (see the
  memory gate below) — every verb that starts or reopens a process takes it, and it never fails
  silently: the check that was overridden is printed regardless.

  \`--notify off\` starts the session with its notifications muted: no bell, card, sound or desktop
  toast for it, while it still shows as waiting and its events are still recorded. Absent = on. On
  \`batch\` it is a default for the \`--session\`s that follow it, like \`--model\`.

  \`--away\` starts the session in AWAY MODE on its own (it is told the owner is out and asks them
  nothing, even while the global switch is off); \`--no-away\` refuses to inherit it. Absent: a
  session started from inside a session that is itself in away mode inherits it. On \`batch\` it
  applies to every session.

  \`--account <acc_…>\` (experimental \`multi-account\`) runs the session on that harness account, in
  its own login folder. Absent: the account the plan router picks for the harness (never one that is
  off for agents), else the default login. A session run from inside an agentop session cannot pick
  an account that is off for agents. On \`batch\` it is a default for the \`--session\`s that follow.
  A reopened session always stays on the account it was started on.

  \`--folder <ref>\` files the session into a sidebar folder AT SPAWN (also on \`batch\`, as a default for
  the \`--session\`s that follow, and on \`open\`). <ref> is a folder id, its exact name, or a
  "Parent/Child" path (case-insensitive). An unknown or ambiguous ref is refused before anything
  starts and lists the candidates — a folder is never created for you. \`kill --folder\` ends the
  session and moves it (e.g. to "…/Finalizadas") in one step. \`folders\` prints the tree to pick from.

  \`--handoff\` (from inside a leader) starts that leader's SUCCESSOR: the same folder, pin position, title,
  check-in agenda, leader role, away mode and last-answer relay the web hand-off gives. Refused without a
  verified calling session. \`kill\` of the predecessor then leaves the successor pinned.

  \`--task <id|title>\` / \`--subtask <id|title>\` file the session on the BOARD at spawn, with the task's real
  title on the row. A reference that matches nothing (or two things) is refused before anything starts and
  lists the closest titles — it is never kept as a free-text name. A worker is refused when its cwd is not a
  checkout of the task's repository, or is a main checkout another live session already works in (use a
  worktree, or \`--shared-cwd\`). With no \`--folder\` the session is filed where the task's other sessions
  already are. \`--json\` adds the filing block (task, subtask, folder, cwd, role, warnings).

Orchestrating several at once — the form an assistant should use:

  agentop session batch --task "<name>" [--cwd <path>] [--model <id>] [--effort <level>] [--mode <default|accept-edits|plan|no-questions>] [--folder <folder>] \\
                       --session "<harness>[@<cwd>]: <prompt>" [--session "..."] [--subtask <id|title>] [--shared-cwd] [--away|--no-away] [--json] [--force]
  agentop session open  "<task>" [--folder <folder>] [--json] [--force]
  agentop session list  [--json]

  \`batch\` starts every session detached and files them all under one task, so \`open\` brings the
  whole task back later and the cockpit groups them together. \`--cwd\`/\`--model\`/\`--effort\` given
  before the sessions apply to all of them; a \`@<cwd>\` on a session overrides it. \`--json\` prints
  the started ids as data.

  Example — three assistants on one repository, in parallel:

    agentop session batch --task "auth-refactor" --cwd ~/app --json \\
      --session "claude: refactor the token store" \\
      --session "codex: port the tests" \\
      --session "gemini: review the migration"

Harnesses that can be started: ${STARTABLE.join(', ')}

Memory gate: before starting (or reopening) a session, agentop checks whether this machine has
room for it (available memory, minus room kept for one heavy job, and the CPU load) — a refusal
names how many WOULD fit and the biggest consumer, and exits non-zero without starting anything.
\`--wait\` waits for room instead and starts once it frees; \`--force\` starts anyway; a machine
that cannot be measured (no /proc) is never refused.`

/**
 * A reconciled row as `resolveSessionRef` needs it. Unlike the registry alone, this includes
 * `unregistered` rows (the backend hosts them, the registry does not) — `attach`/`kill` resolve
 * against this so a session `list` shows is never one only `list` can name.
 */
const toRefCandidate = (r: ReconciledSession): RefCandidate => ({ id: r.id, label: r.managed?.label })

function explainPlanError(e: SpawnPlanError): string {
  switch (e.code) {
    case 'unsupported-harness':
      return `${e.harness} cannot be started by agentop yet. Supported: ${STARTABLE.join(', ')}.`
    case 'resume-unsupported':
      return `${e.harness} cannot reopen a conversation by id, so it cannot be resumed.`
    case 'resume-id-unusable':
      return `${e.harness} cannot reopen conversation ${e.id}: its id is not one the CLI accepts (only sessions agentop started or sessions with a recorded id can be reopened).`
    case 'model-unsupported':
      return `${e.harness} has no model flag, so --model cannot be applied.`
    case 'effort-unsupported':
      return `${e.harness} has no effort flag, so --effort cannot be applied.`
    case 'unknown-effort':
      return `${e.harness} does not accept effort "${e.value}". Accepted: ${e.accepted.join(', ')}.`
    case 'unknown-mode':
      return `"${e.value}" is not a mode ${e.harness} can start in. Modes: default, accept-edits, plan, no-questions.`
    case 'account-unsupported':
      return `${e.harness} keeps a single login per computer, so it cannot start in another account's folder.`
  }
}

/**
 * The memory gate's console output, shared by every verb that starts or reopens a process — a
 * single spawn, a whole batch, or a task reopen — so a refusal reads the same sentence wherever it
 * happens. Returns `true` when the caller must stop: nothing below this point may spawn, register
 * or retire anything. `--force` never overrides silently (`admissionOverrideNote`), and an
 * unmeasured machine (`admission.unmeasured`) prints nothing here — see spawn-admission.ts.
 */
function reportAdmission(admission: Admission, lang: CliLang, json: boolean): boolean {
  if (!admission.admit) {
    if (json) console.log(JSON.stringify(admissionRefusalBody(admission.refusal, lang), null, 2))
    else console.error(admissionMessage(admission.refusal, lang))
    return true
  }
  if (admission.overridden) console.error(admissionOverrideNote(admission, lang))
  return false
}

/**
 * RES.1 — `--wait` on `session start` / `batch` / `open`: a memory refusal WAITS for room instead of
 * failing. Stripped before parsing so every subcommand takes it the same way.
 */
let waitForRoom = false

/**
 * Ask the gate; with `--wait`, keep asking every `WAIT_TICK_MS` until it admits — saying why it is
 * waiting once, then only when the number that would fit changes. Ctrl-C leaves, nothing started.
 */
/** `--folder` refs resolved for THIS command (ref -> folder id). Set once in `runSession`. */
let folderByRef = new Map<string, { id: string; path: string; siblings: string[]; top: boolean }>()
const folderCtx = (ref?: string) => { const f = ref ? folderByRef.get(ref) : undefined; return f ? { folder: { path: f.path, siblings: f.siblings, top: f.top } } : {} }

/** The briefing's folder block for a folder the PLAN chose (explicit, predecessor's or the task's). */
async function folderCtxFor(folderId: string | undefined): Promise<ReturnType<typeof folderCtx>> {
  if (!folderId) return {}
  const r = await resolveFolders([folderId]).catch(() => null)
  const f = r?.ok ? r.byRef.get(folderId) : undefined
  return f ? { folder: { path: f.path, siblings: f.siblings, top: f.top } } : {}
}

function reportFilingRefusal(r: Extract<FilingPlan, { ok: false }>, json: boolean): void {
  if (json) console.log(JSON.stringify({ started: false, code: r.code, detail: r.detail, ...(r.candidates ? { candidates: r.candidates } : {}) }, null, 2))
  else console.error(refusalText(r))
}

let warnedNoFolder = false
async function warnLeaderNoFolder(): Promise<void> {
  const { storedRoleFor } = await import('./session-roles')
  const leader = await callerIsLeader(callerSessionId(), storedRoleFor,
    async id => (await readRegistry()).find(m => m.id === id)?.conversationId).catch(() => false)
  if (leader) { warnedNoFolder = true; console.error(NO_FOLDER_WARNING) }
}

const WAIT_TICK_MS = 10_000
async function admitOrWait(requested: number, force: boolean, lang: CliLang, json: boolean): Promise<Admission> {
  let a = admitSpawn(await readSpawnBudget(), requested, { force })
  if (a.admit || !waitForRoom) return a
  let lastFits = -1
  console.error(lang === 'pt'
    ? `${admissionMessage(a.refusal, lang)}\nAguardando memória (--wait) — Ctrl-C cancela.`
    : `${admissionMessage(a.refusal, lang)}\nWaiting for memory (--wait) — Ctrl-C cancels.`)
  while (!a.admit) {
    if (!json && a.refusal.fits !== lastFits) {
      lastFits = a.refusal.fits
      console.error(lang === 'pt' ? `  … cabem ${a.refusal.fits} de ${requested}` : `  … ${a.refusal.fits} of ${requested} fit`)
    }
    await Bun.sleep(WAIT_TICK_MS)
    a = admitSpawn(await readSpawnBudget(), requested, { force })
  }
  return a
}

export async function runSession(argv: string[]): Promise<number> {
  try {
    return await runSessionCommand(argv)
  } catch (error) {
    const failure = error as NodeJS.ErrnoException | null
    if (!failure || !['EACCES', 'EPERM', 'EROFS'].includes(failure.code ?? '')) throw error
    const reason = failure.code === 'EROFS' ? 'read-only filesystem' : 'permission denied'
    console.error(`Could not complete the session command at ${JSON.stringify(failure.path ?? AGENTISTICS_DATA_DIR)} (${failure.code}: ${reason}); make the data directory writable by your user and retry.`)
    return 1
  }
}

async function runSessionCommand(argv: string[]): Promise<number> {
  waitForRoom = argv.includes('--wait')
  argv = argv.filter(a => a !== '--wait')
  const cmd = parseSessionArgs(argv)
  if (cmd.kind === 'help') { console.log(USAGE); return 0 }
  if (cmd.kind === 'error') { console.error(cmd.message); console.error(`\n${USAGE}`); return 1 }

  // A NATIVE session (`ses_…`) is the engine's: no pane, no registry record, no tmux — so it is
  // answered BEFORE the backend is asked, and a machine without tmux can still end or rename one.
  if ((cmd.kind === 'kill' || cmd.kind === 'rename') && cmd.ref.startsWith('ses_')) {
    return nativeCliVerb(cmd.kind, cmd.ref, cmd.kind === 'rename' ? cmd.label : undefined)
  }
  // The store verbs exist ONLY for native sessions; a managed handle is refused in words, before tmux.
  if (cmd.kind === 'archive' || cmd.kind === 'unarchive' || cmd.kind === 'delete') {
    if (!cmd.ref.startsWith('ses_')) {
      console.error(`\`${cmd.kind}\` is for native Agentistics sessions (ids starting with ses_). For a terminal session use \`agentop session kill\`.`)
      return 1
    }
    return nativeCliVerb(cmd.kind, cmd.ref)
  }

  // Folders are resolved BEFORE anything starts: a bad ref refuses the whole command.
  const folderRefs = cmd.kind === 'batch' ? cmd.specs.map(sp => sp.folder) : cmd.kind === 'start' || cmd.kind === 'open' || cmd.kind === 'kill' || cmd.kind === 'retire' ? [cmd.folder] : []
  if (cmd.kind === 'folders') {
    const tree = await folderTree()
    if (cmd.json) console.log(JSON.stringify({ folders: tree }, null, 2))
    else if (tree.length === 0) console.log('No folders yet.')
    else for (const l of tree) console.log(folderLineText(l))
    return 0
  }
  const resolvedFolders = await resolveFolders(folderRefs)
  if (!resolvedFolders.ok) { console.error(resolvedFolders.message); return 1 }
  folderByRef = resolvedFolders.byRef

  const backend = await resolveBackend()
  const blocked = await backend.unavailable()
  if (blocked) { console.error(blocked); return 1 }

  switch (cmd.kind) {
    case 'start': return start(cmd, backend)
    case 'batch': return batch(cmd, backend)
    case 'open': return openTask(cmd.task, cmd.json ?? false, cmd.force ?? false, backend, cmd.folder)
    case 'list': return list(backend, cmd.json ?? false)
    case 'ls': return ls(cmd, backend)
    case 'attach': return attach(cmd.ref, backend)
    case 'kill': return kill(cmd.ref, backend, cmd.folder)
    case 'retire': {
      const f = cmd.folder ? folderByRef.get(cmd.folder) : undefined
      const { retireCommand } = await import('./cli-retire')
      return retireCommand({ ...cmd, ...(f ? { folderId: f.id, folderPath: f.path } : {}), caller: callerSessionId() })
    }
    // `labelSince` travels WITH the label, always. `pickTitle` settles a disagreement between the
    // name typed here and the one the harness holds by RECENCY, and it can only do that when both
    // sides say when — so a rename written without a timestamp can never win, whatever the user
    // typed and however recently. Measured on this machine: every one of twelve live rows had
    // `labelSince: undefined`, because the cockpit's rename verb stamped it and this one did not.
    // The comparison had therefore never once run in production, and the harness took every row.
    // A rename lands in BOTH places a session can be named: the registry, and the harness's own
    // record. The second half is the shared `renameInHarness` — the cockpit's Rename verb runs the
    // very same function, because one gesture implemented twice is the bug `task-reopen.ts` exists
    // to have fixed once. It never blocks the registry write: whatever became of the harness half is
    // reported in a sentence instead.
    case 'rename': return patch(
      cmd.ref,
      { label: cmd.label, labelSince: Date.now() },
      'renamed',
      backend,
      async session => {
        const s = cliStrings(await resolveLang())
        const outcome = await renameInHarness(session, cmd.label.trim(), backend)
        return `${session.id} ${renameMessage(outcome, session.harness, s)}`
      },
    )
    case 'note': return patch(cmd.ref, { note: cmd.text }, 'annotated', backend)
    case 'switch-account': return switchAccount(cmd, backend)
  }
}

/**
 * Whether the session we just started is already GONE, and what it said on the way out.
 *
 * Returns the sentence to show, or `undefined` when it is running. One helper for all three spawn
 * sites — `start`, `batch` and the reopen — because the failure is identical at each and a check in
 * only one of them is the same bug surviving in the other two.
 *
 * The deadline is `SETTLE_MS`, and it is MEASURED rather than guessed — see that constant. The
 * first version waited 700ms on the reasoning that a refusal must be immediate; the real one lands
 * between 1.5s and 3s, so that check would have reported "started" for the very session it exists
 * to catch.
 */
/** `agentop session kill|rename ses_…` — the engine's lifecycle, through `native-fleet.ts`. */
async function nativeCliVerb(kind: 'kill' | 'rename' | 'archive' | 'unarchive' | 'delete', ref: string, label?: string): Promise<number> {
  const lang = await resolveLang()
  const rows = await loadNativeFleet(lang, { includeArchived: true })
  const found = resolveNativeRef(rows, ref)
  if (!found.ok) {
    console.error(found.reason === 'ambiguous'
      ? `"${ref}" matches several native sessions: ${found.matches.join(', ')}.`
      : `No native session matches "${ref}". (Is the native harness enabled? \`agentop experimental status\`)`)
    return 1
  }
  const out = await runNativeVerb(found.id, kind, lang, label !== undefined ? { title: label } : {})
  if (!out.ok) { console.error(out.message); return 1 }
  console.log(`${found.id} — ${out.message}`)
  return 0
}

async function spawnFailure(backend: SessionBackend, id: string, bin?: string, freshHarness?: HarnessId, settleMs?: number): Promise<string | undefined> {
  const outcome = await spawnDeath(backend, id, settleMs, freshHarness, reportFreshSpawn)
  if (!outcome) return undefined
  // A binary that could not be EXECUTED says nothing on the way out (see `execFailed`), and the
  // only thing that fixes it is the PATH — so name it rather than print a bare status.
  if (bin && execFailed(outcome, bin)) {
    return `\`${bin}\` could not be executed — is it on PATH? PATH: ${process.env.PATH ?? '(empty)'}`
  }
  if (bin === 'codex') return codexStartupFailure(await readHarnessVersion(bin), outcome.status)
  // The harness's own words, because they are the only actionable part. A status with no message is
  // still better than "it did not start".
  return outcome.message
    || `the session exited immediately${outcome.status !== undefined ? ` (status ${outcome.status})` : ''}`
}

/**
 * The managed id of the session this command runs INSIDE (`AGENTOP_MANAGED_ID`, set on every pane
 * agentop spawns) — the parent of anything it starts. Undefined outside a managed pane.
 */
export function callerSessionId(env: Record<string, string | undefined> = process.env): string | undefined {
  const id = env.AGENTOP_MANAGED_ID?.trim()
  return id ? id : undefined
}

/**
 * The calling session when `AGENTOP_MANAGED_ID` was LOST on the way here (an `env -u` workaround, a
 * wrapper script): found from the process tree, and written back into THIS one-shot process's
 * environment so every check downstream (`callerHoldsIdentity`, the hand-off proof) reads the same
 * caller. The tree is the stronger proof — it is what `callerProof` checks — so nothing is weakened.
 * A variable that IS set is never second-guessed. Without this, a leader's worker came up with no
 * parent and landed in "No leader".
 */
export async function recoverCallerFromTree(backend: SessionBackend, env: Record<string, string | undefined> = process.env): Promise<string | undefined> {
  if (callerSessionId(env)) return callerSessionId(env)
  const found = await callerSessionFromTree(
    async () => (backend as { listPanePids?: () => Promise<Map<string, number>> }).listPanePids?.(),
    async () => (await readRegistry()).filter(r => !r.endedAt).map(r => r.id),
  )
  if (found) env.AGENTOP_MANAGED_ID = found
  return found
}

/**
 * Said after a FAILED `--handoff` spawn. Measured 2026-10-17: a leader whose `--handoff` spawn failed
 * retried WITHOUT the flag, and that successor came up with none of the predecessor's setup (no pin,
 * no hand-off link, no relay) because a plain spawn inherits nothing.
 */
const HANDOFF_NOT_MADE = 'The hand-off was NOT made and nothing was inherited. Retry WITH --handoff once the cause is fixed — a spawn without it does not inherit the pin, folder, check-in agenda, mute or launch flags.'

export async function start(
  cmd: Extract<SessionCommand, { kind: 'start' }>,
  backend: SessionBackend,
  deps: {
    provesCaller?: (id: string) => Promise<boolean>
    /** How long a healthy spawn is watched before it counts as up (`SETTLE_MS`). Tests shorten it. */
    settleMs?: number
  } = {},
): Promise<number> {
  // A relative --cwd must resolve against the CALLER's directory: passed through unresolved it
  // reaches `tmux new-session -c` and is interpreted by the tmux SERVER's own cwd instead, and it
  // is written verbatim into the registry, where `list` would print it back meaningless from
  // anywhere else.
  const lang = await resolveLang()
  await recoverCallerFromTree(backend)
  // WHERE this session is filed is decided once, BEFORE the memory gate: a refusal spawns nothing.
  const parentSessionIdForPlan = callerSessionId()
  // `--handoff` is the API's `handoff: true`: only a VERIFIED calling session can have a successor, so
  // without one it is refused before anything starts (never quietly started as an ordinary session).
  // The proof is the PANE, not the environment: the pane pid agentop created for that session must be an
  // ancestor of this process (`callerRunsInSession`), so an exported AGENTOP_MANAGED_ID proves nothing.
  const proof: (cid: string) => Promise<CallerProof> = deps.provesCaller
    ? async cid => (await deps.provesCaller!(cid)) ? 'proven' : 'bad-identity'
    : cid => callerProof(cid, async () => (backend as { listPanePids?: () => Promise<Map<string, number>> }).listPanePids?.())
  if (cmd.handoff) {
    const result = parentSessionIdForPlan ? await proof(parentSessionIdForPlan) : 'bad-identity'
    if (result !== 'proven') {
      console.error(result === 'unavailable'
        ? 'Cannot verify the calling session on this system (no way to read process ancestry). Nothing was started; ask the person who runs agentistics to start the successor from the Sessions screen.'
        : '--handoff needs a verified calling session: run it from inside the leader being replaced, in the terminal agentistics opened for it.')
      return 1
    }
  }
  const verifiedCaller = parentSessionIdForPlan && (cmd.handoff || await callerHoldsIdentity(parentSessionIdForPlan)) ? parentSessionIdForPlan : undefined
  const filing = await planSpawnFilingSafe({
    harness: cmd.harness,
    liveIds: await liveIdsOf(backend),
    // A person with no parent session is neither: only a parent (or an explicit role) makes a worker.
    role: cmd.handoff ? 'leader' : spawnRole({ explicit: cmd.role, leaderPrefix: !!cmd.label && hasRolePrefix(cmd.label), hasParent: !!parentSessionIdForPlan }),
    ...(cmd.handoff ? { handoffOf: parentSessionIdForPlan } : {}),
    taskRef: cmd.taskId ?? cmd.task, subtaskRef: cmd.subtask, folderRef: cmd.folder,
    cwd: cmd.cwd, sharedCwd: cmd.sharedCwd, callerSessionId: verifiedCaller,
  })
  if (!filing.ok) { reportFilingRefusal(filing, cmd.json ?? false); return 1 }
  for (const w of filing.warnings) if (w !== 'no_folder') console.error(WARNING_TEXT[w])
  const cwd = filing.cwd
  const folderId = filing.folderId
  const id = newSessionId()
  const offeredConversationId = randomUUID()
  const logFile = managedProcessLogPath(cmd.harness, id, AGENTISTICS_DATA_DIR)
  // A hand-off names its predecessor exactly; any other spawn by a predecessor that has already
  // handed off is filed under its successor (`team-links.ts`).
  const parentLink = await parentLinkOf(callerSessionId(), { followHandoff: !cmd.handoff })
  const parentSessionId = parentLink.parentSessionId
  // A hand-off already PROVED its caller by the pane above (stronger than the token check), so the
  // predecessor's away mode and role origin are inherited on that proof. The CALLER is what is
  // verified — the followed successor is never the process asking.
  const parentVerified = (cmd.handoff && !!parentSessionId && parentSessionId === parentSessionIdForPlan)
    || await callerHoldsIdentity(callerSessionId())
  const registry0 = parentVerified ? await readRegistry() : []
  // A name that already wears the leader prefix is a statement of intent: never let it silently become a worker.
  const wantedRole = cmd.handoff ? 'leader' as const : cmd.role ?? (cmd.label && hasRolePrefix(cmd.label) ? 'leader' as const : undefined)
  const role = wantedRole
    ? await ensureSpawnRole([offeredConversationId, id], wantedRole, undefined, await spawnRoleOriginFor(parentSessionId, parentVerified))
    : parentSessionId ? await ensureSpawnRole([offeredConversationId, id], 'worker', undefined, await spawnRoleOriginFor(parentSessionId, parentVerified)) : undefined
  const away = await resolveSpawnAwayFor(cmd.away, parentSessionId, parentVerified)
  // HANDOFF: the successor keeps the predecessor's title and is briefed with the owner's last words to it.
  const handoffParentRow = cmd.handoff && parentSessionId ? registry0.find(m => m.id === parentSessionId) : undefined
  const label = cmd.handoff ? handoffTitle(handoffParentRow?.label, cmd.label) : cmd.label
  // …and its launch flags when this hand-off did not name them (same harness only).
  const launch = handoffSpawnDefaults(handoffParentRow, cmd.harness, { ...cmd, mode: cmd.mode ?? registry0.find(r => r.id === verifiedCaller)?.mode })
  const relay = handoffParentRow
    ? await import('./handoff-relay-io').then(m => m.captureHandoffRelay(handoffParentRow)).catch(() => undefined)
    : undefined
  const ctx = buildSpawnContext({ ...(relay ? { handoffRelay: relay.section } : {}), ...(await resolveContextAway(away)), sessionId: id, cwd, harness: cmd.harness, lang, ...(await folderCtxFor(folderId)), ...(await resolveContextTaskByRef(filing.taskId, filing.subtaskId)), ...(await resolveContextParent(parentSessionId)), ...(role ? { role } : await resolveContextRole(id, offeredConversationId)) })
  // PLAN.ACCOUNTS D3 — one decision for every door (`spawn-account.ts`). An agent is asking when
  // this command runs inside a pane that can prove its identity.
  const account = decideSpawnAccount({
    harness: cmd.harness, ...(cmd.account ? { requested: cmd.account } : {}),
    agentCaller: await callerHoldsIdentity(callerSessionId()),
    context: await spawnAccountContext(cmd.account ? [] : [cmd.harness]),
  })
  if (!account.ok) { console.error(spawnAccountMessage(account.reason, account.detail, lang === 'pt' ? 'pt' : 'en')); return 1 }
  const planned = planSpawn({
    harness: cmd.harness, cwd, prompt: cmd.prompt, model: launch.model, effort: launch.effort, mode: launch.mode,
    ...(logFile ? { logFile } : {}),
    conversationId: offeredConversationId,
    context: ctx,
    ...(account.account?.root ? { account: { root: account.account.root } } : {}),
  }, await spawnCapabilities(cmd.harness))
  if (!planned.ok) { console.error(explainPlanError(planned.error)); return 1 }
  if (!cmd.background && planned.plan.modeNeedsProtocol) { console.error(`${cmd.harness} cannot start a terminal in ${planned.plan.modeNeedsProtocol} mode; use a supported mode or a structured session.`); return 1 }

  // The memory GATE, before anything is registered or launched — `requested: 1` is this one
  // process. A refusal here means nothing below this point runs: no id is minted, no row is
  // written, nothing is spawned. `--force` still goes through this check, so the override note
  // is printed from the SAME place a plain refusal would have been.
  if (reportAdmission(
    await admitOrWait(1, cmd.force ?? false, lang, cmd.json ?? false), lang, cmd.json ?? false,
  )) return 1

  // Stamped BEFORE the process is launched, not after it has been checked for a crash.
  //
  // `planFirstSightingClaims` asks whether a conversation began AFTER we spawned, and this is the
  // only timestamp it has. `spawnFailure` deliberately WAITS to see whether the child dies, so a
  // record stamped after it is seconds late — measured 2026-09-08: a kimi session whose own store
  // record began at 13:58:50.831 was recorded as spawned at 13:58:52.914, so its conversation
  // failed the `startedMs > spawnedMs` test and that row stayed unlinked, with an empty chat view,
  // for good. The moment we launched is the moment the claim means; the moment we finished
  // checking is not.
  const spawnedAt = new Date().toISOString()
  // The row (with its label) is written BEFORE the pane exists. `spawnFailure` waits to see whether the
  // child dies; a row written after that wait leaves a window in which the fleet poller sees an
  // unregistered pane and adopts it WITHOUT the name (`session-adopt.ts` cannot know one), so the
  // `--name` was lost. Removed again below if the spawn fails.
  await addSession({
    id,
    harness: cmd.harness,
    cwd,
    createdAt: spawnedAt,
    ...(launch.model ? { model: launch.model } : {}),
    ...(launch.effort ? { effort: launch.effort } : {}),
    ...(launch.mode ? { mode: launch.mode } : {}),
    ...(label ? { label } : {}),
    ...(handoffParentRow?.note ? { note: handoffParentRow.note } : {}),
    ...(account.account ? { accountId: account.account.id } : {}),
    // Stamped at SPAWN — the one moment the association is a fact. See `ManagedSession.taskId`.
    ...filingRow(filing),
    ...(cmd.attemptId ? { attemptId: cmd.attemptId } : {}),
    // TEAM LINK (`team-links.ts`): a leader — `--role leader`, a `--handoff` successor — is born at the root.
    ...spawnParentLink(role, {
      ...(parentSessionId ? { parentSessionId } : {}),
      ...(parentLink.parentConversationId ? { parentConversationId: parentLink.parentConversationId } : {}),
    }),
    ...(away ? { away: true } : {}),
    ...(pendingContextFor(planned.plan, ctx) ? { pendingContext: pendingContextFor(planned.plan, ctx)! } : {}),
    // The link is EXACT here: the CLI was handed this id (`SpawnSpec.assignId`).
    ...(planned.plan.conversationId
      ? { conversationId: planned.plan.conversationId, conversationLink: 'assigned' as const, conversationLinkVia: 'assigned-id' as const }
      : {}),
    ...(await recordedRepo(cwd)),
  })
  const filingConfiguration = await configureSpawn({ taskId: filing.taskId, subtaskId: filing.subtaskId }, { id, conversationId: planned.plan.conversationId })
  if (!filingConfiguration.ready) {
    await removeSession(id)
    reportFilingRefusal({ ok: false, code: 'subtask_refused', detail: `board filing is pending: ${filingConfiguration.pending.map(p => p.reason).join('; ')}; no process was started` }, cmd.json ?? false)
    return 1
  }
  await writeContextFile(planned.plan)
  try {
    if (logFile) await mkdir(dirname(logFile), { recursive: true, mode: 0o700 })
    await backend.spawn({ id, cwd, argv: planned.plan.argv, ...(planned.plan.env ? { env: planned.plan.env } : {}), ...spawnPromptArg(planned.plan, cmd.harness),
      structured: structuredIntentOf({ harness: cmd.harness, origin: cmd.background ? 'background' : 'terminal', prompt: cmd.prompt, mode: launch.mode }, { ...launch, ctx, conversationId: offeredConversationId, mcp: { ...agentisticsMcpLaunch(), env: { AGENTISTICS_API: `http://localhost:${PORT}` } } }),
      ...(planned.plan.modeNeedsProtocol ? { modeNeedsProtocol: planned.plan.modeNeedsProtocol } : {}),
    })
  } catch (e) {
    await removeSession(id).catch(() => {})
    console.error(`Could not start the session: ${e instanceof Error ? e.message : String(e)}`)
    if (cmd.handoff) console.error(HANDOFF_NOT_MADE)
    return 1
  }

  // `spawn` returning is not evidence anything is RUNNING — tmux's contract is "I made you a
  // session". A harness that refuses its arguments has already exited by now, and registering a row
  // for it is what produced three dead rows called MAIN. See `spawn-outcome.ts`.
  const failed = await spawnFailure(backend, id, planned.plan.argv[0], cmd.harness, deps.settleMs)
  if (failed) {
    console.error(failed)
    if (cmd.handoff) console.error(HANDOFF_NOT_MADE)
    await backend.kill(id).catch(() => {})
    await removeSession(id).catch(() => {})
    return 1
  }
  if (role) await markRoleDelivered([planned.plan.conversationId, id], role)

  if (role) await applyRoleTitle(id, label ?? id, role, lang).catch(() => false)
  const configuration = await configureSpawn(filing, { id, conversationId: planned.plan.conversationId }, handoffParentRow)
  if (!configuration.ready) console.error(configurationPendingMessage(id, configuration))
  if (handoffParentRow) {
    // Link both rows, move the predecessor's whole team here, keep this leader at the root, retire the predecessor.
    await import('./team-links-io').then(m => m.completeLeaderHandoff(handoffParentRow.id, id, relay, handoffParentRow.handoffSeq))
  }
  // Muted at birth: keyed by the conversation we assigned, else by the managed id (re-keyed when the
  // poller links the conversation). Delivery only — the session still reads as waiting.
  if (cmd.notify === 'off') await muteAtSpawn(planned.plan.conversationId ?? id).catch(() => {})

  const liveBackend = await backend.list().catch(() => null)
  const backendIds = liveBackend ? new Set(liveBackend.map(b => b.id)) : null
  await retireFallenSessions({
    newSessionId: id,
    conversationId: planned.plan.conversationId,
    cwd,
    harness: cmd.harness,
    backendIds,
  })

  if (cmd.background) {
    if (cmd.json) console.log(JSON.stringify({ id, harness: cmd.harness, label: label ?? null, ...filingJson(filing), configuration }, null, 2))
    else {
      if (configuration.ready) console.log(`Started ${cmd.harness} session ${id}${label ? ` (${label})` : ''} in ${cwd}`)
      console.log(`Attach with: agentop session attach ${id}`)
    }
    return configuration.ready ? 0 : 1
  }
  if (!configuration.ready) return 1
  return execAttach(id, backend)
}

/**
 * Hand the terminal over. The detach key is READ from the backend and printed first — a user who
 * cannot get out is stranded in a buffer that hides their shell, and the key is not always Ctrl-b.
 */
async function execAttach(
  id: string,
  backend: SessionBackend,
): Promise<number> {
  // F2.0b — a live STRUCTURED session has no pane: attaching to it is "open in terminal" — its child
  // ends and the same conversation resumes as a TUI under this id, then the attach enters that.
  const switched = backend.toTerminal ? await backend.toTerminal(id).catch(() => null) : null
  if (switched?.ok) console.log(`Session ${id} was running over its harness's protocol; it now runs in a terminal (the same conversation, resumed).`)
  const hint = await backend.detachHint()
  console.log(`Attaching to ${id}. To leave the session running and come back here, press ${hint}.`)
  const [bin, ...rest] = backend.attachCommand(id)
  const p = Bun.spawn([bin!, ...rest], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' })
  return await p.exited
}

/** The word each state wears. `external` says outright that this row is not ours to drive. */
function stateWord(v: SessionView): string {
  if (v.status === 'external') return 'external'
  if (v.status === 'lost') return 'lost'
  switch (v.activity) {
    case 'waiting-approval': return 'NEEDS APPROVAL'
    case 'waiting': return 'waiting'
    case 'working': return 'working'
    case 'exited': return 'exited'
    default: return v.status
  }
}

/**
 * The Task and the Attempts a batch is filed under, created on first sight.
 *
 * A task is matched by TITLE and an attempt by LABEL within that task, so running the same batch
 * twice adds sessions to the work that exists rather than forking a second copy of it — which is
 * exactly what "the same task under four configs, measured" needs.
 *
 * The attempt's `config` records what was ASKED FOR at spawn, never what is inferred later: that is
 * the whole point of the middle level, and a configuration reconstructed after the fact from the
 * sessions would just be a description of what happened.
 */
async function resolveTaskAndAttempts(
  cmd: Extract<SessionCommand, { kind: 'batch' }>,
  /** The task the planner already resolved by id or title; absent = find by title, else create. */
  knownTaskId?: string,
): Promise<{ taskId: string; attempts: Map<string, string> }> {
  const store = createTaskStore(TASKS_FILE)
  const book = await store.read()
  const now = new Date().toISOString()

  let task = (knownTaskId ? book.tasks.find(t => t.id === knownTaskId) : undefined) ?? book.tasks.find(t => t.title === cmd.task)
  if (!task) {
    // A task a batch is starting is `in_progress` by construction: sessions are about to run.
    task = { id: newTaskId(), title: cmd.task, status: 'in_progress', createdAt: now, updatedAt: now }
    await store.upsertTask(task)
  }
  const created: Task = task

  const attempts = new Map<string, string>()
  for (const spec of cmd.specs) {
    const label = spec.attempt
    if (!label || attempts.has(label)) continue
    const existing = book.attempts.find(a => a.taskId === created.id && a.label === label)
    if (existing) { attempts.set(label, existing.id); continue }
    const attempt: Attempt = {
      id: newAttemptId(),
      taskId: created.id,
      label,
      config: {
        harness: spec.harness,
        ...(spec.model ? { model: spec.model } : {}),
        ...(spec.effort ? { effort: spec.effort } : {}),
      },
      status: 'running',
      startedAt: now,
      updatedAt: now,
    }
    await store.upsertAttempt(attempt)
    attempts.set(label, attempt.id)
  }
  return { taskId: created.id, attempts }
}

/**
 * `agentop session batch` — start several sessions at once, all filed under one task.
 *
 * The command an ASSISTANT drives. Every session is started detached, because a batch by definition
 * has no single terminal to hand over, and the result is printed as JSON on request so the caller
 * gets the ids back as data rather than having to parse prose it did not write.
 *
 * A failure does not abort the rest: with five sessions requested, four that started are four that
 * are running, and pretending otherwise would leave them orphaned. Every outcome is reported.
 */
export async function batch(
  cmd: Extract<SessionCommand, { kind: 'batch' }>,
  backend: SessionBackend,
): Promise<number> {
  const started: Array<{ id: string; harness: string; cwd: string; filing: ReturnType<typeof filingJson> }> = []
  const failed: Array<{ harness: string; reason: string }> = []

  // WHERE each session is filed is decided for the WHOLE batch before anything else: one refusal
  // refuses it all (nothing has started, so there is no half to strand). `--task` here has always
  // meant "this task, created if it is not on the board yet" — so a title that matches nothing is
  // planned against a SYNTHETIC task standing in for the one that will be created: every other
  // refusal (--subtask, --folder, a missing @cwd, a shared checkout) then shows up BEFORE the board
  // is written, and a refused batch creates no task and no attempt.
  const lang = await resolveLang()
  await recoverCallerFromTree(backend)
  const callerId = callerSessionId()
  const verifiedCaller = await callerHoldsIdentity(callerId) ? callerId : undefined
  const parentRow = verifiedCaller ? (await readRegistry()).find(r => r.id === verifiedCaller) : undefined
  if (!cmd.task && !parentRow?.taskId) { console.error('batch needs --task or a verified parent filed on a task.'); return 1 }
  const PENDING_ID = 't-pending-batch'
  const liveIds = await liveIdsOf(backend)
  const planAll = async (taskRef: string, pending: boolean): Promise<Array<Extract<FilingPlan, { ok: true }>> | Extract<FilingPlan, { ok: false }>> => {
    const plans: Array<Extract<FilingPlan, { ok: true }>> = []
    for (const spec of cmd.specs) {
      const p = await planSpawnFilingSafe({
        liveIds,
        role: spawnRole({ leaderPrefix: !!spec.name && hasRolePrefix(spec.name), hasParent: !!callerId }),
        taskRef, subtaskRef: cmd.subtask, folderRef: spec.folder, cwd: spec.cwd, sharedCwd: cmd.sharedCwd,
        callerSessionId: verifiedCaller, harness: spec.harness,
        // Earlier specs of this batch already occupy their directories.
        extraLiveCwds: plans.map(x => x.cwd),
        ...(pending ? { pendingTask: { id: PENDING_ID, title: cmd.task } } : {}),
      })
      if (!p.ok) {
        const display = (text: string) => text.split(PENDING_ID).join(`"${cmd.task}" (new)`)
        return pending ? { ...p, detail: display(p.detail), ...(p.candidates ? { candidates: p.candidates.map(display) } : {}) } : p
      }
      plans.push(p)
    }
    return plans
  }
  let plans = await planAll(cmd.taskId ?? cmd.task, false)
  const createByTitle = !Array.isArray(plans) && plans.code === 'no_such_task' && !cmd.taskId && !/^t-[0-9a-z]+$/.test(cmd.task)
  if (createByTitle) plans = await planAll(PENDING_ID, true)
  if (!Array.isArray(plans)) { reportFilingRefusal(plans, cmd.json ?? false); return 1 }

  // The memory GATE, for the WHOLE batch — `requested` is every session it asks for, and a batch
  // is admitted or refused as a UNIT (see `spawn-admission.ts`'s docstring on `fits`: half a batch
  // is a plan nobody approved). Refused BEFORE the task book is even touched, so a refused batch
  // creates no task, no attempt, and spawns nothing.
  if (reportAdmission(
    await admitOrWait(cmd.specs.length, cmd.force ?? false, lang, cmd.json ?? false),
    lang, cmd.json ?? false,
  )) return 1

  // The task book, resolved BEFORE the first spawn: the ids are stamped on the rows, and a row
  // started before its task existed would carry a name and no id — the unattributed case
  // `task-rollup.ts` has to report as a hole. Best effort: a book that cannot be written costs the
  // ids, never the sessions.
  const resolved = await resolveTaskAndAttempts(cmd, createByTitle ? undefined : plans[0]?.taskId).catch(() => null)
  if (createByTitle) {
    if (!resolved) { console.error('Not started — the task could not be created on the board.'); return 1 }
    // The plans were made against the stand-in: stamp the real id.
    plans = plans.map(p => ({ ...p, taskId: resolved.taskId }))
  }
  const parentLink = await parentLinkOf(callerSessionId(), { followHandoff: true })
  const parentSessionId = parentLink.parentSessionId
  const parentVerified = await callerHoldsIdentity(callerSessionId())
  const away = await resolveSpawnAwayFor(cmd.away, parentSessionId, parentVerified)
  // PLAN.ACCOUNTS D3 — read once for the whole batch; each session WITHOUT `account` takes the
  // router's pick for its harness, which is never an account that is off for agents.
  const agentCaller = await callerHoldsIdentity(callerId)
  const accountContext = await spawnAccountContext([...new Set(cmd.specs.filter(sp => !sp.account).map(sp => sp.harness))])

  const filingJsons: Array<ReturnType<typeof filingJson>> = []
  for (const [index, spec] of cmd.specs.entries()) {
    const filing = plans[index]!
    for (const w of filing.warnings) if (w !== 'no_folder') console.error(WARNING_TEXT[w])
    const cwd = filing.cwd
    const id = newSessionId()
    const offeredConversationId = randomUUID()
    const logFile = managedProcessLogPath(spec.harness, id, AGENTISTICS_DATA_DIR)
    const batchRole = spec.name && hasRolePrefix(spec.name) ? 'leader' as const : parentSessionId ? 'worker' as const : undefined
    const role = batchRole ? await ensureSpawnRole([offeredConversationId, id], batchRole, undefined, await spawnRoleOriginFor(parentSessionId, parentVerified)) : undefined
    const ctx = buildSpawnContext({ ...(await resolveContextAway(away)), sessionId: id, cwd, harness: spec.harness, lang, ...(await folderCtxFor(filing.folderId)), ...(await resolveContextParent(parentSessionId)), ...(role ? { role } : await resolveContextRole(id, offeredConversationId)), ...(await resolveContextTask(filing.taskId, filing.subtaskId, cmd.task)) })
    const account = decideSpawnAccount({
      harness: spec.harness, ...(spec.account ? { requested: spec.account } : {}), agentCaller, context: accountContext,
    })
    if (!account.ok) { failed.push({ harness: spec.harness, reason: spawnAccountMessage(account.reason, account.detail, lang === 'pt' ? 'pt' : 'en') }); continue }
    const planned = planSpawn({
      harness: spec.harness,
      cwd,
      ...(logFile ? { logFile } : {}),
      context: ctx,
      ...((spec.mode ?? parentRow?.mode) ? { mode: spec.mode ?? parentRow?.mode } : {}),
      ...(spec.prompt ? { prompt: spec.prompt } : {}),
      ...(spec.model ? { model: spec.model } : {}),
      ...(spec.effort ? { effort: spec.effort } : {}),
      conversationId: offeredConversationId,
      ...(account.account?.root ? { account: { root: account.account.root } } : {}),
    }, await spawnCapabilities(spec.harness))
    if (!planned.ok) { failed.push({ harness: spec.harness, reason: explainPlanError(planned.error) }); continue }

    // Stamped BEFORE the process is launched, not after it has been checked for a crash.
    //
    // `planFirstSightingClaims` asks whether a conversation began AFTER we spawned, and this is the
    // only timestamp it has. `spawnFailure` deliberately WAITS to see whether the child dies, so a
    // record stamped after it is seconds late — measured 2026-09-08: a kimi session whose own store
    // record began at 13:58:50.831 was recorded as spawned at 13:58:52.914, so its conversation
    // failed the `startedMs > spawnedMs` test and that row stayed unlinked, with an empty chat view,
    // for good. The moment we launched is the moment the claim means; the moment we finished
    // checking is not.
    const spawnedAt = new Date().toISOString()
    // Row first, pane second (same reason as `start`); removed again if the spawn fails.
    await addSession({
      id,
      harness: spec.harness,
      cwd,
      createdAt: spawnedAt,
      // Stamped at SPAWN — the one moment the association is a fact. See `ManagedSession.taskId`.
      ...filingRow(filing, cmd.task),
      // TEAM LINK (`team-links.ts`): a session named as a leader is born at the root.
      ...spawnParentLink(role, {
        ...(parentSessionId ? { parentSessionId } : {}),
        ...(parentLink.parentConversationId ? { parentConversationId: parentLink.parentConversationId } : {}),
      }),
      ...(away ? { away: true } : {}),
      ...(pendingContextFor(planned.plan, ctx) ? { pendingContext: pendingContextFor(planned.plan, ctx)! } : {}),
      ...(spec.attempt && resolved?.attempts.get(spec.attempt)
        ? { attemptId: resolved.attempts.get(spec.attempt)! }
        : {}),
      ...((spec.mode ?? parentRow?.mode) ? { mode: spec.mode ?? parentRow?.mode } : {}),
      ...(spec.model ? { model: spec.model } : {}),
      ...(spec.effort ? { effort: spec.effort } : {}),
      ...(spec.name ? { label: spec.name } : {}),
      ...(account.account ? { accountId: account.account.id } : {}),
      ...(planned.plan.conversationId
        ? { conversationId: planned.plan.conversationId, conversationLink: 'assigned' as const, conversationLinkVia: 'assigned-id' as const }
        : {}),
      ...(await recordedRepo(cwd)),
    })
    const filingConfiguration = await configureSpawn({ taskId: filing.taskId, subtaskId: filing.subtaskId }, { id, conversationId: planned.plan.conversationId })
    if (!filingConfiguration.ready) {
      await removeSession(id)
      failed.push({ harness: spec.harness, reason: `Not started: board filing pending (${filingConfiguration.pending.map(p => p.reason).join('; ')})` })
      continue
    }
    await writeContextFile(planned.plan)
    try {
      if (logFile) await mkdir(dirname(logFile), { recursive: true, mode: 0o700 })
      await backend.spawn({
        id, cwd, argv: planned.plan.argv,
        ...(planned.plan.env ? { env: planned.plan.env } : {}),
        ...spawnPromptArg(planned.plan, spec.harness),
        structured: structuredIntentOf({ harness: spec.harness, origin: 'background', prompt: spec.prompt, mode: spec.mode ?? parentRow?.mode }, { model: spec.model, effort: spec.effort, ctx, conversationId: offeredConversationId, mcp: { ...agentisticsMcpLaunch(), env: { AGENTISTICS_API: `http://localhost:${PORT}` } } }),
        ...(planned.plan.modeNeedsProtocol ? { modeNeedsProtocol: planned.plan.modeNeedsProtocol } : {}),
      })
    } catch (e) {
      await removeSession(id).catch(() => {})
      failed.push({ harness: spec.harness, reason: e instanceof Error ? e.message : String(e) })
      continue
    }
    // Same check as `start`: a harness that refused its arguments is already gone, and a batch that
    // reports N started when N exited is worse than one that reports the refusal — the whole point
    // of a batch is that nobody is watching each one come up.
    const died = await spawnFailure(backend, id, planned.plan.argv[0], spec.harness)
    if (died) {
      failed.push({ harness: spec.harness, reason: died })
      await backend.kill(id).catch(() => {})
      await removeSession(id).catch(() => {})
      continue
    }
    if (role) await markRoleDelivered([planned.plan.conversationId, id], role)
    if (spec.notify === 'off') await muteAtSpawn(planned.plan.conversationId ?? id).catch(() => {})
    const configuration = await configureSpawn(filing, { id, conversationId: planned.plan.conversationId })
    if (!configuration.ready) {
      failed.push({ harness: spec.harness, reason: configurationPendingMessage(id, configuration) })
      console.error(configurationPendingMessage(id, configuration))
    }
    filingJsons.push({ ...filingJson(filing), configuration } as ReturnType<typeof filingJson>)
    const liveBackend = await backend.list().catch(() => null)
    const backendIds = liveBackend ? new Set(liveBackend.map(b => b.id)) : null
    await retireFallenSessions({
      newSessionId: id,
      conversationId: planned.plan.conversationId,
      cwd,
      harness: spec.harness,
      backendIds,
    })
    started.push({ id, harness: spec.harness, cwd, filing: filingJsons[filingJsons.length - 1]! })
  }

  if (cmd.json) {
    console.log(JSON.stringify({ task: cmd.task, started, failed }, null, 2))
  } else {
    for (const st of started) console.log(`${st.id}\t${st.harness}\t${st.cwd}`)
    for (const f of failed) console.error(`failed\t${f.harness}\t${f.reason}`)
    console.log(`\n${started.length} started under task "${cmd.task}"${failed.length ? `, ${failed.length} failed` : ''}.`)
    if (started.length > 0) console.log(`Attach to any with: agentop session attach <id>`)
  }
  return failed.length > 0 ? 1 : 0
}

/** `agentop session open "<task>"` — reopen every session of a task, detached. */
async function openTask(task: string, json: boolean, force: boolean, backend: SessionBackend, folder?: string): Promise<number> {
  const wanted = (await readRegistry()).filter(m => m.task === task)
  if (wanted.length === 0) {
    console.error(`No sessions are filed under "${task}".`)
    return 1
  }
  const conversations = await loadConversations()
  // A backend that cannot be listed is not one with nothing running — reading it as empty would
  // reopen a second assistant into every live session of the task (2026-10-03).
  const listed = await backend.list().catch(() => null)
  if (!listed) {
    console.error('Could not list the running sessions (tmux did not answer); nothing was reopened. Try again in a moment.')
    return 1
  }
  const live = new Set(listed.filter(b => b.alive).map(b => b.id))
  // What is already being driven, so this cannot put a second assistant into a conversation that has
  // one. `live` above cannot answer it: it is keyed by ROW, and the twin case is a row that is down
  // while a DIFFERENT row drives its conversation. Same collector the cockpit's verb uses.
  const inUse = await liveConversationHolders(backend)
  // Claimed within this batch too. The cockpit's copy of this loop has had this set for a while and
  // this one never did, so `conversationForProcess` — which matches on harness and directory, and
  // therefore answers with the FIRST conversation of a repository — handed the same one to every row
  // of a task filed in that repository. The drift `planTaskReopen` was extracted to end, met again
  // one layer out.
  const taken = new Set<string>()
  // A row that knows its conversation reopens it from that exact link even when the store does not
  // hold it — see `reopen-target.ts`.
  const onDisk = await exactLinksOnDisk(wanted, conversations)
  // The DECISION is the pure `planTaskReopen`, shared with the cockpit's verb. The two used to be
  // separate implementations and had drifted: only one retired the row it replaced, so the same
  // gesture left a different registry depending on where you pressed it.
  const plan = planTaskReopen({
    entries: wanted,
    liveIds: live,
    inUse,
    conversationFor: m => reopenTargetFor({ entry: m, pool: conversations, onDisk, taken }),
  })

  // The memory GATE, for the WHOLE reopen — `requested` is only `plan.reopen`, the rows this call
  // would actually SPAWN, never `plan.already` or `plan.heldElsewhere`, which cost nothing (nothing
  // new starts for them). Skipped entirely when there is nothing left to start: `admitSpawn` treats
  // a `requested` of zero as a caller bug, not as "nothing to admit", and a task that is already
  // fully running has no business being refused for memory it does not need.
  if (plan.reopen.length > 0) {
    const lang = await resolveLang()
    if (reportAdmission(
      await admitOrWait(plan.reopen.length, force, lang, json), lang, json,
    )) return 1
  }

  const started: string[] = []
  const configurations: Array<{ id: string; configuration: Awaited<ReturnType<typeof configureSpawn>> }> = []
  const skipped: string[] = [...plan.skipped]
  // A verified agent may not reopen a row whose account is off for agents (the owner still may).
  const agentCaller = plan.reopen.length > 0 && await callerHoldsIdentity(callerSessionId())

  for (const row of plan.reopen) {
    await withConversationResumeLock(row.resumeId, async () => {
      const holder = conversationHeldBy(await liveConversationHolders(backend), row.resumeId)
      if (holder) { plan.heldElsewhere.push({ id: row.entry.id, holder }); return }
      const m = row.entry
      const cwdPlan = await planReopenCwd(m, { liveIds: await liveIdsOf(backend) })
      if (!cwdPlan.ok) { console.error(`${m.id}: ${refusalText(cwdPlan)}`); skipped.push(m.id); return }
      const id = newSessionId()
      const logFile = managedProcessLogPath(m.harness, id, AGENTISTICS_DATA_DIR)
      // PLAN.ACCOUNTS D3 — the row's own account, in its own root; a removed account refuses in words.
      const account = await recordedSpawnAccount(m.accountId, { agentCaller, harness: m.harness })
      if (!account.ok) { console.error(`${m.id}: ${spawnAccountMessage(account.reason, account.detail, 'en', true)}`); skipped.push(m.id); return }
      const planned = planSpawn({ harness: m.harness, cwd: m.cwd, resumeId: row.resumeId, ...(logFile ? { logFile } : {}), ...inheritedLaunch(m, m.harness), ...(account.account?.root ? { account: { root: account.account.root } } : {}) }, await spawnCapabilities(m.harness))
      if (!planned.ok) { skipped.push(m.id); return }
      await addSession({
        id, harness: m.harness, cwd: m.cwd, createdAt: new Date().toISOString(), task,
        // INHERITED from the row being replaced, never taken from the request: a reopened session is
        // the same piece of work, and the attribution (taskId, subtaskId, attemptId) says so. See `inheritedIdentity`.
        ...inheritedIdentity(m),
        ...inheritedLaunch(m, m.harness),
        label: row.label,
        // The conversation is known EXACTLY here — we just handed its id to the CLI. The cockpit's
        // reopen verb has recorded it since it was written; this path had not, so the same gesture
        // left a row that knew which conversation it drove or one that did not, depending on where it
        // was pressed. `planTaskReopen` exists to stop precisely that kind of drift.
        ...(planned.plan.conversationId
          ? { conversationId: planned.plan.conversationId, conversationLink: 'assigned' as const, conversationLinkVia: 'resumed-id' as const }
          : {}),
        // The REPLACEMENT re-measures rather than copying `m.repo`: a reopen is the moment to notice
        // that the worktree came back, and copying a recorded value would carry one stale answer
        // through every session ever reopened from it.
        ...(await recordedRepo(m.cwd)),
    })
    try {
      if (logFile) await mkdir(dirname(logFile), { recursive: true, mode: 0o700 })
      await backend.spawn({ id, cwd: m.cwd, argv: planned.plan.argv, ...(planned.plan.env ? { env: planned.plan.env } : {}),
        structured: structuredIntentOf({ harness: m.harness, origin: 'background', resumeId: row.resumeId, mode: m.mode }, { ...inheritedLaunch(m, m.harness), mcp: { ...agentisticsMcpLaunch(), env: { AGENTISTICS_API: `http://localhost:${PORT}` } } }),
        ...(planned.plan.modeNeedsProtocol ? { modeNeedsProtocol: planned.plan.modeNeedsProtocol } : {}),
      })
    } catch { await removeSession(id); skipped.push(m.id); return }
    // The path the report came from. Claude refuses to resume a conversation that is already open
    // as a background agent, and the refusal is instant — so this reopen wrote a row for a process
    // that no longer existed, and pressing it again wrote another. The old row must NOT be retired
    // either: retiring it on a reopen that failed would lose the only row that still names the work.
    const died = await spawnFailure(backend, id, planned.plan.argv[0])
    if (died) {
      skipped.push(m.id)
      await backend.kill(id).catch(() => {})
      await removeSession(id)
      return
    }
    await rekeyStoredRole(
      [m.id, m.conversationId],
      [id, planned.plan.conversationId],
    )
    await deliverStoredRole(id, planned.plan.conversationId).catch(() => false)
    // The old row is RETIRED, not deleted: it is still a thing that happened, and it stops standing
    // beside its own continuation with the same name on it.
    await patchSession(m.id, { endedAt: new Date().toISOString() })
    const configuration = await configureSpawn({ folderId: folder ? folderByRef.get(folder)?.id : undefined }, { id, conversationId: planned.plan.conversationId })
    configurations.push({ id, configuration })
    if (!configuration.ready) console.error(configurationPendingMessage(id, configuration))
    if (!folder && !warnedNoFolder) await warnLeaderNoFolder()
    started.push(id)
    })
  }

  if (json) {
    console.log(JSON.stringify({
      task, started, skipped, configurations, already: plan.already,
      // Each one NAMES the session that already has the conversation, because a machine reader is
      // exactly who needs to be told where the work is rather than that something did not happen.
      heldElsewhere: plan.heldElsewhere.map(h => ({ id: h.id, heldBy: h.holder.id, label: h.holder.label })),
    }, null, 2))
  } else {
    for (const id of started) console.log(id)
    // Reported, never silent: a partial reopen presented as a success leaves someone believing they
    // have their whole task back.
    for (const h of plan.heldElsewhere) {
      console.log(`${h.id}\talready open in ${h.holder.label}`)
    }
    const alreadyUp = plan.already.length ? `, ${plan.already.length} already running` : ''
    const held = plan.heldElsewhere.length ? `, ${plan.heldElsewhere.length} already open elsewhere` : ''
    console.log(`\n${started.length} reopened${skipped.length ? `, ${skipped.length} could not be` : ''}${alreadyUp}${held}.`)
  }
  return taskReopenSucceeded(plan, started.length) && configurations.every(c => c.configuration.ready) ? 0 : 1
}

/** The fleet as DATA, so an assistant orchestrating sessions reads it rather than parsing a table
 *  meant for a person. One shape for every command that offers `--json`: `ls` prints exactly what
 *  `list` prints, because a second machine-readable format is a second thing to keep in step. */
function fleetJson(snap: SessionSnapshot): unknown {
  return {
    sessions: snap.sessions.map(v => ({
      id: v.id,
      status: v.status,
      activity: v.activity ?? null,
      harness: v.harness ?? null,
      cwd: v.cwd,
      label: v.label ?? null,
      task: v.task ?? null,
      resumeId: v.resume?.sessionId ?? null,
      // The RECORDED conversation, kept apart from `resumeId` above rather than folded into it.
      // They answer different questions: this one is what the row provably drives, that one is a
      // target the reopen verb OFFERS and will fall back to a harness-and-directory guess for. A
      // caller reading one field could not tell which of the two it had been given.
      conversationId: v.conversationId ?? null,
    })),
    attention: snap.attention,
    unavailable: snap.unavailable ?? null,
  }
}

/**
 * The whole fleet, from the registry, the backend, `/proc`, the conversation store and what each
 * harness records about its own sessions.
 *
 * It reads the SAME sources the cockpit's poller does, and that is the point rather than a detail:
 * `session ls` is the cockpit's table printed, so a source wired into one and not the other is how
 * one session ends up wearing two different names depending on where you look at it. It was missing
 * `loadHarnessSessions` for exactly one commit, and the row a user had renamed inside the session
 * read correctly in the cockpit and stale on the command line.
 *
 * There is deliberately NO heartbeat here: a one-shot command must not stamp `lastSeenMs`. It runs
 * once and exits, so a run that happened to be the last thing before a reboot would be indistinguish-
 * able from a fleet that was alive — and `crash-group.ts` would be reading a write nobody made a
 * claim with.
 */
/**
 * How long between the two confirming polls a one-shot command makes. Long enough for a working
 * session's screen to have moved (or a quiet one to have stayed still) — tmux's activity clock has
 * one-second resolution — short enough not to be felt on the command line.
 */
const CONFIRM_POLL_GAP_MS = 700

async function pollFleet(backend: SessionBackend): Promise<SessionSnapshot> {
  /*
   * THE RUNNING SERVER'S POLLER FIRST — it is the one with MEMORY.
   *
   * The two-poll seeding below is the best a one-shot command can do ALONE, and it is not enough:
   * `working` is movement, and two frames 700 ms apart can be identical while the assistant is
   * between tokens. Measured against a live machine, `agentop session ls` reported ZERO sessions
   * running while the server's own fleet reported four — which is exactly "aqui aparecem 4 e no
   * agentop só 3", in its worst form.
   *
   * `null` means no server is running, and then the seeding below is still the right answer.
   */
  const shared = isServerProcess()
    ? null
    : await readServerSnapshot<SessionSnapshot>(await resolveLang())
  if (shared) return shared

  const poller = createSessionsPoller({
    backend, readRegistry, scanProcesses, loadConversations, loadHarnessSessions,
    findExactLinks: exactLinksOnDisk,
  })
  // Poll TWICE, and return the second. The cockpit debounces the noisy per-frame reading by
  // confirming a `waiting` state across two polls (`attention-confirm.ts`), but a one-shot command
  // has no memory of a previous poll — so a single reading cannot be confirmed and a lone quiet
  // frame (a finished sub-turn, a repaint) would be reported as "waiting on you" for a session that
  // is still working. The first poll seeds the poller's confirmation memory; the second returns the
  // confirmed reading, so `session ls`/`list` agrees with the cockpit and the event channel instead
  // of reviving the exact false positive on the command line.
  await poller.poll()
  await new Promise(r => setTimeout(r, CONFIRM_POLL_GAP_MS))
  return await poller.poll()
}

/**
 * `agentop session ls` — the cockpit's sessions table, printed once.
 *
 * Everything about what a row IS comes from the same modules the Sessions tab uses: `pollFleet`
 * gathers the fleet, `toControlSession` maps it, `renderSessionTable` draws it. What is decided here
 * is what a COMMAND LINE has to decide — which rows the question is about (what is running, unless
 * `--all`), how wide the output may be, and whether anything is going to a terminal at all.
 */
async function ls(
  cmd: Extract<SessionCommand, { kind: 'ls' }>,
  backend: SessionBackend,
): Promise<number> {
  const snap = await pollFleet(backend)
  if (cmd.json) { console.log(JSON.stringify(await withNativeJson(fleetJson(snap)), null, 2)); return 0 }

  const lang = await resolveLang()
  const s = cliStrings(lang)
  // The TABLE's own chrome — its column headings and the words an empty grouping key wears — is the
  // control center's, because it is the control center's table. Two copies of "usage" and "no task"
  // are two places for them to disagree about what a column is called.
  const c = controlStrings(lang)

  // Said BEFORE the table: an unavailable backend has not established that nothing is running, and
  // the rows below may be a previous poll rather than a fresh one.
  if (snap.unavailable) console.error(snap.unavailable)

  // Resolved per session and memoized by directory — the same read the cockpit does, and what makes
  // three worktrees of one repository group under the project rather than under three names.
  const facts = await Promise.all(snap.sessions.map(v => repoFacts(v.cwd, v.recordedRepo)))
  // A preferences file that cannot be read costs the "finished" mark on a task heading, never the
  // table: the fleet is what the command is for.
  const finishedTasks = await readPreferences().then(p => p.finishedTasks ?? []).catch(() => [])
  // NATIVE.LIFE: the engine's own sessions are rows of the same table (`native-fleet.ts`).
  const fleet = [...snap.sessions.map((v, i) => toControlSession(v, s, facts[i])), ...await loadNativeFleet(lang)]
  // `sessionRunning` rather than a state list of our own: an EXTERNAL row is running — it exists
  // because `/proc` found a live assistant — and what cannot be read there is its activity, never
  // whether it is alive.
  const shown = cmd.all ? fleet : fleet.filter(sessionRunning)

  const tty = process.stdout.isTTY === true
  // `--width`, then the terminal, then `COLUMNS`, then the natural width — the precedence is
  // `resolveWidth`'s, so it is stated and tested in one place. `columns` is passed ONLY on a tty:
  // off one it is undefined anyway, and asking for it would make the fallback depend on a value
  // that cannot exist.
  const width = resolveWidth({
    ...(cmd.width !== undefined ? { explicit: cmd.width } : {}),
    ...(tty && process.stdout.columns ? { columns: process.stdout.columns } : {}),
    ...(process.env.COLUMNS !== undefined ? { env: process.env.COLUMNS } : {}),
  })
  const color = cmd.color ?? (tty && !process.env.NO_COLOR)
  // Every SENTENCE this command prints is wrapped, never truncated: they name sessions and flags,
  // and a cut one hides the very thing it exists to say. Through the app's own `wrapText`, and a
  // no-op at a pipe's natural width — where one long line is what `grep` wants.
  const say = (text: string) => { for (const l of wrapText(text, width)) console.log(l) }

  // A mute blank is indistinguishable from a broken command, so an empty list says which of the
  // three things happened. The decision is pure; only the sentence is chosen here.
  const empty = emptyReason({
    fleet: fleet.length,
    shown: shown.length,
    ...(snap.unavailable ? { unavailable: snap.unavailable } : {}),
  })
  if (empty !== null) {
    // `unavailable` was already printed above, and it is the whole explanation.
    if (empty === 'empty') say(s.sessLs.none)
    else if (empty === 'filtered') say(s.sessLs.noneRunning(fleet.length))
    return empty === 'unavailable' ? 1 : 0
  }

  for (const line of renderSessionTable({
    sessions: shown,
    width,
    grouping: cmd.group,
    color,
    doneTasks: finishedTasks,
    strings: {
      cols: c.sessionsCols,
      words: sessionWordBook(c),
      closed: c.sessionsClosedWord,
      done: c.sessionsDoneWord,
    },
  })) console.log(line)

  const waiting = shown.filter(v => v.state === 'waiting' || v.state === 'waiting-approval')
  if (waiting.length > 0) {
    console.log('')
    say(s.sessLs.waiting(waiting.length, waiting.map(v => v.title).join(', ')))
  }

  // A harness with no probed rules cannot tell a permission prompt from an ordinary pause. Saying so
  // is the difference between a gap and a wrong answer — and `approvalBlind` is set only on the rows
  // that can lack it, so a closed conversation never names a harness that is in fact probed.
  const blind = [...new Set(shown.filter(v => v.approvalBlind).map(v => v.harness))]
  if (blind.length > 0) say(s.sessLs.blind(blind.join(', ')))
  return 0
}

async function list(backend: SessionBackend, json = false): Promise<number> {
  const snap = await pollFleet(backend)

  if (json) {
    console.log(JSON.stringify(await withNativeJson(fleetJson(snap)), null, 2))
    return 0
  }

  const native = await loadNativeFleet(await resolveLang())
  if (snap.unavailable) console.error(snap.unavailable)
  // The native sessions are the engine's; tab-separated in the same five columns, so a script reading
  // `list` needs no second parser. Printed first because the managed list below may be empty.
  for (const n of native) console.log(`${n.id}\t${n.stateLabel}\t${n.harness}\t${n.named ? n.title : ''}\t${n.cwd}`)
  if (snap.sessions.length === 0) {
    if (native.length > 0) return 0
    // Only claim "nothing is running" when the poll actually succeeded — an unavailable backend has
    // not established that, and saying so would be a confident zero.
    if (!snap.unavailable) console.log('No sessions.')
    return snap.unavailable ? 1 : 0
  }

  for (const v of snap.sessions) {
    const id = v.status === 'external' ? '-' : v.id
    // `?` rather than a guessed harness: an unregistered session's harness is genuinely unrecorded.
    console.log(`${id}\t${stateWord(v)}\t${v.harness ?? '?'}\t${v.label ?? ''}\t${v.cwd}`)
  }

  const waiting = snap.sessions.filter(v => needsAttention(v.activity))
  if (waiting.length > 0) {
    console.log(`\n${waiting.length} session(s) waiting on you: ${waiting.map(v => v.label ?? v.id).join(', ')}`)
  }

  // A harness with no probed rules cannot distinguish a permission prompt from an ordinary pause.
  // Saying so is the difference between a gap and a wrong answer.
  // Only rows we actually HOST can have their approval detected, so only they can lack it. A closed
  // conversation and a foreign process have no screen to read at all — including them here named
  // claude, kimi and codex as undetectable when all three are probed.
  const blind = [...new Set(
    snap.sessions
      .filter(v => v.status !== 'external' && v.status !== 'closed' && !v.approvalDetection)
      .map(v => v.harness)
      .filter((h): h is NonNullable<typeof h> => h !== undefined),
  )]
  if (blind.length > 0) {
    console.log(`Approval detection is not available for: ${blind.join(', ')} — those sessions show as "waiting" either way.`)
  }
  return 0
}

/** The `--json` fleet plus the native sessions, as their own key so an existing reader is untouched. */
async function withNativeJson(json: unknown): Promise<unknown> {
  const native = await loadNativeFleet(await resolveLang())
  return native.length > 0
    ? { ...(json as object), native: native.map(n => ({ id: n.id, harness: n.harness, state: n.state, title: n.title, cwd: n.cwd, model: n.model ?? null })) }
    : json
}

async function attach(ref: string, backend: SessionBackend): Promise<number> {
  const reconciled = reconcileSessions(await readRegistry(), await backend.list())
  const found = resolveSessionRef(reconciled.map(toRefCandidate), ref)
  if (found.ok) return execAttach(found.session.id, backend)

  // Not a row agentop hosts — but it may be a conversation that is RUNNING somewhere, and the user
  // asked to get into it. This is the case the product had no answer for: it refused with "open it
  // where it already is", which names a place that for a background agent does not exist.
  //
  // The answer is to CLOSE the assistant holding it and reopen the conversation here. The lock
  // exists to stop two assistants in one conversation, and closing the first satisfies it exactly;
  // refusing satisfies it by leaving the user with none. The decision is the pure `planTakeover` —
  // it checks that the harness can resume by id BEFORE anything is killed.
  const took = await takeOver(ref, backend)
  if (took !== null) return took

  console.error(refError(ref, found.reason, found.matches))
  return 1
}

/**
 * Close whatever is holding a live conversation and reopen it under agentop.
 *
 * `null` when `ref` names no live conversation — the caller then reports the ordinary lookup error.
 *
 * Not claude-specific: the two steps are the same everywhere, and `planSpawn` already knows which
 * harnesses can resume by id at all. Today only claude publishes a live-session list to search
 * (`claude agents --json`); the day another does, it joins the search and nothing else changes.
 *
 * **Deliberately NOT gated by the memory check.** This is a takeover, not a net-new spawn: the
 * holder process is killed (below) before the replacement is started, so the machine never carries
 * both at once and the memory cost is zero, not +1. Gating it would refuse a swap that frees the
 * exact memory it would need.
 */
async function takeOver(ref: string, backend: SessionBackend): Promise<number | null> {
  const live = await liveAgentFor(ref)
  if (!live) return null

  const result = await withConversationResumeLock(live.sessionId, async () => {
    const holder = conversationHeldBy(await liveConversationHolders(backend), live.sessionId)
    if (holder?.kind === 'managed') return { attach: holder.id }
    const id = newSessionId()
    const logFile = managedProcessLogPath(live.harness, id, AGENTISTICS_DATA_DIR)
    // PLAN.ACCOUNTS D3 — a conversation agentop ran before keeps that row's account (and its root);
    // one it never ran has no record and reopens in the default root, as before. Decided BEFORE the
    // holder is closed: a removed account must refuse while the user still has their assistant.
    const previous = newestRowOfConversation(await readRegistry(), live.sessionId)
    const account = await recordedSpawnAccount(previous?.accountId, { agentCaller: await callerHoldsIdentity(callerSessionId()), harness: live.harness })
    if (!account.ok) { console.error(spawnAccountMessage(account.reason, account.detail, 'en', true)); return 1 }
    const planned = planSpawn({ harness: live.harness, cwd: live.cwd, resumeId: live.sessionId, ...inheritedLaunch(previous, live.harness), ...(logFile ? { logFile } : {}), ...(account.account?.root ? { account: { root: account.account.root } } : {}) }, await spawnCapabilities(live.harness))
    if (planned.ok && planned.plan.modeNeedsProtocol) { console.error(`Cannot reopen ${live.sessionId}: terminal cannot apply ${planned.plan.modeNeedsProtocol} approval mode`); return 1 }
    const plan = planTakeover({
      conversationId: live.sessionId,
      harness: live.harness,
      resumable: planned.ok,
      holder: { pid: live.pid, cwd: live.cwd, label: live.name },
      cwd: live.cwd,
    })

    if (plan.kind === 'refuse') {
      console.error(explainTakeover(plan.reason))
      return 1
    }
    if (plan.kind === 'free' || !planned.ok) return null

    // Ending somebody's running assistant loses whatever it was mid-turn, so it is stated before it
    // happens rather than reported after.
    console.log(`Closing ${plan.holder.label ?? plan.conversationId.slice(0, 8)} (pid ${plan.holder.pid}) to reopen it here…`)
    try {
      process.kill(plan.holder.pid!, 'SIGTERM')
    } catch (e) {
      console.error(`Could not close it: ${e instanceof Error ? e.message : String(e)}`)
      return 1
    }
    // Wait for it to actually go. Resuming while the old one is still shutting down is the very race
    // the harness refuses on, and it would land as another dead row.
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 100))
      try { process.kill(plan.holder.pid!, 0) } catch { break }
    }

    try {
      if (logFile) await mkdir(dirname(logFile), { recursive: true, mode: 0o700 })
      await backend.spawn({ id, cwd: plan.cwd, argv: planned.plan.argv, ...(planned.plan.env ? { env: planned.plan.env } : {}),
        structured: structuredIntentOf({ harness: live.harness, origin: 'terminal', resumeId: live.sessionId, mode: previous?.mode }, { ...inheritedLaunch(previous, live.harness), mcp: { ...agentisticsMcpLaunch(), env: { AGENTISTICS_API: `http://localhost:${PORT}` } } }),
      })
    } catch (e) {
      console.error(`Closed it, but could not reopen: ${e instanceof Error ? e.message : String(e)}`)
      return 1
    }
    const died = await spawnFailure(backend, id, planned.plan.argv[0])
    if (died) { console.error(died); await backend.kill(id).catch(() => {}); return 1 }

    // The newest row of this conversation is the one being continued: its filing and name come
    // along, and the live harness name (if any) still wins for the label.
    const record: ManagedSession = {
      id, harness: live.harness, cwd: plan.cwd, createdAt: new Date().toISOString(),
      ...inheritedIdentity(previous),
      ...inheritedLaunch(previous, live.harness),
      ...(live.name ? { label: live.name, labelSince: Date.now() } : {}),
      conversationId: plan.conversationId,
      ...(await recordedRepo(plan.cwd)),
    }
    // The write is READ BACK, and that is not belt-and-braces — it is the failure this path actually
    // had. `registry.ts` serialises writes within ONE process; agentop runs as several (the cockpit,
    // the daemon, every one-shot command), all read-modify-writing the same file. A record added here
    // was observed erased by a longer-lived process that had read the file just before, and the
    // session it lost was the one the user was about to sit in: running, unregistered, and beyond
    // every verb the cockpit offers. One retry closes the ordinary interleaving; a loss that survives
    // it is SAID rather than left for the user to discover when a rename stops working.
    // Retired like every other reopen: it stops standing beside its own continuation.
    if (previous && !previous.endedAt) await patchSession(previous.id, { endedAt: new Date().toISOString() })
    if (!await addVerified(record)) {
      console.error(
        `${id} is running but its registry record could not be kept — another agentop process is `
        + 'writing the same registry. The cockpit will take it back on its next poll; if it does not, '
        + `run \`agentop session attach ${id}\` again.`,
      )
    }
    await deliverStoredRole(id, plan.conversationId).catch(() => false)
    return { attach: id }
  })
  // Attaching can last for hours; the claim only covers the check, spawn and registry write.
  return result !== null && typeof result === 'object' ? execAttach(result.attach, backend) : result
}

/**
 * Add a session and confirm it survived. `false` when it did not, after one retry.
 *
 * Deliberately not inside `registry.ts`: the retry is a statement about CONCURRENCY between
 * processes, and the registry module's own contract ("one in-process writer") is honest about not
 * covering that. Hiding a cross-process retry inside `add` would make every caller believe a
 * guarantee that still does not exist.
 */
async function addVerified(record: ManagedSession): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    await addSession(record)
    if ((await readRegistry()).some(s => s.id === record.id)) return true
  }
  return false
}

/** Already-localized refusal — the harness's limitation said in words, never a silent no-op. */
function explainTakeover(reason: TakeoverRefusal): string {
  switch (reason.code) {
    case 'resume-unsupported':
      return `${reason.harness} cannot reopen a conversation by id, so the assistant holding it was left alone.`
    case 'holder-unreachable':
      return `something is holding this conversation${reason.label ? ` (${reason.label})` : ''} and agentop cannot close it.`
    case 'no-cwd':
      return 'this conversation has no directory to reopen in — a removed worktree, most likely.'
  }
}

/**
 * The LIVE conversation matching what the user typed, when there is exactly one.
 *
 * Matched on a prefix of the conversation id or on the session's NAME, because those are the two
 * things on screen. Ambiguity resolves to nothing rather than to a guess: taking over the wrong
 * conversation closes the wrong assistant.
 */
async function liveAgentFor(ref: string): Promise<
  { sessionId: string; harness: HarnessId; cwd: string; pid?: number; name?: string } | null
> {
  try {
    const needle = ref.trim().toLowerCase()
    const hits = (await readHarnessAgents()).filter(a =>
      a.sessionId.toLowerCase().startsWith(needle)
      || (a.name ?? '').toLowerCase() === needle)
    const only = hits.length === 1 ? hits[0]! : undefined
    if (!only?.cwd) return null
    return {
      sessionId: only.sessionId,
      harness: 'claude',
      cwd: only.cwd,
      ...(only.pid !== undefined ? { pid: only.pid } : {}),
      ...(only.name ? { name: only.name } : {}),
    }
  } catch {
    return null
  }
}

/** CONTA.TROCA — the same host verb the browser's dialog calls (`account-switch-host.ts`). */
async function switchAccount(
  cmd: { ref: string; accountId?: string; harness?: string; resend?: boolean; json?: boolean },
  backend: SessionBackend,
): Promise<number> {
  const registry = await readRegistry()
  const reconciled = reconcileSessions(registry, await backend.list())
  const found = resolveSessionRef(reconciled.map(toRefCandidate), cmd.ref)
  if (!found.ok) { console.error(refError(cmd.ref, found.reason, found.matches)); return 1 }
  const { id } = found.session
  const lang = await resolveLang()
  if (!cmd.accountId) {
    const row = registry.find(r => r.id === id)
    const { listSwitchOptions } = await import('./account-switch-io')
    const all = row ? await listSwitchOptions({ harness: row.harness, ...(row.accountId ? { accountId: row.accountId } : {}), agentCaller: !!callerSessionId() }) : []
    // --harness narrows the list to one harness; without it every harness that can take the session is listed.
    const options = cmd.harness ? all.filter(o => o.harness === cmd.harness) : all
    if (cmd.json) { console.log(JSON.stringify({ options }, null, 2)); return 0 }
    if (!options.length) { console.log(lang === 'pt' ? 'Nenhuma outra conta disponível para esta sessão.' : 'No other account is available for this session.'); return 0 }
    for (const o of options) console.log(`${o.harness}\t${o.id}\t${o.label}${o.plan ? ` (${o.plan})` : ''}${o.recommended ? '\t*' : ''}`)
    return 0
  }
  const { hostForFleet } = await import('./fleet-web')
  const host = await hostForFleet(lang)
  if (!host.switchSessionAccount) { console.error('unavailable'); return 1 }
  const out = await host.switchSessionAccount({
    id, accountId: cmd.accountId, ...(cmd.harness ? { harness: cmd.harness } : {}), ...(cmd.resend ? { resendPending: true } : {}), ...(callerSessionId() ? { callerVerified: true } : {}),
  })
  if (cmd.json) console.log(JSON.stringify(out))
  else (out.ok ? console.log : console.error)(out.ok && out.id ? `${out.message} (${out.id})` : out.message)
  return out.ok ? 0 : 1
}

async function kill(ref: string, backend: SessionBackend, folder?: string): Promise<number> {
  const registry = await readRegistry()
  const reconciled = reconcileSessions(registry, await backend.list())
  const found = resolveSessionRef(reconciled.map(toRefCandidate), ref)
  if (!found.ok) { console.error(refError(ref, found.reason, found.matches)); return 1 }
  const { id } = found.session
  const statusBefore = reconciled.find(r => r.id === id)?.status
  // Killing the session this command runs INSIDE would cut its own tool call: it becomes a retire.
  const { killIsSelf, KILL_SELF_SENTENCE, retireCommand } = await import('./cli-retire')
  if (killIsSelf(id, callerSessionId())) {
    console.error(KILL_SELF_SENTENCE)
    const f = folder ? folderByRef.get(folder) : undefined
    return retireCommand({ ref: id, ...(f ? { folderId: f.id, folderPath: f.path } : {}), caller: id })
  }

  // HANDOFF.RELAY: a predecessor's last answer to the owner reaches its successor before it dies.
  const { flushBeforeKill } = await import('./handoff-relay-io')
  const flushed = await flushBeforeKill(id, async (to, text) => {
    const harness = registry.find(m => m.id === to)?.harness ?? ''
    return backend.sendTextReliable ? backend.sendTextReliable(to, text, harness) : backend.sendText(to, text)
  }, await resolveLang())
  if (flushed.warning) console.error(flushed.warning)

  const confirmed = await killAndRetireSession(id, async () => {
    const killed = await backend.kill(id)
    return killed || statusBefore === 'lost' || statusBefore === 'exited'
  })
  // A session that was already `lost` (the backend has nothing by this id — there was never
  // anything for `kill` to do) or `exited` (the hosted command already finished) is safe to clear
  // even on a backend report we cannot trust, because the reconciled view established BEFORE this
  // call already knew nothing was running. This is the fallback, not the common path: an ordinary
  // kill still relies on `confirmed`, so a real failure never gets papered over.
  if (!confirmed && statusBefore !== 'lost' && statusBefore !== 'exited') {
    console.error(`Could not confirm ${id} was killed — it may still be running. Its registry entry was kept.`)
    return 1
  }
  // MARKED finished, never deleted — see `retireSession`'s own docstring. A session filed under a
  // task must go on resolving in `loadTaskWorld`'s rows after `agentop session kill`, exactly as it
  // already does behind the web/cockpit kill verb.
  console.log(`Killed ${id}.`)
  const f = folder ? folderByRef.get(folder) : undefined
  if (f) {
    // `fileInFolder` is a MOVE and unpins. If this session handed off and the successor does not hold
    // its pin yet (the hand-off inheritance did not run, or the pin was added afterwards), give the
    // slot to the successor first so filing the predecessor never silently drops it.
    const { updatePreferences } = await import('../preferences')
    await (await import('./handoff-relay-io')).passPinForKill(registry.find(m => m.id === id), registry, updatePreferences)
    const conv = registry.find(m => m.id === id)?.conversationId
    const moved = await fileInFolder(f.id, { id, conversationId: conv }).catch(() => false)
    console.log(moved ? `Moved ${id} to ${f.path}.` : `Could not move ${id} to ${f.path}.`)
  }
  return 0
}

async function patch(
  ref: string,
  // `labelSince` is here rather than stamped inside because it belongs to `label` and to nothing
  // else — a note carries no timestamp and must not acquire one by passing through this helper.
  fields: { label?: string; labelSince?: number; note?: string },
  verb: string,
  backend: SessionBackend,
  /**
   * What to print once the registry write has landed, when the plain `<id> <verb>.` is not the whole
   * story. `rename` uses it to report what became of the HARNESS half; `note` has no second half and
   * passes nothing. It runs only after `patchSession` succeeded, so it can never announce work done
   * on a session the write did not find.
   */
  then?: (session: ManagedSession) => Promise<string>,
): Promise<number> {
  const registry = await readRegistry()
  const found = resolveSessionRef(registry, ref)
  if (!found.ok) {
    // `rename`/`note` patch registry METADATA, so they only ever resolve against the registry —
    // an unregistered session has none to patch. But "not found" there is not the same claim as
    // "does not exist": check the reconciled view so the error says which one is actually true.
    if (found.reason === 'not-found') {
      const reconciled = reconcileSessions(registry, await backend.list())
      const inBackend = resolveSessionRef(reconciled.map(toRefCandidate), ref)
      if (inBackend.ok) {
        console.error(
          `${inBackend.session.id} is running but has no registry entry to update — it was not ` +
          'started as a managed session, or its record was lost. There is nothing to rename/note.',
        )
        return 1
      }
    }
    console.error(refError(ref, found.reason, found.matches))
    return 1
  }
  // The registry was read before this write, and writes are queued — a concurrent `kill` can
  // remove the session in between, so the patch itself is the only source of truth on success.
  const applied = await patchSession(found.session.id, fields)
  if (!applied) { console.error(refError(ref, 'not-found', [])); return 1 }
  console.log(then ? await then(found.session) : `${found.session.id} ${verb}.`)
  return 0
}

function refError(ref: string, reason: 'not-found' | 'ambiguous', matches: string[]): string {
  return reason === 'not-found'
    ? `No session matches "${ref}". Run \`agentop session list\` to see them.`
    : `"${ref}" matches more than one session: ${matches.join(', ')}. Use a full id.`
}

/**
 * cli-parse.ts — PURE. `agentop session …` argv -> a typed command.
 *
 * Pure so the argv shape is tested without spawning anything. Note `-p` here is OURS and means the
 * PROMPT: it is not forwarded to the harness as `-p`, which on `claude` and `kimi` means "print and
 * exit" and on `codex` means "profile". `planSpawn` decides how each harness actually receives it.
 *
 * A flag whose value is missing is an ERROR, never a swallowed neighbour — the exact bug
 * `cli.ts`'s `readFlag` comment already warns about for `agentop member`.
 */

import { MIN_QUIET_FOR_MS } from './retire-plan'
import { HARNESS_ORDER, type HarnessId, type SessionRole } from '@agentistics/core'
// `GROUPINGS` is the ONE list of the dimensions a fleet can be grouped along — the same rule
// `HARNESS_SORT` follows: a second hand-written list here would accept a value the table cannot
// draw, or refuse one it can, and TypeScript would accept both.
import { GROUPINGS, type SessionGrouping } from '@agentistics/tui/control/sessions'

export type SessionCommand =
  | {
      kind: 'start'
      harness: HarnessId
      background: boolean
      prompt?: string
      model?: string
      effort?: string
      cwd?: string
      label?: string
      task?: string
      /** See `ManagedSession.taskId`. Resolved from the task book before the spawn. */
      taskId?: string
      /** `--subtask <id|title>`: the subtask of `--task` this session is for (told to the harness). */
      subtask?: string
      attemptId?: string
      /** `--notify off` starts the session with its notifications muted (delivery only — it still
       *  shows as waiting). Absent = on. */
      notify?: NotifySwitch
      /** Start anyway when the memory gate would refuse — see `spawn-admission.ts`. */
      force?: boolean
      /** Explicitly declare the spawned session's briefing role. */
      role?: SessionRole
      /** `--away` / `--no-away`: per-session away mode (absent = inherit a verified away parent's). */
      away?: boolean
      /** `--folder <ref>`: the sidebar folder (id, name or "Parent/Child") the session is filed into at spawn. */
      folder?: string
      /** A refusal is machine-readable too — see `admissionRefusalBody`. */
      json?: boolean
    }
  | { kind: 'list'; json?: boolean }
  /**
   * The fleet as a TABLE, for a person to read — the cockpit's sessions screen printed once.
   *
   * A separate command from `list` rather than a flag on it. `list` is a tab-separated dump that
   * scripts already read line by line, and widening it into columns under those scripts would break
   * them for a cosmetic reason. `ls` starts life as the human one, so it can default to what a
   * person means by the question — what is running, grouped by where I am working — while `list`
   * keeps meaning everything.
   */
  | {
      kind: 'ls'
      /** Include what is not running: finished, lost and closed conversations. */
      all: boolean
      group: SessionGrouping
      json?: boolean
      /** Columns to fit, when the caller states one rather than letting the terminal answer. */
      width?: number
      /** Colour, when the caller overrides what the terminal and `NO_COLOR` would decide. */
      color?: boolean
    }
  /**
   * Start SEVERAL sessions at once, all filed under one task.
   *
   * This is the command an assistant drives. It exists because orchestrating parallel work through
   * the single-session form means N invocations, N ids to collect from N lines of prose, and no way
   * to say "these belong together" — so the caller has to hold state the tool could have held.
   */
  | {
      kind: 'batch'
      task: string
      /** The task book's id for `task`, resolved before the spawn. */
      taskId?: string
      /** `--subtask <id|title>`: a subtask of `task` every session of the batch is for. */
      subtask?: string
      /** One entry per session to start. */
      specs: BatchSpec[]
      json?: boolean
      /** Start the whole batch anyway when the memory gate would refuse it. */
      force?: boolean
      /** `--away` / `--no-away` for every session of the batch (absent = inherit). */
      away?: boolean
    }
  | { kind: 'open'; task: string; json?: boolean; force?: boolean; folder?: string }
  | { kind: 'attach'; ref: string }
  /** `--folder <ref>`: after ending it, move it to that folder (e.g. "…/Finalizadas"). */
  | { kind: 'kill'; ref: string; folder?: string }
  /**
   * Ask the server to end the session once it is provably quiet (`retire-plan.ts`); `--cancel` drops a
   * pending request. `--folder`: file it there once retired. Durations take `s`/`m`/`h` (`60s`, `30m`).
   */
  | { kind: 'retire'; ref: string; cancel?: boolean; folder?: string; quietForMs?: number; deadlineMs?: number; json?: boolean }
  /** The folder tree, so a caller can pick a `--folder` ref. */
  | { kind: 'folders'; json?: boolean }
  /** NATIVE sessions only (`ses_…`): file an ended one away, bring it back, or delete it. */
  | { kind: 'archive' | 'unarchive' | 'delete'; ref: string }
  | { kind: 'rename'; ref: string; label: string }
  | { kind: 'note'; ref: string; text: string }
  | { kind: 'help' }
  | { kind: 'error'; message: string }

/** One session inside a batch, as `--session` spells it. */
export interface BatchSpec {
  harness: HarnessId
  /**
   * The attempt (configuration) this session runs under, by LABEL — see `task-model.ts`.
   *
   * A label rather than an id because this is what the user typed; the handler resolves it against
   * the task book (creating it on first sight) and stamps the resolved `attemptId` on the row.
   */
  attempt?: string
  /** Resolved from `attempt` before the spawn. Never typed by a user. */
  attemptId?: string
  prompt?: string
  cwd?: string
  model?: string
  effort?: string
  name?: string
  /** See `start.notify`. */
  notify?: NotifySwitch
  /** See `start.folder`. */
  folder?: string
}

export type NotifySwitch = 'on' | 'off'

/** `--notify` takes exactly on|off; anything else is refused rather than read as "on". */
function notifyValue(v: string): NotifySwitch | null {
  return v === 'on' || v === 'off' ? v : null
}

const VALUE_FLAGS = new Set([
  '-p', '--prompt', '--model', '--effort', '--cwd', '--name', '--task', '--subtask', '--session', '--attempt', '--notify', '--role', '--folder',
])

/** Pull `--folder <ref>` out of an argument list (open / kill take it anywhere). */
function takeFolder(args: string[]): { folder?: string; rest: string[] } | { error: string } {
  const rest: string[] = []
  let folder: string | undefined
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--folder') {
      const v = args[i + 1]
      if (v === undefined || v.startsWith('--')) return { error: 'Missing value for --folder' }
      folder = v
      i++
    } else rest.push(args[i]!)
  }
  return { ...(folder ? { folder } : {}), rest }
}

/** `60s` / `30m` / `1h` / `90` (seconds) → ms; `null` for anything else. */
export function parseDurationMs(v: string): number | null {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(v.trim())
  if (!m) return null
  const n = Number(m[1])
  const unit = m[2] ?? 's'
  const ms = unit === 'ms' ? n : unit === 's' ? n * 1000 : unit === 'm' ? n * 60_000 : n * 3_600_000
  return Number.isFinite(ms) ? Math.round(ms) : null
}

const RETIRE_USAGE = 'Usage: agentop session retire <id|name> [--cancel] [--quiet-for 60s] [--deadline 30m] [--folder <folder>] [--json]'

function parseRetire(args: string[], json: boolean): SessionCommand {
  const f = takeFolder(args)
  if ('error' in f) return { kind: 'error', message: f.error }
  let ref: string | undefined
  let cancel = false
  let quietForMs: number | undefined
  let deadlineMs: number | undefined
  const rest = f.rest
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!
    if (a === '--json') continue
    if (a === '--cancel') { cancel = true; continue }
    if (a === '--quiet-for' || a === '--deadline') {
      const v = rest[i + 1]
      const ms = v === undefined ? null : parseDurationMs(v)
      if (ms === null || (a === '--deadline' && ms <= 0)) return { kind: 'error', message: `Bad value for ${a}: ${v ?? '(missing)'} — use e.g. 60s, 30m, 1h.` }
      if (a === '--quiet-for' && ms < MIN_QUIET_FOR_MS) return { kind: 'error', message: `--quiet-for must be at least ${MIN_QUIET_FOR_MS / 1000}s (two poll intervals).` }
      if (a === '--quiet-for') quietForMs = ms
      else deadlineMs = ms
      i++
      continue
    }
    if (a.startsWith('--')) return { kind: 'error', message: `Unknown flag for retire: ${a}\n${RETIRE_USAGE}` }
    if (ref !== undefined) return { kind: 'error', message: RETIRE_USAGE }
    ref = a
  }
  if (!ref) return { kind: 'error', message: RETIRE_USAGE }
  return {
    kind: 'retire', ref,
    ...(cancel ? { cancel: true } : {}),
    ...(f.folder ? { folder: f.folder } : {}),
    ...(quietForMs !== undefined ? { quietForMs } : {}),
    ...(deadlineMs !== undefined ? { deadlineMs } : {}),
    ...(json ? { json: true } : {}),
  }
}

function isHarness(v: string): v is HarnessId {
  return (HARNESS_ORDER as readonly string[]).includes(v)
}

export function parseSessionArgs(argv: string[]): SessionCommand {
  const head = argv[0]
  if (!head) return { kind: 'help' }

  const jsonFlag = argv.includes('--json')

  if (head === 'list') return { kind: 'list', ...(jsonFlag ? { json: true } : {}) }

  if (head === 'ls') return parseLs(argv.slice(1), jsonFlag)

  if (head === 'batch') return parseBatch(argv.slice(1), jsonFlag)

  if (head === 'folders') return { kind: 'folders', ...(jsonFlag ? { json: true } : {}) }

  if (head === 'open') {
    const rest = argv.slice(1)
    const forceFlag = rest.includes('--force')
    const f = takeFolder(rest)
    if ('error' in f) return { kind: 'error', message: f.error }
    const task = f.rest.filter(a => a !== '--json' && a !== '--force').join(' ').trim()
    if (!task) return { kind: 'error', message: 'Usage: agentop session open "<task>" [--folder <folder>] [--force]' }
    return { kind: 'open', task, ...(jsonFlag ? { json: true } : {}), ...(forceFlag ? { force: true } : {}), ...(f.folder ? { folder: f.folder } : {}) }
  }

  if (head === 'attach') {
    const ref = argv[1]
    if (!ref) return { kind: 'error', message: 'Usage: agentop session attach <id|name>' }
    return { kind: 'attach', ref }
  }

  if (head === 'kill') {
    const f = takeFolder(argv.slice(1))
    if ('error' in f) return { kind: 'error', message: f.error }
    const ref = f.rest[0]
    if (!ref) return { kind: 'error', message: 'Usage: agentop session kill <id|name> [--folder <folder>]' }
    return { kind: 'kill', ref, ...(f.folder ? { folder: f.folder } : {}) }
  }

  if (head === 'retire') return parseRetire(argv.slice(1), jsonFlag)

  if (head === 'archive' || head === 'unarchive' || head === 'delete') {
    const ref = argv[1]
    if (!ref) return { kind: 'error', message: `Usage: agentop session ${head} <ses_…>  (native Agentistics sessions)` }
    return { kind: head, ref }
  }

  if (head === 'rename') {
    const ref = argv[1]
    const label = argv.slice(2).join(' ').trim()
    if (!ref || !label) return { kind: 'error', message: 'Usage: agentop session rename <id|name> "label"' }
    return { kind: 'rename', ref, label }
  }

  if (head === 'note') {
    const ref = argv[1]
    const text = argv.slice(2).join(' ').trim()
    if (!ref || !text) return { kind: 'error', message: 'Usage: agentop session note <id|name> "text"' }
    return { kind: 'note', ref, text }
  }

  if (!isHarness(head)) {
    return {
      kind: 'error',
      message: `Unknown harness or action: ${head}. Expected one of ${HARNESS_ORDER.join(', ')} — or ls, list, folders, attach, kill, retire, rename, note, archive, unarchive, delete.`,
    }
  }

  const cmd: Extract<SessionCommand, { kind: 'start' }> = {
    kind: 'start', harness: head, background: false,
  }

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--bg' || arg === '--background') { cmd.background = true; continue }
    if (arg === '--json') { cmd.json = true; continue }
    if (arg === '--force') { cmd.force = true; continue }
    if (arg === '--away') { cmd.away = true; continue }
    if (arg === '--no-away') { cmd.away = false; continue }
    if (arg === '--task') {
      const value = argv[i + 1]
      if (value === undefined || VALUE_FLAGS.has(value) || value === '--force') {
        return { kind: 'error', message: 'Missing value for --task' }
      }
      i++
      cmd.task = value
      continue
    }
    if (!VALUE_FLAGS.has(arg)) {
      return { kind: 'error', message: `Unknown option: ${arg}` }
    }
    const value = argv[i + 1]
    if (
      value === undefined || VALUE_FLAGS.has(value)
      || value === '--bg' || value === '--background' || value === '--force'
    ) {
      return { kind: 'error', message: `Missing value for ${arg}` }
    }
    i++
    if (arg === '--notify') {
      const n = notifyValue(value)
      if (n === null) return { kind: 'error', message: `--notify takes "on" or "off", not "${value}".` }
      cmd.notify = n
      continue
    }
    if (arg === '--folder') { cmd.folder = value; continue }
    if (arg === '--role') {
      if (value !== 'leader' && value !== 'worker') return { kind: 'error', message: '--role takes "leader" or "worker".' }
      cmd.role = value
      continue
    }
    if (arg === '-p' || arg === '--prompt') cmd.prompt = value
    else if (arg === '--model') cmd.model = value
    else if (arg === '--effort') cmd.effort = value
    else if (arg === '--cwd') cmd.cwd = value
    else if (arg === '--name') cmd.label = value
    else if (arg === '--subtask') cmd.subtask = value
  }

  return cmd
}

/**
 * What `ls` shows when nobody says otherwise: what is RUNNING, grouped by the project it runs in.
 *
 * Stated once, here, so the parser, the help text and the docs cannot drift into describing three
 * different defaults — the same reason the cockpit keeps a `DEFAULT_SESSION_VIEW`.
 */
export const LS_DEFAULT: { all: boolean; group: SessionGrouping } = { all: false, group: 'project' }

function isGrouping(v: string): v is SessionGrouping {
  return (GROUPINGS as readonly string[]).includes(v)
}

/** `agentop session ls [--all] [--group <dimension>] [--json] [--width <n>] [--no-color]`. */
function parseLs(argv: string[], json: boolean): SessionCommand {
  const cmd: Extract<SessionCommand, { kind: 'ls' }> = {
    kind: 'ls', all: LS_DEFAULT.all, group: LS_DEFAULT.group, ...(json ? { json: true } : {}),
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--json') continue
    if (arg === '--all' || arg === '-a') { cmd.all = true; continue }
    if (arg === '--no-color' || arg === '--no-colour') { cmd.color = false; continue }
    if (arg === '--color' || arg === '--colour') { cmd.color = true; continue }

    if (arg === '--group' || arg === '-g') {
      const value = argv[i + 1]
      // A flag whose value is missing is an ERROR, never a swallowed neighbour: `--group --json`
      // must not quietly group by "--json" and then drop the JSON output.
      if (value === undefined || value.startsWith('-')) {
        return { kind: 'error', message: `Missing value for ${arg}. Accepted: ${GROUPINGS.join(', ')}.` }
      }
      i++
      if (!isGrouping(value)) {
        return { kind: 'error', message: `Unknown grouping "${value}". Accepted: ${GROUPINGS.join(', ')}.` }
      }
      cmd.group = value
      continue
    }

    if (arg === '--width' || arg === '-w') {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('-')) {
        return { kind: 'error', message: `Missing value for ${arg}` }
      }
      i++
      const n = Number(value)
      if (!Number.isInteger(n) || n <= 0) {
        return { kind: 'error', message: `--width takes a positive number of columns, not "${value}".` }
      }
      cmd.width = n
      continue
    }

    return { kind: 'error', message: `Unknown option: ${arg}` }
  }

  return cmd
}

/**
 * `agentop session batch --task "X" --session "claude: fix the parser" --session "codex: ..."`.
 *
 * Each `--session` is `<harness>[@<cwd>]: <prompt>` — deliberately ONE string per session rather
 * than a repeated set of flags, because the caller composing these is usually a program writing a
 * command line, and one token per session is the shape that survives being built by string
 * concatenation. Anything more elaborate belongs in a config file, which is a different feature.
 *
 * Pure, so the whole grammar is tested without spawning anything.
 */
function parseBatch(argv: string[], json: boolean): SessionCommand {
  let task = ''
  let subtask: string | undefined
  const specs: BatchSpec[] = []
  const shared: { cwd?: string; model?: string; effort?: string; attempt?: string; notify?: NotifySwitch; folder?: string } = {}

  let force = false
  let away: boolean | undefined

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--json') continue
    // Like `--force`, for the whole batch: per-session away is a statement about who is watching.
    if (arg === '--away') { away = true; continue }
    if (arg === '--no-away') { away = false; continue }
    // Gates the WHOLE batch, not a per-session flag — `--session` already has its own grammar and
    // a per-session force would mean "start this one anyway, refuse the rest", which is not what
    // the memory gate decides (see `spawn-admission.ts`: a batch is admitted or refused as a unit).
    if (arg === '--force') { force = true; continue }
    if (!VALUE_FLAGS.has(arg)) return { kind: 'error', message: `Unknown option: ${arg}` }
    const value = argv[i + 1]
    if (value === undefined || VALUE_FLAGS.has(value) || value === '--json' || value === '--force') {
      return { kind: 'error', message: `Missing value for ${arg}` }
    }
    i++
    if (arg === '--task') { task = value; continue }
    if (arg === '--subtask') { subtask = value; continue }
    // `--cwd`, `--model` and `--effort` before the sessions are DEFAULTS for all of them: a batch
    // is usually many assistants on one repository, and repeating the path per session is how a
    // generated command line gets long enough to be got wrong.
    if (arg === '--cwd') { shared.cwd = value; continue }
    if (arg === '--model') { shared.model = value; continue }
    if (arg === '--effort') { shared.effort = value; continue }
    // `--attempt` is a positional default like the three above: it applies to every `--session`
    // that FOLLOWS it, until the next one. That is what lets one attempt hold several sessions,
    // which is the case the middle level of the model exists for.
    if (arg === '--attempt') { shared.attempt = value; continue }
    // A positional default like the others: it applies to the `--session`s that follow, so a batch
    // can mute the workers and leave the leader audible (or the reverse).
    if (arg === '--notify') {
      const n = notifyValue(value)
      if (n === null) return { kind: 'error', message: `--notify takes "on" or "off", not "${value}".` }
      shared.notify = n
      continue
    }
    // A positional default like `--notify`: it applies to the `--session`s that FOLLOW it, and a
    // later `--folder` overrides it for the ones after that.
    if (arg === '--folder') { shared.folder = value; continue }
    if (arg === '--session') {
      const spec = parseBatchSpec(value, shared)
      if ('error' in spec) return { kind: 'error', message: spec.error }
      specs.push(spec.spec)
      continue
    }
    return { kind: 'error', message: `${arg} is not accepted by batch — use --session for each one.` }
  }

  if (!task) return { kind: 'error', message: 'batch needs --task "<name>" so the sessions belong together.' }
  if (specs.length === 0) return { kind: 'error', message: 'batch needs at least one --session "<harness>: <prompt>".' }
  return { kind: 'batch', task, ...(subtask ? { subtask } : {}), specs, ...(json ? { json: true } : {}), ...(force ? { force: true } : {}), ...(away !== undefined ? { away } : {}) }
}

/** `<harness>[@<cwd>]: <prompt>` — the one string that describes a session in a batch. */
export function parseBatchSpec(
  value: string,
  shared: { cwd?: string; model?: string; effort?: string; attempt?: string; notify?: NotifySwitch; folder?: string } = {},
): { spec: BatchSpec } | { error: string } {
  const colon = value.indexOf(':')
  const head = (colon === -1 ? value : value.slice(0, colon)).trim()
  const prompt = colon === -1 ? '' : value.slice(colon + 1).trim()

  const at = head.indexOf('@')
  const harness = (at === -1 ? head : head.slice(0, at)).trim()
  const cwd = at === -1 ? '' : head.slice(at + 1).trim()

  if (!isHarness(harness)) {
    return { error: `Unknown harness "${harness}". Expected one of ${HARNESS_ORDER.join(', ')}.` }
  }
  return {
    spec: {
      harness,
      ...(prompt ? { prompt } : {}),
      ...(cwd ? { cwd } : shared.cwd ? { cwd: shared.cwd } : {}),
      ...(shared.model ? { model: shared.model } : {}),
      ...(shared.effort ? { effort: shared.effort } : {}),
      ...(shared.attempt ? { attempt: shared.attempt } : {}),
      ...(shared.notify ? { notify: shared.notify } : {}),
      ...(shared.folder ? { folder: shared.folder } : {}),
    },
  }
}

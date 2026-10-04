/**
 * claude-hooks.ts — **pure**: what agentop puts into a user's `~/.claude/settings.json`, how it
 * merges with whatever is already in there, and how it takes it back out again.
 *
 * That file is not ours. It holds other people's hooks, other tools' keys, and keys this version of
 * agentop has never heard of. So every function here READS a settings object and RETURNS a new one
 * with exactly one thing changed — it never rebuilds the document from a schema it believes in, and
 * it never touches a key it did not write. A `JSON.parse` → mutate-what-I-know → `JSON.stringify`
 * round-trip that drops an unknown key destroys configuration that was working, silently, which is
 * the failure this module is shaped to make impossible.
 *
 * Three rules the tests pin:
 *  - **Refuse rather than overwrite.** A `settings.json` whose `hooks` is a string is not a file to
 *    fix; it is a file to leave alone and report. Every plan returns a discriminated result, and the
 *    caller writes nothing on `ok: false`.
 *  - **Installing twice changes nothing.** `changed: false` is what the second run reports, and the
 *    settings object comes back untouched (=== the input), so the caller does not even rewrite it.
 *  - **Uninstalling is the exact inverse.** It removes OUR hook entry and the containers that exist
 *    only to hold it, and nothing else. A group that also carries someone else's hook keeps that
 *    hook and its group.
 *
 * ## Why the command string is the identity
 *
 * A Claude Code hook entry is `{ type, command, timeout }`. There is no field for "who installed
 * this", and inventing an unknown key inside someone else's schema is how a settings file stops
 * validating on the next release. So OUR entry is recognised by the command it runs — an `agentop`
 * binary invoked with the verb pair `hooks context` — and the version it was written at travels in
 * that same command as `--hook-version N`. It is self-describing: `agentop hooks status` can read a
 * file it has no memory of writing, including one a user hand-edited or copied from another
 * machine, without a second store on the side that could disagree with it.
 */

/**
 * Bumped when the hook CONTRACT changes — the verbs called, what they print, or which events are
 * registered. An installed hook at a lower version is reported as stale by `status` and rewritten
 * in place by `install`.
 *
 * v2 added the `Stop` hook: an install that predates it carries only `SessionStart`, so it is
 * stale by exactly the definition above and `install` brings it up to both.
 */
export const HOOK_VERSION = 3

/**
 * The two Claude Code events agentop registers on, and why there are two.
 *
 * They answer different questions and cost different things:
 *
 *  - **`SessionStart` → `hooks context`** injects the FACTS a starting session cannot know: which
 *    sessions are running now, which is blocked, which task reopens here. It prints nothing when
 *    the fleet is empty, so a quiet machine pays no tokens.
 *  - **`Stop` → `events emit`** records that this session finished a turn. It is the EXACT half of
 *    the event channel — no polling, no inference, Claude saying so itself — and it is the only
 *    reason the channel can report the end of a Claude turn instantly rather than up to five
 *    seconds later. It prints nothing at all: it writes one line to the inbox and exits.
 *
 * Registered as a table rather than two constants so `planHookInstall` / `planHookRemoval` /
 * `readHookStatus` take an event and there is exactly ONE merge implementation. A second copy of
 * the settings merge for the second hook would be a second set of rules about somebody else's file.
 */
export interface HookSpec {
  /** The Claude Code event name — the key under `hooks` in settings.json. */
  event: string
  /** The agentop verb pair this hook runs. Also its identity: see below. */
  verb: readonly [string, string]
  /** Seconds. A hook that hangs holds up the session it was supposed to serve. */
  timeoutSec: number
  /** Claude Code's tool matcher, for the tool events. Absent = every tool (or the event has none). */
  matcher?: string
}

export const HOOK_SPECS: readonly HookSpec[] = [
  // Talks to tmux and reads `/proc`; ten is generous and bounded.
  { event: 'SessionStart', verb: ['hooks', 'context'], timeoutSec: 10 },
  // Appends one line to a local file. Five is already an eternity for that, and this one runs at
  // the end of EVERY turn — the budget has to be small enough that it is never felt.
  { event: 'Stop', verb: ['events', 'emit'], timeoutSec: 5 },
  // VAULT.PERSONAL §8.3. Both exit at once, printing nothing, in a session agentop did not start
  // (no AGENTOP_MANAGED_ID) or one with no grant — a quiet machine pays one process start per call.
  // PreToolUse turns a granted `vault://key` into a call that fetches the value when the command RUNS.
  { event: 'PreToolUse', verb: ['vault', 'pretool'], timeoutSec: 5, matcher: 'Bash' },
  // PostToolUse sends EVERY tool's output through the scrubber (a Read of a file holding the value is
  // as much a leak as a Bash echo), replacing it only when something was found.
  { event: 'PostToolUse', verb: ['vault', 'posttool'], timeoutSec: 5 },
]

export function hookSpecFor(event: string): HookSpec | undefined {
  return HOOK_SPECS.find(s => s.event === event)
}

/** The original single hook. Kept as the DEFAULT of every function below, so nothing that already
 *  called them changed meaning when the second hook was added. */
export const HOOK_EVENT = 'SessionStart'

export const HOOK_TIMEOUT_SEC = 10

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

/** Shell-quote only when it is actually needed — an unquoted `agentop` reads better in a file a
 *  person opens, and a path with a space in it must not become two arguments. */
function shellQuote(s: string): string {
  return /[\s"'\\]/.test(s) ? `"${s.replace(/(["\\$`])/g, '\\$1')}"` : s
}

/**
 * How this installation of agentop should be invoked from a hook, given what is available.
 *
 * Prefer the bare name on PATH: the hook then survives an upgrade that replaces the binary at a
 * different path, which `agentop upgrade` can do. Only when there is no `agentop` on PATH do we
 * pin an absolute one — and running from a source checkout (`bun …/cli.ts`) needs the interpreter
 * as well, or the settings file would carry `bun hooks context`, which is not a command.
 */
export function hookInvocation(o: { onPath?: boolean; execPath: string; script?: string }): string {
  if (o.onPath) return 'agentop'
  const fromSource = !!o.script && (o.script.endsWith('.ts') || o.script.endsWith('.js'))
  return fromSource
    ? `${shellQuote(o.execPath)} ${shellQuote(o.script!)}`
    : shellQuote(o.execPath)
}

/** The full command string an installed hook runs, for one event. */
export function hookCommand(
  invocation: string,
  version = HOOK_VERSION,
  event = HOOK_EVENT,
): string {
  const spec = hookSpecFor(event)
  if (!spec) throw new Error(`No agentop hook is defined for the ${event} event.`)
  return `${invocation} ${spec.verb[0]} ${spec.verb[1]} --hook-version ${version}`
}

/**
 * Is this command one of ours?
 *
 * One of our verb PAIRS is required, and then one of two corroborating marks: the word `agentop`
 * somewhere in the command, or the `--hook-version` flag every install writes. Either alone would
 * be wrong — a source checkout runs `bun …/packages/server/bin/cli.ts`, which contains no
 * `agentop` at all, and `hooks context` on its own is a verb pair another tool could plausibly use.
 * Deliberately loose about everything else: an absolute path, a quoted path, an interpreter prefix
 * and a hand-added `--lang pt` all still match, and all of them are still our hook.
 *
 * `event` NARROWS it to that event's own verb pair, and every caller passes one. Without the
 * narrowing, removing the `SessionStart` hook would also match — and delete — a `Stop` entry a user
 * had moved there by hand: our two hooks would become one thing that cannot be administered
 * separately. Called with no event it matches ANY of our verbs, which is what a general "is this
 * line ours" question means.
 */
export function isAgentopHookCommand(command: string, event?: string): boolean {
  const specs = event === undefined ? HOOK_SPECS : HOOK_SPECS.filter(s => s.event === event)
  const matchesVerb = specs.some(s =>
    new RegExp(`(^|[\\s"'])${s.verb[0]}\\s+${s.verb[1]}(\\s|$|["'])`).test(command))
  if (!matchesVerb) return false
  return /agentop/i.test(command) || /--hook-version/.test(command)
}

/** The version an installed command declares, or null when it declares none (a pre-versioned or
 *  hand-written one — treated as stale, never as current). */
export function hookVersionOf(command: string): number | null {
  const m = /--hook-version[=\s]+(\d+)/.exec(command)
  if (!m || m[1] === undefined) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? n : null
}

// ---------------------------------------------------------------------------
// Reading and planning
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Why a settings document cannot be planned against. The caller reports it and writes NOTHING. */
export type HookPlanError =
  | { code: 'settings-not-object' }
  | { code: 'hooks-not-object' }
  | { code: 'event-not-array'; event: string }

export type HookPlan =
  | { ok: true; settings: Obj; changed: boolean }
  | { ok: false; error: HookPlanError }

export interface HookStatus {
  installed: boolean
  /** Every one of our entries found. More than one is possible in a hand-edited file. */
  commands: string[]
  /** The version of the first entry, or null when it declares none. */
  version: number | null
  /** Installed, but written by a different (older or newer) agentop than this one. */
  stale: boolean
}

/** Read-only: what is in this settings document, as far as we are concerned. Never throws — an
 *  unreadable shape simply carries no hook of ours, which is the truth. */
export function readHookStatus(
  settings: unknown,
  version = HOOK_VERSION,
  event = HOOK_EVENT,
): HookStatus {
  const commands: string[] = []
  if (isObj(settings) && isObj(settings.hooks) && Array.isArray(settings.hooks[event])) {
    for (const group of settings.hooks[event] as unknown[]) {
      if (!isObj(group) || !Array.isArray(group.hooks)) continue
      for (const hook of group.hooks as unknown[]) {
        if (!isObj(hook) || typeof hook.command !== 'string') continue
        if (isAgentopHookCommand(hook.command, event)) commands.push(hook.command)
      }
    }
  }
  const first = commands[0]
  const found = first !== undefined ? hookVersionOf(first) : null
  return {
    installed: commands.length > 0,
    commands,
    version: found,
    stale: commands.length > 0 && found !== version,
  }
}

/**
 * Add (or bring up to date) our SessionStart hook.
 *
 * An entry of ours that is already there is UPDATED IN PLACE — its `timeout`, and any other key a
 * user added to it, is kept. Replacing the whole entry would quietly undo a deliberate edit, and
 * "install refreshed my hook" is not a licence to discard the rest of the line it lives on.
 */
export function planHookInstall(settings: unknown, command: string, event = HOOK_EVENT): HookPlan {
  if (settings === undefined || settings === null) settings = {}
  if (!isObj(settings)) return { ok: false, error: { code: 'settings-not-object' } }

  const hooksRaw = settings.hooks ?? {}
  if (!isObj(hooksRaw)) return { ok: false, error: { code: 'hooks-not-object' } }

  const eventRaw = hooksRaw[event] ?? []
  if (!Array.isArray(eventRaw)) return { ok: false, error: { code: 'event-not-array', event } }

  let changed = false
  let found = false

  const groups = eventRaw.map(group => {
    if (!isObj(group) || !Array.isArray(group.hooks)) return group
    let touched = false
    const hooks = (group.hooks as unknown[]).map(hook => {
      if (!isObj(hook) || typeof hook.command !== 'string') return hook
      if (!isAgentopHookCommand(hook.command, event)) return hook
      found = true
      if (hook.command === command) return hook
      touched = true
      return { ...hook, command }
    })
    if (!touched) return group
    changed = true
    return { ...group, hooks }
  })

  if (!found) {
    groups.push({
      // No `matcher`: every SessionStart source is one where the facts that hook reports are worth
      // having — a fresh start, a resume and a compact have all just lost or never had them — and
      // Stop has no matcher dimension at all.
      ...(hookSpecFor(event)?.matcher ? { matcher: hookSpecFor(event)!.matcher } : {}),
      hooks: [{ type: 'command', command, timeout: hookSpecFor(event)?.timeoutSec ?? HOOK_TIMEOUT_SEC }],
    })
    changed = true
  }

  // Nothing to write: hand back the very object we were given, so the caller can skip the write and
  // leave the file's bytes (and its mtime) exactly as they were.
  if (!changed) return { ok: true, settings, changed: false }

  return {
    ok: true,
    settings: { ...settings, hooks: { ...hooksRaw, [event]: groups } },
    changed: true,
  }
}

/**
 * Remove our hook and nothing else.
 *
 * Containers are pruned when they become empty — the group we appended, the `SessionStart` array,
 * and `hooks` itself — because those exist only to hold the entry we are taking back. The one
 * ambiguity is a `"hooks": {}` a user wrote by hand before installing: it is indistinguishable from
 * the one an install created, and it is pruned. An empty object either way changes no behaviour.
 */
export function planHookRemoval(settings: unknown, event = HOOK_EVENT): HookPlan {
  if (settings === undefined || settings === null) settings = {}
  if (!isObj(settings)) return { ok: false, error: { code: 'settings-not-object' } }

  const hooksRaw = settings.hooks
  if (hooksRaw === undefined) return { ok: true, settings, changed: false }
  if (!isObj(hooksRaw)) return { ok: false, error: { code: 'hooks-not-object' } }

  const eventRaw = hooksRaw[event]
  if (eventRaw === undefined) return { ok: true, settings, changed: false }
  if (!Array.isArray(eventRaw)) return { ok: false, error: { code: 'event-not-array', event } }

  let changed = false
  const groups: unknown[] = []
  for (const group of eventRaw) {
    if (!isObj(group) || !Array.isArray(group.hooks)) { groups.push(group); continue }
    const kept = (group.hooks as unknown[]).filter(hook =>
      !(isObj(hook) && typeof hook.command === 'string' && isAgentopHookCommand(hook.command, event)))
    if (kept.length === (group.hooks as unknown[]).length) { groups.push(group); continue }
    changed = true
    // A group emptied by that removal was ours; one that still carries someone else's hook stays,
    // with everything else on it intact.
    if (kept.length > 0) groups.push({ ...group, hooks: kept })
  }

  if (!changed) return { ok: true, settings, changed: false }

  const hooks: Obj = { ...hooksRaw }
  if (groups.length > 0) hooks[event] = groups
  else delete hooks[event]

  const next: Obj = { ...settings }
  if (Object.keys(hooks).length > 0) next.hooks = hooks
  else delete next.hooks

  return { ok: true, settings: next, changed: true }
}

/** The sentence a refusal deserves. Pure so the CLI and the tests read the same words. */
export function explainHookPlanError(e: HookPlanError, file: string): string {
  switch (e.code) {
    case 'settings-not-object':
      return `${file} does not hold a JSON object, so agentop will not write to it. Fix or move the file and run this again.`
    case 'hooks-not-object':
      return `${file} has a "hooks" key that is not an object, so agentop cannot merge into it without guessing. Nothing was written.`
    case 'event-not-array':
      return `${file} has a "hooks".${e.event} that is not an array, so agentop cannot merge into it without guessing. Nothing was written.`
  }
}

// ---------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------

export type HooksCommand =
  | { kind: 'install'; hook: boolean; skill: boolean }
  | { kind: 'uninstall'; hook: boolean; skill: boolean }
  | { kind: 'status' }
  | { kind: 'context' }
  | { kind: 'help' }
  | { kind: 'error'; message: string }

/**
 * `agentop hooks …`. Pure, so what the words mean is tested rather than inferred from behaviour.
 *
 * `--hook-only` / `--skill-only` narrow install and uninstall to one half; passing both is refused
 * rather than resolved to "everything", which is the opposite of what either flag asks for.
 */
export function parseHooksArgs(argv: string[]): HooksCommand {
  const [verb, ...rest] = argv
  if (!verb || verb === 'help' || verb === '--help' || verb === '-h') return { kind: 'help' }

  const hookOnly = rest.includes('--hook-only')
  const skillOnly = rest.includes('--skill-only')
  // `--hook-version` is passed BY the installed hook to itself; it carries the version for `status`
  // to read out of the settings file and is not an argument `context` acts on.
  const unknown = rest.find(a =>
    a.startsWith('-') && !['--hook-only', '--skill-only'].includes(a) && !a.startsWith('--hook-version'))

  switch (verb) {
    case 'install':
    case 'uninstall': {
      if (unknown) return { kind: 'error', message: `Unknown option ${unknown}.` }
      if (hookOnly && skillOnly) {
        return { kind: 'error', message: 'Pass --hook-only or --skill-only, not both — together they mean neither.' }
      }
      return { kind: verb, hook: !skillOnly, skill: !hookOnly }
    }
    case 'status':
      return { kind: 'status' }
    case 'context':
      return { kind: 'context' }
    default:
      return { kind: 'error', message: `Unknown hooks action "${verb}".` }
  }
}

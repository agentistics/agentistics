/**
 * cli-provider.ts — `agentop provider key <set|status|remove>`.
 *
 * Spec: docs/superpowers/specs/2026-09-25-runtime-b1-provider.md §6 (entry §6.1, storage §6.2,
 * central §6.2.5, status §6.2.6, removal/rotation §6.5).
 *
 * The key is NEVER accepted on argv, in a chat, an issue, a task comment or a file — only this
 * verb's hidden prompt (`maskedInput`, reused as-is from `cli-ui.ts`) or exactly one line of a
 * pipe (`--stdin`). `status` and `remove` never print the value or any substring of it, only a
 * `sha256:xxxxxxxx` fingerprint (`credential-plan.ts`).
 *
 * This module is a HOLDER in `provider-secrets.lint.test.ts`'s sense — `cli-provider.ts` receives
 * the value from the prompt/pipe, hands it to `credential-plan.ts` for shape validation and to
 * `credentials.ts` to store, and drops it. No token typed on argv is ever echoed back in a
 * refusal, not even a provider id typed by mistake in place of a key — the one place this module
 * could leak a secret is a message that quotes what the user typed, so it never does.
 */

import {
  isKeyedProvider,
  KEYED_PROVIDERS,
  PROVIDER_FLAG_ENV,
  providerFlagOn,
  TEAM_CENTRAL,
  type KeyedProviderId,
} from './config.ts'
import { confirm as defaultConfirm, maskedInput as defaultMaskedInput } from './cli-ui.ts'
import { readPreferences as defaultReadPreferences } from './preferences.ts'
import {
  keyShapeSentence,
  refusalSentence,
  validateKeyShape,
} from './provider/credential-plan.ts'
import {
  credentialStatus,
  removeCredential,
  storeCredential,
} from './provider/credentials.ts'

/** Inferred from the function itself rather than a separately named exported type — this module
 *  depends only on `credentials.ts`'s function SIGNATURES, never on how it happens to name its
 *  result types. */
type CredentialStatusResult = Awaited<ReturnType<typeof credentialStatus>>

// ---------------------------------------------------------------------------
// Dependencies — every side effect this module performs is injectable, so the test suite drives
// the whole surface (tty prompts, stdin, the central/flag checks) without a real terminal, a real
// pipe or a real ~/.agentistics.
// ---------------------------------------------------------------------------

export interface ProviderCliDeps {
  stdout: (line: string) => void
  stderr: (line: string) => void
  /** Whether stdin is a real, raw-capable terminal — never read this off `process.stdin` more
   *  than once per call, so a test can simulate "piped" without a real pipe. */
  stdinIsTTY: boolean
  /** Reads exactly ONE line from stdin (the scripted `--stdin` path), with one trailing
   *  `\n`/`\r\n` already stripped. Never trims anything else — a value that is still
   *  whitespace-wrapped is a shape the validator refuses, not something this reader cleans up. */
  readStdinLine: () => Promise<string>
  /** The hidden-prompt primitive (`cli-ui.ts`'s `maskedInput`, reused as-is). */
  maskedInput: (message: string) => Promise<string>
  /** The Yes/No primitive (`cli-ui.ts`'s `confirm`, reused as-is) — asked before a rotation on a
   *  real terminal. */
  confirm: (message: string, initial?: boolean) => Promise<boolean>
  /** `TEAM_CENTRAL` (env) OR the effective `preferences.team.mode === 'central'` (§6.2.5). A
   *  central never runs the native runtime and never stores a provider key. */
  isCentral: () => Promise<boolean>
  /** `providerFlagOn()` (§6.1) — the native runtime's feature flag. Absent reads as OFF. */
  flagOn: () => boolean
  /** Key-directory override, threaded straight through to `credentials.ts`. `undefined` means
   *  "use the real `PROVIDER_KEYS_DIR`" — tests pass a temp directory here. */
  dir?: string
}

async function defaultIsCentral(): Promise<boolean> {
  if (TEAM_CENTRAL) return true
  try {
    const prefs = await defaultReadPreferences()
    // `TeamConfig.mode` is typed `'solo' | 'member'` going forward (§6.2.5's check exists for a
    // machine whose on-disk preferences still carry the older, retired `'central'` value) — widen
    // to `string` before comparing, or the literal-type comparison has no overlap and this file
    // would not type-check against the current type.
    const mode: string | undefined = prefs.team?.mode
    return mode === 'central'
  } catch {
    // A preferences read failure here must never turn into a false "this is a central" — the
    // stronger, unconditional signal is `TEAM_CENTRAL`, already checked above.
    return false
  }
}

/** Reads stdin to EOF and returns its first line, with one trailing `\n` (and, before it, one
 *  trailing `\r`) stripped. Deliberately reads to EOF rather than stopping at the first `\n` byte
 *  read — a small piped value costs nothing extra, and stopping mid-stream would leave the pipe's
 *  writer with a broken connection on some shells. */
async function readOneLineFromStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8')
  const nl = raw.indexOf('\n')
  const line = nl === -1 ? raw : raw.slice(0, nl)
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

function defaultDeps(): ProviderCliDeps {
  return {
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
    stdinIsTTY: !!process.stdin.isTTY,
    readStdinLine: readOneLineFromStdin,
    maskedInput: defaultMaskedInput,
    confirm: defaultConfirm,
    isCentral: defaultIsCentral,
    flagOn: () => providerFlagOn(),
    dir: undefined,
  }
}

// ---------------------------------------------------------------------------
// Never echo what the user typed. A provider id, a flag or a stray positional on `set` sits in
// EXACTLY the position a mistyped key would land (`agentop provider key set <this>`), so every
// refusal in this module names what was EXPECTED and never repeats what was GIVEN.
// ---------------------------------------------------------------------------

function unknownProviderMessage(): string {
  return `unknown provider — supported: ${KEYED_PROVIDERS.join(', ')}`
}

const ARGV_KEY_MESSAGE =
  'a key is never accepted on the command line — run the command without it and paste at the prompt'

const NO_TTY_MESSAGE = 'no terminal to read a hidden key from — pipe it with --stdin'

// ---------------------------------------------------------------------------
// `set`
// ---------------------------------------------------------------------------

type SetParse =
  | { kind: 'ok'; provider: string; stdin: boolean; replace: boolean }
  | { kind: 'usage' }
  | { kind: 'argv-key' }
  | { kind: 'unknown-flag' }

/** Pure: no side effects, so the "never echo" rule can be checked by inspecting the return value
 *  alone — none of these branches carries the rejected token. */
function parseSetArgs(rest: string[]): SetParse {
  if (rest.length === 0 || rest[0]!.startsWith('-')) return { kind: 'usage' }
  const provider = rest[0]!
  let stdin = false
  let replace = false
  for (const tok of rest.slice(1)) {
    if (tok === '--stdin') { stdin = true; continue }
    if (tok === '--replace') { replace = true; continue }
    if (tok.startsWith('--')) return { kind: 'unknown-flag' }
    // A bare positional after the provider id — the exact shape a key typed on argv takes.
    return { kind: 'argv-key' }
  }
  return { kind: 'ok', provider, stdin, replace }
}

const SET_USAGE = 'usage: agentop provider key set <provider> [--stdin] [--replace]'

async function runSet(rest: string[], d: ProviderCliDeps): Promise<number> {
  const parsed = parseSetArgs(rest)
  if (parsed.kind === 'usage') { d.stderr(SET_USAGE); return 2 }
  if (parsed.kind === 'argv-key') { d.stderr(ARGV_KEY_MESSAGE); return 2 }
  if (parsed.kind === 'unknown-flag') {
    d.stderr('unknown flag — see `agentop provider key --help`')
    return 2
  }

  const { provider: providerArg, stdin, replace } = parsed
  if (!isKeyedProvider(providerArg)) { d.stderr(unknownProviderMessage()); return 2 }
  const provider: KeyedProviderId = providerArg

  // Central and the flag are checked BEFORE the key is ever asked for — refusing after a hidden
  // prompt has already been typed would waste the one gesture this module exists to protect.
  if (!d.flagOn()) { d.stderr(refusalSentence('flag-off')); return 1 }
  if (await d.isCentral()) { d.stderr(refusalSentence('central')); return 1 }

  let value: string
  if (stdin) {
    value = await d.readStdinLine()
  } else {
    if (!d.stdinIsTTY) { d.stderr(NO_TTY_MESSAGE); return 2 }
    value = await d.maskedInput('Anthropic API key (never echoed)')
  }

  const shape = validateKeyShape(value)
  if (!shape.ok) { d.stderr(keyShapeSentence(shape.reason)); return 1 }

  // First attempt never forces a replace — an existing key is discovered through
  // `storeCredential`'s own `'exists'` refusal, which is also what carries the old fingerprint
  // for the rotation message, rather than this module re-deriving it with a separate read.
  let res = await storeCredential(provider, value, { dir: d.dir, replace: stdin ? replace : false })

  if (!res.ok && res.reason === 'exists') {
    if (stdin) {
      d.stderr('a key is already stored — pass --replace to overwrite it non-interactively')
      return 1
    }
    const ok = await d.confirm(`A key is already stored (${res.previous}). Replace it?`, false)
    if (!ok) { d.stdout('left unchanged.'); return 0 }
    res = await storeCredential(provider, value, { dir: d.dir, replace: true })
  }

  if (!res.ok) {
    if (res.reason === 'invalid-shape') { d.stderr(keyShapeSentence(res.shape)); return 1 }
    if (res.reason === 'exists') { d.stderr(`a key is already stored (${res.previous}).`); return 1 }
    d.stderr(`could not store the key (${res.reason}).`)
    return 1
  }

  if (res.previous) d.stdout(`${provider}: ${res.previous} → ${res.fingerprint}`)
  else d.stdout(`${provider}: stored ${res.fingerprint} at ${res.path}`)
  return 0
}

// ---------------------------------------------------------------------------
// `status`
// ---------------------------------------------------------------------------

const STATUS_USAGE = 'usage: agentop provider key status [anthropic]'

function stateLine(res: CredentialStatusResult): string {
  const hint = res.state === 'permissions-too-open' ? ` — fix with: chmod 600 ${res.path}` : ''
  return `  state: ${res.state}${hint}`
}

async function printStatusFor(provider: KeyedProviderId, d: ProviderCliDeps): Promise<void> {
  // With the flag off, no credential file is read at all (§6.2.6) — `readContent: false` stats
  // the file (so `present`/`absent`/`permissions-too-open` are still answered) without opening
  // and hashing it, so no fingerprint is ever produced while the runtime that would use it is off.
  const readContent = d.flagOn()
  const res = await credentialStatus(provider, { dir: d.dir, readContent })
  d.stdout(`${provider}:`)
  d.stdout(stateLine(res))
  d.stdout(`  path: ${res.path}`)
  if (res.mode !== undefined) d.stdout(`  mode: ${res.mode}`)
  if (res.storedAt !== undefined) d.stdout(`  stored: ${res.storedAt}`)
  if (res.fingerprint !== undefined) d.stdout(`  fingerprint: ${res.fingerprint}`)
}

async function runStatus(rest: string[], d: ProviderCliDeps): Promise<number> {
  if (rest[0] === '--help') { d.stdout(STATUS_USAGE); return 0 }
  if (rest.length > 1) { d.stderr(STATUS_USAGE); return 2 }
  const providerArg = rest[0]
  if (providerArg !== undefined) {
    if (providerArg.startsWith('-')) { d.stderr(STATUS_USAGE); return 2 }
    if (!isKeyedProvider(providerArg)) { d.stderr(unknownProviderMessage()); return 2 }
  }
  const providers: KeyedProviderId[] = providerArg ? [providerArg] : [...KEYED_PROVIDERS]

  // `status` NEVER refuses outright — it is the one verb that must answer on every machine
  // (§11): with the flag off, with no key stored, and on a central. It states each fact instead.
  d.stdout(d.flagOn() ? `${PROVIDER_FLAG_ENV}: on` : refusalSentence('flag-off'))
  if (await d.isCentral()) d.stdout(refusalSentence('central'))

  for (const p of providers) await printStatusFor(p, d)
  return 0
}

// ---------------------------------------------------------------------------
// `remove`
// ---------------------------------------------------------------------------

const REMOVE_USAGE = 'usage: agentop provider key remove <provider>'

async function runRemove(rest: string[], d: ProviderCliDeps): Promise<number> {
  if (rest.length !== 1 || rest[0]!.startsWith('-')) { d.stderr(REMOVE_USAGE); return 2 }
  const providerArg = rest[0]!
  if (!isKeyedProvider(providerArg)) { d.stderr(unknownProviderMessage()); return 2 }
  const provider: KeyedProviderId = providerArg

  if (!d.flagOn()) { d.stderr(refusalSentence('flag-off')); return 1 }
  if (await d.isCentral()) { d.stderr(refusalSentence('central')); return 1 }

  const res = await removeCredential(provider, { dir: d.dir })
  if (!res.removed) { d.stdout(`${provider}: no key stored.`); return 0 }

  d.stdout(`${provider}: removed ${res.fingerprint ?? '(no fingerprint)'}.`)
  d.stdout(
    'The key is still valid at Anthropic until you revoke it in the console — deleting the '
    + 'local copy is not revocation.',
  )
  return 0
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

const HELP = `
Usage: agentop provider key <set|status|remove> [options]

  agentop provider key set anthropic            Hidden prompt (default) — nothing is echoed
  agentop provider key set anthropic --stdin    Read ONE line from a pipe; no prompt
  agentop provider key set anthropic --replace  With --stdin, allow overwriting a stored key
  agentop provider key status [anthropic]       Presence + fingerprint — never the key itself
  agentop provider key remove anthropic         Delete the stored key (does not revoke it)

The key is NEVER accepted on the command line, in ANY position — not as an argument, not in a
flag. A value on argv lands in shell history and in \`/proc/<pid>/cmdline\`, readable by any
process this user runs and by \`ps\`. \`echo sk-ant-… | agentop provider key set anthropic --stdin\`
still writes the key into shell history — the pipe protects argv, it does not protect the command
that FEEDS it. Prefer a secrets manager: \`pass show anthropic | agentop provider key set
anthropic --stdin\`.

This is your OWN Anthropic API key, billed to the account whose console you got it from. A
Claude Pro/Max SUBSCRIPTION cannot be used here — this loop never reads a subscription session,
by design (see the master runtime spec §22.3). Delegating a turn to the official \`claude\` CLI is
the route for a subscription; this verb is for the pay-as-you-go API key alone.

Nobody should ever paste a key into a chat message, a GitHub issue, a task comment or a file —
including a prompt to an assistant implementing or reviewing this feature. If a key was ever
pasted somewhere it can be read back, revoke it in the Anthropic console and mint a new one.

\`agentop provider key status\` never prints the value, a substring of it, its length, or the raw
stored file — only whether a key is present, its path, its file mode, when it was stored and a
one-way \`sha256:xxxxxxxx\` fingerprint, so a rotation is visible as \`old → new\` without ever
showing either key.
`.trim()

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export async function runProvider(args: string[], deps: Partial<ProviderCliDeps> = {}): Promise<number> {
  const d: ProviderCliDeps = { ...defaultDeps(), ...deps }

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    d.stdout(HELP)
    return 0
  }

  if (args[0] !== 'key') {
    d.stderr('unknown `agentop provider` command — try `agentop provider --help`')
    return 2
  }

  const rest = args.slice(1)
  const verb = rest[0]
  if (verb === undefined || verb === '--help' || verb === '-h') {
    d.stdout(HELP)
    return 0
  }

  try {
    if (verb === 'set') return await runSet(rest.slice(1), d)
    if (verb === 'status') return await runStatus(rest.slice(1), d)
    if (verb === 'remove') return await runRemove(rest.slice(1), d)
  } catch (err) {
    // A defensive net, not the primary control flow: every expected failure above already
    // returns a code. `err`'s message is filesystem/library text (a path, an errno) — never the
    // key, which lives only in local `value`/`res` bindings this catch cannot see.
    d.stderr(`unexpected error: ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }

  d.stderr('unknown `agentop provider key` command — try `agentop provider --help`')
  return 2
}

/**
 * cli-provider.ts — `agentop provider key <set|status|remove>` and `agentop provider try`, for the
 * Anthropic key (B1) and the six OpenAI-compatible ENDPOINTS (B5a: openai, openrouter, deepseek,
 * litellm, 9router, ollama — each a stored base URL plus, usually, a key).
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
  CONTENT_DIR,
  ENDPOINT_PRESETS,
  isKeyedProvider,
  isOpenAICompatibleEndpoint,
  KEYED_PROVIDERS,
  OPENAI_COMPATIBLE_ENDPOINTS,
  PROVIDER_FLAG_ENV,
  providerFlagOn,
  TEAM_CENTRAL,
  type KeyedProviderId,
  type OpenAICompatibleEndpointId,
} from './config.ts'
import { confirm as defaultConfirm, maskedInput as defaultMaskedInput } from './cli-ui.ts'
import { readPreferences as defaultReadPreferences } from './preferences.ts'
import {
  baseUrlSentence,
  keyShapeSentence,
  refusalSentence,
  validateBaseUrl,
  validateKeyShape,
} from './provider/credential-plan.ts'
import {
  credentialStatus,
  readEndpointCredential,
  removeCredential,
  resolveCredential,
  resolveCredentialRef,
  storeCredential,
  storeEndpointCredential,
} from './provider/credentials.ts'
import { createModelLister } from '@agentistics/runtime'
import { runProviderModels, type ProviderModelsCliDeps } from './cli-provider-models.ts'
import type {
  AnthropicClientDeps,
  CredentialResolver,
  InvocationResult,
  OpenAICompatibleClientDeps,
  ProviderClient,
  ProviderRequest,
  ProviderStreamEvent,
  StreamDelivery,
} from '@agentistics/runtime'
import type { Journal } from './journal/types'

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
  /** `try` only: the client that makes the call. Default is the real Anthropic client, built over
   *  the stored key in `dir`. Tests inject a stub so `bun test` never spends money. */
  client?: ProviderClient
  /** `try` only: opens the journal the call is recorded in. Default `openJournal()` (the machine's
   *  journal, `AGENTISTICS_DIR`). A failure to open is not a failure of the call. */
  openJournal?: () => Promise<Journal | null>
  /** `try` only: where the raw capture is written. Default is the machine's content store,
   *  `CONTENT_DIR` (`config.ts`) — the runtime has no default of its own (D23). */
  captureDir?: string
  /** `try --stream` only: writes a chunk to stdout with NO newline added, so text deltas appear as
   *  they arrive. Default `process.stdout.write`. */
  write?: (chunk: string) => void
  /**
   * MODELS DISPATCH HOOK (B5a.3). `agentop provider models …` is written in
   * `./cli-provider-models.ts` (`runProviderModels`) by a separate item; the INTEGRATOR wires it here
   * (default deps, or the binary's dispatch) so this module never imports a file it did not write.
   * Absent: the verb refuses in a sentence rather than doing nothing.
   */
  runModels?: (args: string[]) => Promise<number>
}

// ---------------------------------------------------------------------------
// The host's half of the runtime's injection seams (D23). `@agentistics/runtime` never finds a key
// or a directory on its own: whoever builds a client hands it a resolver and a capture directory.
// Everything that builds an Anthropic client in this binary — `runTry` below, and a registry via
// the runtime's `createProviderClients({ anthropic: hostAnthropicClientDeps() })` — goes through
// here, so the two seams are bound in exactly one place.
// ---------------------------------------------------------------------------

/** Resolves a runtime `CredentialRef` against the key store (`credentials.ts`'s `resolveCredentialRef`,
 *  the one mapping): Anthropic, or `{openai-compatible, <endpoint>}`. A ref for any other pair is
 *  refused outright (`wrong-provider`) rather than asked about. */
export function hostCredentialResolver(dir?: string): CredentialResolver {
  return { resolve: (ref) => resolveCredentialRef(ref, { dir }) }
}

/** One endpoint's client deps: the resolver, the content store, and the endpoint EXPLICITLY — its id,
 *  the base URL read from its own record, and its kind from the preset table (never from the URL). */
export function hostOpenAICompatibleClientDeps(
  endpoint: OpenAICompatibleEndpointId,
  baseUrl: string,
  opts: { dir?: string; captureDir?: string } = {},
): OpenAICompatibleClientDeps {
  return {
    resolver: hostCredentialResolver(opts.dir),
    captureDir: opts.captureDir ?? CONTENT_DIR,
    endpoint: { id: endpoint, baseUrl, kind: ENDPOINT_PRESETS[endpoint].kind },
  }
}

/** The Anthropic client's host-owned dependencies: the key store's resolver and the content store. */
export function hostAnthropicClientDeps(opts: { dir?: string; captureDir?: string } = {}): AnthropicClientDeps {
  return { resolver: hostCredentialResolver(opts.dir), captureDir: opts.captureDir ?? CONTENT_DIR }
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

/** What a stored record is called in a sentence: `anthropic`, or `openrouter (openai-compatible)`. */
function nameOf(provider: KeyedProviderId): string {
  return provider === 'anthropic' ? provider : `${provider} (openai-compatible)`
}

const ARGV_KEY_MESSAGE =
  'a key is never accepted on the command line — run the command without it and paste at the prompt'

const NO_TTY_MESSAGE = 'no terminal to read a hidden key from — pipe it with --stdin'

// ---------------------------------------------------------------------------
// `set`
// ---------------------------------------------------------------------------

type SetParse =
  | { kind: 'ok'; provider: string; stdin: boolean; replace: boolean; baseUrl?: string; noKey: boolean }
  | { kind: 'usage' }
  | { kind: 'argv-key' }
  | { kind: 'unknown-flag' }

/** Pure: no side effects, so the "never echo" rule can be checked by inspecting the return value
 *  alone — none of these branches carries the rejected token. `--base-url` takes a VALUE (config, not
 *  a secret — and still never echoed on a refusal); every other bare positional is refused as the
 *  shape a key typed on argv takes. */
function parseSetArgs(rest: string[]): SetParse {
  if (rest.length === 0 || rest[0]!.startsWith('-')) return { kind: 'usage' }
  const provider = rest[0]!
  let stdin = false
  let replace = false
  let noKey = false
  let baseUrl: string | undefined
  const tail = rest.slice(1)
  for (let i = 0; i < tail.length; i++) {
    const tok = tail[i]!
    if (tok === '--stdin') { stdin = true; continue }
    if (tok === '--replace') { replace = true; continue }
    if (tok === '--no-key') { noKey = true; continue }
    if (tok === '--base-url') {
      const v = tail[++i]
      if (v === undefined || v.startsWith('-')) return { kind: 'usage' }
      baseUrl = v
      continue
    }
    if (tok.startsWith('--base-url=')) { baseUrl = tok.slice('--base-url='.length); continue }
    if (tok.startsWith('--')) return { kind: 'unknown-flag' }
    // A bare positional after the provider id — the exact shape a key typed on argv takes.
    return { kind: 'argv-key' }
  }
  return { kind: 'ok', provider, stdin, replace, noKey, ...(baseUrl !== undefined ? { baseUrl } : {}) }
}

const SET_USAGE = 'usage: agentop provider key set <provider|endpoint> [--stdin] [--replace] '
  + '[--base-url <url>] [--no-key]'

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
  if (isOpenAICompatibleEndpoint(providerArg)) return runSetEndpoint(providerArg, parsed, d)
  // `--base-url` / `--no-key` mean nothing for Anthropic, whose base URL is the client's own constant.
  if (parsed.baseUrl !== undefined || parsed.noKey) {
    d.stderr('unknown flag — see `agentop provider key --help`')
    return 2
  }
  const provider = providerArg

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

/**
 * `key set <endpoint>` (B5a). Same order as Anthropic's, with one more thing decided BEFORE the key
 * is asked for: the base URL (the flag's, else the preset's; `litellm` has none, so `--base-url` is
 * required). A refused URL is never echoed — a pasted `https://user:secret@host` is exactly the value
 * that must not be printed back. `--no-key` is accepted only where the preset says the endpoint may
 * be keyless (Ollama), and then no key is asked for at all.
 */
async function runSetEndpoint(
  endpoint: OpenAICompatibleEndpointId,
  parsed: Extract<SetParse, { kind: 'ok' }>,
  d: ProviderCliDeps,
): Promise<number> {
  const preset = ENDPOINT_PRESETS[endpoint]
  if (parsed.noKey && !preset.keyOptional) {
    d.stderr(`${endpoint} requires a key — --no-key is only for an endpoint that takes none (ollama).`)
    return 2
  }
  if (parsed.noKey && parsed.stdin) { d.stderr('--no-key reads no key — do not combine it with --stdin.'); return 2 }

  if (!d.flagOn()) { d.stderr(refusalSentence('flag-off')); return 1 }
  if (await d.isCentral()) { d.stderr(refusalSentence('central')); return 1 }

  const rawUrl = parsed.baseUrl ?? preset.defaultBaseUrl
  if (rawUrl === null) {
    d.stderr(`${endpoint} has no default base URL — pass --base-url <url>.`)
    return 2
  }
  const url = validateBaseUrl(rawUrl)
  if (!url.ok) { d.stderr(baseUrlSentence(url.reason)); return 1 }

  let key: string | null = null
  if (!parsed.noKey) {
    if (parsed.stdin) {
      key = await d.readStdinLine()
    } else {
      if (!d.stdinIsTTY) { d.stderr(NO_TTY_MESSAGE); return 2 }
      key = await d.maskedInput(`${preset.label} API key (never echoed)`)
    }
    const shape = validateKeyShape(key, endpoint)
    if (!shape.ok) { d.stderr(keyShapeSentence(shape.reason, endpoint)); return 1 }
  }

  const input = { baseUrl: url.baseUrl, key }
  // A non-interactive run (a pipe, or --no-key without a terminal) must say --replace up front; an
  // interactive one is asked.
  const interactive = !parsed.stdin && d.stdinIsTTY
  let res = await storeEndpointCredential(endpoint, input, { dir: d.dir, replace: interactive ? false : parsed.replace })
  if (!res.ok && res.reason === 'exists') {
    if (!interactive) {
      d.stderr('this endpoint is already configured — pass --replace to overwrite it non-interactively')
      return 1
    }
    const prev = `${res.previous.fingerprint ?? 'no key'} at ${res.previous.baseUrl}`
    const ok = await d.confirm(`${endpoint} is already configured (${prev}). Replace it?`, false)
    if (!ok) { d.stdout('left unchanged.'); return 0 }
    res = await storeEndpointCredential(endpoint, input, { dir: d.dir, replace: true })
  }

  if (!res.ok) {
    if (res.reason === 'invalid-shape') { d.stderr(keyShapeSentence(res.shape, endpoint)); return 1 }
    if (res.reason === 'invalid-base-url') { d.stderr(baseUrlSentence(res.baseUrl)); return 1 }
    if (res.reason === 'key-required') { d.stderr(`${endpoint} requires a key.`); return 1 }
    if (res.reason === 'exists') { d.stderr('this endpoint is already configured.'); return 1 }
    d.stderr(`could not store the endpoint (${res.reason}).`)
    return 1
  }

  const now = `${res.fingerprint ?? 'no key'} at ${res.baseUrl}`
  if (res.previous) {
    d.stdout(`${nameOf(endpoint)}: ${res.previous.fingerprint ?? 'no key'} at ${res.previous.baseUrl} → ${now}`)
  } else {
    d.stdout(`${nameOf(endpoint)}: stored ${now} in ${res.path}`)
  }
  return 0
}

// ---------------------------------------------------------------------------
// `status`
// ---------------------------------------------------------------------------

const STATUS_USAGE = 'usage: agentop provider key status [anthropic|<endpoint>]'

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
  d.stdout(`${nameOf(provider)}:`)
  d.stdout(stateLine(res))
  d.stdout(`  path: ${res.path}`)
  if (res.mode !== undefined) d.stdout(`  mode: ${res.mode}`)
  if (res.storedAt !== undefined) d.stdout(`  stored: ${res.storedAt}`)
  if (res.baseUrl !== undefined) d.stdout(`  base url: ${res.baseUrl}`)
  if (res.keyless) d.stdout('  key: none (keyless)')
  if (res.fingerprint !== undefined) d.stdout(`  fingerprint: ${res.fingerprint}`)
  if (res.last4) d.stdout(`  ends with: …${res.last4}`)
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

const REMOVE_USAGE = 'usage: agentop provider key remove <provider|endpoint>'

async function runRemove(rest: string[], d: ProviderCliDeps): Promise<number> {
  if (rest.length !== 1 || rest[0]!.startsWith('-')) { d.stderr(REMOVE_USAGE); return 2 }
  const providerArg = rest[0]!
  if (!isKeyedProvider(providerArg)) { d.stderr(unknownProviderMessage()); return 2 }
  const provider: KeyedProviderId = providerArg

  if (!d.flagOn()) { d.stderr(refusalSentence('flag-off')); return 1 }
  if (await d.isCentral()) { d.stderr(refusalSentence('central')); return 1 }

  const res = await removeCredential(provider, { dir: d.dir })
  if (!res.removed) { d.stdout(`${nameOf(provider)}: no key stored.`); return 0 }

  d.stdout(`${nameOf(provider)}: removed ${res.fingerprint ?? '(no fingerprint)'}.`)
  const where = provider === 'anthropic' ? 'Anthropic' : ENDPOINT_PRESETS[provider].label
  d.stdout(
    `The key is still valid at ${where} until you revoke it there — deleting the `
    + 'local copy is not revocation.',
  )
  return 0
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

// ── `try` — the first real call (B1.7) ──────────────────────────────────────────────────────────

/** The cheapest current Anthropic model in the price table — the first call should cost as little
 *  as it can while still being a real one. `--model` overrides it. */
export const TRY_DEFAULT_MODEL = 'claude-haiku-4-5-20251001'
/** Fixed on purpose: not a flag, so no invocation of this verb can ask for a large answer.
 *  Spec §6.6 — the first-call verb uses a fixed tiny prompt with `max_tokens ≤ 64`. */
export const TRY_PROMPT = 'Reply with the single word: ok'
export const TRY_MAX_TOKENS = 16

const TRY_USAGE = 'usage: agentop provider try anthropic [--model <id>] [--stream]\n'
  + '       agentop provider try <endpoint> --model <id>'

type TryParse =
  | { kind: 'ok'; provider: string; model: string; modelGiven: boolean; stream: boolean }
  | { kind: 'usage' }
  | { kind: 'unknown-flag' }

function parseTryArgs(rest: string[]): TryParse {
  if (rest.length === 0 || rest[0]!.startsWith('-')) return { kind: 'usage' }
  const provider = rest[0]!
  let model = TRY_DEFAULT_MODEL
  let stream = false
  let modelGiven = false
  for (let i = 1; i < rest.length; i++) {
    const tok = rest[i]!
    if (tok === '--stream') { stream = true; continue }
    if (tok === '--model') {
      const v = rest[++i]
      if (v === undefined || v.startsWith('-') || v.length === 0) return { kind: 'usage' }
      model = v
      modelGiven = true
      continue
    }
    if (tok.startsWith('--model=')) {
      const v = tok.slice('--model='.length)
      if (v.length === 0) return { kind: 'usage' }
      model = v
      modelGiven = true
      continue
    }
    if (tok.startsWith('-')) return { kind: 'unknown-flag' }
    return { kind: 'usage' }
  }
  return { kind: 'ok', provider, model, modelGiven, stream }
}

const COUNTERS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const

async function defaultOpenJournal(): Promise<Journal | null> {
  const { openJournal } = await import('./journal/journal')
  return openJournal()
}

/**
 * `--stream`: the provider stream goes through ONE runtime hub (`providerEventStream`) and this
 * verb is simply its first reader — the shape every other surface (web, TUI, VS Code) reads the
 * same stream through. Text deltas are written as they arrive; a gap the hub reports (`lagged`) is
 * a notice on stderr, never silence; the record events (a tool call, its failure) are one compact
 * line each. Returns the terminal `end` event's result, or `null` when the stream ended without one
 * (a client breaking its contract, or a source that failed) — the caller says so in words.
 */
async function streamToTerminal(
  client: ProviderClient,
  request: ProviderRequest,
  attempt: number,
  d: ProviderCliDeps,
  onStarted: (e: Extract<ProviderStreamEvent, { type: 'started' }>) => Promise<unknown>,
): Promise<InvocationResult | null> {
  const { openProviderStream, providerEventStream } = await import('@agentistics/runtime')
  const opened = openProviderStream(client, request, attempt)
  if (!opened.ok) return null
  const write = d.write ?? ((chunk: string) => { process.stdout.write(chunk) })
  const hub = providerEventStream()
  const reader = hub.subscribe()
  // `model.started` is journaled from the SOURCE, before the hub, so it is recorded once however
  // many readers watch and whether or not any of them keeps up.
  async function* tapStarted(src: AsyncIterable<ProviderStreamEvent>): AsyncGenerator<ProviderStreamEvent> {
    for await (const e of src) {
      if (e.type === 'started') await onStarted(e)
      yield e
    }
  }
  const pumping = hub.pipe(tapStarted(opened.stream))

  // assigned inside `show`; widened explicitly so control flow does not pin it to `null`
  let result = null as InvocationResult | null
  let midLine = false
  const announced = new Set<number>()
  const line = (text: string, toErr = false): void => {
    if (midLine) { write('\n'); midLine = false }
    ;(toErr ? d.stderr : d.stdout)(text)
  }
  const show = (e: ProviderStreamEvent): void => {
    switch (e.type) {
      case 'text-delta':
        if (e.text.length > 0) { write(e.text); midLine = !e.text.endsWith('\n') }
        return
      case 'tool-call-delta':
        if (!announced.has(e.index)) { announced.add(e.index); line(`  → tool call ${e.name} (arguments streaming…)`) }
        return
      case 'tool-call':
        line(`  → tool call ${e.name} ready (${e.id}) — not executed`)
        return
      case 'tool-call-failed':
        line(`  → tool call ${e.failure.name} could not be assembled: ${e.failure.reason} (${e.failure.userCode})`, true)
        return
      case 'end':
        result = e.result
        return
      default:
        return
    }
  }
  const onDelivery = (dv: StreamDelivery<ProviderStreamEvent>): void => {
    if (dv.kind === 'event') { show(dv.event); return }
    if (dv.kind === 'lagged') { line(`  (the display fell behind — ${dv.missed} live chunks were not shown; the result below is complete)`, true); return }
    line(dv.reason === 'source-failed'
      ? '  (the stream broke off before its end)'
      : '  (the display was detached for falling too far behind)', true)
  }
  for await (const dv of reader) onDelivery(dv)
  await pumping
  if (midLine) write('\n')
  return result
}

/**
 * One attempt, no retry: a smoke test that quietly re-sent a billable call would spend more than
 * the owner authorised. The retry loop (`retry.ts`) is the runtime's, not this verb's.
 *
 * Order matters and is the emitter's contract: `model.invoked` is appended BEFORE the request
 * leaves, so a crash mid-call still leaves a record that a billable call was outstanding.
 */
async function runTry(rest: string[], d: ProviderCliDeps): Promise<number> {
  if (rest[0] === '--help') { d.stdout(TRY_USAGE); return 0 }
  const parsed = parseTryArgs(rest)
  if (parsed.kind === 'usage') { d.stderr(TRY_USAGE); return 2 }
  if (parsed.kind === 'unknown-flag') { d.stderr('unknown flag — see `agentop provider try --help`'); return 2 }
  if (!isKeyedProvider(parsed.provider)) { d.stderr(unknownProviderMessage()); return 2 }
  if (isOpenAICompatibleEndpoint(parsed.provider)) {
    // No default model for an endpoint: what it serves is the operator's choice, and a guessed id is
    // a billed call to a model nobody asked for.
    if (!parsed.modelGiven) { d.stderr(`${parsed.provider} has no default model — pass --model <id>.`); return 2 }
    return runTryEndpoint(parsed.provider, parsed.model, parsed.stream, d)
  }

  if (!d.flagOn()) { d.stderr(refusalSentence('flag-off')); return 1 }
  if (await d.isCentral()) { d.stderr(refusalSentence('central')); return 1 }

  // Refuse BEFORE anything is journaled: a call that cannot be made must not leave a
  // `model.invoked` claiming a billable request was outstanding.
  const cred = await resolveCredential('anthropic', { dir: d.dir })
  if (!cred.ok) {
    d.stderr(
      cred.reason === 'absent'
        ? 'no key stored — run `agentop provider key set anthropic` first.'
        : `the stored key cannot be used (${cred.reason}) — see \`agentop provider key status anthropic\`.`,
    )
    return 1
  }

  // Lazy: `key set|status|remove` never load the AI SDK the runtime carries.
  const { createAnthropicClient, createProviderEmitter, invokedEvent, terminalEvent } = await import('@agentistics/runtime')
  const client = d.client ?? createAnthropicClient(hostAnthropicClientDeps({ dir: d.dir, captureDir: d.captureDir }))

  let journal: Journal | null = null
  try { journal = await (d.openJournal ?? defaultOpenJournal)() } catch { journal = null }

  // A client that cannot stream is refused BEFORE anything is journaled: a call that is never made
  // must leave no `model.invoked` behind, and quietly falling back to the non-streamed call would
  // be a different request than the one asked for.
  if (parsed.stream) {
    const { streamingRefusal } = await import('@agentistics/runtime')
    const refusal = streamingRefusal(client)
    if (refusal) {
      d.stderr(`${refusal.provider}: this client cannot stream (${refusal.userCode}) — run without --stream.`)
      return 1
    }
  }

  const emitter = createProviderEmitter({ journal, adapterVersion: client.adapterVersion })
  const invocationId = `inv_${crypto.randomUUID().replaceAll('-', '')}`
  const attempt = 1
  const startedAt = new Date().toISOString()

  const start = { invocationId, attempt, provider: 'anthropic' as const, requestedModel: parsed.model, startedAt }
  d.stdout(`anthropic: one call to ${parsed.model} (max_tokens ${TRY_MAX_TOKENS}) — this is billed to your account.`)
  await emitter.invoked(start)

  const request: ProviderRequest = {
    model: parsed.model,
    messages: [{ role: 'user', content: TRY_PROMPT }],
    maxTokens: TRY_MAX_TOKENS,
    correlation: { invocationId },
    credential: { provider: 'anthropic', id: 'default' },
  }
  const result = parsed.stream
    ? await streamToTerminal(client, request, attempt, d, (e) => emitter.started({
        ...start,
        ...(e.messageId === undefined ? {} : { messageId: e.messageId }),
        ...(e.servedModel === undefined ? {} : { servedModel: e.servedModel }),
      }))
    : await client.invokeOnce(request, attempt)
  if (result === null) {
    d.stderr('the stream ended without a result — the outcome of this call is unknown.')
    d.stderr(`  model.invoked was recorded for ${invocationId} and is left outstanding: check the Anthropic console before retrying.`)
    return 1
  }

  const outcome = result.status === 'completed'
    ? {
        status: 'completed' as const, ...start, latencyMs: result.latencyMs,
        ...(result.requestId === undefined ? {} : { requestId: result.requestId }),
        messageId: result.messageId, servedModel: result.servedModel, usage: result.usage, stopReason: result.stopReason,
      }
    : {
        status: 'failed' as const, ...start, latencyMs: result.latencyMs,
        ...(result.requestId === undefined ? {} : { requestId: result.requestId }),
        error: result.error,
      }
  const terminalAt = new Date().toISOString()
  const terminalResult = await emitter.terminal(outcome, {}, terminalAt)

  const ctx = { adapterVersion: client.adapterVersion, recordedAt: terminalAt }
  const invokedId = invokedEvent(start, {}, ctx).eventId
  const terminal = terminalEvent(outcome, {}, ctx, terminalAt)

  const lost = emitter.counters().lost
  const journaled = journal !== null && lost['model.invoked'] === 0 && terminalResult !== null && lost[terminal.type] === 0
    && lost['model.started'] === 0

  if (result.status === 'failed') {
    d.stderr(`the call failed: ${result.error.kind} (${result.error.retryable ? 'retryable' : 'not retryable'}).`)
    if (result.requestId !== undefined) d.stderr(`  request-id: ${result.requestId}`)
    d.stderr(`  recorded as ${terminal.type}: ${terminal.eventId}${journaled ? '' : ' (NOT journaled)'}`)
    return 1
  }

  const u = result.usage
  const missing = new Set(u.missing ?? [])
  d.stdout(`  served model: ${result.servedModel}`)
  d.stdout(`  message id: ${result.messageId === '' ? '(none stated)' : result.messageId}`)
  d.stdout(`  request-id: ${result.requestId ?? '(none stated)'}`)
  for (const c of COUNTERS) d.stdout(`  ${c}: ${missing.has(c) ? 'not reported by the provider' : u[c]}`)
  d.stdout(`  stop: ${result.stopReason.kind}`)
  d.stdout(`  latency: ${Math.round(result.latencyMs)} ms`)
  if (result.capture) d.stdout(`  raw capture: sha256:${result.capture.sha256} (${result.capture.bytes} bytes)`)
  d.stdout(`  ${invokedEvent(start, {}, ctx).type}: ${invokedId}`)
  d.stdout(`  ${terminal.type}: ${terminal.eventId}`)
  d.stdout(journaled ? '  journaled: yes' : `  journaled: NO (lost: ${JSON.stringify(lost)}) — the call succeeded but is not on record.`)
  return journaled ? 0 : 1
}

/**
 * `try <endpoint> --model <id>` (B5a). The Anthropic verb's contract exactly — fixed tiny prompt,
 * `max_tokens` 16, ONE attempt, `model.invoked` journaled BEFORE the request leaves, then
 * `model.completed` or `model.failed` — against the endpoint's stored base URL and key. It also
 * prints what the protocol adds: the usage CERTAINTY (who stated the counters) and the COST as the
 * endpoint itself reported it, or `N/A` with the reason. Never a table price, never the fallback rate.
 */
async function runTryEndpoint(endpoint: OpenAICompatibleEndpointId, model: string, stream: boolean, d: ProviderCliDeps): Promise<number> {
  if (!d.flagOn()) { d.stderr(refusalSentence('flag-off')); return 1 }
  if (await d.isCentral()) { d.stderr(refusalSentence('central')); return 1 }

  const record = await readEndpointCredential(endpoint, { dir: d.dir })
  if (!record.ok) {
    d.stderr(
      record.reason === 'absent'
        ? `${endpoint} is not configured — run \`agentop provider key set ${endpoint}\` first.`
        : `the stored ${endpoint} record cannot be used (${record.reason}) — see \`agentop provider key status ${endpoint}\`.`,
    )
    return 1
  }

  const { createOpenAICompatibleClient, createProviderEmitter, invokedEvent, terminalEvent } = await import('@agentistics/runtime')
  const client = d.client ?? createOpenAICompatibleClient(
    hostOpenAICompatibleClientDeps(endpoint, record.baseUrl, { dir: d.dir, captureDir: d.captureDir }),
  )

  // This client has no stream yet (B2 streams Anthropic only). `--stream` is refused BEFORE
  // anything is journaled, exactly as on the Anthropic path — never a hang, and never quietly
  // answered with the non-streamed call, which would be a different request than the one asked for.
  // Refused even if the client someday declares a stream: this verb has no streamed path for an
  // endpoint, and falling through below would be exactly that silent non-streamed answer.
  if (stream) {
    const { streamingRefusal } = await import('@agentistics/runtime')
    const code = streamingRefusal(client)?.userCode ?? 'provider.streaming_unsupported'
    d.stderr(`${endpoint}: this client cannot stream (${code}) — run without --stream.`)
    return 1
  }

  let journal: Journal | null = null
  try { journal = await (d.openJournal ?? defaultOpenJournal)() } catch { journal = null }

  const emitter = createProviderEmitter({ journal, adapterVersion: client.adapterVersion })
  const invocationId = `inv_${crypto.randomUUID().replaceAll('-', '')}`
  const attempt = 1
  const startedAt = new Date().toISOString()
  const start = { invocationId, attempt, provider: 'openai-compatible' as const, requestedModel: model, startedAt }

  d.stdout(`${endpoint}: one call to ${model} at ${record.baseUrl} (max_tokens ${TRY_MAX_TOKENS}) — this may be billed to your account.`)
  await emitter.invoked(start)

  const result: InvocationResult = await client.invokeOnce({
    model,
    messages: [{ role: 'user', content: TRY_PROMPT }],
    maxTokens: TRY_MAX_TOKENS,
    correlation: { invocationId },
    credential: { provider: 'openai-compatible', id: endpoint },
  }, attempt)

  const outcome = result.status === 'completed'
    ? {
        status: 'completed' as const, ...start, latencyMs: result.latencyMs,
        ...(result.requestId === undefined ? {} : { requestId: result.requestId }),
        messageId: result.messageId, servedModel: result.servedModel, usage: result.usage, stopReason: result.stopReason,
      }
    : {
        status: 'failed' as const, ...start, latencyMs: result.latencyMs,
        ...(result.requestId === undefined ? {} : { requestId: result.requestId }),
        error: result.error,
      }
  const terminalAt = new Date().toISOString()
  const terminalResult = await emitter.terminal(outcome, {}, terminalAt)

  const ctx = { adapterVersion: client.adapterVersion, recordedAt: terminalAt }
  const invokedId = invokedEvent(start, {}, ctx).eventId
  const terminal = terminalEvent(outcome, {}, ctx, terminalAt)
  const lost = emitter.counters().lost
  const journaled = journal !== null && lost['model.invoked'] === 0 && terminalResult !== null && lost[terminal.type] === 0

  if (result.status === 'failed') {
    d.stderr(`the call failed: ${result.error.kind} (${result.error.retryable ? 'retryable' : 'not retryable'}).`)
    if (result.requestId !== undefined) d.stderr(`  request-id: ${result.requestId}`)
    d.stderr(`  recorded as ${terminal.type}: ${terminal.eventId}${journaled ? '' : ' (NOT journaled)'}`)
    return 1
  }

  const u = result.usage
  const missing = new Set(u.missing ?? [])
  d.stdout(`  served model: ${result.servedModel}`)
  d.stdout(`  id: ${result.messageId}`)
  d.stdout(`  request-id: ${result.requestId ?? '(none stated)'}`)
  for (const c of COUNTERS) d.stdout(`  ${c}: ${missing.has(c) ? 'not reported by the endpoint' : u[c]}`)
  d.stdout(`  certainty: ${result.usageCertainty ?? 'not graded'}`)
  d.stdout(`  cost: ${costLine(result.cost)}`)
  if (result.usageNotes !== undefined && result.usageNotes.length > 0) d.stdout(`  usage notes: ${result.usageNotes.join(', ')}`)
  d.stdout(`  stop: ${result.stopReason.kind}`)
  d.stdout(`  latency: ${Math.round(result.latencyMs)} ms`)
  if (result.capture) d.stdout(`  raw capture: sha256:${result.capture.sha256} (${result.capture.bytes} bytes)`)
  d.stdout(`  ${invokedEvent(start, {}, ctx).type}: ${invokedId}`)
  d.stdout(`  ${terminal.type}: ${terminal.eventId}`)
  d.stdout(journaled ? '  journaled: yes' : `  journaled: NO (lost: ${JSON.stringify(lost)}) — the call succeeded but is not on record.`)
  return journaled ? 0 : 1
}

type CompletedResult = Extract<InvocationResult, { status: 'completed' }>

/** The cost line: the endpoint's OWN figure with the field it came from, or `N/A` and why. There is
 *  no third branch — this verb never prices from a table and never uses the fallback rate. */
export function costLine(cost: CompletedResult['cost']): string {
  if (cost === undefined) return 'N/A — the client stated no cost'
  if (cost.kind === 'router-reported') return `US$ ${cost.usd} (reported by the endpoint, ${cost.field})`
  const why: Record<typeof cost.reason, string> = {
    'no-verified-price': 'the endpoint reported no cost and no verified price is used here',
    'local-unbilled': 'a local server — nothing is billed',
    'counters-missing': 'the usage counters needed to price it were not reported',
  }
  return `N/A — ${why[cost.reason]}`
}

const HELP = `
Usage: agentop provider key <set|status|remove> [options]
       agentop provider try anthropic [--model <id>] [--stream]
       agentop provider try <endpoint> --model <id>
       agentop provider models …     (see its own --help)

Endpoints (OpenAI-compatible): openai, openrouter, deepseek, litellm, 9router, ollama.
  agentop provider key set <endpoint> [--base-url <url>] [--stdin] [--replace]
                                                A base URL (preset unless given; litellm has none)
                                                plus a key from the hidden prompt or --stdin
  agentop provider key set ollama --no-key      A keyless local endpoint
  A base URL must be https://, or http:// to this machine only; it may carry no user, password,
  query or fragment.

  agentop provider key set anthropic            Hidden prompt (default) — nothing is echoed
  agentop provider key set anthropic --stdin    Read ONE line from a pipe; no prompt
  agentop provider key set anthropic --replace  With --stdin, allow overwriting a stored key
  agentop provider key status [anthropic]       Presence + fingerprint + last 4 characters
  agentop provider key remove anthropic         Delete the stored key (does not revoke it)
  agentop provider try anthropic [--model <id>] ONE real, billed call with a fixed tiny prompt
                                                (max_tokens 16); records it in the journal and
                                                prints usage, request-id and the event ids. Set a
                                                spend limit in the Anthropic console first.
  agentop provider try anthropic --stream       The same one call, streamed: the answer is printed
                                                as it arrives, then the same summary.

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

\`agentop provider key status\` never prints the value, more than its last 4 characters, its length,
or the raw stored file — only whether a key is present, its path, its file mode, when it was
stored, a one-way \`sha256:xxxxxxxx\` fingerprint (a rotation is visible as \`old → new\`) and the
key's last 4 characters, which is what the Anthropic console shows beside each key.
`.trim()

// ---------------------------------------------------------------------------
// `models` — the host adapter over `./cli-provider-models.ts`
// ---------------------------------------------------------------------------

/** The live model list is read through the stored endpoint's base URL and opaque key handle. The
 *  handle is passed on UNREVEALED — the runtime lister reveals it inline in its one request. */
function modelsDepsOf(d: ProviderCliDeps): ProviderModelsCliDeps {
  const lister = createModelLister({ fetch })
  return {
    stdout: d.stdout,
    stderr: d.stderr,
    isCentral: d.isCentral,
    flagOn: d.flagOn,
    knownEndpoints: OPENAI_COMPATIBLE_ENDPOINTS,
    resolveEndpoint: async (endpointId) => {
      if (!isOpenAICompatibleEndpoint(endpointId)) return { ok: false, reason: 'unknown-endpoint' }
      const read = await readEndpointCredential(endpointId, { dir: d.dir })
      if (!read.ok) {
        const reason = read.reason === 'absent' ? 'not-stored'
          : read.reason === 'wrong-provider' ? 'unknown-endpoint'
          : read.reason
        return { ok: false, reason }
      }
      return { ok: true, endpoint: { baseUrl: read.baseUrl, credential: read.handle } }
    },
    listModels: (args) => lister.list(args),
  }
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export async function runProvider(args: string[], deps: Partial<ProviderCliDeps> = {}): Promise<number> {
  const d: ProviderCliDeps = { ...defaultDeps(), ...deps }

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    d.stdout(HELP)
    return 0
  }

  // `agentop provider models <endpoint>` (B5a.3) — `deps.runModels` overrides it in a test; by default
  // it runs over THIS call's deps (dir, central check, flag, writers), so it refuses exactly where
  // `key` and `try` refuse.
  if (args[0] === 'models') {
    const run = d.runModels ?? ((rest: string[]) => runProviderModels(rest, modelsDepsOf(d)))
    return run(args.slice(1))
  }

  if (args[0] === 'try') {
    try {
      return await runTry(args.slice(1), d)
    } catch (err) {
      d.stderr(`unexpected error: ${err instanceof Error ? err.message : String(err)}`)
      return 1
    }
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

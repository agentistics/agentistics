/**
 * provider-secrets.lint.test.ts — the boundary against a leaked provider API key.
 *
 * Same shape as `billing-detect.test.ts`: needles assembled from string FRAGMENTS at runtime, so
 * this test file never spells a secret-shaped name literally — the source it greps is greppable
 * BECAUSE this file is not the thing it is checking for. Driven by a directory WALK, not a fixed
 * file list, so a module added to the provider layer later is covered by having been created —
 * the `backup-coverage.lint.test.ts` / `capability-guard.test.ts` "guarded by having been added"
 * principle, applied to secret handling instead of route registration.
 *
 * See docs/superpowers/specs/2026-09-25-runtime-b1-provider.md §6.3.2.
 *
 * C1.1 moved most of this directory's provider modules into the standalone `@agentistics/runtime`
 * package (`packages/runtime/src/provider/**`) — `credentials.ts`, `credential-plan.ts` and this
 * test STAY here (they are the host's own key storage; see `runtime-boundary.lint.test.ts` for the
 * companion rule that the runtime may never import them back). The walk below now ALSO covers
 * `packages/runtime/src`, so a moved module stays guarded at its new address rather than quietly
 * dropping out of this test's coverage the moment it left `packages/server`.
 *
 * HOLDERS — the only files that may ever hold the key's value in a variable:
 *   - provider/credentials.ts               (reads/writes the file; wraps in a handle)
 *   - provider/credential-plan.ts           (validates a string it is given; not a storage holder,
 *                                             but receives the value, so it is listed as one)
 *   - runtime src/provider/anthropic/client.ts   (the SDK needs a string — unwraps the handle once;
 *                                             moved from this directory's own `anthropic/client.ts`)
 *   - runtime src/provider/credential.ts    (NEW, C1.2: types only — declares the runtime's own
 *                                             `CredentialHandle` interface, including its
 *                                             `reveal(): string` method signature. It holds no
 *                                             runtime VALUE — nothing in it can produce a real key —
 *                                             but its source text literally spells the Guard 1
 *                                             needle `reveal(` as that method's name, so a plain
 *                                             non-holder scan would trip on the type declaration
 *                                             itself. Listed as a holder for exactly that reason,
 *                                             the same way `credential-plan.ts` is: it receives/
 *                                             names the shape of the value without storing one.)
 *   - runtime src/provider/openai-compatible/client.ts  (B5a.1: builds the Chat Completions bearer
 *                                             header — the one place that endpoint's key is unwrapped)
 *   - runtime src/provider/openai-compatible/models.ts  (B5a.3: its `list()` receives the key as a
 *                                             STRING by contract D5 and builds the same header)
 *   - runtime src/provider/google/client.ts  (B5b.1: builds the Gemini key header — the one place a
 *                                             Google key is unwrapped; `google/usage.ts`, `raw.ts` and
 *                                             `raw-stream.ts` beside it are non-holders and are walked)
 * `cli-provider.ts` receives the typed value from the prompt and hands it to `credentials.ts`; it
 * is not a HOLDER (Guard 1 does not apply to it — its `PROVIDER_KEYS_DIR` doc mention is fine
 * precisely because Guard 1 never scans it), but it is host-facing provider code, so Guards 2 and
 * 3 (no subscription-credential file, no raw env read) apply to it too.
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'

// ── pure checkers ──────────────────────────────────────────────────────────────────────────────

/** Every needle found verbatim (case-sensitive) in `src`. */
export function violations(src: string, needles: readonly string[]): string[] {
  return needles.filter(n => src.includes(n))
}

/** Every needle found in `src`, matched case-insensitively. */
export function violationsCI(src: string, needles: readonly string[]): string[] {
  const hay = src.toLowerCase()
  return needles.filter(n => hay.includes(n.toLowerCase()))
}

/**
 * True when `src` imports the credentials module for anything but its TYPES — a non-holder may
 * hold the `CredentialHandle` type (to type a parameter) but must never import a runtime binding
 * from the one module that can produce a real key.
 */
export function importsRuntimeFromCredentials(src: string): boolean {
  const re = /import\s+([^;\n]*?)\s*from\s*['"](?:\.{1,2}\/)*credentials(?:\.ts)?['"]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const clause = (m[1] ?? '').trim()
    if (!clause.startsWith('type ')) return true
  }
  return false
}

/**
 * True when `src` reads one of `names` out of `process.env` as CODE — `process.env.X`,
 * `process.env['X']` / `["X"]`, or a destructure `{ X } = process.env` / `{ X: y } = process.env`.
 * This is Guard 3 for a DEFINER (below): a module that legitimately reads the environment for other
 * settings may still never read a CREDENTIAL variable out of it.
 */
export function readsCredentialEnv(src: string, names: readonly string[]): string[] {
  return names.filter(n =>
    new RegExp(`process\\.env(?:\\.${n}\\b|\\[\\s*['"\`]${n}['"\`]\\s*\\])`).test(src)
    || new RegExp(`\\{[^}]*\\b${n}\\b[^}]*\\}\\s*=\\s*process\\.env\\b`).test(src))
}

/**
 * True when `src` reads `process.env` as CODE — `process.env.X` / `process.env['X']` — never when
 * the phrase merely appears inside backtick-quoted prose (a doc comment saying a module does NOT
 * read it is not a violation; stripping backtick spans first is what tells the two apart).
 */
// RAW source, no stripping: skipping backtick spans to spare a doc comment would also skip
// `${process.env.X}` inside a template literal, which is a real read. A holder that wants to say it
// does not read the environment says so in words.
export function usesProcessEnv(src: string): boolean {
  return /process\.env\b/.test(src)
}

// ── the walk ────────────────────────────────────────────────────────────────────────────────────

function walk(root: string): string[] {
  if (!existsSync(root)) return []
  const out: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, entry.name)
    if (entry.isDirectory()) out.push(...walk(p))
    else if (entry.isFile() && p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p)
  }
  return out
}

const S_ROOT = join(import.meta.dir, '..')
const PROVIDER_DIR = join(S_ROOT, 'provider')
const CORE_PROVIDER_DIR = join(S_ROOT, '../../core/src/provider')
const JOURNAL_DIR = join(S_ROOT, 'journal')
const CLI_PROVIDER = join(S_ROOT, 'cli-provider.ts')
/** UI.1's `/api/provider` routes. The same RECEIVER role as `cli-provider.ts`: a key arrives in a
 *  PUT body, is handed to `credential-plan.ts` / `credentials.ts`, and is dropped. It imports runtime
 *  bindings from `credentials.ts` (so it cannot be a Guard 1 non-holder) and is held to Guards 2 and
 *  3 exactly as the CLI verb is. It never reveals a handle — keeping a stored key on a base-URL-only
 *  PUT is `rebaseEndpointCredential`, inside the holder. */
const PROVIDER_WEB = join(S_ROOT, 'provider-web.ts')
// C1.1 moved the bulk of the provider layer here; walked too, so a moved module stays covered.
const RUNTIME_SRC_DIR = join(S_ROOT, '../../runtime/src')

const WALKED = [
  ...walk(PROVIDER_DIR),
  ...walk(CORE_PROVIDER_DIR),
  ...walk(JOURNAL_DIR),
  ...walk(RUNTIME_SRC_DIR),
  // B5a.3 — the `models` verb. A NON-holder under Guard 1 in full: it passes the endpoint's handle
  // on unrevealed, so it must never spell `reveal(` or any key-carrying name.
  join(S_ROOT, 'cli-provider-models.ts'),
]

const HOLDERS = [
  join(S_ROOT, 'provider/credentials.ts'),
  join(S_ROOT, 'provider/credential-plan.ts'),
  join(RUNTIME_SRC_DIR, 'provider/anthropic/client.ts'),
  // B5a.1 — unwraps an endpoint's handle into the Chat Completions bearer header, once per call.
  join(RUNTIME_SRC_DIR, 'provider/openai-compatible/client.ts'),
  // B5a.3 — the model lister reveals the endpoint's handle inline into its one request's header.
  join(RUNTIME_SRC_DIR, 'provider/openai-compatible/models.ts'),
  // B5b.1 — unwraps the Google handle into the one key header of each Gemini request, once per call.
  join(RUNTIME_SRC_DIR, 'provider/google/client.ts'),
  // NEW, C1.2 — types-only, but spells `reveal(` as its handle interface's method name. See the
  // "HOLDERS" doc block above for why it is listed rather than exempted.
  join(RUNTIME_SRC_DIR, 'provider/credential.ts'),
  // UI.1: Anthropic's model list (GET /v1/models, not billed) for the web's "test connection". The
  // runtime's lister is OpenAI-shaped (bearer auth) and `@agentistics/runtime` was not this item's to
  // change, so the ONE request that reveals the Anthropic handle lives here, inline in its header.
  join(S_ROOT, 'provider/anthropic-models.ts'),
]

// NOT a holder — see "GUARD 1 EXEMPTION" above. Excluded from Guard 1 only; Guards 2/3 still run
// over it via GUARD_2_3_FILES.

const NON_HOLDERS = WALKED.filter(f => !HOLDERS.includes(f))
const GUARD_2_3_FILES = [...WALKED, CLI_PROVIDER, PROVIDER_WEB]

// ── the DEFINERS (B1.8 sweep, LOW c) ────────────────────────────────────────────────────────────
//
// The files that DEFINE what the guards forbid were never walked: `server/config.ts` (the key
// directory, the key-file function, the subscription-credential paths) and `core/src/providers.ts`
// (the `ProviderId` union). They are walked now. A guard applies to a definer IN FULL unless the
// definer provably cannot satisfy it BY DEFINITION — and then ONLY the needles it defines are
// exempt, each named below with its reason, and a test fails if an exemption stops being used (a
// stale exemption is a hole nobody can see).

interface Definer {
  file: string
  /** Guard 1 needles this file may spell, and why. Empty = Guard 1 applies in full. */
  guard1Defines: Record<string, string>
  /** Guard 2 needles this file may spell, and why. Empty = Guard 2 applies in full. */
  guard2Defines: Record<string, string>
  /** Guard 3 (ANY `process.env` read) cannot apply — the reason; `null` = it applies in full. Guard
   *  3b (no CREDENTIAL variable read) applies to every definer regardless. */
  guard3Exempt: string | null
}

const DEFINERS: readonly Definer[] = [
  {
    file: join(S_ROOT, 'config.ts'),
    guard1Defines: {
      ['PROVIDER_KEYS' + '_DIR']: 'config.ts DEFINES the key directory constant every holder reads',
      ['provider' + '-keys']: "the directory NAME inside that constant's definition",
      ['provider' + 'KeyFile']: 'config.ts DEFINES the one function that turns a provider id into a key path',
    },
    guard2Defines: {
      ['CLAUDE_CREDENTIALS' + '_FILE']: 'config.ts DEFINES the constant (billing-detect reads it; no provider module may)',
      ['.credentials' + '.json']: "the file name inside that constant's definition",
      ['CLAUDE_JSON' + '_FILE']: 'config.ts DEFINES the constant (billing-detect reads it)',
      ['CLAUDE' + '_DIR']: 'config.ts DEFINES the harness data root every adapter reads',
      ['auth' + '.json']: 'config.ts DEFINES the Codex auth-file path (CODEX_AUTH_FILE) billing-detect reads',
      ['billing' + '-detect']: "config.ts's doc comments name the module its billing paths exist for",
    },
    guard3Exempt: 'config.ts is WHERE the environment is read, for dozens of non-credential settings '
      + '(ports, directories, feature flags) — its job, not a leak. Guard 3b still forbids a credential variable.',
  },
  {
    file: join(S_ROOT, '../../core/src/providers.ts'),
    guard1Defines: {},
    guard2Defines: {},
    guard3Exempt: null,
  },
]

// ── needles, assembled from fragments so this file never spells the thing it forbids ───────────

const GUARD1_CS: readonly string[] = [
  'api' + 'Key',
  'PROVIDER_KEYS' + '_DIR',
  'provider' + '-keys',
  'provider' + 'KeyFile',
  'ANTHROPIC_API' + '_KEY',
  'reveal' + '(',
]

const GUARD1_CI: readonly string[] = [
  'x-' + 'api' + '-key',
  'author' + 'ization',
  // B5a — the Chat Completions credential rides a bearer header; only a holder may build one.
  'bear' + 'er',
]

/** billing-detect.test.ts's FORBIDDEN list, rebuilt with the same fragment technique. */
const BILLING_FORBIDDEN: readonly string[] = [
  'access' + 'Token',
  'refresh' + 'Token',
  'email' + 'Address',
  'account' + 'Uuid',
  'organization' + 'Uuid',
  'display' + 'Name',
  'customApiKey' + 'Responses',
  'mcp' + 'OAuth',
  'access' + '_token',
  'refresh' + '_token',
]

const GUARD2_EXTRA: readonly string[] = [
  'CLAUDE_CREDENTIALS' + '_FILE',
  '.credentials' + '.json',
  'claudeAi' + 'Oauth',
  'oauth' + 'Account',
  'CLAUDE_JSON' + '_FILE',
  'CLAUDE' + '_DIR',
  'auth' + '.json',
  'oauth' + '_creds',
  'api' + 'KeyHelper',
  'auth' + 'Token',
  'billing' + '-detect',
  'billing' + 'Detect',
]

const GUARD2: readonly string[] = [...BILLING_FORBIDDEN, ...GUARD2_EXTRA]

/** None in B1 — a future non-secret variable (a feature flag name, say) would be named here. */
const ENV_ALLOWLIST: readonly string[] = []

/** Guard 3b — environment variables that hold (or redirect) a provider CREDENTIAL. No provider module
 *  and no definer may read one: the Anthropic pair (B1) plus the variables the OpenAI SDK family and
 *  the B5a endpoints fall back to — a base URL counts, because redirecting the host a key is sent to
 *  is as good as reading the key. */
const CREDENTIAL_ENV_NAMES: readonly string[] = [
  'ANTHROPIC_API' + '_KEY',
  'ANTHROPIC_BASE' + '_URL',
  'OPENAI_API' + '_KEY',
  'OPENAI_BASE' + '_URL',
  'OPENROUTER_API' + '_KEY',
  'DEEPSEEK_API' + '_KEY',
  // B5b — what Google's SDKs fall back to: the two key variables, the base URL (redirecting the host a
  // key is sent to is as good as reading it), and the service-account file that would be a second,
  // non-key credential kind (a Google subscription/login inside our loop is prohibited, master §22.4).
  'GEMINI_API' + '_KEY',
  'GOOGLE_API' + '_KEY',
  'GOOGLE_GEMINI_BASE' + '_URL',
  'GOOGLE_APPLICATION' + '_CREDENTIALS',
]

// ── a clean fixture the self-tests can measure against ─────────────────────────────────────────

const CLEAN_SOURCE = `
import { createHash } from 'node:crypto'
import type { CredentialHandle } from './credentials.ts'

export function fingerprintOf(value: string): string {
  return \`sha256:\${createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 8)}\`
}
`

describe('provider-secrets.lint — a provider API key never leaves its holders', () => {
  test('non-vacuity: the walk found both existing holders, and cli-provider.ts exists', () => {
    expect(WALKED).toContain(join(S_ROOT, 'provider/credentials.ts'))
    expect(WALKED).toContain(join(S_ROOT, 'provider/credential-plan.ts'))
    expect(existsSync(CLI_PROVIDER)).toBe(true)
    expect(existsSync(PROVIDER_WEB)).toBe(true)
  })

  test('provider-web.ts never reveals a handle and never holds a key past its handler', () => {
    const src = readFileSync(PROVIDER_WEB, 'utf8')
    // It receives a key in a request body but must never unwrap a STORED one: keeping a key on a
    // base-URL-only PUT is the holder's job (`rebaseEndpointCredential`).
    expect(violations(src, ['reveal' + '('])).toEqual([])
    // No header that would carry a key is built here — every request goes through a holder.
    expect(violationsCI(src, ['x-' + 'api' + '-key', 'author' + 'ization', 'bear' + 'er'])).toEqual([])
    // No console output at all: nothing in this module may log a request body.
    expect(/console\.(log|error|warn|info|debug)/.test(src)).toBe(false)
  })

  test('non-vacuity: the B5a client is walked AND listed as a holder', () => {
    expect(WALKED).toContain(join(RUNTIME_SRC_DIR, 'provider/openai-compatible/client.ts'))
    expect(WALKED).toContain(join(RUNTIME_SRC_DIR, 'provider/openai-compatible/raw.ts'))
    expect(HOLDERS).toContain(join(RUNTIME_SRC_DIR, 'provider/openai-compatible/client.ts'))
  })

  test('non-vacuity: the B5b Google client is walked AND listed as a holder; its readers are walked as non-holders', () => {
    for (const f of ['client.ts', 'raw.ts', 'raw-stream.ts', 'usage.ts']) {
      expect(WALKED).toContain(join(RUNTIME_SRC_DIR, 'provider/google', f))
    }
    expect(HOLDERS).toContain(join(RUNTIME_SRC_DIR, 'provider/google/client.ts'))
    expect(HOLDERS).not.toContain(join(RUNTIME_SRC_DIR, 'provider/google/raw.ts'))
  })

  test('non-vacuity: the walk also reaches the moved runtime modules, not only this directory', () => {
    // Without this, a typo in RUNTIME_SRC_DIR (or the package moving again) would silently turn
    // Guards 1-3 into checks that scan nothing under packages/runtime while staying green.
    expect(WALKED).toContain(join(RUNTIME_SRC_DIR, 'provider/anthropic/client.ts'))
    expect(WALKED).toContain(join(RUNTIME_SRC_DIR, 'provider/emit.ts'))
    expect(WALKED).toContain(join(RUNTIME_SRC_DIR, 'provider/credential.ts'))
    expect(HOLDERS).toContain(join(RUNTIME_SRC_DIR, 'provider/anthropic/client.ts'))
    expect(HOLDERS).toContain(join(RUNTIME_SRC_DIR, 'provider/credential.ts'))
  })

  test('self-test: Guard 1 needles each trip alone, and a clean source trips nothing', () => {
    for (const needle of GUARD1_CS) {
      expect(violations(`const x = '${needle}'`, GUARD1_CS)).toEqual([needle])
    }
    for (const needle of GUARD1_CI) {
      expect(violationsCI(`const X = '${needle.toUpperCase()}'`, GUARD1_CI)).toEqual([needle])
    }
    expect(violations(CLEAN_SOURCE, GUARD1_CS)).toEqual([])
    expect(violationsCI(CLEAN_SOURCE, GUARD1_CI)).toEqual([])
    expect(importsRuntimeFromCredentials(CLEAN_SOURCE)).toBe(false)
    expect(importsRuntimeFromCredentials(`import { X } from './credentials'`)).toBe(true)
    expect(importsRuntimeFromCredentials(`import { X } from '../credentials.ts'`)).toBe(true)
    expect(importsRuntimeFromCredentials(`import type { X } from './credentials'`)).toBe(false)
  })

  test('self-test: Guard 2 needles each trip alone, and a clean source trips nothing', () => {
    for (const needle of GUARD2) {
      expect(violations(`// ${needle}`, GUARD2)).toEqual([needle])
    }
    expect(violations(CLEAN_SOURCE, GUARD2)).toEqual([])
  })

  test('self-test: Guard 3 catches real reads and ignores backtick-quoted prose', () => {
    expect(usesProcessEnv(CLEAN_SOURCE)).toBe(false)
    expect(usesProcessEnv("const k = process.env.ANTHROPIC_API_KEY")).toBe(true)
    expect(usesProcessEnv("const k = process.env['ANTHROPIC_API_KEY']")).toBe(true)
    expect(usesProcessEnv('const { KEY } = process.env')).toBe(true)
    // A template literal is source, not prose — stripping backtick spans would miss this read.
    expect(usesProcessEnv('const k = `${process.env.KEY}`')).toBe(true)
  })

  test('Guard 1: no non-holder names the key, or imports it as a runtime value', () => {
    for (const file of NON_HOLDERS) {
      const src = readFileSync(file, 'utf8')
      expect({ file, cs: violations(src, GUARD1_CS) }).toEqual({ file, cs: [] })
      expect({ file, ci: violationsCI(src, GUARD1_CI) }).toEqual({ file, ci: [] })
      expect({ file, importsCredentials: importsRuntimeFromCredentials(src) })
        .toEqual({ file, importsCredentials: false })
    }
  })

  test('Guard 2: no provider module can reach a subscription credential', () => {
    for (const file of GUARD_2_3_FILES) {
      const src = readFileSync(file, 'utf8')
      expect({ file, hits: violations(src, GUARD2) }).toEqual({ file, hits: [] })
    }
  })

  test('self-test: Guard 3b catches every read shape of a credential variable, and only those', () => {
    const k = 'OPENAI_API' + '_KEY'
    expect(readsCredentialEnv(`const a = process.env.${k}`, CREDENTIAL_ENV_NAMES)).toEqual([k])
    expect(readsCredentialEnv(`const a = process.env['${k}']`, CREDENTIAL_ENV_NAMES)).toEqual([k])
    expect(readsCredentialEnv(`const { ${k}: a } = process.env`, CREDENTIAL_ENV_NAMES)).toEqual([k])
    expect(readsCredentialEnv(`const a = process.env.${k}_OLD`, CREDENTIAL_ENV_NAMES)).toEqual([])
    expect(readsCredentialEnv('const a = process.env.PORT', CREDENTIAL_ENV_NAMES)).toEqual([])
    expect(readsCredentialEnv(`// never reads ${k}`, CREDENTIAL_ENV_NAMES)).toEqual([])
  })

  test('non-vacuity: the definers are walked, and every exemption is still used', () => {
    for (const d of DEFINERS) {
      expect(existsSync(d.file)).toBe(true)
      const src = readFileSync(d.file, 'utf8')
      for (const needle of [...Object.keys(d.guard1Defines), ...Object.keys(d.guard2Defines)]) {
        expect({ file: d.file, needle, used: src.includes(needle) }).toEqual({ file: d.file, needle, used: true })
      }
    }
  })

  test('Guards 1-3 over the DEFINERS, minus only the needles each one defines', () => {
    for (const d of DEFINERS) {
      const src = readFileSync(d.file, 'utf8')
      const g1 = GUARD1_CS.filter(n => !(n in d.guard1Defines))
      const g2 = GUARD2.filter(n => !(n in d.guard2Defines))
      expect({ file: d.file, cs: violations(src, g1) }).toEqual({ file: d.file, cs: [] })
      expect({ file: d.file, ci: violationsCI(src, GUARD1_CI) }).toEqual({ file: d.file, ci: [] })
      expect({ file: d.file, g2: violations(src, g2) }).toEqual({ file: d.file, g2: [] })
      if (d.guard3Exempt === null) {
        expect({ file: d.file, hasRawRead: usesProcessEnv(src) }).toEqual({ file: d.file, hasRawRead: false })
      }
    }
  })

  test('Guard 3b: no provider module and no definer reads a credential variable from the environment', () => {
    for (const file of [...GUARD_2_3_FILES, ...DEFINERS.map(d => d.file)]) {
      const src = readFileSync(file, 'utf8')
      expect({ file, reads: readsCredentialEnv(src, CREDENTIAL_ENV_NAMES) }).toEqual({ file, reads: [] })
    }
  })

  test('Guard 3: no provider module reads the environment for a credential', () => {
    for (const file of GUARD_2_3_FILES) {
      const src = readFileSync(file, 'utf8')
      const hasRawRead = usesProcessEnv(src)
      // The allowlist can only ever narrow a hit down to nothing; it is empty in B1, so any real
      // `process.env` read here is unconditionally a violation.
      expect({ file, hasRawRead, allowlisted: ENV_ALLOWLIST.length > 0 })
        .toEqual({ file, hasRawRead: false, allowlisted: false })
    }
  })
})

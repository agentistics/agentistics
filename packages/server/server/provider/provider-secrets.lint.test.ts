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
 * HOLDERS — the only files that may ever hold the key's value in a variable:
 *   - provider/credentials.ts        (reads/writes the file; wraps in a handle)
 *   - provider/credential-plan.ts    (validates a string it is given; not a storage holder, but
 *                                      receives the value, so it is listed as one for the guard)
 *   - provider/anthropic/client.ts   (the SDK needs a string — unwraps the handle once)
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

const WALKED = [...walk(PROVIDER_DIR), ...walk(CORE_PROVIDER_DIR), ...walk(JOURNAL_DIR)]

const HOLDERS = [
  join(S_ROOT, 'provider/credentials.ts'),
  join(S_ROOT, 'provider/credential-plan.ts'),
  join(S_ROOT, 'provider/anthropic/client.ts'),
]

const NON_HOLDERS = WALKED.filter(f => !HOLDERS.includes(f))
const GUARD_2_3_FILES = [...WALKED, CLI_PROVIDER]

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

/**
 * runtime-boundary.lint.test.ts — Decision D23: `@agentistics/runtime` may NEVER import from
 * `packages/server` or `packages/web`.
 *
 * The runtime is compiled into the single `agentop` binary AND published on its own
 * (`@agentistics/runtime`'s `package.json` has no dependency on either sibling package) — an
 * import that reaches into `packages/server` or `packages/web` compiles fine inside this monorepo
 * (a relative path resolves) and then breaks the standalone package the moment it is published,
 * or drags a Bun/Node-only, host-specific module into code that must stay host-agnostic (the same
 * class of defect `CLAUDE.md` already calls out for `packages/server` importing `packages/web`).
 * `index.ts`'s own docstring states the rule; this file is what enforces it.
 *
 * Same shape as `provider-secrets.lint.test.ts` (this package's neighbour before the move) and
 * `tokens.lint.test.ts`: pure checker functions, exported and self-tested against planted needles
 * and a clean fixture, then run for real over a directory WALK — so a file added to the runtime
 * later is covered by having been created, never by someone remembering to list it.
 *
 * Two import forms are forbidden:
 *
 *  1. **A bare specifier naming `@agentistics/server` or `@agentistics/web`** (the package itself,
 *     or any subpath of it) — `@agentistics/core` is NOT forbidden; the runtime already depends on
 *     it (`package.json`) and it is the one shared package a runtime and a host may both import.
 *  2. **A relative specifier that resolves outside `packages/runtime`, at all** — not only into
 *     `packages/server`/`packages/web`. `packages/core` is included in this refusal on purpose
 *     (see DECISION below): the runtime already has `@agentistics/core` as a real npm dependency,
 *     so a relative reach into `../../core/src/...` has a correct alternative and no reason to
 *     exist. Refusing every escape, rather than naming server/web as the only forbidden
 *     destinations, means a NEW sibling package added next year is covered by the same rule
 *     without this file needing to learn its name.
 *
 * DECISION (asked for explicitly in the C1.2 task): relative escapes into `packages/core` ARE
 * refused, same as server/web. A relative import climbing out of `packages/runtime` has, by
 * construction, no reason to exist that `@agentistics/<pkg>` cannot express instead — `core` is a
 * workspace dependency precisely so the runtime never needs to know where its source lives on
 * disk. Allowing "escape into core, refuse escape into server/web" would need this file to special
 * -case core forever and would still miss the next new package; refusing every escape needs no
 * maintenance and matches D23's own wording ("may never import from packages/server or
 * packages/web") read as "the runtime imports nothing by relative path outside itself".
 */
import { describe, test, expect } from 'bun:test'
import { readdirSync, readFileSync, existsSync } from 'fs'
import { dirname, join, relative, resolve, sep } from 'path'

// ── pure checkers ──────────────────────────────────────────────────────────────────────────────

/**
 * Every module specifier `src` reaches for — `import ... from '...'`, `export ... from '...'`
 * (named or `export * from`), a dynamic `import('...')`, a `require('...')`, and a side-effect-only
 * `import '...'` with no `from` clause at all. Four small regexes rather than one clever one, on
 * purpose: each targets exactly one syntax form and is easy to read back against the form it names,
 * the same trade-off `tokens.lint.test.ts` makes for its two-term-sum regex over a single
 * do-everything AST walk this package does not otherwise need.
 */
export function importSpecifiers(src: string): string[] {
  const specs: string[] = []
  const patterns: RegExp[] = [
    /\bfrom\s*(['"])([^'"]+)\1/g, // import ... from '...'; export {..}/* from '...'
    /\bimport\s*\(\s*(['"])([^'"]+)\1/g, // dynamic import('...')
    /\brequire\s*\(\s*(['"])([^'"]+)\1/g, // require('...')
    /\bimport\s*(['"])([^'"]+)\1/g, // side-effect only: import '...' (no `from`)
  ]
  for (const re of patterns) {
    let m: RegExpExecArray | null
    while ((m = re.exec(src))) specs.push(m[2])
  }
  return specs
}

export interface BoundaryViolation {
  specifier: string
  reason: string
}

const FORBIDDEN_PACKAGES: readonly string[] = ['@agentistics/server', '@agentistics/web']

/**
 * Classifies one specifier written inside `fromFile`. `runtimeRoot` is `packages/runtime` — the
 * one directory a relative import may never resolve outside of (see DECISION above).
 */
export function classifySpecifier(
  specifier: string,
  fromFile: string,
  runtimeRoot: string
): BoundaryViolation | null {
  for (const pkg of FORBIDDEN_PACKAGES) {
    if (specifier === pkg || specifier.startsWith(`${pkg}/`)) {
      return { specifier, reason: `imports the forbidden package "${pkg}"` }
    }
  }
  if (specifier.startsWith('.')) {
    const resolved = resolve(dirname(fromFile), specifier)
    const rel = relative(runtimeRoot, resolved)
    const escapes = rel === '..' || rel.startsWith(`..${sep}`)
    if (escapes) {
      return {
        specifier,
        reason: `relative import escapes packages/runtime (resolves to ${resolved})`,
      }
    }
  }
  return null
}

/** Every violation in one file's source. */
export function boundaryViolations(src: string, fromFile: string, runtimeRoot: string): BoundaryViolation[] {
  const out: BoundaryViolation[] = []
  for (const spec of importSpecifiers(src)) {
    const v = classifySpecifier(spec, fromFile, runtimeRoot)
    if (v) out.push(v)
  }
  return out
}

// ── the walk ───────────────────────────────────────────────────────────────────────────────────

const RUNTIME_ROOT = import.meta.dir
// The one file this lint test excludes from its own walk: it is the checker, not code under
// test, and its self-tests deliberately construct fixture strings that LOOK like violations (built
// from fragments below so the raw source of this file never itself spells a matchable
// `from '...'`/`import '...'` pointing outside the package — belt AND suspenders).
const SELF = join(import.meta.dir, 'runtime-boundary.lint.test.ts')

function walk(root: string): string[] {
  if (!existsSync(root)) return []
  const out: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue
      out.push(...walk(p))
      continue
    }
    if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name) && p !== SELF) out.push(p)
  }
  return out
}

const ALL_FILES = walk(RUNTIME_ROOT)

// ── fixtures, built from fragments so this file's own source never spells a real violating
//    import — the same technique `provider-secrets.lint.test.ts` uses for secret-shaped needles ──

const AT = '@'
const SERVER_PKG = `${AT}agentistics/server`
const WEB_PKG = `${AT}agentistics/web`
const UP = '..'
const SEP = '/'
const ESCAPE_TO_SERVER = [UP, UP, 'server', 'server', 'config.ts'].join(SEP) // -> packages/server/server/config.ts
const ESCAPE_TO_CORE = [UP, UP, 'core', 'src', 'types.ts'].join(SEP) // -> packages/core/src/types.ts
const STAY_INSIDE = ['.', 'provider', 'client.ts'].join(SEP) // -> packages/runtime/src/provider/client.ts (from src/index.ts)

const FROM = 'from'
const Q = "'"

/** Assembles `import { X } ${FROM} '<spec>'` without ever writing that phrase as one literal. */
function fakeNamedImport(spec: string): string {
  return ['import', '{', 'X', '}', FROM, `${Q}${spec}${Q}`].join(' ')
}
function fakeSideEffectImport(spec: string): string {
  return ['import', `${Q}${spec}${Q}`].join(' ')
}
const DYNAMIC_IMPORT_KEYWORD = 'im' + 'port'
const REQUIRE_KEYWORD = 'requi' + 're'
function fakeDynamicImport(spec: string): string {
  return `${DYNAMIC_IMPORT_KEYWORD}(${Q}${spec}${Q})`
}
function fakeRequire(spec: string): string {
  return `${REQUIRE_KEYWORD}(${Q}${spec}${Q})`
}

const CLEAN_SOURCE = `
import type { ProviderId } from '@agentistics/core'
import { createAnthropicClient } from './anthropic/client.ts'
export type { ProviderId }
`

describe('runtime-boundary.lint — @agentistics/runtime never imports packages/server or packages/web (D23)', () => {
  test('non-vacuity: the walk found more than a handful of files, including index.ts and the anthropic client', () => {
    expect(ALL_FILES.length).toBeGreaterThan(5)
    expect(ALL_FILES).toContain(join(RUNTIME_ROOT, 'src/index.ts'))
    expect(ALL_FILES).toContain(join(RUNTIME_ROOT, 'src/provider/anthropic/client.ts'))
    expect(ALL_FILES).toContain(join(RUNTIME_ROOT, 'src/provider/emit.ts'))
    expect(ALL_FILES).not.toContain(SELF)
  })

  test('self-test: importSpecifiers finds every syntax form and nothing else', () => {
    expect(importSpecifiers(fakeNamedImport('@agentistics/core'))).toEqual(['@agentistics/core'])
    expect(importSpecifiers(`export * ${FROM} ${Q}./retry.ts${Q}`)).toEqual(['./retry.ts'])
    expect(importSpecifiers(`export type { X } ${FROM} ${Q}./client.ts${Q}`)).toEqual(['./client.ts'])
    expect(importSpecifiers(fakeSideEffectImport('./polyfill.ts'))).toEqual(['./polyfill.ts'])
    expect(importSpecifiers(fakeDynamicImport('./lazy.ts'))).toEqual(['./lazy.ts'])
    expect(importSpecifiers(fakeRequire('./legacy.ts'))).toEqual(['./legacy.ts'])
    expect(importSpecifiers(CLEAN_SOURCE)).toEqual(['@agentistics/core', './anthropic/client.ts'])
    expect(importSpecifiers('const x = 1')).toEqual([])
  })

  test('self-test: rule 1 (forbidden package) trips on @agentistics/server and @agentistics/web, and their subpaths, and nothing else', () => {
    const fromFile = join(RUNTIME_ROOT, 'src/index.ts')
    expect(classifySpecifier(SERVER_PKG, fromFile, RUNTIME_ROOT)?.reason).toMatch(/forbidden package/)
    expect(classifySpecifier(WEB_PKG, fromFile, RUNTIME_ROOT)?.reason).toMatch(/forbidden package/)
    expect(classifySpecifier(`${SERVER_PKG}/server/config.ts`, fromFile, RUNTIME_ROOT)?.reason).toMatch(
      /forbidden package/
    )
    expect(classifySpecifier(`${WEB_PKG}/src/App.tsx`, fromFile, RUNTIME_ROOT)?.reason).toMatch(
      /forbidden package/
    )
    // A package merely starting with the same prefix is NOT the same package.
    expect(classifySpecifier(`${AT}agentistics/serverish`, fromFile, RUNTIME_ROOT)).toBeNull()
    expect(classifySpecifier('@agentistics/core', fromFile, RUNTIME_ROOT)).toBeNull()
  })

  test('self-test: rule 2 (relative escape) trips leaving packages/runtime for server OR core, never for a specifier staying inside', () => {
    const fromFile = join(RUNTIME_ROOT, 'src/index.ts')
    const toServer = classifySpecifier(ESCAPE_TO_SERVER, fromFile, RUNTIME_ROOT)
    expect(toServer?.reason).toMatch(/escapes packages\/runtime/)
    expect(toServer?.reason).toContain(join(RUNTIME_ROOT, '..', 'server', 'server', 'config.ts'))

    // DECISION: a relative escape into packages/core is refused too, not only server/web.
    const toCore = classifySpecifier(ESCAPE_TO_CORE, fromFile, RUNTIME_ROOT)
    expect(toCore?.reason).toMatch(/escapes packages\/runtime/)

    expect(classifySpecifier(STAY_INSIDE, fromFile, RUNTIME_ROOT)).toBeNull()
    // A bare package specifier that is not server/web is untouched by rule 2 even though it is not
    // relative — rule 2 only ever looks at specifiers starting with '.'.
    expect(classifySpecifier('@agentistics/core', fromFile, RUNTIME_ROOT)).toBeNull()
  })

  test('self-test: boundaryViolations composes both rules over a whole source, and a clean source trips nothing', () => {
    const fromFile = join(RUNTIME_ROOT, 'src/index.ts')
    const dirty = [fakeNamedImport(SERVER_PKG), fakeNamedImport(ESCAPE_TO_CORE)].join('\n')
    const violations = boundaryViolations(dirty, fromFile, RUNTIME_ROOT)
    expect(violations.map(v => v.specifier)).toEqual([SERVER_PKG, ESCAPE_TO_CORE])
    expect(boundaryViolations(CLEAN_SOURCE, fromFile, RUNTIME_ROOT)).toEqual([])
  })

  test('every real file under packages/runtime stays inside the boundary', () => {
    const offences: Array<{ file: string; violations: BoundaryViolation[] }> = []
    for (const file of ALL_FILES) {
      const src = readFileSync(file, 'utf8')
      const v = boundaryViolations(src, file, RUNTIME_ROOT)
      if (v.length > 0) offences.push({ file: relative(RUNTIME_ROOT, file), violations: v })
    }
    expect(offences).toEqual([])
  })
})

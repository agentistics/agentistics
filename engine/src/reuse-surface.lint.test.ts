/**
 * reuse-surface.lint — spec §6, held over the SOURCE: the engine imports `@agentistics/core`,
 * `@agentistics/engine-api` and its own `@agentistics/runtime`, and NOTHING ELSE of the public tree.
 *
 * Every other public function arrives through `reuse.ts` (backed by `host.readers`, contract 1.2),
 * every machine fact through `host.ts`. NO production file is exempt — the transitional
 * `public-bridge.ts` is gone, and a test below keeps it gone. The exceptions are named here, each
 * with its reason:
 *   - the PROOFS — `projections/differential*`, `parity-matrix`, `p3-fixture-events` and the
 *     scripts — compare the integrations against the public legacy readers BY DEFINITION;
 *   - tests, which may read the public tree to prove a contract against it.
 *
 * A relative import that climbs out of this repository is refused everywhere: it would compile in
 * an overlaid checkout and break in a standalone one, silently.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { Glob } from 'bun'

const ENGINE = resolve(import.meta.dir, '..')
const REPO = resolve(ENGINE, '..')

const ALLOWED_PACKAGES = ['@agentistics/core', '@agentistics/engine-api', '@agentistics/runtime']
const GONE_BRIDGE = 'src/public-bridge.ts'
const isProof = (f: string) =>
  /^src\/projections\/(differential[^/]*|parity-matrix|p3-fixture-events)\.ts$/.test(f) || f.startsWith('scripts/')
const isTest = (f: string) => f.endsWith('.test.ts') || f.startsWith('test/')

function specifiers(src: string): string[] {
  const out: string[] = []
  for (const m of src.matchAll(/^\s*(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm)) out.push(m[1]!)
  for (const m of src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]!)
  return out
}

const FILES = [...new Glob('{src,scripts,test}/**/*.ts').scanSync(ENGINE)].filter(f => !f.startsWith('test/fixtures/'))

describe('reuse-surface.lint — the engine reaches the public tree only through the contract', () => {
  test('non-vacuity: the walk sees the integrations, the provider verb and the reuse module', () => {
    expect(FILES).toContain('src/integrations/claude/index.ts')
    expect(FILES).toContain('src/cli-provider.ts')
    expect(FILES).toContain('src/reuse.ts')
  })

  test('no production file imports the public server tree, or any public package but the allowed ones', () => {
    const bad: string[] = []
    for (const f of FILES) {
      if (isProof(f) || isTest(f)) continue
      for (const s of specifiers(readFileSync(join(ENGINE, f), 'utf8'))) {
        if (!s.startsWith('@agentistics/')) continue
        const pkg = s.split('/').slice(0, 2).join('/')
        if (!ALLOWED_PACKAGES.includes(pkg)) bad.push(`${f}: ${s}`)
      }
    }
    expect(bad).toEqual([])
  })

  test('no file climbs out of this repository with a relative import', () => {
    const bad: string[] = []
    for (const f of FILES) {
      const abs = join(ENGINE, f)
      for (const s of specifiers(readFileSync(abs, 'utf8'))) {
        if (!s.startsWith('.')) continue
        if (relative(REPO, resolve(dirname(abs), s)).startsWith('..')) bad.push(`${f}: ${s}`)
      }
    }
    expect(bad).toEqual([])
  })

  test('the transitional bridge stays deleted — the host hands the surface over (contract 1.2)', () => {
    expect(FILES).not.toContain(GONE_BRIDGE)
  })

  test('the engine reads no environment — the host is where the machine is read', () => {
    const bad: string[] = []
    for (const f of FILES) {
      if (isProof(f) || isTest(f)) continue
      const code = readFileSync(join(ENGINE, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      if (/process\.env\b/.test(code)) bad.push(f)
    }
    expect(bad).toEqual([])
  })
})

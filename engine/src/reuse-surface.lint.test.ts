/**
 * reuse-surface.lint — spec §6, held over the SOURCE: the engine imports `@agentistics/core`,
 * `@agentistics/engine-api` and its own `@agentistics/runtime`, and NOTHING ELSE of the public tree.
 *
 * Every other public function arrives through `reuse.ts` (backed by `host.readers`, or for now the
 * transitional `public-bridge.ts`), every machine fact through `host.ts`. The exceptions are named
 * here, each with its reason, and a stale exception fails too (an exemption nobody uses is a hole
 * nobody can see):
 *   - `public-bridge.ts` — the ONE production file allowed to, until the contract carries the
 *     surface (it says so at its top);
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
const BRIDGE = 'src/public-bridge.ts'
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
  test('non-vacuity: the walk sees the integrations, the provider verb and the bridge', () => {
    expect(FILES).toContain('src/integrations/claude/index.ts')
    expect(FILES).toContain('src/cli-provider.ts')
    expect(FILES).toContain(BRIDGE)
  })

  test('no production file imports the public server tree, or any public package but the allowed ones', () => {
    const bad: string[] = []
    for (const f of FILES) {
      if (f === BRIDGE || isProof(f) || isTest(f)) continue
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

  test('the bridge is still needed: it imports the public tree (else delete it and this exemption)', () => {
    expect(specifiers(readFileSync(join(ENGINE, BRIDGE), 'utf8')).some(s => s.startsWith('@agentistics/server/'))).toBe(true)
  })

  test('the engine reads no environment outside the bridge — the host is where the machine is read', () => {
    const bad: string[] = []
    for (const f of FILES) {
      if (f === BRIDGE || isProof(f) || isTest(f)) continue
      const code = readFileSync(join(ENGINE, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      if (/process\.env\b/.test(code)) bad.push(f)
    }
    expect(bad).toEqual([])
  })
})

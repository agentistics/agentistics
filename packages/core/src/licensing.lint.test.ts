import { describe, expect, it } from 'bun:test'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

/**
 * The licence map in `LICENSING.md`, kept true by the build.
 *
 * Two licences live in this repository. The platform is FSL-1.1-ALv2. A package is Apache-2.0 only
 * when it is integration surface (the hub contract, an SDK, an adapter SDK), and one that bundles
 * FSL code is not really Apache: `@agentistics/mcp` could not be Apache, because its published
 * `dist/` inlines `@agentistics/core`. So two things are asserted, over every workspace package:
 *
 *  1. **every package declares a licence, and only one of the two.** A package with no `license`
 *     field is publishable with no stated terms — `@agentistics/runtime` was exactly that until the
 *     relicense.
 *  2. **an Apache-2.0 package depends on no FSL workspace package** — neither declared in
 *     `dependencies` / `peerDependencies` / `devDependencies` NOR imported from its source. The
 *     second half is the one that matters: workspace packages resolve without being declared, which
 *     is precisely how `@agentistics/mcp` imports `@agentistics/core` with only the MCP SDK in its
 *     `dependencies`. A bundler inlines whatever is imported. The root package (`agentistics`) is
 *     FSL like the platform, and is checked like any other.
 *  3. **an Apache-2.0 package imports nothing by a relative path that leaves its own directory** —
 *     `../../core/src/types` reaches FSL code without ever naming `@agentistics/core`, so the check
 *     above alone would pass it.
 *  4. **an Apache-2.0 package carries its own `LICENSE` with the Apache text** — the root LICENSE
 *     is FSL, so a package without one ships under the wrong text.
 */

const ROOT = join(import.meta.dir, '..', '..', '..')
const ALLOWED = new Set(['FSL-1.1-ALv2', 'Apache-2.0'])

interface Pkg {
  dir: string
  name: string
  license?: string
  deps: string[]
}

function readPkg(dir: string): Pkg {
  const json = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>
  const deps = ['dependencies', 'peerDependencies', 'devDependencies'].flatMap((k) =>
    Object.keys((json[k] as Record<string, string> | undefined) ?? {}),
  )
  return { dir, name: String(json.name), license: json.license as string | undefined, deps }
}

const IMPORT = /(?:from|import)\s*\(?\s*['"](@agentistics\/[a-z0-9-]+)/g
const RELATIVE = /(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]*)['"]/g

/** PURE. The relative specifiers in `text` (a file in `fileDir`) that resolve outside `pkgDir`. */
export function escapingImports(text: string, fileDir: string, pkgDir: string): string[] {
  const root = resolve(pkgDir)
  const out: string[] = []
  for (const m of text.matchAll(RELATIVE)) {
    const spec = m[1]
    if (!spec) continue
    const target = resolve(fileDir, spec)
    if (target !== root && !target.startsWith(root + sep)) out.push(spec)
  }
  return out
}

/** Source files of a package (tests, dist and node_modules excluded). */
function sourceFiles(dir: string): string[] {
  const files: string[] = []
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(ts|tsx|js|mjs)$/.test(e.name) && !/\.test\.(ts|tsx)$/.test(e.name)) files.push(p)
    }
  }
  walk(dir)
  return files
}

/** Every `@agentistics/<pkg>` a package's own source imports (tests, dist and node_modules excluded). */
function importedWorkspacePackages(dir: string): string[] {
  const found = new Set<string>()
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(ts|tsx|js|mjs)$/.test(e.name) && !/\.test\.(ts|tsx)$/.test(e.name)) {
        for (const m of readFileSync(p, 'utf8').matchAll(IMPORT)) if (m[1]) found.add(m[1])
      }
    }
  }
  if (relative(ROOT, dir) !== '') walk(dir)
  return [...found]
}

function workspacePackages(): Pkg[] {
  const pkgsDir = join(ROOT, 'packages')
  const dirs = readdirSync(pkgsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(pkgsDir, d.name, 'package.json')))
    .map((d) => join(pkgsDir, d.name))
  return [readPkg(ROOT), ...dirs.map(readPkg)]
}

describe('licensing map', () => {
  const pkgs = workspacePackages()
  const byName = new Map(pkgs.map((p) => [p.name, p]))

  it('finds the workspace packages', () => {
    expect(pkgs.length).toBeGreaterThan(5)
  })

  for (const pkg of pkgs) {
    it(`${pkg.name} declares FSL-1.1-ALv2 or Apache-2.0`, () => {
      expect(ALLOWED.has(pkg.license ?? '')).toBe(true)
    })

    if (pkg.license === 'Apache-2.0') {
      it(`${pkg.name} (Apache-2.0) depends on no FSL workspace package`, () => {
        const used = new Set([...pkg.deps, ...importedWorkspacePackages(pkg.dir)])
        const fsl = [...used].filter((d) => byName.get(d)?.license === 'FSL-1.1-ALv2')
        expect(fsl).toEqual([])
      })

      it(`${pkg.name} (Apache-2.0) imports nothing outside its own directory by a relative path`, () => {
        const escaping = sourceFiles(pkg.dir).flatMap((f) =>
          escapingImports(readFileSync(f, 'utf8'), dirname(f), pkg.dir).map((s) => `${relative(pkg.dir, f)}: ${s}`),
        )
        expect(escaping).toEqual([])
      })

      it(`${pkg.name} (Apache-2.0) carries its own Apache-2.0 LICENSE`, () => {
        const file = join(pkg.dir, 'LICENSE')
        expect(existsSync(file)).toBe(true)
        const text = readFileSync(file, 'utf8')
        expect(text).toContain('Apache License')
        expect(text).toContain('Version 2.0, January 2004')
      })
    }
  }

  it('@agentistics/engine-api is Apache-2.0 — the contract a third party codes an engine against', () => {
    expect(byName.get('@agentistics/engine-api')?.license).toBe('Apache-2.0')
  })

  it('sees a relative import that leaves the package', () => {
    const pkgDir = join(ROOT, 'packages', 'engine-api')
    const fileDir = join(pkgDir, 'src')
    const text = [
      "import { a } from './version'",
      "import type { B } from '../../core/src/types'",
      "export * from '../src/engine'",
      "const c = await import('../../server/server/limits')",
    ].join('\n')
    expect(escapingImports(text, fileDir, pkgDir)).toEqual(['../../core/src/types', '../../server/server/limits'])
  })

  it('sees the imports an undeclared workspace dependency hides', () => {
    const mcp = byName.get('@agentistics/mcp')
    expect(mcp).toBeDefined()
    expect(importedWorkspacePackages(mcp!.dir)).toContain('@agentistics/core')
  })

  it('the root LICENSE is the FSL-1.1-ALv2 text', () => {
    const text = readFileSync(join(ROOT, 'LICENSE'), 'utf8')
    expect(text).toContain('Functional Source License, Version 1.1, ALv2 Future License')
    expect(text).not.toContain('${')
  })
})

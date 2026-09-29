import { describe, expect, it } from 'bun:test'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'

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
    }
  }

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

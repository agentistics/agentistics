/**
 * S1a changes NOTHING a user can see: evidence.ts is a pure module with no importer in the product yet (the doors
 * arrive in S1c, the guard in S2a). Proof is structural (no product file imports it) and behavioural (the module
 * performs no IO of its own and touches no store).
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const SERVER = join(import.meta.dir, '..')

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (n === 'node_modules') continue
    const p = join(dir, n)
    if (statSync(p).isDirectory()) walk(p, out); else if (p.endsWith('.ts')) out.push(p)
  }
  return out
}

describe('S1a is inert', () => {
  test('STRUCTURE: no non-test product file imports delivery/evidence', () => {
    const offenders = walk(SERVER)
      .filter((f) => !/\.test\.ts$/.test(f) && !f.endsWith('delivery/evidence.ts'))
      .filter((f) => /from\s+['"][^'"]*\/evidence['"]|['"]\.\/evidence['"]/.test(readFileSync(f, 'utf8')) && /delivery\/evidence|\.\/evidence/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SERVER, f))
    expect(offenders).toEqual([])
  })

  test('PURE: evidence.ts imports only node:crypto — no fs, no child_process, no store, no clock', () => {
    const src = readFileSync(join(SERVER, 'delivery/evidence.ts'), 'utf8')
    const imports = [...src.matchAll(/^import .* from ['"]([^'"]+)['"]/gm)].map((m) => m[1])
    expect(imports).toEqual(['node:crypto'])
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(code).not.toMatch(/\bDate\.now\b|new Date\(|process\.|fetch\(|Bun\./)
  })

  test('BEHAVIOUR: calling the validators creates no file and needs no data dir', async () => {
    const { buildEvidenceItem } = await import('./evidence')
    const before = readdirSync(process.cwd()).sort()
    const r = buildEvidenceItem({ kind: 'probe', probe: { kind: 'bundle', literal: 'a-literal-of-12+' } }, { revision: 1, headSha: null, treeClean: true, by: 'x', at: 't', items: [] })
    expect(r.ok).toBe(true)
    expect(readdirSync(process.cwd()).sort()).toEqual(before)
  })
})

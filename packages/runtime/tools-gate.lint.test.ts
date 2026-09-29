/**
 * tools-gate.lint.test.ts — the policy gate has no side door (B3 hard rule: every write and every
 * shell command goes through the policy before it runs).
 *
 * Two structural claims, checked over a WALK of `src/` so a file added later is covered by having
 * been created:
 *
 *  1. `mintGrant` is imported by `src/tools/gate.ts` and nothing else outside tests — only the gate
 *     turns an `allow` verdict into the token a tool demands.
 *  2. `.execute(` is called only in `src/tools/gate.ts` outside tests — nothing runs a tool except
 *     through the gate. (`define.ts` DECLARES `execute`; declaring is not calling.)
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'fs'
import { join, relative } from 'path'

export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

export function importsMintGrant(src: string): boolean {
  return /\bimport\s*\{[^}]*\bmintGrant\b[^}]*\}\s*from/.test(stripComments(src))
}

export function callsExecute(src: string): boolean {
  return /\.execute\s*\(/.test(stripComments(src))
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(d =>
    d.isDirectory() ? walk(join(dir, d.name)) : d.name.endsWith('.ts') ? [join(dir, d.name)] : [])
}

describe('tools gate lint — checkers', () => {
  test('finds the needles and ignores comments', () => {
    expect(importsMintGrant(`import { mintGrant } from './grant.ts'`)).toBe(true)
    expect(importsMintGrant(`// import { mintGrant } from './grant.ts'`)).toBe(false)
    expect(callsExecute(`await tool.execute(input, ctx, g)`)).toBe(true)
    expect(callsExecute(`/* tool.execute(x) */ const a = 1`)).toBe(false)
  })
})

describe('tools gate lint — src/', () => {
  const root = join(import.meta.dir, 'src')
  const files = walk(root).filter(f => !f.endsWith('.test.ts'))

  test('only the gate mints grants', () => {
    const offenders = files.filter(f => importsMintGrant(readFileSync(f, 'utf8'))).map(f => relative(root, f))
    expect(offenders).toEqual(['tools/gate.ts'])
  })

  test('only the gate executes a tool', () => {
    const offenders = files.filter(f => callsExecute(readFileSync(f, 'utf8'))).map(f => relative(root, f))
    expect(offenders).toEqual(['tools/gate.ts'])
  })
})

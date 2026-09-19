import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { stripComments } from './stripComments'

describe('stripComments', () => {
  it('drops a block comment, however many lines it runs', () => {
    expect(stripComments('/** a\n * bbb\n */\nconst x = 1')).toContain('const x = 1')
    expect(stripComments('/** a\n * bbb\n */\nconst x = 1')).not.toContain('bbb')
  })

  it('drops a WHOLE-LINE comment', () => {
    expect(stripComments('  // const gate = true\nconst x = 1')).not.toContain('const gate')
  })

  /**
   * THE PLANT. This is the case the weaker stripper let through, and the whole reason this module
   * exists: a needle written after real code is not code, and a lint that cannot tell the two apart
   * passes on a file that dropped the very line it was pinning.
   */
  it('drops a TRAILING comment written after real code', () => {
    const planted = 'const x = 1 // const editorEnabled = ctx.editorEnabled === true && !isCentral\n'
    expect(planted).toContain('const editorEnabled')
    expect(stripComments(planted)).not.toContain('const editorEnabled')
    expect(stripComments(planted)).toContain('const x = 1')
  })

  it('and the weaker rule it replaces does NOT — which is what was shipping', () => {
    const weak = (s: string) => s
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    const planted = 'const x = 1 // const editorEnabled = ctx.editorEnabled === true && !isCentral\n'
    expect(weak(planted)).toContain('const editorEnabled')
  })

  it('leaves a URL alone — `://` is not a comment', () => {
    expect(stripComments("const u = 'https://example.com/a'\n")).toContain('https://example.com/a')
  })
})

/**
 * AND THERE IS NO SECOND ONE. Two strippers of different strength for one job is one stripper and
 * one hole — the defect this replaces, found by a reviewer inside a lint whose whole purpose was
 * preventing exactly this class of thing.
 *
 * Exemptions are by NAME and each carries its reason, because "looks like a copy" is not the test:
 * a LENGTH-PRESERVING stripper is a different job (the assertions above it report line numbers, so
 * the offsets have to survive), and a file another change owns is not one this scan may reach into.
 */
describe('the lint tests read through this module', () => {
  const WEB = join(import.meta.dir, '..')
  /** The literal source shapes that have shipped here, as text rather than as a regex about a regex. */
  const BLOCK_WIPE = 'replace(/\\/\\*[\\s\\S]*?\\*\\//g'
  const STARTS_WITH = "startsWith('//')"
  const EXEMPT = new Map([
    // Blanks comments instead of removing them: every assertion under it names a LINE.
    ['touchTarget.lint.test.ts', 'length-preserving by necessity'],
    // Owned by another change in flight; this scan may not become a reason to edit it.
    ['RepoFileEditor.test.tsx', 'another change owns this file'],
    // The module itself, and this file — which quotes the weaker rule in order to prove it weaker.
    ['stripComments.ts', 'the implementation'],
    ['stripComments.test.ts', 'quotes both rules on purpose'],
  ])

  function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out) }
      else if (/\.tsx?$/.test(e.name)) out.push(p)
    }
    return out
  }

  const files = walk(WEB)

  it('the scan is looking at something', () => {
    expect(statSync(WEB).isDirectory()).toBe(true)
    expect(files.length).toBeGreaterThan(100)
  })

  it('no test carries a comment stripper of its own', () => {
    const offenders: string[] = []
    for (const file of files) {
      const name = file.slice(file.lastIndexOf('/') + 1)
      if (EXEMPT.has(name)) continue
      if (!/\.test\.tsx?$/.test(name)) continue
      const src = readFileSync(file, 'utf8')
      if (src.includes(BLOCK_WIPE) || src.includes(STARTS_WITH)) offenders.push(file.slice(WEB.length + 1))
    }
    // A fourth copy is a fourth chance for one of them to be the weak one.
    expect(offenders.sort()).toEqual([])
  })

  it('the scan can see a stripper, so the assertion above is not vacuous', () => {
    expect(readFileSync(join(import.meta.dir, 'stripComments.ts'), 'utf8')).toContain(BLOCK_WIPE)
    expect(files.some(f => f.endsWith('/touchTarget.lint.test.ts'))).toBe(true)
  })
})

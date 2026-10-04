/**
 * copyGuard.test.ts — sentences the product must not say any more, in any string the web shows.
 * An unpriced model is shown as unknown (PRICE.UNKNOWN), never priced at a "default rate"; the vault
 * is not sold as "ultra secure" (the site's fact-check of v2.101.2).
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const BANNED = [/default rate/i, /fallback rate/i, /tarifa padrão/i, /ultra[ -]secure/i, /ultra[ -]segur[oa]/i]

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(n => {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) return files(p)
    return /\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : []
  })
}
/** The text inside string and template literals only — code comments say what they like. */
function literals(src: string): string[] {
  const noComments = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
  return [...noComments.matchAll(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g)].map(m => m[0])
}

describe('copy the web must not show', () => {
  test('no "default rate" for an unpriced model, no "ultra secure" vault, in any web string', () => {
    const hits: string[] = []
    for (const f of files(ROOT)) for (const lit of literals(readFileSync(f, 'utf8'))) {
      if (BANNED.some(re => re.test(lit))) hits.push(`${f.slice(ROOT.length + 1)}: ${lit.slice(0, 120)}`)
    }
    expect(hits).toEqual([])
  })
})

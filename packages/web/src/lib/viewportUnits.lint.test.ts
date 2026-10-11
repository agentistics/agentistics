import { expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * The text-size setting zooms `<html>` (`textScale.ts`), and inside a zoomed root a viewport unit
 * is zoomed too: `100dvh` renders as 100dvh × 1.5 at the largest size, so a full-height shell
 * overflows the screen by half, and at 0.85 it ends short of the floor. Every viewport length is
 * therefore written `calc(100dvh / var(--ui-zoom, 1))`. A bare one fails here.
 *
 * Comments are skipped (they explain these units constantly). A deliberate exception carries
 * `@viewport-unit-intentional` and a reason on the same line.
 */
const root = join(import.meta.dir, '..')
const UNIT = /(?<![\w.\-#])(\d+(?:\.\d+)?)((?:d|s|l)?v(?:h|w|min|max))\b/g
const COMPENSATED = /^\s*\/\s*var\(--ui-zoom/

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(tsx?|css)$/.test(name) && !name.includes('.test.')) out.push(p)
  }
  return out
}

function bareUnits(source: string): string[] {
  const hits: string[] = []
  let inBlock = false
  for (const line of source.split('\n')) {
    const t = line.trim()
    if (inBlock) { if (t.includes('*/')) inBlock = false; continue }
    if (t.startsWith('/*') && !t.includes('*/')) { inBlock = true; continue }
    if (/^(\/\/|\*|\/\*)/.test(t) || line.includes('@viewport-unit-intentional')) continue
    const code = line.split(' // ')[0] ?? ''
    for (const m of code.matchAll(UNIT)) {
      if (!COMPENSATED.test(code.slice(m.index! + m[0].length))) hits.push(t)
    }
  }
  return hits
}

test('the rule itself: a bare unit is caught, a compensated one is not', () => {
  expect(bareUnits(`const a = { height: '100dvh' }`)).toHaveLength(1)
  expect(bareUnits(`max-width: calc(100vw - 32px);`)).toHaveLength(1)
  expect(bareUnits(`const a = { height: 'calc(100dvh / var(--ui-zoom, 1))' }`)).toHaveLength(0)
  expect(bareUnits(`  // a \`100dvh\` column`)).toHaveLength(0)
  expect(bareUnits(`const id = 'v2'; const w = '12px'`)).toHaveLength(0)
})

test('every viewport unit in the web app is compensated for the text-size zoom', () => {
  const offenders: Record<string, string[]> = {}
  for (const file of walk(root)) {
    const hits = bareUnits(readFileSync(file, 'utf8'))
    if (hits.length) offenders[relative(root, file)] = hits
  }
  expect(offenders).toEqual({})
})

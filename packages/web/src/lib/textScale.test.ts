import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { applyTextScale, clampTextScale } from './textScale'
import { stripComments } from './stripComments'

function fakeRoot() {
  const vars = new Map<string, string>()
  return {
    vars,
    style: {
      zoom: '', fontSize: '16px',
      setProperty: (k: string, v: string) => { vars.set(k, v) },
      removeProperty: (k: string) => { const o = vars.get(k) ?? ''; vars.delete(k); return o },
    },
  }
}

describe('text scale', () => {
  test('clamps invalid and out-of-range values', () => {
    expect(clampTextScale(undefined)).toBe(1)
    expect(clampTextScale(Number.NaN)).toBe(1)
    expect(clampTextScale(0.2)).toBe(0.85)
    expect(clampTextScale(2)).toBe(1.5)
    expect(clampTextScale(1.125)).toBe(1.125)
  })

  test('scales the whole document with zoom and publishes the factor', () => {
    const root = fakeRoot()
    expect(applyTextScale(root, 1.4)).toBe(1.4)
    expect(root.style.zoom).toBe('1.4')
    expect(root.vars.get('--ag-zoom')).toBe('1.4')
    expect(root.style.fontSize).toBe('')
  })

  test('the default leaves no trace on the root', () => {
    const root = fakeRoot()
    applyTextScale(root, 1.4)
    applyTextScale(root, 1)
    expect(root.style.zoom).toBe('')
    expect(root.vars.has('--ag-zoom')).toBe(false)
  })

  test('every viewport unit in the app is compensated for the zoom', () => {
    const bare = /(?<![\w.-])\d+(?:\.\d+)?(?:dvh|svh|vh|dvw|vw)\b(?!\s*\/\s*var\(--ag-zoom)/
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) { if (name !== 'a11y') walk(p); continue }
        if (!/\.(tsx?|css)$/.test(name) || /\.test\./.test(name)) continue
        stripComments(readFileSync(p, 'utf8')).split('\n').forEach((line, i) => {
          if (bare.test(line)) offenders.push(`${p}:${i + 1}`)
        })
      }
    }
    walk(join(import.meta.dir, '..'))
    expect(offenders).toEqual([])
  })
})

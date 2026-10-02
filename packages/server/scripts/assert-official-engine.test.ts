import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ENGINE_API_VERSION } from '@agentistics/engine-api'
import { checkEngineLine, findLeakedMarkers, parseEnginePin } from './assert-official-engine'

const sat = (v: string, r: string) => Bun.semver.satisfies(v, r)
const expected = { version: '0.1.0', apiRange: '^1.2.0' }

describe('checkEngineLine', () => {
  test('passes the pinned engine', () => {
    const r = checkEngineLine('agentop 2.84.0\nengine 0.1.0 (api 1.2.0)\n', expected, sat)
    expect(r).toEqual({ ok: true, version: '0.1.0', api: '1.2.0' })
  })

  test('fails a community (null-slot) build', () => {
    const r = checkEngineLine('agentop 2.84.0\nengine: none — community build\n', expected, sat)
    expect(r.ok).toBe(false)
  })

  test('fails when no engine line is printed', () => {
    expect(checkEngineLine('agentop 2.84.0\n', expected, sat).ok).toBe(false)
  })

  test('fails the in-tree engine, which reports the host version', () => {
    const r = checkEngineLine('agentop 2.84.0\nengine 2.84.0 (api 1.2.0)\n', expected, sat)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('in-tree')
  })

  test('fails an engine outside the pinned contract range', () => {
    const r = checkEngineLine('engine 0.1.0 (api 2.0.0)', expected, sat)
    expect(r.ok).toBe(false)
  })

  test('fails an engine that did not load', () => {
    expect(checkEngineLine('engine: not loaded — contract version mismatch', expected, sat).ok).toBe(false)
  })
})

describe('parseEnginePin', () => {
  test('the committed engine.pin is valid', () => {
    const pin = parseEnginePin(readFileSync(join(import.meta.dir, '..', '..', '..', 'engine.pin'), 'utf8'))
    expect(pin.ref).toMatch(/^[0-9a-f]{40}$/)
    // The pin's range must admit the contract THIS tree speaks, not a version frozen in the test:
    // a hardcoded '1.2.0' rejected the very pin bump that engine-api 1.3.0 required.
    expect(Bun.semver.satisfies(ENGINE_API_VERSION, pin.api)).toBe(true)
  })

  test('refuses a short SHA and a missing range', () => {
    expect(() => parseEnginePin('{"ref":"cd7550cb","api":"^1.2.0"}')).toThrow()
    expect(() => parseEnginePin(`{"ref":"${'a'.repeat(40)}"}`)).toThrow()
  })
})

describe('findLeakedMarkers', () => {
  const enc = (t: string) => new TextEncoder().encode(t)

  test('an unminified bundle leaks all three markers', () => {
    const plain = [
      '// ../../.engine/engine/src/cli-provider.ts',
      'function dropModelCaches() {}',
      '// ../../.engine/engine/src/integrations/claude/replay-core.ts',
    ].join('\n')
    const found = findLeakedMarkers(enc(plain))
    expect(found).toHaveLength(3)
  })

  test('a minified bundle leaks nothing', () => {
    expect(findLeakedMarkers(enc('var a=1;function b(){return a}export{b as createEngine};'))).toEqual([])
  })

  test('a path inside a string is not mistaken for the header comment', () => {
    expect(findLeakedMarkers(enc('x="engine/src/cli-provider.ts"'))).toEqual([])
  })
})

describe('release.yml compiles every public binary minified, with no source map', () => {
  const yml = readFileSync(join(import.meta.dir, '..', '..', '..', '.github', 'workflows', 'release.yml'), 'utf8')
  const compiles = yml.split('\n').filter(l => l.includes('bun build --compile'))

  test('there are compile steps to check', () => {
    expect(compiles.length).toBeGreaterThanOrEqual(5)
  })

  test('every one minifies', () => {
    for (const l of compiles) expect(l).toContain('--minify')
  })

  test('none emits a source map', () => {
    const code = yml.split('\n').filter(l => !l.trim().startsWith('#'))
    for (const l of code) expect(l).not.toContain('--sourcemap')
  })
})

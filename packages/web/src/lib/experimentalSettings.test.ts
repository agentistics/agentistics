import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { confirmCopy, featureBlurb, featureName, requestSwitch, stateSentence, switchDisabled, type ExperimentalFeatureWire } from './experimentalSettings'
import { invalidateEngineCaps, onEngineCapsInvalidated } from './engineCapsBus'

const provider = (over: Partial<ExperimentalFeatureWire> = {}): ExperimentalFeatureWire => ({
  id: 'provider', env: 'AGENTISTICS_PROVIDER', on: false, source: 'default', overridden: false, switchable: true,
  description: { en: 'Native runtime.', pt: 'Runtime nativo.' }, ...over,
})
const journal = (): ExperimentalFeatureWire => provider({ id: 'journal', env: 'AGENTISTICS_JOURNAL', on: true, switchable: false })

describe('requestSwitch — pressing only asks', () => {
  test('a switchable feature asks for the opposite of what it is', () => {
    expect(requestSwitch(provider())).toEqual({ id: 'provider', next: true })
    expect(requestSwitch(provider({ on: true, source: 'preference' }))).toEqual({ id: 'provider', next: false })
  })
  test('a default-on feature has no switch to press', () => {
    expect(requestSwitch(journal())).toBeNull()
  })
  test('an explicit variable disables the control', () => {
    expect(switchDisabled(provider({ source: 'env', envValue: '1', on: true }))).toBe(true)
    expect(switchDisabled(provider())).toBe(false)
  })
})

describe('confirmCopy', () => {
  test('turning on says what changes and that it is experimental, in both languages', () => {
    const en = confirmCopy({ id: 'provider', next: true }, provider(), 'en')
    expect(en.message).toMatch(/native Agentistics harness appears/i)
    expect(en.message).toMatch(/experimental/i)
    expect(en.confirmLabel).toBe('Turn on')
    const pt = confirmCopy({ id: 'provider', next: true }, provider(), 'pt')
    expect(pt.message).toMatch(/harness nativo/i)
    expect(pt.message).toMatch(/experimental/i)
    expect(pt.confirmLabel).toBe('Ligar')
  })
  test('turning off says nothing is deleted', () => {
    expect(confirmCopy({ id: 'provider', next: false }, provider({ on: true }), 'en').message).toMatch(/nothing is deleted/i)
    expect(confirmCopy({ id: 'provider', next: false }, provider({ on: true }), 'pt').message).toMatch(/nada é apagado/i)
  })
})

describe('words', () => {
  test('plain-language blurbs in both languages, no commands or variables; unknown ids fall back', () => {
    for (const id of ['provider', 'journal', 'projections']) for (const l of ['en', 'pt'] as const) {
      const t = featureBlurb({ id, description: { en: 'x', pt: 'x' } }, l)
      expect(t.length).toBeGreaterThan(20)
      expect(t).not.toMatch(/AGENTISTICS_|agentop /)
    }
    expect(featureBlurb({ id: 'zzz', description: { en: 'E', pt: 'P' } }, 'pt')).toBe('P')
  })
  test('names and state sentences', () => {
    expect(featureName({ id: 'provider' }, 'pt')).toBe('Harness nativo e provedores de modelo')
    expect(stateSentence(provider({ source: 'env', envValue: '0', overridden: true }), 'en')).toMatch(/AGENTISTICS_PROVIDER/)
    expect(stateSentence(journal(), 'en')).toMatch(/on by default/i)
  })
})

describe('ExperimentalSettings.tsx — a confirmation is required before any write', () => {
  const src = readFileSync(join(import.meta.dir, '../pages/settings/ExperimentalSettings.tsx'), 'utf8')
  test('the switch only sets the pending request; the PUT lives in confirm()', () => {
    expect(src).toMatch(/onToggle=\{\(\) => setPending\(requestSwitch\(f\)\)\}/)
    const puts = [...src.matchAll(/method: 'PUT'/g)]
    expect(puts.length).toBe(1)
    expect(src.indexOf("method: 'PUT'")).toBeGreaterThan(src.indexOf('const confirm = async'))
    expect(src.indexOf("method: 'PUT'")).toBeLessThan(src.indexOf('const pendingFeature'))
  })
  test('reuses the existing primitives and tells the rest of the app after a write', () => {
    expect(src).toContain("from './primitives'")
    expect(src).toContain("from '../../components/ToggleSwitch'")
    expect(src).toMatch(/ConfirmModal/)
    expect(src).toMatch(/invalidateEngineCaps\(\)/)
  })
})

describe('engineCapsBus — the switch makes cached readers ask again', () => {
  test('invalidate calls every subscriber; unsubscribe stops it; a throwing one does not stop the rest', () => {
    let a = 0, b = 0
    const offA = onEngineCapsInvalidated(() => { a++ })
    const offBad = onEngineCapsInvalidated(() => { throw new Error('x') })
    const offB = onEngineCapsInvalidated(() => { b++ })
    invalidateEngineCaps()
    expect([a, b]).toEqual([1, 1])
    offA(); offBad(); offB()
    invalidateEngineCaps()
    expect([a, b]).toEqual([1, 1])
  })
})

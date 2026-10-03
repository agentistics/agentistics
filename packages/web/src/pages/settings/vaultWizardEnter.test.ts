/**
 * Owner decision 2026-10-02: pressing ENTER in any code field of the vault wizard submits the step,
 * exactly like clicking its button. Pinned over the source: every code field the wizard draws sits
 * inside a `<form onSubmit>` whose button is `type="submit"` — a field outside a form, or a step
 * whose button is a plain `type="button"` with the action on onClick, is how Enter silently did nothing.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(import.meta.dir, 'VaultSettings.tsx'), 'utf8')
const wizard = src.slice(src.indexOf('function EnrolWizard('), src.indexOf('const PRINT_CSS'))

describe('the vault wizard: Enter submits every code step', () => {
  test('the wizard region was found', () => {
    expect(wizard.length).toBeGreaterThan(1000)
  })
  test('every CodeField / SetupCodeField is inside an open <form onSubmit>', () => {
    const fields = [...wizard.matchAll(/<(CodeField|SetupCodeField)\b/g)]
    expect(fields.length).toBeGreaterThanOrEqual(6)
    for (const f of fields) {
      const before = wizard.slice(0, f.index)
      const opens = (before.match(/<form onSubmit=/g) ?? []).length
      const closes = (before.match(/<\/form>/g) ?? []).length
      expect({ field: f[1], at: before.split('\n').length, inForm: opens - closes === 1 }).toMatchObject({ inForm: true })
    }
  })
  test('the setup-code step is the first step and submits on Enter', () => {
    const setup = wizard.slice(wizard.indexOf("step === 'setup'"), wizard.indexOf("step === 'probe' && ("))
    expect(setup).toContain('<form onSubmit=')
    expect(setup).toContain('void acceptSetup()')
    expect(setup).toContain('type="submit"')
  })
  test('no code step keeps its action on a type="button" onClick', () => {
    for (const action of ['showQr()', 'showWords()', 'enrolPresence(', 'acceptSetup()', 'confirmAuth()', 'confirmWords()']) {
      expect(wizard).not.toMatch(new RegExp(`type="button"[^>]*onClick=\\{\\(\\) => \\{ void ${action.replace(/[()]/g, '\\$&')}`))
    }
  })
})

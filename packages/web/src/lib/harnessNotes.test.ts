import { expect, test } from 'bun:test'
import { harnessActionHint, harnessSetupNote } from './harnessNotes'

test('no card or hint tells a person to run or type a command', () => {
  for (const id of ['claude', 'codex', 'gemini', 'copilot']) {
    for (const lang of ['pt', 'en'] as const) {
      const note = harnessSetupNote(id, lang) ?? ''
      expect(note).not.toMatch(/\brun\b|\brode\b|\bexecute\b|gh auth|npm |login"/i)
    }
  }
  for (const installed of [true, false]) {
    for (const lang of ['pt', 'en'] as const) {
      expect(harnessActionHint(installed, lang)).toMatch(/Entrar|Instalar|Sign in|Install/)
    }
  }
})

test('copilot points at the Sign in button in both languages', () => {
  expect(harnessSetupNote('copilot', 'pt')).toContain('Entrar')
  expect(harnessSetupNote('copilot', 'en')).toContain('Sign in')
})

import { describe, expect, test } from 'bun:test'
import { applyVaultChip, expandVaultChip, hasVaultChip, removeVaultChip, vaultChipLabel, vaultChipTokens, vaultTrigger } from './vaultChip'

const sel = { items: [{ id: 'it_a', name: 'OpenAI' }, { id: 'it_b', name: 'Banco' }, { id: 'it_c', name: 'Wi-Fi' }], groups: [{ id: 'gr_p', name: 'pelvie' }] }

describe(':vault chip', () => {
  test('trigger opens the text or follows whitespace; never mid-word', () => {
    expect(vaultTrigger(':vault')).toBe(0)
    expect(vaultTrigger('use :vault')).toBe(4)
    expect(vaultTrigger('http://x:vault')).toBeNull()
  })
  test('label: names only, the owner\'s wording', () => {
    expect(vaultChipLabel(sel, true)).toBe('3 credenciais · grupo pelvie')
    expect(vaultChipLabel({ items: [sel.items[0]!], groups: [] }, true)).toBe('OpenAI')
    expect(vaultChipLabel({ items: [sel.items[0]!, sel.items[1]!], groups: [] }, false)).toBe('2 credentials')
  })
  test('apply replaces the trigger; choosing again edits the one chip; remove drops it', () => {
    const a = applyVaultChip('deploy with :vault', 18, sel, true)
    expect(a.text).toBe('deploy with 🔐«3 credenciais · grupo pelvie» ')
    expect(vaultChipTokens(a.text)).toEqual([{ start: 12, end: 12 + '🔐«3 credenciais · grupo pelvie»'.length }])
    const b = applyVaultChip(a.text + 'now', 0, { items: [sel.items[0]!], groups: [] }, true)
    expect(b.text).toBe('deploy with 🔐«OpenAI» now')
    expect(hasVaultChip(removeVaultChip(b.text))).toBe(false)
  })
  test('on send: references and the briefing, never a value', () => {
    expect(expandVaultChip('deploy with 🔐«OpenAI» now', ['vault://openai'], 'BRIEF')).toBe('deploy with vault://openai now\n\nBRIEF')
    expect(expandVaultChip('no chip', ['vault://x'], 'BRIEF')).toBe('no chip')
  })
})

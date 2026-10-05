import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pt_ as pers } from './personalText'

const src = readFileSync(join(import.meta.dir, '..', 'pages', 'VaultPage.tsx'), 'utf8')

describe('the quick vault views point to the full list', () => {
  test('the link says it in both languages', () => {
    expect(pers('quickAll', 'pt')).toBe('Veja a listagem dos seus segredos aqui')
    expect(pers('quickAll', 'en')).toBe('See the full list of your secrets here')
  })
  test('it is a button that navigates to /vault, in the one body both quick views share', () => {
    expect(src).toMatch(/data-vault-full-list[\s\S]{0,400}navigate\('\/vault'\)/)
  })
  test('the page shows the locked safe ONLY when the vault is locked — an open one goes straight to the list', () => {
    // `VaultStage` (the safe and its unlock) is referenced from exactly one branch: `state.kind === 'locked'`.
    expect((src.match(/<VaultStage/g) ?? []).length).toBe(1)
    expect(src).toMatch(/if \(state\.kind === 'locked'\) \{[\s\S]{0,700}<VaultStage/)
  })
})

describe('the header button', () => {
  const btn = readFileSync(join(import.meta.dir, '..', 'components', 'vault', 'VaultHeaderButton.tsx'), 'utf8')
  test('the icon is never orange — no active/route colour override', () => {
    expect(btn).not.toContain('anthropic-orange')
    expect(btn).not.toContain('useLocation')
  })
  test('the badge sits where the bell wears its own (top-right, -5/-5, 16 px)', () => {
    const bell = readFileSync(join(import.meta.dir, '..', 'components', 'NotificationBell.tsx'), 'utf8')
    expect(bell).toContain('top: -5, right: -5')
    expect(btn).toContain('top: -5, right: -5, width: 16, height: 16')
    expect(btn).not.toContain('bottom: -5')
  })
})

describe('the locked /vault page', () => {
  test('has no page header — the safe in the centre is the title', () => {
    const branch = src.slice(src.indexOf("if (state.kind === 'locked') {"), src.indexOf("if (state.kind === 'code')"))
    expect(branch).toContain('<VaultStage')
    expect(branch).not.toContain('{header}')
  })
})

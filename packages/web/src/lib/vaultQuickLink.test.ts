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
  test('the safe is shown ONLY when the vault is locked — an open one goes straight to the list', () => {
    // `VaultStage` (the safe and its unlock) is drawn twice — the page and the panel (VAULT.UX-R2: the Nay
    // tab uses the SAME centred safe, scaled) — and each time only from its `state.kind === 'locked'` branch.
    expect((src.match(/<VaultStage /g) ?? []).length).toBe(2)
    expect(src).toMatch(/if \(state\.kind === 'locked'\) \{[\s\S]{0,700}<VaultStage /)
    expect(src).toMatch(/\{state\.kind === 'locked' && <VaultStage [^>]*compact/)
  })
  test('the two quick actions share ONE row at the top: new secret, then the full list', () => {
    expect(src).toMatch(/data-quick-new[\s\S]{0,600}data-vault-full-list/)
    expect(src.indexOf('data-vault-full-list')).toBeLessThan(src.indexOf("placeholder={t('search')} aria-label={t('search')} autoFocus"))
  })
})

describe('the locked /vault page', () => {
  test('has no page header — the safe in the centre is the title', () => {
    const branch = src.slice(src.indexOf("if (state.kind === 'locked') {"), src.indexOf("if (state.kind === 'code')"))
    expect(branch).toContain('<VaultStage')
    expect(branch).not.toContain('{header}')
  })
})

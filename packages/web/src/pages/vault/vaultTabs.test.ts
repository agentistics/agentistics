/**
 * VAULT v4: the vault has ONE page, and every control the two old screens offered is still reachable
 * from one of its tabs. Each entry of `VAULT_CONTROL_MAP` names the tab and a marker; the marker must
 * appear INSIDE that tab's own renderer (not merely somewhere in the file), so a control deleted from a
 * tab — or left behind in a component nothing mounts — fails here.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { VAULT_CONTROL_MAP, VAULT_TABS, legacyVaultTarget, parseVaultTab } from './vaultTabs'
import { SETTINGS_SECTIONS } from '../../lib/settingsSections'

const page = readFileSync(join(import.meta.dir, '..', 'VaultPage.tsx'), 'utf8')
const areas = readFileSync(join(import.meta.dir, 'VaultAreas.tsx'), 'utf8')
const between = (src: string, a: string, b: string) => {
  const i = src.indexOf(a)
  expect(i, a).toBeGreaterThan(-1)
  const j = src.indexOf(b, i + a.length)
  return src.slice(i, j === -1 ? undefined : j)
}
const REGION: Record<string, string> = {
  page: between(page, 'export default function VaultPage(', '// ── Segredos'),
  locked: between(page, "if (state.kind === 'locked') {", "if (state.kind === 'code')"),
  secrets: between(page, 'function SecretsArea(', '// ── the FAB') + between(page, 'function SecretRow(', '// ── dialogs'),
  dialog: between(page, 'function SecretDialog(', 'function VersionsDialog('),
  methods: between(areas, 'export function MethodsArea(', '// ── Dispositivos'),
  devices: between(areas, 'export function DevicesArea(', '// ── Configurações'),
  settings: between(areas, 'export function SettingsArea(', '\u0000'),
}

describe('/vault — every old control has a home in a tab', () => {
  for (const row of VAULT_CONTROL_MAP) {
    test(`${row.control} → ${row.tab}`, () => {
      expect(REGION[row.tab]!.includes(row.marker), `${row.marker} in ${row.tab}`).toBe(true)
    })
  }
  test('each tab is mounted by the page', () => {
    for (const tab of VAULT_TABS) expect(REGION.page).toContain(`tab === '${tab}'`)
    expect(REGION.page).toContain('<SecretsArea')
    expect(REGION.page).toContain('<MethodsArea')
    expect(REGION.page).toContain('<DevicesArea')
    expect(REGION.page).toContain('<SettingsArea')
  })
  test('the old Settings → Vault screen is gone, and not embedded anywhere', () => {
    expect(existsSync(join(import.meta.dir, '..', 'settings', 'VaultSettings.tsx'))).toBe(false)
    expect(page).not.toContain('VaultSettings')
    expect(areas).not.toContain('VaultSettings')
    expect(SETTINGS_SECTIONS.some(s => (s.id as string) === 'vault')).toBe(false)
  })
  test('the locked page has no page header — only the safe and the ways in', () => {
    expect(REGION.locked).toContain('<VaultStage')
    expect(REGION.locked).not.toContain('{header}')
  })
})

describe('tabs in the URL, and the old route', () => {
  test('?tab= picks a tab; anything else is the secrets', () => {
    expect(parseVaultTab('?tab=devices')).toBe('devices')
    expect(parseVaultTab('?tab=settings')).toBe('settings')
    expect(parseVaultTab('?tab=nope')).toBe('secrets')
    expect(parseVaultTab('')).toBe('secrets')
    expect(parseVaultTab('?show=system')).toBe('secrets')
  })
  test('/settings/vault lands on the unlock methods, or on the tab it names', () => {
    expect(legacyVaultTarget('')).toBe('/vault?tab=methods')
    expect(legacyVaultTarget('?tab=settings')).toBe('/vault?tab=settings')
    expect(legacyVaultTarget('?tab=bogus')).toBe('/vault?tab=methods')
  })
  test('the router redirects the old route through that function', () => {
    const router = readFileSync(join(import.meta.dir, '..', '..', 'AppRouter.tsx'), 'utf8')
    expect(router).toMatch(/<Route path="vault" element=\{<LegacyVaultRedirect \/>\} \/>/)
    expect(router).toContain('legacyVaultTarget(loc.search)')
  })
})

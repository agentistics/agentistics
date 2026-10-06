/**
 * PURE — the `/vault` page's four areas (VAULT v4, owner-approved 2026-10-06: "Opção A", tabs under the
 * title) and where every control of the two screens it replaced went. `VAULT_CONTROL_MAP` is the record
 * the redesign is held to: each control the old `/vault` page or the old Settings → Vault screen offered
 * names the tab that offers it now, and `vaultTabs.test.ts` checks each against the source of that tab.
 */
export type VaultTab = 'secrets' | 'methods' | 'devices' | 'settings'
export const VAULT_TABS: readonly VaultTab[] = ['secrets', 'methods', 'devices', 'settings']

/** `?tab=` → a tab; `?show=system|mine` (the old Settings link into the list) → secrets; anything else → secrets. */
export function parseVaultTab(search: string): VaultTab {
  let p: URLSearchParams
  try { p = new URLSearchParams(search) } catch { return 'secrets' }
  const t = p.get('tab')
  return (VAULT_TABS as readonly string[]).includes(t ?? '') ? (t as VaultTab) : 'secrets'
}

/**
 * Where the old Settings → Vault route sends a visitor. Its first and largest blocks were the unlock
 * methods (authenticator, personal confirmation), so that is where it lands; a `?tab=` it carries wins.
 */
export function legacyVaultTarget(search: string): string {
  let t: string | null = null
  try { t = new URLSearchParams(search).get('tab') } catch { /* no query */ }
  const tab: VaultTab = (VAULT_TABS as readonly string[]).includes(t ?? '') ? (t as VaultTab) : 'methods'
  return `/vault?tab=${tab}`
}

/**
 * Old control → the tab that has it now, plus a marker the test finds in that tab's source (a text
 * key or a call). `from` says which old screen offered it.
 */
export const VAULT_CONTROL_MAP: readonly { control: string; from: 'page' | 'settings'; tab: VaultTab | 'page' | 'dialog' | 'locked'; marker: string }[] = [
  // the old /vault page
  { control: 'New secret', from: 'page', tab: 'secrets', marker: "t('new')" },
  { control: 'Import .env / JSON', from: 'page', tab: 'secrets', marker: "t('importShort')" },
  { control: 'Groups (create / rename / delete)', from: 'page', tab: 'secrets', marker: "t('manageGroups')" },
  { control: 'Search', from: 'page', tab: 'secrets', marker: "t('f_search')" },
  { control: 'Kind filter', from: 'page', tab: 'secrets', marker: "t('allKinds')" },
  { control: 'Group filter', from: 'page', tab: 'secrets', marker: "t('allGroups')" },
  { control: 'Trash toggle', from: 'page', tab: 'secrets', marker: "t('trash')" },
  { control: 'System secrets (Do sistema)', from: 'page', tab: 'secrets', marker: "t('systemMeta')" },
  { control: 'Paging + per page', from: 'page', tab: 'secrets', marker: "t('perPage')" },
  { control: 'Reveal / hide a value', from: 'page', tab: 'secrets', marker: "t('reveal')" },
  { control: 'Copy a value', from: 'page', tab: 'secrets', marker: "t('copy')" },
  { control: 'Edit', from: 'page', tab: 'secrets', marker: "t('edit')" },
  { control: 'Replace value (use only)', from: 'page', tab: 'secrets', marker: "t('replaceValue')" },
  { control: 'Versions + restore a version', from: 'page', tab: 'secrets', marker: "t('versions')" },
  { control: 'Move to group', from: 'page', tab: 'secrets', marker: "t('moveTo')" },
  { control: 'Move to trash', from: 'page', tab: 'secrets', marker: "t('delete')" },
  { control: 'Restore from trash', from: 'page', tab: 'secrets', marker: "t('restore')" },
  { control: 'Delete for good', from: 'page', tab: 'secrets', marker: "t('purge')" },
  { control: 'Use only / Always confirm / URL / notes / tags (form)', from: 'page', tab: 'dialog', marker: "t('useOnlyShort')" },
  { control: 'Phones with biometrics (remove)', from: 'page', tab: 'devices', marker: 'removePasskey(' },
  { control: 'Phones with the code alone (remove)', from: 'page', tab: 'devices', marker: 'removeDevice(' },
  { control: 'Stale phone keys (clear)', from: 'page', tab: 'devices', marker: 'clearStalePhones(' },
  { control: 'Accept the code on the phone', from: 'page', tab: 'devices', marker: 'setCodeReveal(' },
  { control: 'Register this phone (on the phone)', from: 'page', tab: 'devices', marker: '<PhoneEnrol' },
  { control: 'Erase the vault history in the backup', from: 'page', tab: 'settings', marker: 'wipeBackupHistory(' },
  { control: 'Phone registration box (locked)', from: 'page', tab: 'locked', marker: 'lockedPhoneBox(' },
  // the old Settings → Vault screen
  { control: 'Unlock (Hello / code / phone)', from: 'settings', tab: 'locked', marker: '<VaultStage' },
  { control: 'Recover with the 24 words', from: 'settings', tab: 'settings', marker: "vt('rec_recover'" },
  { control: 'Lock now', from: 'settings', tab: 'settings', marker: "vt('lockNow'" },
  { control: 'Status: protector, key id, created', from: 'settings', tab: 'settings', marker: "vt('keyId'" },
  { control: 'Authenticator: set up / replace phone', from: 'settings', tab: 'methods', marker: "vt('auth_replace'" },
  { control: 'Authenticator paused / frozen', from: 'settings', tab: 'methods', marker: "'auth_frozen'" },
  { control: 'Windows Hello: turn on / add', from: 'settings', tab: 'methods', marker: "t('m_hello_d')" },
  { control: 'Security key: add / coming soon', from: 'settings', tab: 'methods', marker: "t('st_soon')" },
  { control: 'Enrolled credentials list', from: 'settings', tab: 'methods', marker: "'pres_since'" },
  { control: 'Turn personal confirmation off', from: 'settings', tab: 'methods', marker: "vt('pres_turnOff'" },
  { control: 'Recovery key: create / new', from: 'settings', tab: 'settings', marker: "t('rec_new_short')" },
  { control: 'Auto-lock minutes', from: 'settings', tab: 'settings', marker: '<AutoLockRow' },
  { control: 'Unlock policy (daily / always / Hello only)', from: 'settings', tab: 'settings', marker: '<UnlockPolicyRow' },
  { control: 'Memory hardening report', from: 'settings', tab: 'settings', marker: '<HardeningBlock' },
  { control: 'How your vault works', from: 'settings', tab: 'methods', marker: '<HowStrip' },
  { control: 'How it works (envelope, holder, backups…)', from: 'settings', tab: 'settings', marker: 'how_envelope_h' },
  { control: 'Protect your vault (setup wizard banner)', from: 'settings', tab: 'page', marker: "vt('ultraStart'" },
  { control: 'Waiting to be encrypted', from: 'settings', tab: 'secrets', marker: "vt('pendingTitle'" },
]

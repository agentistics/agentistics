/** Which settings sections a viewer can see. UX-only gate — the server enforces real authz. */
export type SettingsSectionId =
  | 'preferences' | 'accessibility' | 'sessions' | 'data-sources' | 'harnesses' | 'pricing' | 'install' | 'whatsnew'
  | 'chat' | 'providers' | 'memory' | 'notifications' | 'backup'

export type SettingsGroup = 'personal'

export interface SettingsSection { id: SettingsSectionId; labelEn: string; labelPt: string; group: SettingsGroup }
export interface SettingsViewer {
  /** `CAPS.localChat` from /api/session. `false` means the exposure profile denies chat
   *  entirely, so the section has nothing to offer. `undefined` (not yet loaded) shows it —
   *  hiding a section on a slow fetch is worse than showing one that is briefly empty. */
  localChat?: boolean
  /** `GET /api/engine`'s `manifest.provides.nativeRuntime` (UI.2). `false` — a community build, no
   *  engine — means there is no native runtime to hold provider credentials for. `undefined` (not yet
   *  loaded) shows the section, the same reading `localChat` gets. */
  nativeRuntime?: boolean
}

// No `billing` section: plans are registered on each account's pencil in Usage → Accounts. The old
// `/settings/billing` route stays only as a redirect there, so bookmarks still land.
export const SETTINGS_SECTIONS: SettingsSection[] = [
  { id: 'preferences', labelEn: 'Preferences', labelPt: 'Preferências', group: 'personal' },
  // Visible in BOTH modes: the magnifiers are stored per account and per machine
  // otherwise, so there is no mode in which this screen has nothing to configure.
  { id: 'accessibility', labelEn: 'Accessibility', labelPt: 'Acessibilidade', group: 'personal' },
  { id: 'notifications', labelEn: 'Notifications', labelPt: 'Notificações', group: 'personal' },
  { id: 'sessions', labelEn: 'Sessions', labelPt: 'Sessões', group: 'personal' },
  { id: 'data-sources', labelEn: 'Data & sources', labelPt: 'Dados & fontes', group: 'personal' },
  { id: 'backup', labelEn: 'Backup', labelPt: 'Backup', group: 'personal' },
  { id: 'harnesses', labelEn: 'Harnesses', labelPt: 'Harnesses', group: 'personal' },
  { id: 'pricing', labelEn: 'Pricing', labelPt: 'Preços', group: 'personal' },
  { id: 'install', labelEn: 'Install', labelPt: 'Instalação', group: 'personal' },
  { id: 'whatsnew', labelEn: "What's new", labelPt: 'Novidades', group: 'personal' },
  { id: 'chat', labelEn: 'Chat', labelPt: 'Chat', group: 'personal' },
  // Runtime provider credentials (Anthropic, OpenAI, OpenRouter, DeepSeek, LiteLLM, 9Router,
  // Ollama) — a machine-local secret store, same reason `connection`/`chat` are host-only.
  { id: 'providers', labelEn: 'Providers', labelPt: 'Provedores', group: 'personal' },
  { id: 'memory', labelEn: 'Memory', labelPt: 'Memória', group: 'personal' },
]

export function visibleSettingsSections(v: SettingsViewer): SettingsSection[] {
  return SETTINGS_SECTIONS.filter(s => {
    switch (s.id) {
      case 'chat': return v.localChat !== false
      case 'memory':
      case 'providers': return v.nativeRuntime === true
      default: return true
    }
  })
}

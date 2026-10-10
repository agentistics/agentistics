import { useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { Sparkles, ChevronDown } from 'lucide-react'
import type { AppContext } from '../../lib/app-context'
import { BUNDLE_VERSION } from '../../lib/bundleVersion'
import { releasesBetween } from '../../whatsNew/select'
import { openWhatsNew } from '../../whatsNew/open'
import { ReleaseSection } from '../../components/WhatsNewModal'
import { useSyncExternalStore } from 'react'
import { autoOpenStore } from '../../whatsNew/seen'
import { PrefRow, SectionHeader, Toggle, dialogButtonStyle } from './primitives'
import { version as PACKAGE_VERSION } from '../../../../../package.json'

/** How many versions are open by default; the rest sit under "show earlier versions". */
export const EXPANDED_COUNT = 5

export default function WhatsNewSettings() {
  const ctx = useOutletContext<AppContext>()
  const pt = ctx.lang === 'pt'
  const lang = pt ? 'pt' : 'en'
  const current = BUNDLE_VERSION || PACKAGE_VERSION
  const autoOpen = useSyncExternalStore(autoOpenStore.subscribe, autoOpenStore.get, autoOpenStore.serverSnapshot)
  const [showOlder, setShowOlder] = useState(false)
  const all = releasesBetween(null, current)
  const recent = all.slice(0, EXPANDED_COUNT)
  const older = all.slice(EXPANDED_COUNT)
  const isMobile = typeof window !== 'undefined' && window.matchMedia?.('(max-width: 768px)').matches === true

  return (
    <>
      <SectionHeader label={pt ? 'Novidades' : "What's new"} />
      <div style={{ marginBottom: 8 }}>
        <PrefRow
          label={pt ? `Versão atual: v${current}` : `Current version: v${current}`}
          sub={pt ? 'O que mudou nas últimas atualizações, em linguagem simples.' : 'What changed in recent updates, in plain language.'}
        >
          <button
            type="button"
            onClick={() => openWhatsNew({ version: current, from: '' })}
            style={{ ...dialogButtonStyle('primary', isMobile), display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <Sparkles size={14} /> {pt ? 'Ver novidades' : "See what's new"}
          </button>
        </PrefRow>
        <PrefRow
          label={pt ? 'Abrir as novidades depois de atualizar' : 'Open the news after updating'}
          sub={pt ? 'Mostra o que mudou sozinho, uma vez por versão. A notificação continua aparecendo.' : 'Shows what changed by itself, once per version. The notification still appears.'}
        >
          <Toggle on={autoOpen} onToggle={() => autoOpenStore.set(!autoOpen)} label={pt ? 'Abrir as novidades depois de atualizar' : 'Open the news after updating'} />
        </PrefRow>
      </div>

      <SectionHeader label={pt ? 'Histórico' : 'History'} />
      {all.length === 0 && (
        <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>{pt ? 'Nenhuma novidade registrada ainda.' : 'No release notes recorded yet.'}</div>
      )}
      <div data-testid="whatsnew-history">
        {recent.map((e, i) => <ReleaseSection key={e.version} entry={e} lang={lang} first={i === 0} />)}
        {older.length > 0 && (
          <>
            <button
              type="button"
              onClick={() => setShowOlder(v => !v)}
              aria-expanded={showOlder}
              data-testid="whatsnew-older-toggle"
              style={{ ...dialogButtonStyle('secondary', isMobile), display: 'inline-flex', alignItems: 'center', gap: 6, margin: '10px 0' }}
            >
              <ChevronDown size={14} style={{ transform: showOlder ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }} />
              {showOlder
                ? (pt ? 'Ocultar versões anteriores' : 'Hide earlier versions')
                : (pt ? `Mostrar versões anteriores (${older.length})` : `Show earlier versions (${older.length})`)}
            </button>
            {showOlder && older.map((e, i) => <ReleaseSection key={e.version} entry={e} lang={lang} first={i === 0} />)}
          </>
        )}
      </div>
    </>
  )
}

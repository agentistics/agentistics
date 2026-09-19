/**
 * PresetShelf — the "vitrine de disparo" (launch shelf) inside `FleetOverview`.
 *
 * Shows the machine's saved session presets (see `@agentistics/core`'s `sessionPresets.ts`) as a
 * row of quick-launch cards, capped at `SHELF_PRESET_COUNT` — the board's own cut (s-d85c7d9d9d): a
 * whole list of presets is the same board a tab over, so this is a SHORT shelf with a link to the
 * full list in Settings.
 *
 * A PRESET IS NEVER A SESSION. It carries no state, no tmux registration, nothing capturable — the
 * same argument `shell-isolation.test.ts` exists to have settled once already — so this band is
 * drawn with a DASHED border and lives entirely apart from any session row: clicking one never
 * enters the fleet, it only ever hands the click to the caller, which decides whether to confirm and
 * launch directly (a preset with a `cwd`) or open the ordinary new-session wizard pre-filled (one
 * without). See `SessionsPage.tsx`'s `onSelectPreset` and `PresetLaunchConfirm.tsx`.
 */

import { Link } from 'react-router-dom'
import { Rocket } from 'lucide-react'
import type { SessionPreset } from '@agentistics/core'
import { presetsForShelf } from '@agentistics/core'
import { HARNESS_LABELS } from '../../lib/harness'
import { HarnessMark } from './HarnessMark'
import { useIsMobile } from '../../hooks/useIsMobile'

/** The last path segment, for a compact caption — `/home/user/repo` reads as `repo`. Never used
 *  for anything but display: the full path still travels to `/api/fleet/new` untouched. */
function folderName(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
}

export interface PresetShelfProps {
  lang: 'pt' | 'en'
  presets: readonly SessionPreset[]
  onSelect: (preset: SessionPreset) => void
}

export function PresetShelf({ lang, presets, onSelect }: PresetShelfProps) {
  const pt = lang === 'pt'
  const isMobile = useIsMobile()
  const shown = presetsForShelf(presets)
  if (shown.length === 0) return null
  const hiddenCount = presets.length - shown.length

  return (
    <section style={{ marginBottom: isMobile ? 16 : 20 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
        <h2 style={{ margin: 0, fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-tertiary)' }}>
          {pt ? 'Disparo rápido' : 'Quick launch'}
        </h2>
        <Link
          to="/settings/sessions"
          style={{ fontSize: 11, color: 'var(--text-tertiary)', textDecoration: 'none', flexShrink: 0 }}
        >
          {hiddenCount > 0
            ? (pt ? `Gerenciar · +${hiddenCount}` : `Manage · +${hiddenCount}`)
            : (pt ? 'Gerenciar' : 'Manage')}
        </Link>
      </div>
      <p style={{ margin: '0 0 10px', fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-tertiary)', opacity: 0.85 }}>
        {pt
          ? 'Modelos salvos de sessão — não são sessões. Cada clique pede confirmação antes de iniciar um assistente de verdade.'
          : 'Saved session templates — not sessions themselves. Each click confirms before starting a real assistant.'}
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {shown.map(preset => (
          <button
            key={preset.id}
            type="button"
            onClick={() => onSelect(preset)}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              minHeight: 44, padding: '8px 13px', borderRadius: 10, cursor: 'pointer',
              border: '1px dashed var(--border)', background: 'var(--bg-card)',
              color: 'var(--text-primary)', fontFamily: 'inherit', textAlign: 'left',
            }}
          >
            <HarnessMark harness={preset.harness} size={18} />
            <span style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
              <span style={{
                fontSize: 12.5, fontWeight: 650, overflow: 'hidden', textOverflow: 'ellipsis',
                whiteSpace: 'nowrap', maxWidth: 180,
              }}>
                {preset.label}
              </span>
              <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 180 }}>
                {(HARNESS_LABELS as Record<string, string>)[preset.harness] ?? preset.harness}
                {preset.cwd ? ` · ${folderName(preset.cwd)}` : (pt ? ' · escolher pasta' : ' · pick a folder')}
              </span>
            </span>
            <Rocket size={13} style={{ color: 'var(--anthropic-orange)', flexShrink: 0 }} />
          </button>
        ))}
      </div>
    </section>
  )
}

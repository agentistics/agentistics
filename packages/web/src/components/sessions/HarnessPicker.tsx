/**
 * HarnessPicker — the assistant card grid, pulled out of `NewSessionModal`'s step 1 so a second
 * dialog that needs "which assistant" does not fall back to a native `<select>` (see
 * `formBits.tsx`'s own note on what a restated control costs).
 *
 * A bare `<select>` draws the platform's own menu — it ignores this application's palette in both
 * themes, cannot show the harness's mark, and is the one control that misses the 44px mobile
 * target every other row in these dialogs meets. This is a row of cards instead: the same shape
 * `NewSessionModal` always used, just no longer copied by hand.
 */
import { HarnessMark } from './HarnessMark'
import { Muted } from './formBits'
import { HARNESS_COLORS, HARNESS_LABELS } from '../../lib/harness'

export interface HarnessPickerOption {
  id: string
  label: string
}

export interface HarnessPickerProps {
  lang: 'pt' | 'en'
  /** `null` while the machine is still being asked what it can start; `[]` once it has looked and
   *  found nothing startable — two different sentences, never a shared empty grid. */
  harnesses: readonly HarnessPickerOption[] | null
  /** The chosen harness's id, or `''` for "none chosen yet". */
  value: string
  onChange: (id: string) => void
}

export function HarnessPicker({ lang, harnesses, value, onChange }: HarnessPickerProps) {
  const pt = lang === 'pt'

  if (harnesses === null) {
    return <Muted text={pt ? 'Vendo o que está instalado…' : 'Checking what is installed…'} />
  }
  if (harnesses.length === 0) {
    // Not an empty picker: the machine looked and found nothing it knows how to start.
    return <Muted text={pt
      ? 'Nenhum assistente que o agentop saiba iniciar foi encontrado nesta máquina.'
      : 'No assistant agentop knows how to start was found on this machine.'} />
  }

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {harnesses.map(h => {
        const on = value === h.id
        const color = (HARNESS_COLORS as Record<string, string>)[h.id] ?? 'var(--text-secondary)'
        const name = (HARNESS_LABELS as Record<string, string>)[h.id] ?? h.label
        return (
          <button
            key={h.id}
            type="button"
            onClick={() => onChange(h.id)}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '9px 13px', borderRadius: 10, cursor: 'pointer',
              border: `1px solid ${on ? color : 'var(--border-subtle)'}`,
              background: on ? `color-mix(in srgb, ${color} 14%, transparent)` : 'var(--bg-elevated)',
              color: on ? 'var(--text-primary)' : 'var(--text-secondary)',
              fontFamily: 'inherit', fontSize: 13, fontWeight: on ? 650 : 500,
            }}
          >
            <HarnessMark harness={h.id} size={18} />
            {name}
          </button>
        )
      })}
    </div>
  )
}

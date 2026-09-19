/**
 * EffortPicker — the effort scale, pulled out of `NewSessionModal`'s step 1.
 *
 * A CLOSED set, never free text: `effortSteps` orders exactly the levels the harness's own CLI
 * published (`spawn-spec.ts`), so this can never offer a level that fails at spawn. A raw text
 * input a person can type into is precisely the anti-pattern this replaces — see
 * `effortScale.ts`'s own header.
 */
import { effortColor, effortSteps } from '../../lib/effortScale'

export interface EffortPickerProps {
  /** The harness's own closed set, in the order its CLI printed it — see `effortScale.ts`. */
  efforts: readonly string[]
  /** The chosen level, or `''` for "leave it to the assistant". */
  value: string
  onChange: (value: string) => void
}

export function EffortPicker({ efforts, value, onChange }: EffortPickerProps) {
  const steps = effortSteps(efforts)
  if (steps.length === 0) return null

  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {steps.map(step => {
        const on = value === step.value
        const color = effortColor(step.intensity)
        return (
          <button
            key={step.value}
            type="button"
            onClick={() => onChange(on ? '' : step.value)}
            className={on && step.peak ? 'ag-effort-peak' : undefined}
            style={{
              display: 'flex', alignItems: 'center', gap: 7,
              padding: '8px 13px', borderRadius: 9, cursor: 'pointer',
              border: `1px solid ${on ? color : 'var(--border-subtle)'}`,
              background: on ? `color-mix(in srgb, ${color} 16%, transparent)` : 'var(--bg-elevated)',
              color: on ? 'var(--text-primary)' : 'var(--text-secondary)',
              fontFamily: 'inherit', fontSize: 12.5, fontWeight: on ? 650 : 500,
              transition: 'background 0.15s, border-color 0.15s',
            }}
          >
            <span style={{ width: 8, height: 8, borderRadius: 4, background: color, flexShrink: 0 }} />
            {step.value}
          </button>
        )
      })}
    </div>
  )
}

/**
 * EffortPicker — the effort scale, pulled out of `NewSessionModal`'s step 1.
 *
 * A CLOSED set, never free text: `effortSteps` orders exactly the levels the harness's own CLI
 * published (`spawn-spec.ts`), so this can never offer a level that fails at spawn. A raw text
 * input a person can type into is precisely the anti-pattern this replaces — see
 * `effortScale.ts`'s own header.
 */
import { effortColor, effortSteps } from '../../lib/effortScale'
import { PillPicker } from './PillPicker'

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

  const items = steps.map(step => ({
    key: step.value,
    label: step.value,
    color: effortColor(step.intensity),
    ...(step.peak ? { className: 'ag-effort-peak' } : {}),
  }))
  // Clicking the chosen level again clears it ("leave it to the assistant").
  return <PillPicker items={items} value={value} onPick={key => onChange(key === value ? '' : key)} />
}

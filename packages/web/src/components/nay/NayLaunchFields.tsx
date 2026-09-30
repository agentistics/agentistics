/**
 * NayLaunchFields.tsx — the three pickers a Nay conversation starts with: assistant, model and
 * reasoning effort. Shared by Settings -> Chat (the saved defaults) and the dock's create picker, so
 * the two can never offer different things. A picker the chosen CLI has no flag for is ABSENT, and
 * the pickers are the Agentistics `Select`, never a native one.
 */

import type { HarnessAnswer } from '../../lib/wizardSteps'
import { effortOptions, harnessOptions, modelOptions, withHarness, type NayLaunchChoice } from '../../lib/nayLaunch'
import { Select } from '../../pages/settings/primitives'
import { HARNESS_LABELS } from '../../lib/harness'

export function NayLaunchFields({ value, onChange, harnesses, pt, layout }: {
  value: NayLaunchChoice
  onChange: (next: NayLaunchChoice) => void
  harnesses: readonly HarnessAnswer[]
  pt: boolean
  /** `rows`: a label beside each field (Settings). `stack`: label above, full width (a narrow
   *  popover). `compact`: fields side by side (the dock's create picker). */
  layout: 'rows' | 'stack' | 'compact'
}) {
  const h = harnesses.find(x => x.id === value.harness)
  const models = modelOptions(h, pt, value.model)
  const efforts = effortOptions(h, pt)
  const fields: { key: string; label: string; node: React.ReactNode }[] = [
    { key: 'harness', label: pt ? 'Assistente' : 'Assistant', node: (
      <Select value={value.harness} options={harnessOptions(harnesses, HARNESS_LABELS)} onChange={v => onChange(withHarness(value, v))} />
    ) },
  ]
  if (models) fields.push({ key: 'model', label: pt ? 'Modelo' : 'Model', node: (
    <Select value={value.model} options={models} searchPlaceholder={pt ? 'Buscar modelo…' : 'Search models…'}
      onChange={v => onChange({ ...value, model: v })} />
  ) })
  if (efforts) fields.push({ key: 'effort', label: pt ? 'Esforço' : 'Effort', node: (
    <Select value={value.effort} options={efforts} onChange={v => onChange({ ...value, effort: v })} />
  ) })

  if (layout === 'compact' || layout === 'stack') {
    return (
      <div style={{ display: 'grid', gridTemplateColumns: layout === 'stack' ? 'minmax(0, 1fr)' : `repeat(${fields.length}, minmax(0, 1fr))`, gap: 6 }}>
        {fields.map(f => (
          <label key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
            <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>{f.label}</span>
            {f.node}
          </label>
        ))}
      </div>
    )
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {fields.map(f => (
        <div key={f.key} style={{ display: 'grid', gridTemplateColumns: 'minmax(90px, 140px) minmax(0, 280px)', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>{f.label}</span>
          {f.node}
        </div>
      ))}
    </div>
  )
}

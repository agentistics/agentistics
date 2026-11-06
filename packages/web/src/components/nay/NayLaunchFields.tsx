/**
 * NayLaunchFields.tsx — the three pickers a Nay conversation starts with: assistant, model and
 * reasoning effort. Shared by Settings -> Chat (the saved defaults) and the dock's create picker, so
 * the two can never offer different things. A picker the chosen CLI has no flag for is ABSENT, and
 * the pickers are the Agentistics `Select`, never a native one.
 */

import type { HarnessAnswer } from '../../lib/wizardSteps'
import { accountChoices, effortOptions, harnessOptions, modelOptions, withHarness, type NayLaunchChoice } from '../../lib/nayLaunch'
import { HarnessPicker } from '../sessions/HarnessPicker'
import { EffortPicker } from '../sessions/EffortPicker'
import { usePlanLimits } from '../../lib/planLimits'
import { Select } from '../../pages/settings/primitives'
import { HARNESS_LABELS } from '../../lib/harness'

export function NayLaunchFields({ value, onChange, harnesses, pt, layout }: {
  value: NayLaunchChoice
  onChange: (next: NayLaunchChoice) => void
  harnesses: readonly HarnessAnswer[]
  pt: boolean
  /** `rows`: a label beside each field (Settings). `stack`: label above, full width (a narrow
   *  popover). `compact`: fields side by side (the dock's create picker). */
  layout: 'rows' | 'stack' | 'compact' | 'card'
}) {
  if (layout === 'card') return <NayLaunchCard value={value} onChange={onChange} harnesses={harnesses} pt={pt} />
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

const labelStyle = { fontSize: 10, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-tertiary)', marginBottom: 4 } as const

/**
 * Variant A of the Nay selector (the owner's pick, 06/11): the New-session controls in the Nay panel —
 * assistant cards (the very `HarnessPicker`, with "more room" and Install), the model `Select` with
 * search, the effort pills and an ACCOUNT field. "Automática" is the account router's pick, so a person
 * who never opens the field starts exactly where every other start does. Out on purpose: session type,
 * away mode, title, folder, task, first message, attachments and mode.
 */
function NayLaunchCard({ value, onChange, harnesses, pt }: {
  value: NayLaunchChoice; onChange: (next: NayLaunchChoice) => void; harnesses: readonly HarnessAnswer[]; pt: boolean
}) {
  const snap = usePlanLimits()
  const h = harnesses.find(x => x.id === value.harness)
  const models = modelOptions(h, pt, value.model)
  const { auto, accounts } = accountChoices(snap.limits, snap.accountLabels, value.harness, snap.now)
  const freeText = (pct: number | null) => (pct === null ? '' : `${pct}% ${pt ? 'livre' : 'free'}`)
  const accountOptions = auto ? [
    { value: '', label: `${pt ? 'Automática' : 'Automatic'} — ${auto.label}${auto.freePct === null ? '' : ` · ${freeText(auto.freePct)}`}`,
      hint: pt ? 'escolhe a conta de mais folga' : 'picks the account with most room' },
    ...accounts.map(a => ({ value: a.value, label: `${a.label}${a.freePct === null ? '' : ` · ${freeText(a.freePct)}`}`,
      ...(a.nearLimit ? { hint: pt ? 'quase no limite' : 'near the limit' } : {}) })),
  ] : null
  const picked = value.account ? accounts.find(a => a.value === value.account) : auto
  return (
    <div data-nay-launch-card style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
      <div>
        <div style={labelStyle}>{pt ? 'Assistente' : 'Assistant'}</div>
        <HarnessPicker lang={pt ? 'pt' : 'en'} harnesses={harnesses} value={value.harness}
          onChange={id => onChange(withHarness(value, id))} planLimits={snap.limits} now={snap.now} />
      </div>
      {models && (
        <div>
          <div style={labelStyle}>{pt ? 'Modelo' : 'Model'}</div>
          <Select value={value.model} options={models} searchable searchPlaceholder={pt ? 'Buscar modelo…' : 'Search models…'}
            onChange={v => onChange({ ...value, model: v })} />
        </div>
      )}
      {h && h.efforts.length > 0 && (
        <div>
          <div style={labelStyle}>{pt ? 'Esforço' : 'Effort'}</div>
          <EffortPicker efforts={h.efforts} value={value.effort} onChange={v => onChange({ ...value, effort: v })} />
        </div>
      )}
      {accountOptions && (
        <div>
          <div style={labelStyle}>{pt ? 'Conta' : 'Account'}</div>
          <Select value={value.account} options={accountOptions} onChange={v => onChange({ ...value, account: v })} />
          {picked && picked.freePct !== null && (
            <div aria-hidden style={{ marginTop: 5, height: 4, borderRadius: 2, background: 'var(--border-subtle)', overflow: 'hidden' }}>
              <div style={{ width: `${picked.freePct}%`, height: '100%', background: picked.nearLimit ? 'var(--accent-red)' : picked.freePct < 40 ? 'var(--accent-orange, #f59e0b)' : 'var(--accent-green, #10b981)' }} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * The ONE dialog away mode asks on activation: until when, what is pre-authorised, the worker
 * ceiling, a top-model ceiling for EVERY active provider (a reported limit or a registered plan —
 * what `agentistics_plan_limits` reads) and a free note — then it frees the person. Built only from
 * the settings primitives (`ConfirmModal`, `Select`, `Checkbox`, `FieldTextarea`); nothing hand-rolled.
 */
import React, { useEffect, useState } from 'react'
import { Moon } from 'lucide-react'
import { AWAY_AUTH_IDS, AWAY_AUTH_LABEL, AWAY_DEFAULT_MAX_WORKERS, AWAY_DEFAULT_TOP_CAP, AWAY_MAX_CEILING, AWAY_NOTE_MAX, AWAY_TOP_MODEL, SURFACE_HARNESS_ORDER, type AwayAuthId, type AwayTopCaps, type HarnessId } from '@agentistics/core' // @native-gated: activeCapProviders keeps only harnesses AWAY_TOP_MODEL names
import { Checkbox, ConfirmModal, FieldTextarea, Select } from '../pages/settings/primitives'
import { activeCapProviders, setAway, UNTIL_CHOICES, untilChoiceLabel, untilFromChoice, useAway, type UntilChoice } from '../lib/awayMode'
import { usePlanLimits } from '../lib/planLimits'
import { HARNESS_LABELS } from '../lib/harness'

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i)

export default function AwayModeDialog({ open, lang, onClose }: { open: boolean; lang: 'pt' | 'en'; onClose: () => void }) {
  const pt = lang === 'pt'
  const [until, setUntil] = useState<UntilChoice>('tomorrow9')
  const [auth, setAuth] = useState<AwayAuthId[]>(['releases', 'workers'])
  const [maxWorkers, setMaxWorkers] = useState(AWAY_DEFAULT_MAX_WORKERS)
  const [topCaps, setTopCaps] = useState<AwayTopCaps>({})
  const plans = usePlanLimits()
  const stored = useAway().state?.topCaps ?? {}
  const providers = activeCapProviders(SURFACE_HARNESS_ORDER, plans.limits, plans.registered, stored) // @native-gated: filtered to AWAY_TOP_MODEL
  const capOf = (h: HarnessId) => Math.min(topCaps[h] ?? stored[h] ?? AWAY_DEFAULT_TOP_CAP, maxWorkers)
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (open) { setError(null); setBusy(false); setTopCaps({}) } }, [open])

  const confirm = async () => {
    if (busy) return
    setBusy(true)
    const r = await setAway({
      on: true, until: untilFromChoice(until, Date.now()), authorised: auth, note,
      // Only the providers listed are sent; one not listed keeps the shared default.
      maxWorkers, topCaps: Object.fromEntries(providers.map(h => [h, capOf(h)])),
    })
    setBusy(false)
    if (r.ok) onClose()
    else setError(pt ? `Não foi possível ligar o modo ausente (${r.error}).` : `Could not turn away mode on (${r.error}).`)
  }

  const label = (t: string) => <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>{t}</span>
  return (
    <ConfirmModal
      open={open}
      tone="default"
      icon={<Moon size={17} />}
      title={pt ? 'Ligar o modo ausente' : 'Turn on away mode'}
      message={pt
        ? 'As sessões passam a saber que você está fora: os líderes decidem dentro do que você autorizar, seguem o ritmo do plano e não param o turno com perguntas; os workers reportam ao líder.'
        : 'Sessions will know you are out: leaders decide within what you authorise, pace by your plan and never stop a turn on a question; workers report to their leader.'}
      confirmLabel={busy ? (pt ? 'Ligando…' : 'Turning on…') : (pt ? 'Ligar' : 'Turn on')}
      cancelLabel={pt ? 'Cancelar' : 'Cancel'}
      onConfirm={() => { void confirm() }}
      onCancel={onClose}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {label(pt ? 'Até quando' : 'Until when')}
          <Select value={until} onChange={v => setUntil(v as UntilChoice)}
            options={UNTIL_CHOICES.map(c => ({ value: c, label: untilChoiceLabel(c, lang) }))} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {label(pt ? 'Pode sem me perguntar' : 'Allowed without asking me')}
          {AWAY_AUTH_IDS.map(id => (
            <Checkbox key={id} checked={auth.includes(id)} label={AWAY_AUTH_LABEL[id][lang]}
              onChange={c => setAuth(a => (c ? [...a, id] : a.filter(x => x !== id)))} />
          ))}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {label(pt ? 'Máx. de workers' : 'Max workers')}
          <Select value={String(maxWorkers)} onChange={v => setMaxWorkers(Number(v))}
            options={range(1, AWAY_MAX_CEILING).map(n => ({ value: String(n), label: String(n) }))} />
        </div>
        <div data-away-top-caps style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {label(pt ? 'Máx. no modelo de topo, por provedor' : 'Max on the top model, per provider')}
          {providers.length === 0 ? (
            <span style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.45 }}>
              {pt ? `Nenhum plano ativo detectado ainda — cada provedor fica com até ${Math.min(AWAY_DEFAULT_TOP_CAP, maxWorkers)}.`
                : `No active plan detected yet — every provider gets up to ${Math.min(AWAY_DEFAULT_TOP_CAP, maxWorkers)}.`}
            </span>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 }}>
              {providers.map(h => (
                <div key={h} data-provider={h} style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
                  <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {HARNESS_LABELS[h] ?? h} · {AWAY_TOP_MODEL[h][lang]}
                  </span>
                  <Select value={String(capOf(h))} onChange={v => setTopCaps(c => ({ ...c, [h]: Number(v) }))}
                    options={range(0, maxWorkers).map(n => ({ value: String(n), label: String(n) }))} />
                </div>
              ))}
            </div>
          )}
        </div>
        <FieldTextarea label={pt ? 'Recado para os líderes (opcional)' : 'Note for the leaders (optional)'}
          value={note} onChange={setNote} rows={2} maxLength={AWAY_NOTE_MAX}
          placeholder={pt ? 'ex.: foco no QUAL; nada de deploy em cloud' : 'e.g. focus on QUAL; no cloud deploys'} />
        {error && <span role="alert" style={{ fontSize: 12, color: '#ef4444' }}>{error}</span>}
      </div>
    </ConfirmModal>
  )
}

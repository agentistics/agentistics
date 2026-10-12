/**
 * The ONE dialog away mode asks on activation: until when, what is pre-authorised, the worker/Opus
 * ceilings and a free note — then it frees the person. Built only from the settings primitives
 * (`ConfirmModal`, `Select`, `Checkbox`, `FieldTextarea`); nothing hand-rolled.
 */
import React, { useEffect, useState } from 'react'
import { Moon } from 'lucide-react'
import { AWAY_AUTH_IDS, AWAY_AUTH_LABEL, AWAY_DEFAULT_MAX_OPUS, AWAY_DEFAULT_MAX_WORKERS, AWAY_MAX_CEILING, AWAY_NOTE_MAX, type AwayAuthId } from '@agentistics/core'
import { Checkbox, ConfirmModal, FieldTextarea, Select } from '../pages/settings/primitives'
import { setAway, UNTIL_CHOICES, untilChoiceLabel, untilFromChoice, type UntilChoice } from '../lib/awayMode'

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i)

export default function AwayModeDialog({ open, lang, onClose }: { open: boolean; lang: 'pt' | 'en'; onClose: () => void }) {
  const pt = lang === 'pt'
  const [until, setUntil] = useState<UntilChoice>('tomorrow9')
  const [auth, setAuth] = useState<AwayAuthId[]>(['releases', 'workers'])
  const [maxWorkers, setMaxWorkers] = useState(AWAY_DEFAULT_MAX_WORKERS)
  const [maxOpus, setMaxOpus] = useState(AWAY_DEFAULT_MAX_OPUS)
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (open) { setError(null); setBusy(false) } }, [open])

  const confirm = async () => {
    if (busy) return
    setBusy(true)
    const r = await setAway({
      on: true, until: untilFromChoice(until, Date.now()), authorised: auth, note,
      maxWorkers, maxOpus: Math.min(maxOpus, maxWorkers),
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
        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {label(pt ? 'Máx. de workers' : 'Max workers')}
            <Select value={String(maxWorkers)} onChange={v => setMaxWorkers(Number(v))}
              options={range(1, AWAY_MAX_CEILING).map(n => ({ value: String(n), label: String(n) }))} />
          </div>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {label(pt ? 'Máx. no Opus' : 'Max on Opus')}
            <Select value={String(Math.min(maxOpus, maxWorkers))} onChange={v => setMaxOpus(Number(v))}
              options={range(0, maxWorkers).map(n => ({ value: String(n), label: String(n) }))} />
          </div>
        </div>
        <FieldTextarea label={pt ? 'Recado para os líderes (opcional)' : 'Note for the leaders (optional)'}
          value={note} onChange={setNote} rows={2} maxLength={AWAY_NOTE_MAX}
          placeholder={pt ? 'ex.: foco no QUAL; nada de deploy em cloud' : 'e.g. focus on QUAL; no cloud deploys'} />
        {error && <span role="alert" style={{ fontSize: 12, color: '#ef4444' }}>{error}</span>}
      </div>
    </ConfirmModal>
  )
}

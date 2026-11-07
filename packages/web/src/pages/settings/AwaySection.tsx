/**
 * Settings → Sessions → Autonomous mode. A `RowSwitch`: on opens the one activation dialog
 * (`AwayModeDialog`), off asks for confirmation before clearing every own flag. Hidden where this server cannot drive sessions
 * (no `localShell`), because autonomous mode only changes what sessions here are told.
 */
import { AwayImpact } from '../../components/AwayImpact'
import { ConfirmModal } from './primitives'
import React, { useState } from 'react'
import { RowSwitch, SectionHeader } from './primitives'
import AwayModeDialog from '../../components/AwayModeDialog'
import { AUTONOMOUS_ICON, awayUntilLabel, setAway, useAway } from '../../lib/awayMode'

export default function AwaySection({ lang, capable, embedded = false }: { lang: 'pt' | 'en'; capable: boolean; embedded?: boolean }) {
  const pt = lang === 'pt'
  const away = useAway()
  const [dialog, setDialog] = useState(false)
  const [confirmOff, setConfirmOff] = useState(false)
  if (!capable) return null
  const armed = away.state?.on === true
  const waiting = armed && !away.active
  // Embedded (the Leadership page) already states the "until/scheduled" line in its header.
  const outside = pt ? 'fora da janela agora' : 'outside the window now'
  const sub = armed && away.state
    ? (embedded
      ? (waiting ? outside : (pt ? 'Líderes decidem e registram; workers reportam ao líder.' : 'Leaders decide and record; workers report to their leader.'))
      : `${awayUntilLabel(away.state, lang, Date.now())}${waiting ? ` — ${outside}` : ''}`)
    : (pt ? 'Quando ligado, as sessões não perguntam nada a você: os líderes decidem e registram, os workers reportam ao líder.'
      : 'When on, sessions ask you nothing: leaders decide and record, workers report to their leader.')
  return (
    <>
      {!embedded && <SectionHeader label={pt ? 'Modo autônomo' : 'Autonomous mode'} />}
      <RowSwitch wrap
        on={armed}
        disabled={away.state === null}
        icon={<AUTONOMOUS_ICON size={15} />}
        label={pt ? 'Sessões trabalham sem pedir permissão' : "Sessions work without asking permission"}
        sub={sub}
        onToggle={() => { if (armed) setConfirmOff(true); else setDialog(true) }}
      />
      {armed && <button type="button" data-away-edit onClick={() => setDialog(true)}
        style={{ alignSelf: 'flex-start', margin: '2px 0 6px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', borderRadius: 8, padding: '4px 10px', fontSize: 12, cursor: 'pointer' }}>
        {pt ? 'Editar quando' : 'Edit when'}
      </button>}
      <ConfirmModal open={confirmOff} tone="default" title={pt ? 'Voltou?' : 'Back?'}
        message={pt ? 'Isto limpa o modo autônomo de todas as sessões.' : 'This clears autonomous mode for every session.'}
        confirmLabel={pt ? 'Desligar' : 'Turn off'} cancelLabel={pt ? 'Cancelar' : 'Cancel'}
        onConfirm={() => { setConfirmOff(false); void setAway({ on: false }) }} onCancel={() => setConfirmOff(false)}>
        <AwayImpact pt={pt} open={confirmOff} />
      </ConfirmModal>
      <AwayModeDialog open={dialog} lang={lang} onClose={() => setDialog(false)} />
    </>
  )
}

/**
 * Settings → Sessions → Away mode. A `RowSwitch`: on opens the one activation dialog
 * (`AwayModeDialog`), off asks for confirmation before clearing every own flag. Hidden where this server cannot drive sessions
 * (no `localShell`), because away mode only changes what sessions here are told.
 */
import { AwayImpact } from '../../components/AwayImpact'
import { ConfirmModal } from './primitives'
import React, { useState } from 'react'
import { Moon } from 'lucide-react'
import { AWAY_AUTH_LABEL } from '@agentistics/core'
import { RowSwitch, SectionHeader } from './primitives'
import AwayModeDialog from '../../components/AwayModeDialog'
import { awayUntilLabel, setAway, useAway } from '../../lib/awayMode'

export default function AwaySection({ lang, capable }: { lang: 'pt' | 'en'; capable: boolean }) {
  const pt = lang === 'pt'
  const away = useAway()
  const [dialog, setDialog] = useState(false)
  const [confirmOff, setConfirmOff] = useState(false)
  if (!capable) return null
  const sub = away.active && away.state
    ? `${awayUntilLabel(away.state, lang, Date.now())} · ${away.state.authorised.map(a => AWAY_AUTH_LABEL[a][lang]).join(', ') || (pt ? 'nada pré-autorizado' : 'nothing pre-authorised')}`
    : (pt ? 'Quando ligado, as sessões não perguntam nada a você: os líderes decidem e registram, os workers reportam ao líder.'
      : 'When on, sessions ask you nothing: leaders decide and record, workers report to their leader.')
  return (
    <>
      <SectionHeader label={pt ? 'Modo ausente' : 'Away mode'} />
      <RowSwitch wrap
        on={away.active}
        disabled={away.state === null}
        icon={<Moon size={15} />}
        label={pt ? 'Estou fora (dormindo, viajando)' : "I'm away (asleep, travelling)"}
        sub={sub}
        onToggle={() => { if (away.active) setConfirmOff(true); else setDialog(true) }}
      />
      <ConfirmModal open={confirmOff} tone="default" title={pt ? 'Voltou?' : 'Back?'}
        message={pt ? 'Isto limpa o modo ausente de todas as sessões.' : 'This clears away mode for every session.'}
        confirmLabel={pt ? 'Desligar' : 'Turn off'} cancelLabel={pt ? 'Cancelar' : 'Cancel'}
        onConfirm={() => { setConfirmOff(false); void setAway({ on: false }) }} onCancel={() => setConfirmOff(false)}>
        <AwayImpact pt={pt} open={confirmOff} />
      </ConfirmModal>
      <AwayModeDialog open={dialog} lang={lang} onClose={() => setDialog(false)} />
    </>
  )
}

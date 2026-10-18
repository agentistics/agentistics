import { useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import type { ControlSession } from '@agentistics/tui/control/session-fleet'
import type { AppContext } from '../../lib/app-context'
import { useFleet } from '../../lib/fleet'
import { useCheckinReports, type CheckinState } from '../../lib/checkin'
import { useIsMobile } from '../../hooks/useIsMobile'
import { PageHeader } from '../../components/nav/PageHeader'
import { Pill } from '../../components/Pill'
import { Section } from '../../components/Section'
import { RecordCard, RecordCardAction } from '../settings/primitives'
import CheckinDefaultsSection from '../settings/CheckinDefaultsSection'

export default function CheckinsPage() {
  const { lang, capabilities, isCentral } = useOutletContext<AppContext>()
  const enabled = capabilities?.localShell !== false && !isCentral
  const { reports, error } = useCheckinReports(enabled)
  const { fleet } = useFleet(lang, enabled)
  return <CheckinsContent lang={lang} reports={reports} rows={fleet.rows} error={error} capable={enabled} />
}

export function CheckinsContent({ lang, reports, rows, error = false, capable = true }: {
  lang: 'pt' | 'en'; reports: readonly CheckinState[] | null; rows: readonly ControlSession[]; error?: boolean; capable?: boolean
}) {
  const [visible, setVisible] = useState(10)
  const pt = lang === 'pt'
  const isMobile = useIsMobile()
  const rounds = (reports ?? []).filter(report => report.last).slice().sort((a, b) => (b.last?.at ?? b.lastRunAt ?? 0) - (a.last?.at ?? a.lastRunAt ?? 0))
  return <div style={{ minWidth: 0 }}>
    <PageHeader lang={lang} areaId="leadership" pageId="checkins" />
    {!capable ? <p role="status">{pt ? 'Check-ins indisponíveis nesta instância.' : 'Check-ins are unavailable on this instance.'}</p> : <>
      {error && <p role="status">{pt ? 'Não foi possível atualizar as rodadas.' : 'Could not refresh check-in rounds.'}</p>}
      {!reports && !error && <p role="status">{pt ? 'Carregando rodadas…' : 'Loading rounds…'}</p>}
      {reports && !error && rounds.length === 0 && <p>{pt ? 'Nenhuma rodada de check-in registrada ainda.' : 'No check-in rounds recorded yet.'}</p>}
      <div style={{ display: 'grid', gap: 12, marginBottom: 20, gridTemplateColumns: 'minmax(0, 1fr)' }}>
        {rounds.slice(0, visible).map(report => {
          const round = report.last!
          const row = rows.find(row => row.id === report.session || row.conversationId === report.session)
          const at = round.at ?? report.lastRunAt
          return <RecordCard key={report.session} fieldLayout="stacked" title={row?.title?.trim() || (pt ? 'Sessão desconhecida' : 'Unknown session')}
            subtitle={at != null ? <time dateTime={new Date(at).toISOString()}>{new Date(at).toLocaleString(pt ? 'pt-BR' : 'en-US')}</time> : undefined}
            badge={<Pill tone={round.state === 'needs_you' ? 'warn' : 'ok'}>{round.state === 'needs_you' ? (pt ? 'Precisa de você' : 'Needs you') : round.state === 'resolved' ? (pt ? 'Resolvido' : 'Resolved') : 'OK'}</Pill>}
            fields={[
              ...(round.needs?.map((need, index) => ({ label: `${pt ? 'Pendência' : 'Need'} ${index + 1}`, value: <span style={{ overflowWrap: 'anywhere' }}>{need.subject}: {need.text}</span> })) ?? []),
            ]}>
            <p style={{ margin: 0, fontSize: 12, color: 'var(--text-secondary)', textAlign: 'left', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{round.summary}</p>
          </RecordCard>
        })}
      </div>
      {rounds.length > visible && <RecordCardAction label={pt ? 'Mostrar mais check-ins' : 'Show more check-ins'} onClick={() => setVisible(count => count + 10)}>{pt ? `Mostrar mais (${rounds.length - visible})` : `Show more (${rounds.length - visible})`}</RecordCardAction>}
      <Section title={pt ? 'Padrão para líderes' : 'Leader defaults'}>
        <CheckinDefaultsSection pt={pt} isMobile={isMobile} />
      </Section>
    </>}
  </div>
}

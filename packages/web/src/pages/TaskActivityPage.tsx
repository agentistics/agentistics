import React from 'react'
import { Link, useOutletContext } from 'react-router-dom'
import type { AppContext } from '../lib/app-context'
import { useTaskActivity } from '../lib/tasks'
import { PageHeader } from '../components/nav/PageHeader'
import { RecordCard } from './settings/primitives'
import { useIsMobile } from '../hooks/useIsMobile'

export default function TaskActivityPage() {
  const { lang } = useOutletContext<AppContext>()
  const { events, loading, error, reload } = useTaskActivity()
  const isMobile = useIsMobile()
  const pt = lang === 'pt'

  return (
    <>
      <PageHeader lang={lang} areaId="tasks" pageId="activity" isMobile={isMobile}
        status={loading ? (pt ? 'Carregando atividade…' : 'Loading activity…')
          : error ? (pt ? 'Não foi possível atualizar a atividade.' : 'Activity could not be refreshed.')
            : (pt ? `${events.length} eventos recentes` : `${events.length} recent events`)}
        actions={[{ label: pt ? 'Atualizar' : 'Refresh', onClick: () => { void reload() } }]} />
      {!loading && !error && events.length === 0 && (
        <p style={{ color: 'var(--text-secondary)' }}>{pt ? 'Nenhuma atividade registrada no quadro.' : 'No board activity recorded.'}</p>
      )}
      <ul aria-label={pt ? 'Atividade do quadro' : 'Board activity'} style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 12, minWidth: 0 }}>
        {events.map(event => (
          <li key={event.id} style={{ minWidth: 0 }}>
            <RecordCard
              title={<Link to={`/tasks/${encodeURIComponent(event.taskId)}`} style={{
                display: 'flex', alignItems: 'center', minHeight: isMobile ? 44 : undefined,
                color: 'var(--anthropic-orange)', overflowWrap: 'anywhere', whiteSpace: 'normal',
              }}>{event.taskId}</Link>}
              subtitle={event.actor}
              fields={[
                { label: pt ? 'Evento' : 'Event', value: <span style={{ overflowWrap: 'anywhere' }}>{event.summary ?? event.kind}</span> },
                { label: pt ? 'Quando' : 'When', value: Number.isFinite(Date.parse(event.at))
                  ? <time dateTime={event.at}>{new Date(event.at).toLocaleString(pt ? 'pt-BR' : 'en-US')}</time>
                  : (pt ? 'Horário indisponível' : 'Time unavailable') },
                ...(event.from !== undefined || event.to !== undefined ? [{
                  label: pt ? 'Mudança' : 'Change', value: `${event.from || '—'} → ${event.to || '—'}`,
                }] : []),
                ...(event.detail && !event.summary ? [{
                  label: pt ? 'Detalhes' : 'Details', value: <span style={{ overflowWrap: 'anywhere' }}>{event.detail}</span>,
                }] : []),
              ]}
            />
          </li>
        ))}
      </ul>
    </>
  )
}

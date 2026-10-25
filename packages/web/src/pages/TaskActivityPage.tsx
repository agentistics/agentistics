import React from 'react'
import { Link, useOutletContext } from 'react-router-dom'
import type { AppContext } from '../lib/app-context'
import { useTaskActivity, useTaskList, useTaskStatuses, type TaskEvent } from '../lib/tasks'
import { PageHeader } from '../components/nav/PageHeader'
import { RecordCard } from './settings/primitives'
import { useIsMobile } from '../hooks/useIsMobile'
import { activityActor, activitySentence } from './taskActivity'

export default function TaskActivityPage() {
  const { lang } = useOutletContext<AppContext>()
  const { events, loading, error, reload } = useTaskActivity()
  const { rows, reload: reloadTasks } = useTaskList()
  const { statuses } = useTaskStatuses()
  const isMobile = useIsMobile()
  const pt = lang === 'pt'

  return (
    <>
      <PageHeader lang={lang} areaId="tasks" pageId="activity" isMobile={isMobile}
        status={loading ? (pt ? 'Carregando atividade…' : 'Loading activity…')
          : error ? (pt ? 'Não foi possível atualizar a atividade.' : 'Activity could not be refreshed.')
            : (pt ? `${events.length} eventos recentes` : `${events.length} recent events`)}
        actions={[{ label: pt ? 'Atualizar' : 'Refresh', onClick: () => { void reload(); void reloadTasks() } }]} />
      {!loading && !error && events.length === 0 && (
        <p style={{ color: 'var(--text-secondary)' }}>{pt ? 'Nenhuma atividade registrada no quadro.' : 'No board activity recorded.'}</p>
      )}
      <TaskActivityList events={events} titles={new Map((rows ?? []).map(row => [row.task.id, row.task.title]))} statuses={statuses ?? []} lang={lang} isMobile={isMobile} />
    </>
  )
}

/** Pure list also used by the regression fixtures at desktop and phone widths. */
export function TaskActivityList({ events, titles, statuses = [], lang, isMobile = false }: {
  events: readonly TaskEvent[]; titles: ReadonlyMap<string, string>
  statuses?: readonly { id: string; label: string }[]; lang: 'pt' | 'en'; isMobile?: boolean
}) {
  const pt = lang === 'pt'
  return <ul aria-label={pt ? 'Atividade do quadro' : 'Board activity'} style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 12, minWidth: 0 }}>
    {events.map(event => <li key={event.id} style={{ minWidth: 0 }}>
      <RecordCard fieldLayout="stacked"
        title={<Link to={`/tasks/${encodeURIComponent(event.taskId)}`} style={{
          display: 'flex', alignItems: 'center', minHeight: isMobile ? 44 : undefined,
          color: 'var(--anthropic-orange)', overflowWrap: 'anywhere', whiteSpace: 'normal',
        }}>{titles.get(event.taskId) ?? (pt ? 'Tarefa indisponível' : 'Task unavailable')}</Link>}
        subtitle={<span style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{pt ? 'Por' : 'By'} {activityActor(event.actor, lang)}</span>}
        fields={[]}
      >
        <p style={{ margin: 0, fontSize: 12, color: 'var(--text-secondary)', textAlign: 'left' }}>{activitySentence(event, lang, statuses)}</p>
        <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{Number.isFinite(Date.parse(event.at))
          ? <time dateTime={event.at}>{new Date(event.at).toLocaleString(pt ? 'pt-BR' : 'en-US')}</time>
          : (pt ? 'Horário indisponível' : 'Time unavailable')}</div>
      </RecordCard>
    </li>)}
  </ul>
}

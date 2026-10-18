import React, { useMemo } from 'react'
import { useOutletContext } from 'react-router-dom'
import { repoShortName, sessionLabel, type SessionMeta } from '@agentistics/core'
import type { AppContext } from '../lib/app-context'
import { PageHeader } from '../components/nav/PageHeader'
import { Section } from '../components/Section'
import { RecordCard, RecordCardAction } from './settings/primitives'
import { HARNESS_LABELS } from '../lib/harness'
import { groupCiSessions } from './actionsGroups'

export default function ActionsPage() {
  const { data, lang, setSelectedSession } = useOutletContext<AppContext>()
  return <ActionsContent sessions={data.sessions} lang={lang} onSelect={setSelectedSession} />
}

export function ActionsContent({ sessions, lang, onSelect }: {
  sessions: SessionMeta[]; lang: 'pt' | 'en'; onSelect: (session: SessionMeta) => void
}) {
  const pt = lang === 'pt'
  const groups = useMemo(() => groupCiSessions(sessions), [sessions])
  const runs = groups.reduce((total, group) => total + group.sessions.length, 0)
  const repos = groups.filter(group => group.remote !== '').length
  return <>
    <PageHeader lang={lang} areaId="repositories" pageId="actions" status={!runs ? undefined : pt
      ? `${runs} ${runs === 1 ? 'execução' : 'execuções'} em ${repos} ${repos === 1 ? 'repositório' : 'repositórios'}`
      : `${runs} ${runs === 1 ? 'run' : 'runs'} in ${repos} ${repos === 1 ? 'repository' : 'repositories'}`} />
    {!groups.length ? <p style={{ color: 'var(--text-secondary)' }}>{pt ? 'Nenhuma execução de CI registrada.' : 'No CI runs recorded.'}</p>
      : groups.map(group => <Section key={group.remote} title={<span style={{ overflowWrap: 'anywhere', minWidth: 0 }}>
        {group.remote ? repoShortName(group.remote) : (pt ? 'Sem repositório' : 'No repository')}
      </span>}>
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8, minWidth: 0 }}>
          {group.sessions.map(session => {
            const title = sessionLabel(session) || (pt ? 'Execução sem título' : 'Untitled run')
            const at = Date.parse(session.start_time)
            return <li key={session.session_id} style={{ minWidth: 0 }}>
              <RecordCard fieldLayout="stacked" title={title} fields={[]}
                badge={<RecordCardAction inline label={`${pt ? 'Abrir' : 'Open'} ${title}`} onClick={() => onSelect(session)}>{pt ? 'Abrir execução' : 'Open run'}</RecordCardAction>}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: 12, color: 'var(--text-secondary)' }}>
                  <span>{session.harness ? (HARNESS_LABELS[session.harness] ?? session.harness) : 'N/A'}</span>
                  {session.model && <span style={{ overflowWrap: 'anywhere' }}>· {session.model}</span>}
                  {Number.isFinite(at) ? <time dateTime={new Date(at).toISOString()}>{new Date(at).toLocaleString(pt ? 'pt-BR' : 'en-US')}</time> : <span>N/A</span>}
                </div>
              </RecordCard>
            </li>
          })}
        </ul>
      </Section>)}
  </>
}

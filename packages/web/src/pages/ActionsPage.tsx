import React, { useMemo } from 'react'
import { useOutletContext } from 'react-router-dom'
import { repoShortName } from '@agentistics/core'
import type { AppContext } from '../lib/app-context'
import { PageHeader } from '../components/nav/PageHeader'
import { Section } from '../components/Section'
import { RecentSessions } from '../components/RecentSessions'
import { groupCiSessions } from './actionsGroups'

export default function ActionsPage() {
  const { data, lang, setSelectedSession } = useOutletContext<AppContext>()
  const pt = lang === 'pt'
  const groups = useMemo(() => groupCiSessions(data.sessions), [data.sessions])
  const runs = groups.reduce((total, group) => total + group.sessions.length, 0)
  const repos = groups.filter(group => group.remote !== '').length

  return (
    <>
      <PageHeader lang={lang} areaId="repositories" pageId="actions" status={pt
        ? `${runs} execuções em ${repos} repositórios`
        : `${runs} runs in ${repos} repositories`} />
      {groups.length === 0
        ? <p style={{ color: 'var(--text-secondary)' }}>{pt ? 'Nenhuma execução de CI registrada.' : 'No CI runs recorded.'}</p>
        : groups.map(group => (
          <Section key={group.remote} title={<span style={{ overflowWrap: 'anywhere', minWidth: 0 }}>
            {group.remote ? repoShortName(group.remote) : (pt ? 'Sem repositório' : 'No repository')}
          </span>}>
            <RecentSessions sessions={group.sessions} lang={lang} onSelect={setSelectedSession} />
          </Section>
        ))}
    </>
  )
}

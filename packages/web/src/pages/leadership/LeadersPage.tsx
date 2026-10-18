import { useNavigate, useOutletContext } from 'react-router-dom'
import type { ControlSession } from '@agentistics/tui/control/session-fleet'
import type { AppContext } from '../../lib/app-context'
import { useFleet } from '../../lib/fleet'
import { getSessionRole, useSessionRoles, useSessionRolesReady, type SessionRole } from '../../lib/sessionRoles'
import { sessionIdentityKey } from '../../lib/sessionIdentity'
import { applyLeadersOnly } from '../../lib/leadersFilter'
import { sessionChildren } from '../../lib/sessionParent'
import { fmtSpan } from '../../lib/planLimits'
import { useIsMobile } from '../../hooks/useIsMobile'
import { PageHeader } from '../../components/nav/PageHeader'
import { Pill } from '../../components/Pill'
import { RecordCard, RecordCardAction } from '../settings/primitives'

type Lang = 'pt' | 'en'

export default function LeadersPage() {
  const { lang, capabilities, isCentral } = useOutletContext<AppContext>()
  const enabled = capabilities?.localShell !== false && !isCentral
  const { fleet, loading, unsupported, stale } = useFleet(lang, enabled)
  useSessionRoles()
  const rolesReady = useSessionRolesReady()
  const roleOf = (row: ControlSession) => getSessionRole(sessionIdentityKey(row)) ?? getSessionRole(row.id)
  return <LeadersContent lang={lang} rows={fleet.rows} roleOf={roleOf} loading={loading || !rolesReady}
    unavailable={!enabled || unsupported} stale={stale} />
}

/** Fixture-friendly composition; the live page supplies the shared fleet and role stores. */
export function LeadersContent({ lang, rows, roleOf, loading = false, unavailable = false, stale, now = Date.now() }: {
  lang: Lang; rows: readonly ControlSession[]; roleOf: (row: ControlSession) => SessionRole | undefined
  loading?: boolean; unavailable?: boolean; stale?: string | null; now?: number
}) {
  const pt = lang === 'pt'
  const navigate = useNavigate()
  const isMobile = useIsMobile()
  const leaders = applyLeadersOnly(rows, true, roleOf)
  const needsYou = leaders.filter(row => row.state === 'waiting' || row.state === 'waiting-approval').length
  return <div style={{ minWidth: 0 }}>
    <PageHeader lang={lang} areaId="leadership" pageId="leaders" isMobile={isMobile}
      status={!loading && !unavailable && !stale ? (pt ? `${leaders.length} líderes · ${needsYou} precisam de você` : `${leaders.length} leaders · ${needsYou} need you`) : undefined} />
    {unavailable ? <p role="status">{pt ? 'A liderança não está disponível nesta instância.' : 'Leadership is unavailable on this instance.'}</p>
      : loading ? <p role="status">{pt ? 'Carregando líderes…' : 'Loading leaders…'}</p>
      : <>
        {stale && <p role="status">{stale}</p>}
        {!stale && leaders.length === 0 && <p>{pt ? 'Nenhuma sessão líder agora.' : 'No leader sessions right now.'}</p>}
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'minmax(0, 1fr)' : 'repeat(auto-fit, minmax(min(100%, 300px), 1fr))', gap: 12 }}>
          {leaders.map(row => <RecordCard key={row.id} title={row.title} subtitle={row.harness}
            badge={<Pill tone={row.state === 'waiting-approval' ? 'warn' : row.state === 'working' ? 'ok' : 'neutral'}>{row.stateLabel}</Pill>}
            fields={[
              ...(row.task || row.taskId ? [{ label: pt ? 'Tarefa' : 'Task', value: <span style={{ overflowWrap: 'anywhere' }}>{row.task ?? row.taskId}</span> }] : []),
              { label: pt ? 'Em execução' : 'Running for', value: row.startedAt === undefined ? (pt ? 'Horário indisponível' : 'Time unavailable') : fmtSpan(Math.max(0, now - row.startedAt), lang) },
              { label: pt ? 'Filhas' : 'Children', value: sessionChildren(row, rows).length },
            ]}
            actions={<RecordCardAction label={pt ? `Abrir ${row.title}` : `Open ${row.title}`} onClick={() => navigate(`/sessions/${encodeURIComponent(row.id)}`)}>{pt ? 'Abrir' : 'Open'}</RecordCardAction>} />)}
        </div>
      </>}
  </div>
}

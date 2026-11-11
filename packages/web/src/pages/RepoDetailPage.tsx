import { runStatusText } from '../lib/workflows'
import React, { useMemo, useState } from 'react'
import { useOutletContext, useParams, useNavigate } from 'react-router-dom'
import {
  GitBranch, ArrowLeft, ExternalLink, Link2Off, Workflow as WorkflowIcon,
  Clock, GitCommit, ChevronDown, DollarSign, Cpu, Wrench, Bot, FileCode, MessageSquare, Database, AlertTriangle,
  ClipboardList,
} from 'lucide-react'
import type { AppContext, } from '../lib/app-context'
import type { SessionMeta, SurfaceHarnessId, WorkflowRun, WorkflowAgent } from '@agentistics/core'
import { costCellText, unpricedTokens, repoShortName, fmt, fmtCost, fmtDuration, formatProjectName, formatModel, sessionLabel, workflowTokens, sessionTokenTotal, totalTokens, totalTokensExplained } from '@agentistics/core'
import { TokenBreakdownLine } from '../components/TokenBreakdownLine'
import { capable, HARNESS_LABELS, HARNESS_COLORS, DYNAMIC_WORKFLOWS_DOC } from '../lib/harness'
import { DocLink } from '../components/DocLink'
import { buildWorkflowSteps, groupRunsBySession } from '../lib/workflowSteps'
import { useDerivedStats } from '../hooks/useData'
import { useIsMobile } from '../hooks/useIsMobile'
import { Section } from '../components/Section'
import { ModelBreakdown } from '../components/ModelBreakdown'
import { ActivityChart } from '../components/ActivityChart'
import { RecentSessions } from '../components/RecentSessions'
import { ScopedSessions } from '../components/ScopedSessions'
import { sessionCost } from '../components/ScopedSessions'
import { StatTile, STAT_TILE_GRID } from '../components/StatTile'
import { MetricNote } from '../components/MetricNote'
import { RepoTasksTab } from '../components/tasks/RepoTasksTab'
import { repoTaskTotals, tasksOfRepo } from '../lib/repoTasks'
import { useTaskList } from '../lib/tasks'

type Tab = 'overview' | 'sessions' | 'tasks' | 'workflows'

export default function RepoDetailPage() {
  const ctx = useOutletContext<AppContext>()
  const { data, filters, currency, brlRate, lang, theme, setSelectedSession } = ctx
  const { id } = useParams()
  const navigate = useNavigate()
  const pt = lang === 'pt'

  // Route id → scope. A `folder:<path>` id is an unlinked project folder (scoped by its
  // project_path); anything else is a normalized remote (scoped by the repos filter).
  const rawId = id ?? ''
  const isFolder = rawId.startsWith('folder:')
  const folderPath = isFolder ? rawId.slice('folder:'.length) : ''
  const remote = isFolder ? '' : rawId
  const linked = !isFolder

  // Scope every metric to this repo/folder by overriding the relevant filter WITHOUT mutating
  // the global filter (so leaving the page leaves the FiltersBar untouched). All other active
  // filters (date/harness/models/users/presence) still compose because we spread `filters`.
  const scopedFilters = useMemo(
    () => (isFolder ? { ...filters, projects: [folderPath] } : { ...filters, repos: [remote] }),
    [filters, isFolder, folderPath, remote],
  )
  const scoped = useDerivedStats(data, scopedFilters)
  const [tab, setTab] = useState<Tab>('overview')
  // All hooks must run before any early return (rules of hooks); guard on scoped safely inside.
  const sessionIds = useMemo(
    () => new Set((scoped?.filteredSessions ?? []).map(s => s.session_id)),
    [scoped],
  )
  const sessionByIdWf = useMemo(
    () => new Map((data.sessions ?? []).map(s => [s.session_id, s] as [string, SessionMeta])),
    [data.sessions],
  )
  // The board, scoped by the SAME filters as every other tab — `/api/tasks` already takes `repos`
  // and `projects`, so nothing here re-derives a scope. A profile with no host power
  // answers `refused`, which arrives as an empty list and simply leaves the tab out.
  const { rows: taskRows } = useTaskList(scopedFilters)
  // A task belongs to a repository through its SESSIONS' `git_remote` — `''` on a `folder:` route
  // is the "no linked repository" bucket, and the rows there arrived scoped by project.
  const repoTasks = useMemo(
    () => tasksOfRepo(taskRows ?? [], isFolder ? '' : remote),
    [taskRows, isFolder, remote],
  )
  const taskTotals = useMemo(() => repoTaskTotals(repoTasks), [repoTasks])

  if (!scoped) return null

  const sessions = scoped.filteredSessions
  const workflows = (data.workflows ?? []).filter(w => sessionIds.has(w.sessionId))
  const harnessOf = (w: WorkflowRun): SurfaceHarnessId => sessionByIdWf.get(w.sessionId)?.harness ?? 'claude'

  const title = linked ? repoShortName(remote) : (folderPath.split('/').filter(Boolean).pop() || (pt ? 'Sem repositório' : 'No repository'))
  const host = linked ? remote.split('/')[0]! : ''
  const tabs: { id: Tab; label: string; icon: React.ReactNode; show: boolean; badge?: number }[] = [
    { id: 'overview', label: pt ? 'Visão geral' : 'Overview', icon: <GitBranch size={13} />, show: true },
    { id: 'sessions', label: pt ? 'Sessões' : 'Sessions', icon: <Clock size={13} />, show: true },
    { id: 'tasks', label: pt ? 'Tarefas' : 'Tasks', icon: <ClipboardList size={13} />, show: repoTasks.length > 0, badge: repoTasks.length || undefined },
    { id: 'workflows', label: 'Dynamic Workflows', icon: <WorkflowIcon size={13} />, show: workflows.length > 0 && workflows.some(w => capable(harnessOf(w), 'dynamicWorkflows')), badge: workflows.length },
  ]

  return (
    <>
      {/* Header */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <button
          onClick={() => navigate('/repositories')}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 5, alignSelf: 'flex-start',
            fontSize: 12, color: 'var(--text-tertiary)', background: 'transparent', border: 'none',
            cursor: 'pointer', fontFamily: 'inherit', padding: 0,
          }}
        >
          <ArrowLeft size={13} /> {pt ? 'Repositórios' : 'Repositories'}
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ color: linked ? 'var(--anthropic-orange)' : 'var(--text-tertiary)' }}>
            {linked ? <GitBranch size={18} /> : <Link2Off size={18} />}
          </span>
          <span style={{ fontSize: 19, fontWeight: 700, color: 'var(--text-primary)' }}>{title}</span>
          {host && (
            <a href={`https://${remote}`} target="_blank" rel="noreferrer" style={{
              display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, fontWeight: 600,
              color: 'var(--text-secondary)', background: 'var(--bg-elevated)', border: '1px solid var(--border)',
              padding: '3px 8px', borderRadius: 6, textDecoration: 'none',
            }}>
              {remote} <ExternalLink size={11} />
            </a>
          )}
        </div>
        {/* Full folder path subtitle — a machine-local detail, hidden where a repo
            is keyed by its remote (the title/host chip already identify it). Shown on machines,
            where the same repo can live at several local paths. */}
        {(folderPath || scoped.repoStats[0]?.path) && (
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
            {formatProjectName(folderPath || scoped.repoStats[0]!.path)}
          </span>
        )}
      </div>

      {/* KPI row */}
      <div style={{ display: 'grid', gridTemplateColumns: STAT_TILE_GRID, gap: 10 }}>
        <StatTile label={pt ? 'Sessões' : 'Sessions'} value={String(scoped.totalSessions)} />
        <StatTile label={pt ? 'Custo' : 'Cost'} value={costCellText(scoped.totalCostUSD, scoped.unpricedTokens, totalTokens(scoped.tokenTotals), pt ? 'pt' : 'en', usd => fmtCost(usd, currency, brlRate))} accent />
        {/* ONE tokens tile — the total of all four billed counters, where this used to be input
            and output as two tiles (the pair that comes to 0,34 % of the volume). The four
            counters themselves are the line UNDER this strip, not tiles in it: the grid is
            `STAT_TILE_GRID`, an `auto-fit` over `minmax(150px, 1fr)` — about eight columns at
            ~1400px — so taking the strip past that count strands the last tile alone on a second
            row. `scoped.tokenTotals` is the same filtered model usage `totalCostUSD` above
            is priced from, so the tokens and the money describe the same turns under the repo
            scope. */}
        <StatTile
          label="Tokens"
          value={fmt(totalTokens(scoped.tokenTotals))}
          title={totalTokensExplained(scoped.tokenTotals, pt ? 'pt' : 'en')}
        />
        <StatTile label="Commits" value={String(scoped.gitCommits)} />
        <StatTile label={pt ? 'Linhas' : 'Lines'} value={`+${fmt(scoped.linesAdded)} −${fmt(scoped.linesRemoved)}`} />
        <StatTile label="Agents" value={String(scoped.totalAgentInvocations)} />
      </div>
      {/* What the Tokens tile above is made of. A wrapping line has no cell count, so unlike four
          more tiles it cannot strand anything at any width. */}
      <TokenBreakdownLine tokens={scoped.tokenTotals} lang={pt ? 'pt' : 'en'} />

      {/* Tabs */}
      <div className="tabscroll" style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border)', overflowX: 'auto' }}>
        {tabs.filter(t => t.show).map(t => {
          const active = tab === t.id
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap',
                padding: '9px 13px', fontSize: 13, fontWeight: active ? 700 : 500, fontFamily: 'inherit',
                color: active ? 'var(--anthropic-orange)' : 'var(--text-secondary)',
                background: 'transparent', border: 'none', cursor: 'pointer',
                borderBottom: active ? '2px solid var(--anthropic-orange)' : '2px solid transparent',
                marginBottom: -1,
              }}
            >
              {t.icon} {t.label}
              {t.badge != null && t.badge > 0 && (
                <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-tertiary)', background: 'var(--bg-elevated)', borderRadius: 8, padding: '1px 6px' }}>{t.badge}</span>
              )}
              {/* Every ALM surface carries the mark — one that appears on five of six reads as the
                  unmarked one being the finished part. */}
            </button>
          )
        })}
      </div>

      {tab === 'overview' && (
        <>
          <Section title={<><Clock size={14} /> {pt ? 'Atividade ao longo do tempo' : 'Activity over time'}</>}>
            <ActivityChart data={scoped.heatmapData} height={200} theme={theme} />
          </Section>
          <Section title={pt ? 'Uso por modelo' : 'Model usage & cost'}>
            <ModelBreakdown
              modelUsage={scoped.modelUsage}
              currency={currency}
              brlRate={brlRate}
              fallbackInputTokens={scoped.inputTokens}
              fallbackOutputTokens={scoped.outputTokens}
              fallbackCostUSD={scoped.totalCostUSD}
            />
          </Section>
        </>
      )}

      {tab === 'sessions' && (
        <Section title={<><Clock size={14} /> {pt ? 'Sessões' : 'Sessions'}</>}>
          {/* `ScopedSessions`, not `RecentSessions`: this tab is already scoped to ONE repository,
              so the browser's group-by, status filter, six-key sort, search and grid toggle re-ask
              questions the page has answered — and cost the first screen of a phone before a single
              session appeared. What is left is what the tab is for: each session's metrics, and the
              way into it. See the module comment on ScopedSessions for the rest.
              The Actions tab above keeps `RecentSessions` on purpose: a CI runner's session was
              never on this machine's fleet, so it has no /sessions row to link to. */}
          <ScopedSessions sessions={sessions} lang={lang} currency={currency} brlRate={brlRate} />
        </Section>
      )}

      {tab === 'tasks' && (
        <Section title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}><ClipboardList size={14} /> {pt ? 'Tarefas neste repositório' : 'Tasks in this repository'}</span>}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10, marginBottom: 14 }}>
            <StatTile label={pt ? 'Tarefas' : 'Tasks'} value={String(taskTotals.tasks)} />
            <StatTile label={pt ? 'Em andamento' : 'In flight'} value={String(taskTotals.inFlight)} />
            <StatTile label={pt ? 'Entregues' : 'Delivered'} value={String(taskTotals.delivered)} />
            {taskTotals.abandoned > 0 && (
              <StatTile label={pt ? 'Abandonadas' : 'Abandoned'} value={String(taskTotals.abandoned)} />
            )}
            <StatTile label={pt ? 'Sessões' : 'Sessions'} value={String(taskTotals.sessions)} />
            {/* `N/A`, never a `0`: a repository whose tasks nobody could price has not
                delivered for free. */}
            <StatTile label={pt ? 'Custo' : 'Cost'} value={taskTotals.costUSD === null ? 'N/A' : fmtCost(taskTotals.costUSD, currency, brlRate)} accent />
          </div>
          <MetricNote style={{ marginTop: 0, marginBottom: 12 }}>
            {pt
              ? 'Uma tarefa pertence a este repositório pelo `git_remote` das sessões filiadas a ela — nunca por um campo digitado —, então uma que atravessa dois repositórios aparece nos dois, e aqui conta só o que gastou neste. Só as sessões que este repositório viu são contadas: uma sessão sem conversa vinculada não entra em nenhum número. Os filtros do topo da página valem aqui.'
              : 'A task belongs to this repository through its sessions\u2019 `git_remote` \u2014 never through a field somebody typed \u2014 so one spanning two repositories appears under both, and counts here only what it spent in this one. Only the sessions this repository could see are counted: one with no linked conversation contributes to no figure. The filters at the top of the page apply here too.'}
          </MetricNote>
          {taskTotals.creditTasks > 0 && (
            <MetricNote style={{ marginTop: 0, marginBottom: 12 }}>
              {pt
                ? `${taskTotals.creditTasks} ${taskTotals.creditTasks === 1 ? 'tarefa também gastou' : 'tarefas também gastaram'} créditos do Copilot. Créditos não são dólares e não entram no custo acima.`
                : `${taskTotals.creditTasks} ${taskTotals.creditTasks === 1 ? 'task also spent' : 'tasks also spent'} Copilot credits. Credits are not dollars and are not in the cost above.`}
            </MetricNote>
          )}
          <RepoTasksTab
            rows={repoTasks}
            lang={pt ? 'pt' : 'en'}
            currency={currency}
            brlRate={brlRate}
            onOpen={id => navigate(`/tasks/${encodeURIComponent(id)}`)}
          />
        </Section>
      )}

      {tab === 'workflows' && (
        <Section title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}><WorkflowIcon size={14} /> Dynamic Workflows <DocLink href={DYNAMIC_WORKFLOWS_DOC} title={pt ? 'O que é Dynamic Workflows? (doc da Anthropic)' : 'What is Dynamic Workflows? (Anthropic docs)'} /></span>}>
          <WorkflowsMini workflows={workflows} lang={lang} currency={currency} brlRate={brlRate} sessionById={sessionByIdWf} />
        </Section>
      )}
    </>
  )
}

function statusColor(status: WorkflowRun['status']): string {
  return runStatusText(status, false).color
}

/** Seconds-aware run duration (fmtDuration floors to whole minutes, so a 12s run
 *  would read "0m" — workflow runs are often sub-minute). */
function fmtRunDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`
}

function agentGlyph(status: WorkflowAgent['status']): { ch: string; color: string } {
  if (status === 'completed') return { ch: '✓', color: '#22c55e' }
  if (status === 'failed') return { ch: '✗', color: '#ef4444' }
  return { ch: '⤼', color: 'var(--text-tertiary)' }
}

function WorkflowsMini({ workflows, lang, currency, brlRate, sessionById }: {
  workflows: WorkflowRun[]
  lang: 'pt' | 'en'; currency: 'USD' | 'BRL'; brlRate: number
  sessionById: Map<string, SessionMeta>
}) {
  const pt = lang === 'pt'
  const [view, setView] = useState<'all' | 'session'>('all')
  const sessionCount = useMemo(() => new Set(workflows.map(w => w.sessionId)).size, [workflows])
  const groups = useMemo(() => groupRunsBySession(workflows), [workflows])

  if (workflows.length === 0) {
    return <div style={{ fontSize: 13, color: 'var(--text-tertiary)', padding: '8px 2px' }}>{pt ? 'Nenhum workflow.' : 'No workflows.'}</div>
  }
  return (
    // Fill the full available width so the run cards and step/agent rows reach the component edge.
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%' }}>
      {/* View toggle: flat list of runs vs grouped by session */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 11, color: 'var(--text-tertiary)', marginRight: 2 }}>{pt ? 'Ver:' : 'View:'}</span>
        {([['all', pt ? 'Todos' : 'All'], ['session', pt ? 'Por sessão' : 'By session']] as const).map(([v, label]) => (
          <button key={v} onClick={() => setView(v)} style={wfPill(view === v)}>{label}</button>
        ))}
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-tertiary)', fontVariantNumeric: 'tabular-nums' }}>
          {workflows.length} {pt ? 'workflows' : 'workflows'} · {sessionCount} {pt ? (sessionCount === 1 ? 'sessão' : 'sessões') : (sessionCount === 1 ? 'session' : 'sessions')}
        </span>
      </div>

      {view === 'all'
        ? workflows.map(w => (
          <WorkflowRunCard key={w.runId} run={w} pt={pt} currency={currency} brlRate={brlRate} sessionById={sessionById} />
        ))
        : groups.map(g => (
          <SessionGroupCard key={g.sessionId} group={g} pt={pt} currency={currency} brlRate={brlRate} sessionById={sessionById} />
        ))}
    </div>
  )
}

function SessionGroupCard({ group: g, pt, currency, brlRate, sessionById }: {
  group: ReturnType<typeof groupRunsBySession>[number]
  pt: boolean; currency: 'USD' | 'BRL'; brlRate: number; sessionById: Map<string, SessionMeta>
}) {
  const [open, setOpen] = useState(true)
  const s = sessionById.get(g.sessionId)
  const label = s ? sessionLabel(s) : g.sessionId.slice(0, 8)
  const project = s?.project_path ? formatProjectName(s.project_path) : ''
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}>
      <div
        onClick={() => setOpen(o => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '9px 12px', background: 'var(--bg-elevated)', borderBottom: open ? '1px solid var(--border)' : 'none', cursor: 'pointer' }}
      >
        <ChevronDown size={13} style={{ transform: open ? 'none' : 'rotate(-90deg)', transition: 'transform 0.2s', color: 'var(--text-tertiary)', flexShrink: 0 }} />
        <MessageSquare size={13} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
        <span title={label} style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, maxWidth: '55%' }}>{label}</span>
        {project && (
          <span title={project} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, maxWidth: '30%' }}>
            <FileCode size={11} style={{ flexShrink: 0 }} /> {project}
          </span>
        )}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 12, fontSize: 11, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
          <span><strong style={{ color: 'var(--text-primary)' }}>{g.totals.runs}</strong> {pt ? 'workflows' : 'workflows'}</span>
          <span>{g.totals.agents} {pt ? 'agentes' : 'agents'}</span>
          <span>{fmt(workflowTokens(g.totals))} tok</span>
          <span style={{ color: 'var(--anthropic-orange)', fontWeight: 600 }}>{fmtCost(g.totals.costUSD, currency, brlRate)}</span>
        </span>
      </div>
      {/* Animated collapse — glides open/closed instead of snapping. */}
      <div style={{ display: 'grid', gridTemplateRows: open ? '1fr' : '0fr', transition: 'grid-template-rows 0.28s cubic-bezier(0.22, 1, 0.36, 1)' }}>
        <div style={{ overflow: 'hidden', minHeight: 0 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 10 }}>
            {g.runs.map(w => (
              <WorkflowRunCard key={w.runId} run={w} pt={pt} currency={currency} brlRate={brlRate} sessionById={sessionById} />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function wfPill(active: boolean): React.CSSProperties {
  return {
    padding: '4px 10px', borderRadius: 7, fontSize: 11, cursor: 'pointer', fontFamily: 'inherit',
    border: '1px solid var(--border)',
    background: active ? 'var(--anthropic-orange-dim, rgba(205,93,56,0.12))' : 'var(--bg-elevated)',
    color: active ? 'var(--anthropic-orange, #cd5d38)' : 'var(--text-secondary)',
    fontWeight: active ? 600 : 500,
  }
}

function WorkflowRunCard({ run, pt, currency, brlRate, sessionById }: {
  run: WorkflowRun; pt: boolean; currency: 'USD' | 'BRL'; brlRate: number; sessionById: Map<string, SessionMeta>
}) {
  const [open, setOpen] = useState(true)
  const s = sessionById.get(run.sessionId)
  const harness = s?.harness ?? 'claude'
  // Session context: title + project. Repo is omitted here — this page is already repo-scoped.
  const sessTitle = s ? sessionLabel(s) : ''
  const project = s?.project_path ? formatProjectName(s.project_path) : ''
  const steps = buildWorkflowSteps(run, pt ? '(sem fase)' : '(no phase)')
  const tok = workflowTokens(run.totals)

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', overflow: 'hidden', background: 'var(--bg-card)' }}>
      {/* Header */}
      <div
        onClick={() => setOpen(o => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '10px 12px', cursor: 'pointer' }}
      >
        <ChevronDown size={14} style={{ transform: open ? 'none' : 'rotate(-90deg)', transition: 'transform 0.2s', color: 'var(--text-tertiary)', flexShrink: 0 }} />
        {/* A colour alone cannot carry five states — the word rides the title. */}
        <span title={runStatusText(run.status, pt).text} style={{ width: 8, height: 8, borderRadius: '50%', background: statusColor(run.status), flexShrink: 0 }} />
        <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{run.name}</span>
        <span style={{
          fontSize: 10.5, fontWeight: 600, color: HARNESS_COLORS[harness], flexShrink: 0,
          background: 'var(--bg-elevated)', border: `1px solid ${HARNESS_COLORS[harness]}55`,
          borderRadius: 5, padding: '2px 7px',
        }}>{HARNESS_LABELS[harness]}</span>
        {steps.length > 0 && (
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)', flexShrink: 0 }}>
            {steps.length} {pt ? (steps.length === 1 ? 'fase' : 'fases') : (steps.length === 1 ? 'phase' : 'phases')}
          </span>
        )}
        {/* Metrics as aligned right-hand columns (value + micro-label) — reads as a table and
            uses the full row width instead of leaving a ragged gap. */}
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'stretch', flexShrink: 0 }}>
          <WfMetric label={pt ? 'agentes' : 'agents'} value={String(run.totals.agentCount)} w={78} />
          <WfMetric label="tokens" value={fmt(tok)} w={82} />
          <WfMetric label={pt ? 'custo' : 'cost'} value={fmtCost(run.totals.costUSD, currency, brlRate)} w={92} accent />
          {run.durationMs > 0 && <WfMetric label={pt ? 'duração' : 'duration'} value={fmtRunDuration(run.durationMs)} w={64} />}
        </span>
        {/* Session context line (own row via flex-basis:100%): session title + project. */}
        {(sessTitle || project) && (
          <span style={{ flexBasis: '100%', paddingLeft: 32, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', fontSize: 11, color: 'var(--text-tertiary)', minWidth: 0 }}>
            {sessTitle && (
              <span title={sessTitle} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '60%' }}>
                <MessageSquare size={11} style={{ flexShrink: 0 }} /> {sessTitle}
              </span>
            )}
            {project && (
              <span title={project} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <FileCode size={11} style={{ flexShrink: 0 }} /> {project}
              </span>
            )}
          </span>
        )}
      </div>

      {/* Timeline */}
      {open && (() => {
        const noPhaseLabel = pt ? '(sem fase)' : '(no phase)'
        // Agents are only meaningfully phased when at least one DECLARED phase actually ran an
        // agent. When they're not (everything fell into the no-phase bucket), the numbered rail +
        // empty "nada rodou" phases are just noise — show a clean flat agent list instead.
        const phased = steps.some(s => s.title !== noPhaseLabel && s.agents.length > 0)
        if (!phased) {
          const allAgents = steps.flatMap(s => s.agents)
          return (
            <div style={{ padding: '2px 12px 12px', display: 'flex', flexDirection: 'column', gap: 7 }}>
              {allAgents.map((a, j) => <WfAgentRow key={j} a={a} pt={pt} currency={currency} brlRate={brlRate} />)}
            </div>
          )
        }
        const shown = steps.filter(s => s.title !== noPhaseLabel || s.agents.length > 0)
        return (
          <div style={{ padding: '4px 12px 12px', display: 'flex', flexDirection: 'column' }}>
            {shown.map((step, i) => (
              <div key={`${step.title}-${i}`} style={{ display: 'flex', gap: 10 }}>
                {/* Rail */}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 22, flexShrink: 0 }}>
                  <span style={{
                    width: 20, height: 20, borderRadius: '50%', flexShrink: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 10, fontWeight: 700, color: 'var(--text-secondary)',
                    background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                  }}>{i + 1}</span>
                  {i < shown.length - 1 && <span style={{ flex: 1, width: 2, background: 'var(--border)', minHeight: 8 }} />}
                </div>
                {/* Step body */}
                <div style={{ flex: 1, minWidth: 0, paddingBottom: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-primary)' }}>{step.title}</span>
                    <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)' }}>{step.subtotal.count} {pt ? 'agentes' : 'agents'}</span>
                    {step.subtotal.count > 0 && (
                      <span style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
                        {fmt(workflowTokens(step.subtotal))} tok · {fmt(step.subtotal.tokensOut)} out · <strong style={{ color: 'var(--anthropic-orange)' }}>{fmtCost(step.subtotal.costUSD, currency, brlRate)}</strong>
                      </span>
                    )}
                  </div>
                  {step.agents.length === 0
                    ? <div style={{ fontSize: 11, color: 'var(--text-tertiary)', fontStyle: 'italic', marginTop: 4 }}>{pt ? 'nada rodou' : 'nothing ran'}</div>
                    : <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
                        {step.agents.map((a, j) => <WfAgentRow key={j} a={a} pt={pt} currency={currency} brlRate={brlRate} />)}
                      </div>}
                </div>
              </div>
            ))}
          </div>
        )
      })()}
    </div>
  )
}

/** One agent line inside a Dynamic Workflow run: status glyph + label + model on the left,
 *  tokens + cost right-aligned, an optional tool-stats line wrapping underneath. */
function WfAgentRow({ a, pt, currency, brlRate }: { a: WorkflowAgent; pt: boolean; currency: 'USD' | 'BRL'; brlRate: number }) {
  const g = agentGlyph(a.status)
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', fontSize: 11.5 }}>
      <span style={{ color: g.color, fontWeight: 700, width: 12, flexShrink: 0 }}>{g.ch}</span>
      {/* label grows to fill the row; tokens/cost sit in fixed right columns aligned with the header */}
      <span style={{ color: 'var(--text-primary)', fontWeight: 600, wordBreak: 'break-word', flex: 1, minWidth: 120 }}>{a.label}</span>
      {a.model && <span style={{ color: 'var(--text-tertiary)', fontSize: 10.5, flexShrink: 0 }}>{formatModel(a.model)}</span>}
      <span style={{ width: 96, textAlign: 'right', color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }} title={`${a.tokensIn.toLocaleString()} in · ${a.tokensOut.toLocaleString()} out · ${a.cacheRead.toLocaleString()} cache read · ${a.cacheWrite.toLocaleString()} cache write`}>{fmt(workflowTokens(a))}</span>
      <span style={{ width: 92, textAlign: 'right', color: 'var(--anthropic-orange)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{fmtCost(a.costUSD, currency, brlRate)}</span>
      {a.toolStats && (
        <span style={{ flexBasis: '100%', paddingLeft: 20, color: 'var(--text-tertiary)', fontSize: 10.5 }}>
          {a.toolStats.readCount}r · {a.toolStats.editFileCount}e · +{a.toolStats.linesAdded}/−{a.toolStats.linesRemoved}
        </span>
      )}
    </div>
  )
}

/** A right-aligned metric column (value on top, micro-label below) for the workflow run header —
 *  fixed width so the columns line up across rows and fill the row instead of a ragged gap. */
function WfMetric({ label, value, w, accent }: { label: string; value: string; w: number; accent?: boolean }) {
  return (
    <span style={{ width: w, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 1, flexShrink: 0 }}>
      <span style={{ fontSize: 12, fontWeight: accent ? 700 : 600, fontVariantNumeric: 'tabular-nums', color: accent ? 'var(--anthropic-orange)' : 'var(--text-primary)' }}>{value}</span>
      <span style={{ fontSize: 8.5, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-tertiary)' }}>{label}</span>
    </span>
  )
}

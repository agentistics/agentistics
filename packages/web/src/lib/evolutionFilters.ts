/**
 * evolutionFilters.ts — the state of the page-only filters of "Evolução de entregas", and the ONE function that turns
 * them (plus the bar's own period/harness) into the query `GET /api/deliveries/metrics` reads — the same contract the
 * MCP tool `agentistics_delivery_metrics` and `agentop flow evolucao` use.
 *
 * The fixed filters bar lives in App.tsx and the page in its own route, so the state sits in a small external store
 * (the pattern of `lib/notifications.ts`): the bar writes it, the page reads it, and both survive navigating away.
 */
import { useMemo, useSyncExternalStore } from 'react'
import { GROUP_BYS, QA_RESULTS, type CalPriority, type CalStage, type GroupBy, type MetricOptions, type QaResult } from '@agentistics/core'
import { HARNESS_LABELS } from './harness'
import type { ExtraDimension, ExtraFilters } from './extraFilters'
import { STAGE_LABEL } from '../components/tasks/liveDeliveryModel'

export interface EvolutionFilters {
  versions: string[]
  stages: CalStage[]
  models: string[]
  qa: QaResult[]
  priorities: CalPriority[]
  /** A task id (single choice — the route's `task`). */
  task: string | null
  groupBy: GroupBy
}

export const DEFAULT_EVOLUTION_FILTERS: EvolutionFilters = { versions: [], stages: [], models: [], qa: [], priorities: [], task: null, groupBy: 'day' }

/** The "no version" / "unknown model" choice the route calls `none`. */
export const NONE_OPTION = 'none'

export function evolutionNarrowing(f: EvolutionFilters): boolean {
  return f.versions.length + f.stages.length + f.models.length + f.qa.length + f.priorities.length > 0 || f.task !== null || f.groupBy !== 'day'
}

/** PURE: base period/harness + the page-only filters → the metrics query string (no `?`). */
export function evolutionQuery(base: { from?: string; to?: string; harnesses?: readonly string[] }, f: EvolutionFilters): string {
  const q = new URLSearchParams()
  if (base.from) q.set('from', base.from)
  if (base.to) q.set('to', base.to)
  if (base.harnesses?.length) q.set('harness', base.harnesses.join(','))
  if (f.versions.length) q.set('version', f.versions.join(','))
  if (f.stages.length) q.set('stage', f.stages.join(','))
  if (f.models.length) q.set('model', f.models.join(','))
  if (f.qa.length) q.set('qa', f.qa.join(','))
  if (f.priorities.length) q.set('priority', f.priorities.join(','))
  if (f.task) q.set('task', f.task)
  q.set('groupBy', f.groupBy)
  return q.toString()
}

// ---------------------------------------------------------------------------------------------- the store

type Listener = () => void
let state: EvolutionFilters = DEFAULT_EVOLUTION_FILTERS
let options: MetricOptions | null = null
const listeners = new Set<Listener>()
const emit = () => { for (const l of listeners) l() }
const subscribe = (l: Listener) => { listeners.add(l); return () => { listeners.delete(l) } }

export const getEvolutionFilters = (): EvolutionFilters => state
export function setEvolutionFilters(next: Partial<EvolutionFilters>): void { state = { ...state, ...next }; emit() }
export function resetEvolutionFilters(): void { state = DEFAULT_EVOLUTION_FILTERS; emit() }
/** The page publishes the values the filters can take (from the last reply) so the bar can list them. */
export function setEvolutionOptions(o: MetricOptions | null): void { options = o; emit() }

export function useEvolutionFilters(): EvolutionFilters { return useSyncExternalStore(subscribe, getEvolutionFilters, getEvolutionFilters) }
const getOptions = () => options
export function useEvolutionOptions(): MetricOptions | null { return useSyncExternalStore(subscribe, getOptions, getOptions) }

// ---------------------------------------------------------------------------------------------- the bar's dimensions

const GROUP_LABEL: Record<GroupBy, { pt: string; en: string }> = {
  day: { pt: 'Dia', en: 'Day' }, week: { pt: 'Semana', en: 'Week' }, version: { pt: 'Versão', en: 'Version' }, model: { pt: 'Modelo', en: 'Model' },
}
export const QA_LABEL: Record<QaResult, { pt: string; en: string }> = {
  first_pass: { pt: 'Aprovada na 1ª', en: 'Approved first time' },
  rejected_once: { pt: 'Reprovada 1x', en: 'Rejected once' },
  rejected_many: { pt: 'Reprovada 2x ou mais', en: 'Rejected twice or more' },
  pending: { pt: 'QA ainda não feita', en: 'QA not done yet' },
}
export const PRIORITY_NAME: Record<CalPriority, { pt: string; en: string }> = {
  urgent: { pt: 'Urgente', en: 'Urgent' }, high: { pt: 'Alta', en: 'High' }, medium: { pt: 'Média', en: 'Medium' }, low: { pt: 'Baixa', en: 'Low' },
}
const FILTER_STAGES: CalStage[] = ['queue', 'running', 'qa', 'adjust', 'leader', 'merge', 'ci', 'published', 'blocked']

/** The dimensions the fixed filters bar offers ONLY on this page, built from the store and the last reply's options. */
export function buildEvolutionExtra(f: EvolutionFilters, opts: MetricOptions | null, lang: 'pt' | 'en'): ExtraFilters {
  const pt = lang === 'pt'
  const none = pt ? 'Sem versão' : 'No version'
  const dims: ExtraDimension[] = [
    {
      id: 'version', label: pt ? 'Versão' : 'Version', mode: 'multi', selected: f.versions, onChange: v => setEvolutionFilters({ versions: v }),
      options: [...(opts?.versions ?? []).map(v => ({ value: v, label: v })), { value: NONE_OPTION, label: none }],
    },
    {
      id: 'stage', label: pt ? 'Etapa' : 'Stage', mode: 'multi', selected: f.stages, onChange: v => setEvolutionFilters({ stages: v as CalStage[] }),
      options: FILTER_STAGES.map(s => ({ value: s, label: pt ? STAGE_LABEL[s].pt : STAGE_LABEL[s].en, color: STAGE_LABEL[s].color })),
    },
    {
      id: 'model', label: pt ? 'Modelo autor' : 'Author model', mode: 'multi', selected: f.models, onChange: v => setEvolutionFilters({ models: v }),
      options: [...(opts?.authorModels ?? []).map(m => ({ value: m, label: m })), { value: NONE_OPTION, label: pt ? 'Desconhecido' : 'Unknown' }],
    },
    {
      id: 'qa', label: pt ? 'Resultado da QA' : 'QA result', mode: 'multi', selected: f.qa, onChange: v => setEvolutionFilters({ qa: v as QaResult[] }),
      options: QA_RESULTS.map(r => ({ value: r, label: pt ? QA_LABEL[r].pt : QA_LABEL[r].en })),
    },
    {
      id: 'priority', label: pt ? 'Prioridade' : 'Priority', mode: 'multi', selected: f.priorities, onChange: v => setEvolutionFilters({ priorities: v as CalPriority[] }),
      options: (['urgent', 'high', 'medium', 'low'] as CalPriority[]).map(p => ({ value: p, label: pt ? PRIORITY_NAME[p].pt : PRIORITY_NAME[p].en })),
    },
    {
      id: 'task', label: pt ? 'Tarefa' : 'Task', mode: 'single', selected: f.task ? [f.task] : [], searchable: true,
      onChange: v => setEvolutionFilters({ task: v[0] ?? null }),
      options: (opts?.tasks ?? []).map(t => ({ value: t.id, label: t.title })),
    },
    {
      id: 'group', label: pt ? 'Agrupar por' : 'Group by', mode: 'single', selected: [f.groupBy], neutral: 'day',
      onChange: v => setEvolutionFilters({ groupBy: ((v[0] ?? 'day') as GroupBy) }),
      options: GROUP_BYS.map(g => ({ value: g, label: pt ? GROUP_LABEL[g].pt : GROUP_LABEL[g].en })),
    },
  ]
  return { dims, clear: resetEvolutionFilters }
}

/** The hook the app shell calls: the bar's extra dimensions, following the store. */
export function useEvolutionExtra(lang: 'pt' | 'en'): ExtraFilters {
  const f = useEvolutionFilters()
  const o = useEvolutionOptions()
  return useMemo(() => buildEvolutionExtra(f, o, lang), [f, o, lang])
}

/** Label for a value of a dimension in the chip rows and the table (harness ids come from the app's own labels). */
export const harnessName = (id: string): string => (HARNESS_LABELS as Record<string, string>)[id] ?? id

import { afterEach, describe, expect, test } from 'bun:test'
import { buildEvolutionExtra, DEFAULT_EVOLUTION_FILTERS, evolutionNarrowing, evolutionQuery, getEvolutionFilters, resetEvolutionFilters, setEvolutionFilters } from './evolutionFilters'
import { extraActiveCount } from './extraFilters'

afterEach(() => resetEvolutionFilters())

describe('evolutionQuery — the contract with the route, the MCP tool and the CLI', () => {
  test('the defaults ask only for the day grouping', () => {
    expect(evolutionQuery({}, DEFAULT_EVOLUTION_FILTERS)).toBe('groupBy=day')
  })

  test('period, harnesses and every page-only filter map to their parameter', () => {
    const q = evolutionQuery(
      { from: '2026-11-01T03:00:00.000Z', to: '2026-11-08T02:59:59.999Z', harnesses: ['claude', 'codex'] },
      { versions: ['2.201.0', 'none'], stages: ['qa', 'ci'], models: ['claude-opus-5'], qa: ['rejected_once'], priorities: ['high'], task: 'T-1', groupBy: 'version' },
    )
    expect(new URLSearchParams(q).toString()).toBe(new URLSearchParams({
      from: '2026-11-01T03:00:00.000Z', to: '2026-11-08T02:59:59.999Z', harness: 'claude,codex', version: '2.201.0,none', stage: 'qa,ci',
      model: 'claude-opus-5', qa: 'rejected_once', priority: 'high', task: 'T-1', groupBy: 'version',
    }).toString())
  })

  test('the query is read by the SAME function the server and the MCP tool use', async () => {
    const { metricFiltersOf } = await import('../../../server/server/delivery/metrics')
    const f = metricFiltersOf(new URLSearchParams(evolutionQuery({ harnesses: ['claude'] }, { ...DEFAULT_EVOLUTION_FILTERS, versions: ['none'], qa: ['pending'], groupBy: 'model' })))
    expect(f).toMatchObject({ harnesses: ['claude'], versions: ['__none__'], qa: ['pending'], groupBy: 'model' })
  })
})

describe('the page-only store and the bar dimensions', () => {
  test('narrowing is anything beyond the defaults, including a non-default grouping', () => {
    expect(evolutionNarrowing(DEFAULT_EVOLUTION_FILTERS)).toBe(false)
    expect(evolutionNarrowing({ ...DEFAULT_EVOLUTION_FILTERS, groupBy: 'week' })).toBe(true)
    expect(evolutionNarrowing({ ...DEFAULT_EVOLUTION_FILTERS, task: 'T' })).toBe(true)
  })

  test('the bar offers the seven page-only dimensions, listing what the reply says exists', () => {
    const opts = { versions: ['2.201.0', '2.200.0'], authorModels: ['claude-opus-5'], harnesses: ['claude'], tasks: [{ id: 'T1', title: 'Esteira' }] }
    const extra = buildEvolutionExtra(getEvolutionFilters(), opts, 'pt')
    expect(extra.dims.map(d => d.id)).toEqual(['version', 'stage', 'model', 'qa', 'priority', 'task', 'group'])
    expect(extra.dims.find(d => d.id === 'version')!.options.map(o => o.value)).toEqual(['2.201.0', '2.200.0', 'none'])
    expect(extra.dims.find(d => d.id === 'model')!.options.map(o => o.value)).toEqual(['claude-opus-5', 'none'])
    expect(extra.dims.find(d => d.id === 'task')!.options).toEqual([{ value: 'T1', label: 'Esteira' }])
    expect(extra.dims.find(d => d.id === 'group')!.options.map(o => o.value)).toEqual(['day', 'week', 'version', 'model'])
    expect(extraActiveCount(extra)).toBe(0) // grouping by day is not a filter
  })

  test('choosing a value in the bar writes the store; "clear" returns every dimension to its default', () => {
    const extra = () => buildEvolutionExtra(getEvolutionFilters(), null, 'en')
    extra().dims.find(d => d.id === 'qa')!.onChange(['rejected_once'])
    extra().dims.find(d => d.id === 'group')!.onChange(['week'])
    extra().dims.find(d => d.id === 'task')!.onChange(['T9'])
    expect(getEvolutionFilters()).toMatchObject({ qa: ['rejected_once'], groupBy: 'week', task: 'T9' })
    expect(extraActiveCount(extra())).toBe(3)
    extra().clear()
    expect(getEvolutionFilters()).toEqual(DEFAULT_EVOLUTION_FILTERS)
  })

  test('labels follow the language', () => {
    const en = buildEvolutionExtra(DEFAULT_EVOLUTION_FILTERS, null, 'en').dims
    const pt = buildEvolutionExtra(DEFAULT_EVOLUTION_FILTERS, null, 'pt').dims
    expect(en.map(d => d.label)).toEqual(['Version', 'Stage', 'Author model', 'QA result', 'Priority', 'Task', 'Group by'])
    expect(pt.map(d => d.label)).toEqual(['Versão', 'Etapa', 'Modelo autor', 'Resultado da QA', 'Prioridade', 'Tarefa', 'Agrupar por'])
    setEvolutionFilters({ groupBy: 'day' })
  })
})

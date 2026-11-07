import { describe, expect, test } from 'bun:test'
import { NONE_KEY } from '@agentistics/core'
import { evolutionQuery } from './cli'
import type { DeliveryRecord } from './machine'
import { metricFiltersOf, metricInputsFrom, metricsFrom, type SubtaskCost } from './metrics'

const H = 3_600_000
const T0 = Date.parse('2026-11-03T12:00:00Z')
const NOW = Date.parse('2026-11-07T15:00:00Z')
const iso = (h: number) => new Date(T0 + h * H).toISOString()

function record(id: string, o: Partial<DeliveryRecord> = {}): DeliveryRecord {
  const base = {
    subtaskId: id, taskId: 'T1', phase: 'publicado', revision: 3, gates: {}, humanGates: [], approvals: {}, skips: [],
    versionTarget: '2.201.0', authorModel: 'claude-opus-5', publishedAt: iso(30), createdAt: iso(0), updatedAt: iso(30),
    history: [
      { from: 'fila', to: 'executando', at: iso(2), actor: 'x', detail: '', revision: 1 },
      { from: 'executando', to: 'qa', at: iso(14), actor: 'x', detail: '', revision: 2 },
      { from: 'qa', to: 'ajuste', at: iso(20), actor: 'x', detail: 'reprovado', revision: 3 },
      { from: 'ajuste', to: 'qa', at: iso(23), actor: 'x', detail: '', revision: 4 },
      { from: 'qa', to: 'revisao_lider', at: iso(25), actor: 'x', detail: '', revision: 5 },
      { from: 'revisao_lider', to: 'pr_merge', at: iso(26), actor: 'x', detail: '', revision: 6 },
      { from: 'pr_merge', to: 'ci', at: iso(27), actor: 'x', detail: '', revision: 7 },
      { from: 'ci', to: 'publicado', at: iso(28), actor: 'x', detail: '', revision: 8 },
    ],
  }
  return { ...base, ...o } as unknown as DeliveryRecord
}

const costs = new Map<string, SubtaskCost>([['a', { costUSD: 12.5, tokens: 5_000, harness: 'claude', model: 'claude-opus-5' }]])
const tasks = [{ id: 'T1', title: 'Esteira de entrega', priority: 'high' }]
const subtasks = [{ id: 'a', taskId: 'T1', title: 'Barra' }, { id: 'b', taskId: 'T1', title: 'Tela' }]

describe('metricInputsFrom', () => {
  test('a record becomes an input with its moves, version, cost and the owner request that created it', () => {
    const [i] = metricInputsFrom({
      records: [record('a')], tasks, subtasks, costs,
      requests: [{ at: iso(-3), linkedSubtaskIds: ['a'] }, { at: iso(-1), linkedSubtaskIds: ['a'] }, { at: iso(-9), linkedSubtaskIds: ['zzz'] }],
    })
    expect(i).toMatchObject({ subtaskId: 'a', taskTitle: 'Esteira de entrega', title: 'Barra', priority: 'high', version: '2.201.0', phase: 'publicado', harness: 'claude', costUSD: 12.5, tokens: 5000 })
    expect(i!.requestedAtMs).toBe(T0 - 3 * H) // the EARLIEST linked request
    expect(i!.publishedAtMs).toBe(T0 + 30 * H)
    expect(i!.history).toHaveLength(8)
  })

  test('a dequeued record is not a delivery; a deferred version (next) is no version; an open record is not published', () => {
    const out = metricInputsFrom({
      records: [record('a', { dequeued: { at: iso(1), actor: 'l', reason: 'x' } }), record('b', { versionTarget: 'next', phase: 'qa', publishedAt: undefined })],
      tasks, subtasks, costs, requests: [],
    })
    expect(out.map(i => i.subtaskId)).toEqual(['b'])
    expect(out[0]!.version).toBeNull()
    expect(out[0]!.publishedAtMs).toBeNull()
    expect(out[0]!.costUSD).toBeNull() // no session filed -> unmeasured, not zero
    expect(out[0]!.requestedAtMs).toBeNull()
  })

  test('the author model falls back to the one that did the work only when the record names none', () => {
    const out = metricInputsFrom({ records: [record('a', { authorModel: undefined })], tasks, subtasks, costs, requests: [] })
    expect(out[0]!.authorModel).toBe('claude-opus-5')
    const none = metricInputsFrom({ records: [record('b', { authorModel: undefined })], tasks, subtasks, costs, requests: [] })
    expect(none[0]!.authorModel).toBeNull()
  })
})

describe('metricFiltersOf', () => {
  test('no query is no filter', () => { expect(metricFiltersOf(new URLSearchParams(''))).toEqual({}) })

  test('lists, none, BRT days and group-by', () => {
    const f = metricFiltersOf(new URLSearchParams('from=2026-11-01&to=2026-11-07&harness=claude,none&version=2.201.0,none&stage=qa,nonsense&model=opus&qa=rejected_once,x&priority=high,nope&task=Esteira&groupBy=week'))
    expect(f.fromMs).toBe(Date.parse('2026-11-01T03:00:00Z'))
    expect(f.toMs).toBe(Date.parse('2026-11-08T03:00:00Z') - 1)
    expect(f).toMatchObject({ harnesses: ['claude', NONE_KEY], versions: ['2.201.0', NONE_KEY], stages: ['qa'], authorModels: ['opus'], qa: ['rejected_once'], priorities: ['high'], task: 'Esteira', groupBy: 'week' })
  })

  test('an unknown group-by or an unparseable date is dropped', () => {
    const f = metricFiltersOf(new URLSearchParams('groupBy=year&from=banana'))
    expect(f).toEqual({})
  })
})

describe('evolutionQuery (the CLI flags)', () => {
  test('maps the flags to the same query the route reads, ignoring bare switches', () => {
    const q = evolutionQuery({ from: '2026-11-01', groupBy: 'version', qa: 'pending', harness: 'true' })
    expect(q.get('from')).toBe('2026-11-01')
    expect(q.get('groupBy')).toBe('version')
    expect(q.get('qa')).toBe('pending')
    expect(q.has('harness')).toBe(false)
    expect(metricFiltersOf(q)).toMatchObject({ qa: ['pending'], groupBy: 'version' })
  })
})

describe('metricsFrom — the same numbers the screen and the MCP tool show', () => {
  const inputs = metricInputsFrom({
    records: [record('a'), record('b', { versionTarget: '2.200.0', authorModel: 'sol', publishedAt: iso(20), history: [
      { from: 'fila', to: 'executando', at: iso(1), actor: 'x', detail: '', revision: 1 }, { from: 'executando', to: 'qa', at: iso(5), actor: 'x', detail: '', revision: 2 },
      { from: 'qa', to: 'revisao_lider', at: iso(8), actor: 'x', detail: '', revision: 3 }, { from: 'revisao_lider', to: 'publicado', at: iso(20), actor: 'x', detail: '', revision: 4 },
    ] })],
    tasks, subtasks, costs, requests: [],
  })
  const reply = (q: string) => metricsFrom({ nowMs: NOW, inputs }, metricFiltersOf(new URLSearchParams(q)))

  test('summary, QA by author model and rows follow the filters', () => {
    const all = reply('')
    expect(all.summary.published).toBe(2)
    expect(all.rowsTotal).toBe(2)
    expect(all.qaByAuthor.find(a => a.model === 'claude-opus-5')).toMatchObject({ n: 1, rejected: 1, rate: 1 })
    expect(all.qaByAuthor.find(a => a.model === 'sol')).toMatchObject({ n: 1, rejected: 0, rate: 0 })
    const sol = reply('model=sol')
    expect(sol.rowsTotal).toBe(1)
    expect(sol.rows[0]!.subtaskId).toBe('b')
    expect(sol.summary.leadP50Ms).toBe(20 * H)
    expect(reply('version=2.200.0').rows.map(r => r.subtaskId)).toEqual(['b'])
  })

  test('cost is the board rollup; a delivery with no priced session stays null', () => {
    const r = reply('')
    expect(r.rows.find(x => x.subtaskId === 'a')!.costUSD).toBe(12.5)
    expect(r.rows.find(x => x.subtaskId === 'b')!.costUSD).toBeNull()
    expect(r.summary.costPerPublishedUSD).toBe(12.5)
    expect(r.summary.costKnown).toBe(1)
  })

  test('group by version lists the versions in numeric order; an unrecorded ETA is not scored', () => {
    const r = reply('groupBy=version')
    expect(r.groups.map(g => g.key)).toEqual(['2.200.0', '2.201.0'])
    expect(r.summary.etaRate).toBeNull()
    expect(r.summary.noEta).toBe(2)
  })
})

import React, { useState } from 'react'
import { Flag, Info, Users } from 'lucide-react'
import type { HistoryBucket, HistoryCoverage, HistoryTaskRow } from '@agentistics/core/benchmark'
import { TabStrip } from '../sessions/formBits'
import { nf, type Lang, type Money } from '../../lib/benchmarkFormat'
import { durationText, historyTaskRows, matches, moneyText, sizeLabel, type HistorySortKey, type SizeFilter } from '../../lib/benchmarkView'
import { Bar } from './BenchStyle'

const muted: React.CSSProperties = { color: 'var(--text-tertiary)', fontSize: 12, lineHeight: 1.45 }
const card: React.CSSProperties = { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 14, padding: 14, minWidth: 0 }
const h3: React.CSSProperties = { margin: 0, fontSize: 14, fontWeight: 700, display: 'flex', gap: 7, alignItems: 'center' }
const field: React.CSSProperties = { background: 'var(--bg-input, var(--bg-elevated))', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text-primary)', padding: '5px 10px', fontSize: 13, minWidth: 0 }
const SIZES: readonly SizeFilter[] = ['all', 'S', 'M', 'L']

const dash = '—'

/** "Por tarefa" over the OBSERVED history: one row per task, a row opens its subtasks. Cost is tokens × price of priced sessions; `*` = some session had no price. */
export function BenchHistoryTasks({ tasks, coverage, lang, money, initialOpen = null }: { tasks: HistoryTaskRow[]; coverage: HistoryCoverage; lang: Lang; money: Money; initialOpen?: string | null }) {
  const pt = lang === 'pt'
  const [size, setSize] = useState<SizeFilter>('all')
  const [needle, setNeedle] = useState('')
  const [sort, setSort] = useState<{ key: HistorySortKey; dir: 1 | -1 }>({ key: 'cost', dir: -1 })
  const [open, setOpen] = useState<string | null>(initialOpen)
  const [subNeedle, setSubNeedle] = useState('')
  const rows = historyTaskRows(tasks, { size, needle, key: sort.key, dir: sort.dir })
  const cost = (v: number | null, partial: boolean) => v === null ? dash : `${moneyText(v, lang, money)}${partial ? '*' : ''}`
  const ms = (v: number | null) => v === null ? dash : durationText(v, lang)
  const q = (v: number | null) => v === null ? dash : nf(v, lang, 0)
  const sz = (s: 'S' | 'M' | 'L' | null) => s === null ? dash : sizeLabel(s, lang)
  const head = (key: HistorySortKey, label: string, num = false) =>
    <th className={num ? 'bm-num' : undefined} aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button type="button" onClick={() => setSort(s => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : (key === 'title' ? 1 : -1) }))}>{label}{sort.key === key ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}</button></th>
  return <section style={card} data-testid="benchmark-tasks" aria-label={pt ? 'Por tarefa' : 'By task'}>
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
      <h3 style={h3}><Flag size={15} /> {pt ? 'Por tarefa' : 'By task'}</h3>
      {tasks.length > 0 && <span style={muted}>{rows.length} {pt ? (rows.length === 1 ? 'tarefa' : 'tarefas') : (rows.length === 1 ? 'task' : 'tasks')}</span>}
      {tasks.length > 0 && <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input type="search" value={needle} onChange={e => setNeedle(e.target.value)} placeholder={pt ? 'Filtrar tarefa…' : 'Filter task…'} aria-label={pt ? 'Filtrar tarefa' : 'Filter task'} style={{ ...field, width: 170 }} />
        <TabStrip tabs={SIZES} value={size} onPick={setSize} label={s => s === 'all' ? (pt ? 'Todas' : 'All') : sizeLabel(s, lang)} ariaLabel={pt ? 'Tamanho' : 'Size'} natural />
      </div>}
    </div>
    {tasks.length === 0
      ? <div data-testid="benchmark-tasks-empty" style={{ ...muted, padding: '6px 0' }}>{pt ? 'Nenhuma peça entregue com sessão vinculada neste período.' : 'No delivered piece with a linked session in this period.'}</div>
      : <>
        <div style={{ overflowX: 'auto' }}>
          <table className="bm-tasks"><thead><tr>
            {head('title', pt ? 'Tarefa' : 'Task')}<th>{pt ? 'Tamanho' : 'Size'}</th><th className="bm-num">{pt ? 'Peças' : 'Pieces'}</th>{head('sessions', pt ? 'Sessões' : 'Sessions', true)}
            {head('cost', pt ? 'Custo' : 'Cost', true)}{head('wall', pt ? 'Tempo' : 'Time', true)}<th className="bm-num">{pt ? 'Ativo' : 'Active'}</th>
            {head('qa', pt ? 'Rodadas QA' : 'QA rounds', true)}<th className="bm-num">{pt ? 'Retrabalho' : 'Rework'}</th><th>{pt ? 'Status' : 'Status'}</th>
          </tr></thead><tbody>
            {rows.map(t => {
              const subs = t.subtasks.filter(s => matches(s.title, subNeedle))
              return <React.Fragment key={t.id}>
                <tr className="bm-t" data-testid="benchmark-task-row" data-task={t.id} onClick={() => { setOpen(open === t.id ? null : t.id); setSubNeedle('') }} aria-expanded={open === t.id}>
                  <td>{t.title}</td><td data-l={pt ? 'Tamanho' : 'Size'}>{sz(t.size)}</td>
                  <td className="bm-num" data-l={pt ? 'Peças' : 'Pieces'}>{t.pieces}</td><td className="bm-num" data-l={pt ? 'Sessões' : 'Sessions'}>{t.sessions}</td>
                  <td className="bm-num" data-l={pt ? 'Custo' : 'Cost'}>{cost(t.costUSD, t.costPartial)}</td>
                  <td className="bm-num" data-l={pt ? 'Tempo' : 'Time'}>{ms(t.wallMs)}</td><td className="bm-num" data-l={pt ? 'Ativo' : 'Active'}>{ms(t.activeMs)}</td>
                  <td className="bm-num" data-l="QA">{q(t.qaRounds)}</td>
                  <td className="bm-num" data-l={pt ? 'Retrabalho' : 'Rework'}>{t.reworkedPieces === null ? dash : `${t.reworkedPieces}/${t.pieces}`}</td>
                  <td data-l="Status">{t.status}</td>
                </tr>
                {open === t.id && <tr className="bm-d" data-testid="benchmark-task-detail"><td className="bm-d" colSpan={10}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}><Info size={13} /> {pt ? `${t.pieces} peças, ${t.sessions} sessões${t.lines === null ? '' : `, ${nf(t.lines, lang, 0)} linhas alteradas`}.` : `${t.pieces} pieces, ${t.sessions} sessions${t.lines === null ? '' : `, ${nf(t.lines, lang, 0)} lines changed`}.`}</div>
                  <div style={{ marginTop: 8, maxHeight: 340, overflowY: 'auto' }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 4 }}>
                      <strong style={{ color: 'var(--text-primary)' }}>{pt ? 'Subtarefas' : 'Subtasks'}</strong>
                      <input type="search" value={subNeedle} onClick={e => e.stopPropagation()} onChange={e => setSubNeedle(e.target.value)} placeholder={pt ? 'Filtrar subtarefa…' : 'Filter subtask…'} aria-label={pt ? 'Filtrar subtarefa' : 'Filter subtask'} style={{ ...field, width: 170 }} />
                    </div>
                    {subs.length === 0 ? <div style={muted}>{pt ? 'Nenhuma subtarefa com esse nome.' : 'No subtask with that name.'}</div>
                      : subs.map(s => <div key={s.id} data-testid="benchmark-subtask-row" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', padding: '4px 0', borderTop: '1px solid var(--border)' }}>
                        <span style={{ flex: '1 1 220px', color: 'var(--text-primary)' }}>{s.title}</span>
                        <span>{sz(s.size)}</span><span>{s.sessions} {pt ? (s.sessions === 1 ? 'sessão' : 'sessões') : (s.sessions === 1 ? 'session' : 'sessions')}</span><span>{cost(s.costUSD, s.costPartial)}</span><span>{ms(s.wallMs)}</span>
                        <span>QA {q(s.qaRounds)}</span><span>{s.status}</span>
                      </div>)}
                  </div>
                </td></tr>}
              </React.Fragment>
            })}
          </tbody></table>
        </div>
        <div style={{ ...muted, fontSize: 11, marginTop: 6 }}>
          {pt ? 'Peça = subtarefa entregue com sessão vinculada. Tamanho pelas linhas alteradas (P < 100, G ≥ 500). Custo = tokens × tabela de preços das sessões com preço; * = há sessões sem preço (harness sem custo). — = não medido. Clique na linha para ver as subtarefas.'
            : 'Piece = delivered subtask with a linked session. Size by lines changed (S < 100, L ≥ 500). Cost = tokens × price table of the priced sessions; * = some sessions have no price (harness without cost). — = not measured. Click a row for its subtasks.'}
          {' '}{pt ? `Cobertura: custo em ${coverage.withCost} de ${coverage.pieces} peças, tamanho em ${coverage.withSize}, QA em ${coverage.withQa}, tempo ativo em ${coverage.withActive}.` : `Coverage: cost in ${coverage.withCost} of ${coverage.pieces} pieces, size in ${coverage.withSize}, QA in ${coverage.withQa}, active time in ${coverage.withActive}.`}
        </div>
      </>}
  </section>
}

/** "Por número de sessões" over the observed history: pieces by how many sessions they took. States no verdict. */
export function BenchHistoryBuckets({ buckets, lang, money }: { buckets: HistoryBucket[]; lang: Lang; money: Money }) {
  const pt = lang === 'pt'
  const heads = pt ? ['Sessões por peça', 'Peças', 'Custo mediano', 'Tempo mediano', 'Retrabalho (2+ rodadas de QA)'] : ['Sessions per piece', 'Pieces', 'Median cost', 'Median time', 'Rework (2+ QA rounds)']
  const label = (b: HistoryBucket) => b.label === '1' ? (pt ? '1 sessão' : '1 session') : b.label === '7+' ? (pt ? '7 ou mais' : '7 or more') : `${b.label.replace('-', '–')} ${pt ? 'sessões' : 'sessions'}`
  const n = (v: number) => <span style={muted}> (n={v})</span>
  return <section style={card} data-testid="benchmark-buckets" aria-label={pt ? 'Por número de sessões' : 'By number of sessions'}>
    <h3 style={{ ...h3, marginBottom: 4 }}><Users size={15} /> {pt ? 'Por número de sessões' : 'By number of sessions'}</h3>
    <p style={{ ...muted, margin: '0 0 8px' }}>{pt ? 'Do histórico. Não diz se compensou, porque peça difícil já costuma usar mais sessões.' : 'From history. It does not say whether it paid off, because hard pieces already tend to use more sessions.'}</p>
    <div className="bm-buckets bm-h5">
      {heads.map(h => <div key={h} className="bm-h">{h}</div>)}
      {buckets.map(b => <React.Fragment key={b.label}>
        <div className="bm-k">{label(b)}</div><div data-l={heads[1]}>{nf(b.pieces, lang, 0)}</div>
        <div data-l={heads[2]}>{b.costMedianUSD === null ? dash : <>{moneyText(b.costMedianUSD, lang, money)}{n(b.nCost)}</>}</div>
        <div data-l={heads[3]}>{b.wallMedianMs === null ? dash : <>{durationText(b.wallMedianMs, lang)}{n(b.nWall)}</>}</div>
        <div data-l={heads[4]}>{b.reworkRate === null ? dash : <div style={{ maxWidth: 150 }}>{nf(b.reworkRate * 100, lang, 0)}%{n(b.nRework)}<Bar value={b.reworkRate * 100} tone="rate" mark={false} /></div>}</div>
      </React.Fragment>)}
    </div>
  </section>
}

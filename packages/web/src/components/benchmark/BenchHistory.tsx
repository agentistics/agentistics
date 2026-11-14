import React, { useState } from 'react'
import { Flag, Info } from 'lucide-react'
import type { ComparisonKey, HistoryCoverage, HistoryTaskRow } from '@agentistics/core/benchmark'
import { TabStrip } from '../sessions/formBits'
import { nf, type Lang, type Money } from '../../lib/benchmarkFormat'
import { comparisonWords, durationText, historyTaskRows, matches, moneyText, sizeLabel, type HistorySortKey, type SizeFilter } from '../../lib/benchmarkView'
import { BoardPager } from '../tasks/BoardPager'
import { BOARD_PAGE_SIZES, DEFAULT_BOARD_PAGE_SIZE, resolveBoardPage } from '../tasks/boardPaging'
import { statusLabel } from '../tasks/copy'
import { useTaskStatuses } from '../../lib/tasks'

const muted: React.CSSProperties = { color: 'var(--text-tertiary)', fontSize: 12, lineHeight: 1.45 }
const card: React.CSSProperties = { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 14, padding: 14, minWidth: 0 }
const h3: React.CSSProperties = { margin: 0, fontSize: 14, fontWeight: 700, display: 'flex', gap: 7, alignItems: 'center' }
const field: React.CSSProperties = { background: 'var(--bg-input, var(--bg-elevated))', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text-primary)', padding: '5px 10px', fontSize: 13, minWidth: 0 }
const SIZES: readonly SizeFilter[] = ['all', 'S', 'M', 'L']

const dash = '—'

/** "Por tarefa" over the OBSERVED history: one row per task, a row opens its subtasks. Cost is tokens × price of priced sessions; `*` = some session had no price. */
export function BenchHistoryTasks({ tasks, coverage, lang, money, sides = 'qa', initialOpen = null }: { tasks: HistoryTaskRow[]; coverage: HistoryCoverage; lang: Lang; money: Money; sides?: ComparisonKey; initialOpen?: string | null }) {
  const pt = lang === 'pt'
  const { statuses } = useTaskStatuses()
  const st = (s: string) => statusLabel(s, lang, statuses)
  const [size, setSize] = useState<SizeFilter>('all')
  const [needle, setNeedle] = useState('')
  const [sort, setSort] = useState<{ key: HistorySortKey; dir: 1 | -1 }>({ key: 'cost', dir: -1 })
  const [open, setOpen] = useState<string | null>(initialOpen)
  const [subNeedle, setSubNeedle] = useState('')
  const [pageSize, setPageSize] = useState<number>(DEFAULT_BOARD_PAGE_SIZE)
  const [pageAt, setPageAt] = useState(0)
  const all = historyTaskRows(tasks, { size, needle, key: sort.key, dir: sort.dir, sides })
  const pg = resolveBoardPage(all.length, pageSize, pageAt)
  const rows = all.slice(pg.start, pg.end)
  const cost = (v: number | null, partial: boolean) => v === null ? dash : `${moneyText(v, lang, money)}${partial ? '*' : ''}`
  const ms = (v: number | null) => v === null ? dash : durationText(v, lang)
  const q = (v: number | null) => v === null ? dash : nf(v, lang, 0)
  const words = comparisonWords(lang)[sides]
  /** The prototype's "um → outro": side A, then side B, "—" for a side with nothing measured. */
  const pair = (v: readonly [number | null, number | null], f: (n: number | null, side: 0 | 1) => string) => `${f(v[0], 0)} → ${f(v[1], 1)}`
  const sz = (s: 'S' | 'M' | 'L' | null) => s === null ? dash : sizeLabel(s, lang)
  const head = (key: HistorySortKey, label: string, num = false) =>
    <th className={num ? 'bm-num' : undefined} aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button type="button" onClick={() => { setPageAt(0); setSort(s => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : (key === 'title' ? 1 : -1) })) }}>{label}{sort.key === key ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}</button></th>
  return <section style={card} data-testid="benchmark-tasks" aria-label={pt ? 'Por tarefa' : 'By task'}>
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
      <h3 style={h3}><Flag size={15} /> {pt ? 'Por tarefa' : 'By task'}</h3>
      {tasks.length > 0 && <span style={muted}>{all.length} {pt ? (all.length === 1 ? 'tarefa' : 'tarefas') : (all.length === 1 ? 'task' : 'tasks')}</span>}
      {tasks.length > 0 && <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input type="search" value={needle} onChange={e => { setNeedle(e.target.value); setPageAt(0) }} placeholder={pt ? 'Filtrar tarefa…' : 'Filter task…'} aria-label={pt ? 'Filtrar tarefa' : 'Filter task'} style={{ ...field, width: 170 }} />
        <TabStrip tabs={SIZES} value={size} onPick={v => { setSize(v); setPageAt(0) }} label={s => s === 'all' ? (pt ? 'Todas' : 'All') : sizeLabel(s, lang)} ariaLabel={pt ? 'Tamanho' : 'Size'} natural />
      </div>}
    </div>
    {tasks.length === 0
      ? <div data-testid="benchmark-tasks-empty" style={{ ...muted, padding: '6px 0' }}>{pt ? 'Nenhuma peça entregue com sessão vinculada neste período.' : 'No delivered piece with a linked session in this period.'}</div>
      : <>
        <div style={{ overflowX: 'auto' }}>
          <table className="bm-tasks"><thead><tr>
            {head('title', pt ? 'Tarefa' : 'Task')}<th>{pt ? 'Tamanho' : 'Size'}</th>{head('sessions', pt ? 'Sessões' : 'Sessions', true)}
            {head('cost', pt ? 'Custo' : 'Cost', true)}{head('wall', pt ? 'Tempo' : 'Time', true)}{head('qa', pt ? 'Rodadas QA' : 'QA rounds', true)}
            <th className="bm-num">{pt ? 'Defeitos' : 'Defects'}</th><th>{pt ? 'Aceita' : 'Accepted'}</th>
          </tr></thead><tbody>
            {rows.map(({ task: t, sides: sd }) => {
              const subs = t.subtasks.filter(s => matches(s.title, subNeedle))
              return <React.Fragment key={t.id}>
                <tr className="bm-t" data-testid="benchmark-task-row" data-task={t.id} onClick={() => { setOpen(open === t.id ? null : t.id); setSubNeedle('') }} aria-expanded={open === t.id}>
                  <td>{t.title}</td><td data-l={pt ? 'Tamanho' : 'Size'}>{sz(t.size)}</td>
                  <td className="bm-num" data-l={pt ? 'Sessões' : 'Sessions'}>{pair(sd.sessions, q)}</td>
                  <td className="bm-num" data-l={pt ? 'Custo' : 'Cost'}>{pair(sd.costUSD, (v, i) => cost(v, sd.costPartial[i]))}</td>
                  <td className="bm-num" data-l={pt ? 'Tempo' : 'Time'}>{pair(sd.wallMs, ms)}</td>
                  <td className="bm-num" data-l="QA">{pair(sd.qaRounds, q)}</td>
                  <td className="bm-num" data-l={pt ? 'Defeitos' : 'Defects'}>{pair(sd.defects, q)}</td>
                  <td data-l={pt ? 'Aceita' : 'Accepted'} style={{ whiteSpace: 'nowrap' }}>{pair([null, null], q)}</td>
                </tr>
                {open === t.id && <tr className="bm-d" data-testid="benchmark-task-detail"><td className="bm-d" colSpan={8}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}><Info size={13} /> {pt ? `${t.pieces} peças, ${t.sessions} sessões${t.lines === null ? '' : `, ${nf(t.lines, lang, 0)} linhas alteradas`}; ${sd.nA} no lado A e ${sd.nB} no lado B.` : `${t.pieces} pieces, ${t.sessions} sessions${t.lines === null ? '' : `, ${nf(t.lines, lang, 0)} lines changed`}; ${sd.nA} on side A and ${sd.nB} on side B.`}</div>
                  <div style={{ marginTop: 8, maxHeight: 340, overflowY: 'auto' }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 4 }}>
                      <strong style={{ color: 'var(--text-primary)' }}>{pt ? 'Subtarefas' : 'Subtasks'}</strong>
                      <input type="search" value={subNeedle} onClick={e => e.stopPropagation()} onChange={e => setSubNeedle(e.target.value)} placeholder={pt ? 'Filtrar subtarefa…' : 'Filter subtask…'} aria-label={pt ? 'Filtrar subtarefa' : 'Filter subtask'} style={{ ...field, width: 170 }} />
                    </div>
                    {subs.length === 0 ? <div style={muted}>{pt ? 'Nenhuma subtarefa com esse nome.' : 'No subtask with that name.'}</div>
                      : subs.map(s => <div key={s.id} data-testid="benchmark-subtask-row" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', padding: '4px 0', borderTop: '1px solid var(--border)' }}>
                        <span style={{ flex: '1 1 220px', color: 'var(--text-primary)' }}>{s.title}</span>
                        <span>{sz(s.size)}</span><span>{s.sessions} {pt ? (s.sessions === 1 ? 'sessão' : 'sessões') : (s.sessions === 1 ? 'session' : 'sessions')}</span><span>{cost(s.costUSD, s.costPartial)}</span><span>{ms(s.wallMs)}</span>
                        <span>QA {q(s.qaRounds)}</span><span>{st(s.status)}</span>
                      </div>)}
                  </div>
                </td></tr>}
              </React.Fragment>
            })}
          </tbody></table>
        </div>
        {all.length > BOARD_PAGE_SIZES[0] && <BoardPager info={pg} pageSize={pageSize} lang={lang} onPage={setPageAt} onPageSize={n => { setPageSize(n); setPageAt(0) }} />}
        <div data-testid="benchmark-sides" style={{ ...muted, fontSize: 11, marginTop: 6 }}>
          {pt ? `Lados: ${words.a} → ${words.b} (mediana por peça de cada lado). Cada coluna mostra os dois lados: "um → outro". Defeitos e aceitação ainda não são registrados.` : `Sides: ${words.a} → ${words.b} (median per piece of each side). Each column shows both sides: "one → other". Defects and acceptance are not recorded yet.`}
        </div>
        <div style={{ ...muted, fontSize: 11, marginTop: 4 }}>
          {pt ? 'Peça = subtarefa entregue com sessão vinculada. Tamanho pelas linhas alteradas (P < 100, G ≥ 500). Custo = tokens × tabela de preços das sessões com preço; * = há sessões sem preço (harness sem custo). — = não medido. Clique na linha para ver as subtarefas.'
            : 'Piece = delivered subtask with a linked session. Size by lines changed (S < 100, L ≥ 500). Cost = tokens × price table of the priced sessions; * = some sessions have no price (harness without cost). — = not measured. Click a row for its subtasks.'}
          {' '}{pt ? `Cobertura: custo em ${coverage.withCost} de ${coverage.pieces} peças, tamanho em ${coverage.withSize}, QA em ${coverage.withQa}, tempo ativo em ${coverage.withActive}${coverage.withoutDuration > 0 ? `; ${coverage.withoutDuration} ${coverage.withoutDuration === 1 ? 'peça sem duração' : 'peças sem duração'} (início = entrega, fora das medianas de tempo)` : ''}.` : `Coverage: cost in ${coverage.withCost} of ${coverage.pieces} pieces, size in ${coverage.withSize}, QA in ${coverage.withQa}, active time in ${coverage.withActive}${coverage.withoutDuration > 0 ? `; ${coverage.withoutDuration} ${coverage.withoutDuration === 1 ? 'piece' : 'pieces'} with no duration (start = delivery, left out of the time medians)` : ''}.`}
        </div>
      </>}
  </section>
}

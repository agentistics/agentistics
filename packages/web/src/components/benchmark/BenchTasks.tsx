import React, { useState } from 'react'
import { Flag, Info, Users } from 'lucide-react'
import { TabStrip } from '../sessions/formBits'
import { nf, type Lang, type Money } from '../../lib/benchmarkFormat'
import {
  acceptedText, durationText, matches, moneyText, pairText, taskRows, toneOfScore, wordOf,
  type BucketRow, type SizeFilter, type TaskRow, type TaskSortKey,
} from '../../lib/benchmarkView'
import { Bar, TONE_VAR } from './BenchStyle'

const muted: React.CSSProperties = { color: 'var(--text-tertiary)', fontSize: 12, lineHeight: 1.45 }
const card: React.CSSProperties = { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 14, padding: 14, minWidth: 0 }
const h3: React.CSSProperties = { margin: 0, fontSize: 14, fontWeight: 700, display: 'flex', gap: 7, alignItems: 'center' }
const field: React.CSSProperties = { background: 'var(--bg-input, var(--bg-elevated))', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text-primary)', padding: '5px 10px', fontSize: 13, minWidth: 0 }

const SIZES: readonly SizeFilter[] = ['all', 'S', 'M', 'L']
const sizeLabel = (s: SizeFilter, lang: Lang) => s === 'all' ? (lang === 'pt' ? 'Todas' : 'All') : s === 'L' ? (lang === 'pt' ? 'G' : 'L') : s

/** "Por tarefa": one row per task, sortable, filterable by size and by name; a row opens its subtasks (also filterable). */
export function BenchTasks({ tasks, lang, money, emptyReason, initialOpen = null }: {
  tasks: TaskRow[]; lang: Lang; money: Money; emptyReason: string; initialOpen?: string | null
}) {
  const pt = lang === 'pt'
  const [size, setSize] = useState<SizeFilter>('all')
  const [needle, setNeedle] = useState('')
  const [sort, setSort] = useState<{ key: TaskSortKey; dir: 1 | -1 }>({ key: 'score', dir: -1 })
  const [open, setOpen] = useState<string | null>(initialOpen)
  const [subNeedle, setSubNeedle] = useState('')
  const rows = taskRows(tasks, { size, needle, key: sort.key, dir: sort.dir })
  const head = (key: TaskSortKey, label: string, num = false) =>
    <th className={num ? 'bm-num' : undefined} aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button type="button" onClick={() => setSort(s => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : 1 }))}>{label}{sort.key === key ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}</button></th>
  const money_ = (n: number) => moneyText(n, lang, money)
  const dur = (n: number) => durationText(n, lang)
  return <section style={card} data-testid="benchmark-tasks" aria-label={pt ? 'Por tarefa' : 'By task'}>
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
      <h3 style={h3}><Flag size={15} /> {pt ? 'Por tarefa' : 'By task'}</h3>
      {tasks.length > 0 && <span style={muted}>{rows.length} {pt ? (rows.length === 1 ? 'tarefa' : 'tarefas') : (rows.length === 1 ? 'task' : 'tasks')}</span>}
      {tasks.length > 0 && <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input type="search" value={needle} onChange={e => setNeedle(e.target.value)} placeholder={pt ? 'Filtrar tarefa…' : 'Filter task…'} aria-label={pt ? 'Filtrar tarefa' : 'Filter task'} style={{ ...field, width: 170 }} />
        <TabStrip tabs={SIZES} value={size} onPick={setSize} label={s => sizeLabel(s, lang)} ariaLabel={pt ? 'Tamanho' : 'Size'} natural />
      </div>}
    </div>
    {tasks.length === 0
      ? <div data-testid="benchmark-tasks-empty" style={{ ...muted, padding: '6px 0' }}>{emptyReason}</div>
      : <>
        <div style={{ overflowX: 'auto' }}>
          <table className="bm-tasks"><thead><tr>
            {head('title', pt ? 'Tarefa' : 'Task')}<th>{pt ? 'Tamanho' : 'Size'}</th><th>{pt ? 'Sessões' : 'Sessions'}</th>
            {head('cost', pt ? 'Custo' : 'Cost', true)}{head('time', pt ? 'Tempo' : 'Time', true)}{head('qa', pt ? 'Rodadas QA' : 'QA rounds', true)}
            <th className="bm-num">{pt ? 'Defeitos' : 'Defects'}</th><th>{pt ? 'Aceita' : 'Accepted'}</th>{head('score', pt ? 'Compensou?' : 'Paid off?')}
          </tr></thead><tbody>
            {rows.map(t => {
              const tone = t.score === null ? 'none' : toneOfScore(t.score)
              const subs = (t.subtasks ?? []).filter(s => matches(s.title, subNeedle))
              return <React.Fragment key={t.id}>
                <tr className="bm-t" data-testid="benchmark-task-row" data-task={t.id} onClick={() => { setOpen(open === t.id ? null : t.id); setSubNeedle('') }} aria-expanded={open === t.id}>
                  <td>{t.title}</td><td data-l={pt ? 'Tamanho' : 'Size'}>{t.size === 'L' && pt ? 'G' : t.size}</td>
                  <td data-l={pt ? 'Sessões' : 'Sessions'}>{t.sessions[0]} → {t.sessions[1]}</td>
                  <td className="bm-num" data-l={pt ? 'Custo' : 'Cost'}>{pairText(t.costUSD, money_)}</td>
                  <td className="bm-num" data-l={pt ? 'Tempo' : 'Time'}>{pairText(t.wallMs, dur)}</td>
                  <td className="bm-num" data-l="QA">{pairText(t.qaRounds, n => nf(n, lang, 0))}</td>
                  <td className="bm-num" data-l={pt ? 'Defeitos' : 'Defects'}>{pairText(t.defects, n => nf(n, lang, 0))}</td>
                  <td data-l={pt ? 'Aceita' : 'Accepted'}>{acceptedText(t.accepted, lang)}</td>
                  <td className="bm-cp" style={{ minWidth: 124 }}>
                    {t.score === null ? <span style={muted}>{pt ? 'sem nota' : 'no score'}</span>
                      : <><div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11.5, fontWeight: 700 }}><span style={{ color: TONE_VAR[tone] }}>{wordOf(tone, lang)}</span><span>{Math.round(t.score)}</span></div>
                        <Bar value={t.score} tone={tone} /></>}
                  </td>
                </tr>
                {open === t.id && <tr className="bm-d" data-testid="benchmark-task-detail"><td className="bm-d" colSpan={9}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}><Info size={13} /> {t.note || (pt ? 'Sem observação registrada para esta tarefa.' : 'No note recorded for this task.')}</div>
                  {(t.subtasks?.length ?? 0) > 0 ? <div style={{ marginTop: 8 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 4 }}>
                      <strong style={{ color: 'var(--text-primary)' }}>{pt ? 'Subtarefas' : 'Subtasks'}</strong>
                      <input type="search" value={subNeedle} onClick={e => e.stopPropagation()} onChange={e => setSubNeedle(e.target.value)} placeholder={pt ? 'Filtrar subtarefa…' : 'Filter subtask…'} aria-label={pt ? 'Filtrar subtarefa' : 'Filter subtask'} style={{ ...field, width: 170 }} />
                    </div>
                    {subs.length === 0 ? <div style={muted}>{pt ? 'Nenhuma subtarefa com esse nome.' : 'No subtask with that name.'}</div>
                      : subs.map(s => <div key={s.id} data-testid="benchmark-subtask-row" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', padding: '4px 0', borderTop: '1px solid var(--border)' }}>
                        <span style={{ flex: '1 1 200px', color: 'var(--text-primary)' }}>{s.title}</span>
                        <span>{pairText(s.costUSD, money_)}</span><span>{pairText(s.wallMs, dur)}</span>
                        <span>QA {pairText(s.qaRounds, n => nf(n, lang, 0))}</span><span>{pt ? 'aceita' : 'accepted'} {acceptedText(s.accepted, lang)}</span>
                      </div>)}
                  </div> : <div style={{ ...muted, marginTop: 6 }}>{pt ? 'Esta tarefa não tem subtarefas medidas.' : 'This task has no measured subtasks.'}</div>}
                </td></tr>}
              </React.Fragment>
            })}
          </tbody></table>
        </div>
        <div style={{ ...muted, fontSize: 11, marginTop: 6 }}>{pt ? 'Cada coluna mostra os dois lados: "um → outro". Clique na linha para ver o motivo e as subtarefas.' : 'Each column shows both sides: "one → other". Click a row for the reason and its subtasks.'}</div>
      </>}
  </section>
}

/** "Por número de sessões": the history by how many sessions a task took. Says nothing about paying off. */
export function BenchBuckets({ buckets, lang, money, emptyReason }: { buckets: BucketRow[]; lang: Lang; money: Money; emptyReason: string }) {
  const pt = lang === 'pt'
  const heads = pt ? ['Sessões', 'Tarefas', 'Custo mediano', 'Tempo mediano', 'Defeitos escapados', 'Aceitas de primeira', 'Não reabertas']
    : ['Sessions', 'Tasks', 'Median cost', 'Median time', 'Escaped defects', 'Accepted first try', 'Not reopened']
  const rate = (n: number | null) => n === null ? <span style={muted}>—</span> : <div style={{ maxWidth: 150 }}>{nf(n * 100, lang, 0)}%<Bar value={n * 100} tone="rate" mark={false} /></div>
  return <section style={card} data-testid="benchmark-buckets" aria-label={pt ? 'Por número de sessões' : 'By number of sessions'}>
    <h3 style={{ ...h3, marginBottom: 4 }}><Users size={15} /> {pt ? 'Por número de sessões' : 'By number of sessions'}</h3>
    <p style={{ ...muted, margin: '0 0 8px' }}>{pt ? 'Do histórico. Não diz se compensou, porque tarefa difícil já costuma usar mais sessões.' : 'From history. It does not say whether it paid off, because hard tasks already tend to use more sessions.'}</p>
    {buckets.length === 0 ? <div data-testid="benchmark-buckets-empty" style={muted}>{emptyReason}</div>
      : <div className="bm-buckets">
        {heads.map(h => <div key={h} className="bm-h">{h}</div>)}
        {buckets.map(b => <React.Fragment key={b.label}>
          <div className="bm-k">{b.label}</div><div data-l={heads[1]}>{nf(b.tasks, lang, 0)}</div>
          <div data-l={heads[2]}>{b.costMedianUSD === null ? '—' : moneyText(b.costMedianUSD, lang, money)}</div>
          <div data-l={heads[3]}>{b.wallMedianMs === null ? '—' : durationText(b.wallMedianMs, lang)}</div>
          <div data-l={heads[4]}>{b.escapedDefects === null ? '—' : nf(b.escapedDefects, lang, 1)}</div>
          <div data-l={heads[5]}>{rate(b.firstTryRate)}</div><div data-l={heads[6]}>{rate(b.notReopenedRate)}</div>
        </React.Fragment>)}
      </div>}
  </section>
}

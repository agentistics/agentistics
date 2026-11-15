import React, { useState } from 'react'
import { Flag, Info, Users } from 'lucide-react'
import { TabStrip } from '../sessions/formBits'
import { nf, type Lang, type Money } from '../../lib/benchmarkFormat'
import {
  acceptedText, durationText, matches, moneyText, pairText, taskRows,
  type BucketRow, type SizeFilter, type TaskRow, type TaskSortKey,
} from '../../lib/benchmarkView'
import { Bar, UnmeasuredPill } from './BenchStyle'
import { scoreTone } from '../../lib/benchmarkScore'
import { wordOf } from '../../lib/benchmarkView'

const muted: React.CSSProperties = { color: 'var(--text-tertiary)', fontSize: 12, lineHeight: 1.45 }
const card: React.CSSProperties = { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 14, padding: 14, minWidth: 0 }
const field: React.CSSProperties = { background: 'var(--bg-input, var(--bg-elevated))', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text-primary)', padding: '5px 10px', fontSize: 13, minWidth: 0 }

const SIZES: readonly SizeFilter[] = ['all', 'S', 'M', 'L']
const sizeLabel = (s: SizeFilter, lang: Lang) => s === 'all' ? (lang === 'pt' ? 'Todas' : 'All') : s === 'L' ? (lang === 'pt' ? 'G' : 'L') : s === 'S' ? (lang === 'pt' ? 'P' : 'S') : s

/** The prototype's "Compensou?" cell: the word, the task's own 0–100 score and a small bar in the tone; no score = a plain "sem nota". */
export function TaskVerdictCell({ score, lang }: { score: number | null; lang: Lang }) {
  const pt = lang === 'pt'
  if (score === null) return <td className="bm-cp" data-testid="benchmark-task-verdict" data-tone="none"><UnmeasuredPill lang={lang} testId="benchmark-task-verdict-unmeasured" /></td>
  const n = Math.round(score), tone = scoreTone(score), c = tone === 'good' ? 'var(--accent-green)' : tone === 'bad' ? 'var(--accent-red)' : 'var(--accent-amber, #fbbf24)'
  return <td className="bm-cp" data-testid="benchmark-task-verdict" data-tone={tone}>
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11.5, fontWeight: 700, marginBottom: 4 }}><span className="bm-nw" style={{ color: c }}>{wordOf(tone, lang)}</span><span>{n}</span></div>
    <Bar value={n} tone={tone} />
  </td>
}

/** "Por tarefa": one row per task, sortable, filterable by size and by name; a row opens its subtasks (also filterable). */
export function BenchTasks({ tasks, lang, money, emptyReason, initialOpen = null, keepHead = false }: {
  tasks: TaskRow[]; lang: Lang; money: Money; emptyReason: string; initialOpen?: string | null
  /** The prototype's empty state keeps the column heads and says the reason in one line of the table. */
  keepHead?: boolean
}) {
  const pt = lang === 'pt'
  const [size, setSize] = useState<SizeFilter>('all')
  const [sort, setSort] = useState<{ key: TaskSortKey; dir: 1 | -1 }>({ key: 'cost', dir: -1 })
  const [open, setOpen] = useState<string | null>(initialOpen)
  const [subNeedle, setSubNeedle] = useState('')
  const rows = taskRows(tasks, { size, needle: '', key: sort.key, dir: sort.dir })
  const head = (key: TaskSortKey, label: string, num = false) =>
    <th className={num ? 'bm-num' : undefined} aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button type="button" onClick={() => setSort(s => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : 1 }))}>{label}{sort.key === key ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}</button></th>
  const money_ = (n: number) => moneyText(n, lang, money)
  const dur = (n: number) => durationText(n, lang)
  return <section style={card} data-testid="benchmark-tasks" aria-label={pt ? 'Por tarefa' : 'By task'}>
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
      <h3 className="bm-sec"><Flag size={15} /> {pt ? 'Por tarefa' : 'By task'}</h3>
      {tasks.length > 0 && <span style={muted}>{rows.length} {pt ? (rows.length === 1 ? 'tarefa' : 'tarefas') : (rows.length === 1 ? 'task' : 'tasks')}</span>}
      {(tasks.length > 0 || keepHead) && <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <TabStrip tabs={SIZES} value={size} onPick={setSize} label={s => sizeLabel(s, lang)} ariaLabel={pt ? 'Tamanho' : 'Size'} natural />
      </div>}
    </div>
    {tasks.length === 0 && !keepHead
      ? <div data-testid="benchmark-tasks-empty" style={{ ...muted, padding: '6px 0' }}>{emptyReason}</div>
      : <>
        <div style={{ overflowX: 'auto' }}>
          <table className="bm-tasks"><thead><tr>
            {head('title', pt ? 'Tarefa' : 'Task')}<th>{pt ? 'Tamanho' : 'Size'}</th><th>{pt ? 'Sessões' : 'Sessions'}</th>
            {head('cost', pt ? 'Custo' : 'Cost', true)}{head('time', pt ? 'Tempo' : 'Time', true)}{head('qa', pt ? 'Rodadas QA' : 'QA rounds', true)}
            <th className="bm-num">{pt ? 'Defeitos' : 'Defects'}</th><th>{pt ? 'Aceita' : 'Accepted'}</th>{head('score', pt ? 'Compensou?' : 'Paid off?')}
          </tr></thead><tbody>
            {rows.map(t => {
              const subs = (t.subtasks ?? []).filter(s => matches(s.title, subNeedle))
              return <React.Fragment key={t.id}>
                <tr className="bm-t" data-testid="benchmark-task-row" data-task={t.id} onClick={() => { setOpen(open === t.id ? null : t.id); setSubNeedle('') }} aria-expanded={open === t.id}>
                  <td><div className="bm-clamp" title={t.title}>{t.title}</div></td><td data-l={pt ? 'Tamanho' : 'Size'}>{pt ? (t.size === 'L' ? 'G' : t.size === 'S' ? 'P' : t.size) : t.size}</td>
                  <td data-l={pt ? 'Sessões' : 'Sessions'}>{t.sessions[0]} → {t.sessions[1]}</td>
                  <td className="bm-num" data-l={pt ? 'Custo' : 'Cost'}>{pairText(t.costUSD, money_)}</td>
                  <td className="bm-num" data-l={pt ? 'Tempo' : 'Time'}>{pairText(t.wallMs, dur)}</td>
                  <td className="bm-num" data-l="QA">{pairText(t.qaRounds, n => nf(n, lang, 0))}</td>
                  <td className="bm-num" data-l={pt ? 'Defeitos' : 'Defects'}>{pairText(t.defects, n => nf(n, lang, 0))}</td>
                  <td data-l={pt ? 'Aceita' : 'Accepted'}>{acceptedText(t.accepted, lang)}</td>
                  <TaskVerdictCell score={t.score} lang={lang} />
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
            {tasks.length === 0 && <tr><td colSpan={9} data-testid="benchmark-tasks-empty" style={{ ...muted, padding: '8px 0' }}>{emptyReason}</td></tr>}
          </tbody></table>
        </div>
        {(tasks.length > 0 || keepHead) && <div style={{ ...muted, fontSize: 11, marginTop: 6 }}>{tasks.length === 0 ? (pt ? 'Cada coluna mostra os dois lados: "um → outro". Clique na linha para ver o motivo.' : 'Each column shows both sides: "one → other". Click a row for the reason.') : pt ? 'Cada coluna mostra os dois lados: "um → outro". Clique na linha para ver o motivo e as subtarefas.' : 'Each column shows both sides: "one → other". Click a row for the reason and its subtasks.'}</div>}
      </>}
  </section>
}

/** "Por quantidade de sessões": the history by how many sessions a task took. Says nothing about paying off. */
export function BenchBuckets({ buckets, lang, money, emptyReason, note = '' }: { buckets: BucketRow[]; lang: Lang; money: Money; emptyReason: string; note?: string }) {
  const pt = lang === 'pt'
  const heads = pt ? ['Sessões', 'Tarefas', 'Custo mediano', 'Tempo mediano', 'Defeitos escapados', 'Aceitas de primeira', 'Não reabertas']
    : ['Sessions', 'Tasks', 'Median cost', 'Median time', 'Escaped defects', 'Accepted first try', 'Not reopened']
  // the prototype's short labels for the stacked (phone) facts; the desktop heads stay whole
  const sl = pt ? ['', 'Tarefas', 'Custo', 'Tempo', 'Defeitos', 'De primeira', 'Não reabertas'] : ['', 'Tasks', 'Cost', 'Time', 'Defects', 'First try', 'Not reopened']
  const nw = (x: string) => <span className="bm-nw">{x}</span>
  const unm = <UnmeasuredPill lang={lang} testId="benchmark-bucket-unmeasured" />
  const rate = (n: number | null) => n === null ? unm : <div style={{ maxWidth: 150 }}>{nw(`${nf(n * 100, lang, 0)}%`)}<Bar value={n * 100} tone="rate" mark={false} /></div>
  return <section style={card} data-testid="benchmark-buckets" aria-label={pt ? 'Por quantidade de sessões' : 'By number of sessions'}>
    <h3 className="bm-sec" style={{ marginBottom: 4 }}><Users size={15} /> {pt ? 'Por quantidade de sessões' : 'By number of sessions'}</h3>
    <p style={{ ...muted, margin: '0 0 8px' }}>{pt ? 'Do histórico. Não diz se compensou, porque tarefa difícil já costuma usar mais sessões.' : 'From history. It does not say whether it paid off, because hard tasks already tend to use more sessions.'}{note ? ` ${note}` : ''}</p>
    {buckets.length === 0 ? <div data-testid="benchmark-buckets-empty" style={muted}>{emptyReason}</div>
      : <div className="bm-buckets">
        {heads.map(h => <div key={h} className="bm-h">{h}</div>)}
        {buckets.map(b => <React.Fragment key={b.label}>
          <div className="bm-k">{b.label}</div><div data-l={sl[1]}>{nw(nf(b.tasks, lang, 0))}</div>
          <div data-l={sl[2]}>{b.costMedianUSD === null ? unm : nw(moneyText(b.costMedianUSD, lang, money))}</div>
          <div data-l={sl[3]}>{b.wallMedianMs === null ? unm : nw(durationText(b.wallMedianMs, lang))}</div>
          <div data-l={sl[4]}>{b.escapedDefects === null ? unm : nw(nf(b.escapedDefects, lang, 1))}</div>
          <div data-l={sl[5]}>{rate(b.firstTryRate)}</div><div data-l={sl[6]}>{rate(b.notReopenedRate)}</div>
        </React.Fragment>)}
      </div>}
  </section>
}

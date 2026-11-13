import React, { useEffect, useState } from 'react'
import { Link, useOutletContext } from 'react-router-dom'
import { Check, CircleHelp, Coins, Clock, Gauge, Info, RotateCcw, ShieldCheck, TriangleAlert } from 'lucide-react'
import type { Observed } from '@agentistics/core/benchmark'
import type { AppContext } from '../lib/app-context'
import {
  METRIC_PLAIN, SOURCE_LABEL, benchmarkQuery, dayLabel, formulaText, gapText, harnessReason, harnessState, intervalMethod, nf, fmtInterval,
  type Lang, type Money,
} from '../lib/benchmarkFormat'
import {
  entriesOf, heroOf, parseExperiments, partsOf, type Entry, type Part, type PartRow, type TypeKey,
} from '../lib/benchmarkView'
import { BetaTag } from '../components/BetaTag'
import { Pill } from '../components/Pill'
import { Bar, BenchStyle, TONE_VAR } from '../components/benchmark/BenchStyle'
import { BenchBuckets, BenchTasks } from '../components/benchmark/BenchTasks'

export { BenchmarkHowItWorksPage } from './BenchmarkHowItWorks'

type Status = 'loading' | 'error' | 'ready'

export default function BenchmarkPage() {
  const { lang, filters, currency, brlRate, costBasis } = useOutletContext<AppContext>()
  const [observed, setObserved] = useState<Observed | null>(null)
  const [status, setStatus] = useState<Status>('loading')
  const [experiments, setExperiments] = useState<unknown[] | null>(null)
  const query = benchmarkQuery(filters)
  const qs = new URLSearchParams(query)
  const period = qs.has('from') || qs.has('to')
    ? { fromMs: qs.has('from') ? Number(qs.get('from')) : null, toMs: qs.has('to') ? Number(qs.get('to')) : null } : undefined
  useEffect(() => {
    let live = true
    fetch(`/api/benchmark/observed${query}`).then(r => r.ok ? r.json() : Promise.reject(new Error(String(r.status))))
      .then(x => { if (live) { setObserved(x); setStatus('ready') } }).catch(() => { if (live) setStatus('error') })
    fetch('/api/benchmark/experiments').then(r => r.ok ? r.json() : null).then(x => { if (live && Array.isArray(x)) setExperiments(x) }).catch(() => {})
    return () => { live = false }
  }, [query])
  return <BenchmarkContent lang={lang} observed={observed} status={status} experiments={experiments}
    currency={currency} brlRate={brlRate} costBasis={costBasis} period={period} />
}

const TYPE_ICON: Record<TypeKey, React.ComponentType<{ size?: number }>> = { quality: ShieldCheck, cost: Coins, time: Clock, reliability: Gauge, rework: RotateCcw }

export function BenchmarkContent({ lang, observed, status = observed ? 'ready' : 'loading', experiments = [], currency = 'USD', brlRate, costBasis = 'api', period, initialSelected, initialNumbers = false, initialOpenTask = null }: {
  lang: AppContext['lang']; observed: Observed | null; status?: Status; experiments?: unknown[] | null
  currency?: 'USD' | 'BRL'; brlRate?: number; costBasis?: AppContext['costBasis']
  period?: { fromMs: number | null; toMs: number | null }
  /** Test hooks: which benchmark starts selected, whether the numbers start open, which task row starts open. */
  initialSelected?: string; initialNumbers?: boolean; initialOpenTask?: string | null
}) {
  const pt = lang === 'pt'
  const L = lang as Lang
  const money: Money = { currency, brlRate }
  const day = (ms: number) => dayLabel(ms, L)
  const since = observed?.scope.sinceMs
  const periodText = period ? `${pt ? 'Período' : 'Period'}: ${period.fromMs && period.fromMs > 0 ? day(period.fromMs) : (pt ? 'início' : 'start')} – ${period.toMs ? day(period.toMs) : (pt ? 'hoje' : 'today')}. `
    : status === 'ready' && observed ? `${pt ? 'Período: todo o histórico' : 'Period: whole history'}${since ? `${pt ? ', desde ' : ', since '}${day(since)}` : ''}. ` : ''
  const basisText = costBasis === 'plan'
    ? (pt ? 'O custo aqui é sempre o equivalente à API (tokens × tabela de preços), não o valor do plano. ' : 'Cost here is always the API-equivalent figure (tokens × price table), not the plan price. ')
    : ''
  const entries = entriesOf(observed, parseExperiments(experiments), L)
  const [picked, setPicked] = useState(initialSelected ?? 'observed')
  const [nums, setNums] = useState(initialNumbers)
  const cur = entries.find(e => e.id === picked) ?? entries[0]!
  const hero = heroOf(cur, observed, L)
  const parts = partsOf(cur, observed, L, money)
  const exp = cur.experiment
  const noTasks = pt ? 'Sem tarefas comparadas neste benchmark: o servidor só mede por tarefa quando um experimento controlado roda — nenhum rodou ainda.' : 'No compared tasks in this benchmark: the server only measures per task when a controlled experiment runs — none has yet.'
  const noBuckets = pt ? 'Sem agrupamento por número de sessões: o servidor ainda não calcula esta divisão a partir do histórico.' : 'No grouping by number of sessions: the server does not compute this split from history yet.'
  return <main data-testid="benchmark-page" style={{ maxWidth: 1180, margin: '0 auto', display: 'grid', gap: 12, minWidth: 0 }}>
    <BenchStyle />
    <header style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 22, display: 'flex', gap: 8, alignItems: 'center' }}>Benchmark <BetaTag lang={L} what="Benchmark" /></h1>
        <p style={{ ...muted, margin: '4px 0 0', fontSize: 13 }}>{pt ? 'Dois jeitos de trabalhar fazem as mesmas tarefas. Aqui você vê qual compensou.' : 'Two ways of working do the same tasks. Here you see which one paid off.'}</p>
      </div>
      <Link to="/benchmark/como-funciona" className="bm-btn" data-testid="benchmark-how" style={how}><CircleHelp size={15} style={{ color: 'var(--accent-cyan, var(--accent-blue))' }} />{pt ? 'Como funciona?' : 'How it works'}</Link>
    </header>

    {status === 'loading' && <div data-testid="benchmark-loading" style={empty}>{pt ? 'Carregando dados reais…' : 'Loading real data…'}</div>}
    {status === 'error' && <div data-testid="benchmark-error" style={empty}>{pt ? 'Não foi possível ler os dados reais agora. Nenhum número é mostrado no lugar.' : 'The real data could not be read right now. No number is shown in its place.'}</div>}

    {status === 'ready' && observed && <>
      <p data-testid="benchmark-scope" style={{ ...muted, margin: 0 }}>{periodText}{basisText}{scopeLine(observed, L)}{' '}
        <details style={{ display: 'inline', marginLeft: 6 }}><summary style={{ display: 'inline', cursor: 'pointer' }}>{pt ? 'o que não conta' : 'what does not count'}</summary> <div style={{ marginTop: 2 }}>{scopeExclusions(observed, L)}</div></details></p>

      <div className="bm-top">
        <nav className="bm-list" data-testid="benchmark-list" aria-label={pt ? 'Benchmarks' : 'Benchmarks'}>
          {entries.map(e => <BenchItem key={e.id} e={e} on={e.id === cur.id} onPick={() => setPicked(e.id)} />)}
        </nav>
        <div style={{ minWidth: 0 }}>
          <Hero hero={hero} lang={L} entryId={cur.id} />
        </div>
      </div>

      <section aria-label={pt ? 'Partes' : 'Parts'} data-testid="benchmark-parts">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', margin: '4px 0 8px' }}>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>{pt ? 'Partes' : 'Parts'}</h3>
          <span style={{ ...muted, fontSize: 12.5 }}>{pt ? 'Cada tipo de métrica, com os números que o compõem.' : 'Each metric type, with the figures inside it.'}</span>
          <button type="button" className="bm-btn" data-testid="benchmark-numbers-toggle" aria-pressed={nums} onClick={() => setNums(!nums)} style={toggle}>{nums ? (pt ? 'Esconder os números' : 'Hide the figures') : (pt ? 'Ver os números' : 'Show the figures')}</button>
        </div>
        <div className="bm-types">{parts.map(p => <PartTile key={p.type} p={p} nums={nums} lang={L} observed={observed} />)}</div>
      </section>

      <BenchTasks key={`t-${cur.id}`} tasks={exp?.tasks ?? []} lang={L} money={money} emptyReason={noTasks} initialOpen={initialOpenTask} />
      <BenchBuckets key={`b-${cur.id}`} buckets={exp?.buckets ?? []} lang={L} money={money} emptyReason={noBuckets} />

      <footer data-testid="benchmark-coverage" style={{ ...muted, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
        <span><strong>{pt ? 'Cobertura por harness' : 'Coverage by harness'}:</strong>{' '}
          {Object.entries(observed.coverage).map(([h, c], i) => {
            const state = harnessState(c), why = harnessReason(c, L)
            return <span key={h} data-state={state} title={why}>{i > 0 ? ' · ' : ''}{h} {c.withCost}/{c.sessions}{state === 'none' ? (pt ? ' sem medição' : ' not measured') : state === 'partial' ? (pt ? ' parcial' : ' partial') : ''}</span>
          })}
          {Object.keys(observed.coverage).length === 0 && <span>{pt ? 'sem sessões registradas' : 'no sessions recorded'}</span>}
          {Object.keys(observed.coverage).length > 0 && <span> {pt ? '(sessões com custo medido)' : '(sessions with measured cost)'}</span>}</span>
        <Link to="/benchmark/como-funciona" style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{pt ? 'De onde vêm esses números?' : 'Where do these numbers come from?'}</Link>
      </footer>
    </>}
  </main>
}

function BenchItem({ e, on, onPick }: { e: Entry; on: boolean; onPick: () => void }) {
  return <button type="button" data-testid="benchmark-item" data-bench={e.id} aria-pressed={on} onClick={onPick} style={{
    appearance: 'none', textAlign: 'left', color: 'var(--text-primary)', font: 'inherit', cursor: 'pointer', display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: '3px 8px',
    border: `1px solid ${on ? 'var(--text-tertiary)' : 'var(--border)'}`, borderRadius: 10, background: on ? 'var(--bg-elevated)' : 'var(--bg-card)', padding: '9px 11px',
  }}>
    <span style={{ fontSize: 12.5, fontWeight: 600 }}>{e.name}</span>
    <span style={{ fontWeight: 800, fontSize: 15, fontVariantNumeric: 'tabular-nums', color: TONE_VAR[e.tone] }}>{e.score === null ? '—' : Math.round(e.score)}</span>
    <small style={{ gridColumn: '1/3', color: 'var(--text-tertiary)', fontSize: 11 }}>{e.sample}</small>
    {e.score !== null && <div style={{ gridColumn: '1/3' }}><Bar value={e.score} tone={e.tone} /></div>}
    <span style={{ gridColumn: '1/3', fontSize: 11.5, fontWeight: 700, color: e.tone === 'none' ? 'var(--text-tertiary)' : TONE_VAR[e.tone] }}>{e.word}</span>
  </button>
}

function Hero({ hero, lang, entryId }: { hero: ReturnType<typeof heroOf>; lang: Lang; entryId: string }) {
  const pt = lang === 'pt'
  const c = TONE_VAR[hero.tone]
  const tinted = hero.tone !== 'none'
  return <div data-testid="benchmark-hero" data-tone={hero.tone} data-bench={entryId} style={{
    borderRadius: 14, border: `1px solid ${tinted ? c : 'var(--border)'}`, padding: '16px 18px', minWidth: 0,
    background: tinted ? `color-mix(in srgb, ${c} 12%, transparent)` : 'var(--bg-card)',
  }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 14, flexWrap: 'wrap' }}>
      <div className="bm-word" style={{ fontSize: 32, fontWeight: 800, letterSpacing: '-.02em', lineHeight: 1.1, color: tinted ? c : 'var(--text-primary)' }}>{hero.word}</div>
      {hero.score !== null && <div className="bm-score" style={{ fontSize: 32, fontWeight: 800, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{Math.round(hero.score)}<small style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-secondary)', marginLeft: 5 }}>{pt ? 'de 100' : 'of 100'}</small></div>}
    </div>
    {hero.delta && <div data-testid="benchmark-delta" style={{ fontSize: 15, fontWeight: 700, marginTop: 6 }}>{hero.delta}</div>}
    <p style={{ fontSize: 14.5, lineHeight: 1.45, margin: '8px 0 0', maxWidth: 900 }}>{hero.say}</p>
    {hero.score !== null && <>
      <Bar value={hero.score} tone={hero.tone} big />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 6 }}>
        <span>{pt ? '0 · não compensou' : '0 · did not pay off'}</span><span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{pt ? '50 · empate' : '50 · tie'}</span><span style={{ textAlign: 'right' }}>{pt ? '100 · compensou' : '100 · paid off'}</span>
      </div>
    </>}
    {hero.firm && <div style={{ marginTop: 10 }}><Pill tone={hero.firm.ok ? 'ok' : 'warn'}>{hero.firm.ok ? <Check size={12} /> : <TriangleAlert size={12} />}{hero.firm.text}</Pill></div>}
    <details open={hero.tone === 'none'} style={{ marginTop: 10, fontSize: 12.5, color: 'var(--text-secondary)' }}>
      <summary style={{ cursor: 'pointer', color: 'var(--text-primary)', fontWeight: 600 }}>{hero.tone === 'none' ? (pt ? 'O que falta' : 'What is missing') : (pt ? 'Por que esse resultado?' : 'Why this result?')}</summary>
      {hero.why.map((w, i) => <p key={i} style={{ margin: '6px 0 0', maxWidth: 880 }}>{w}</p>)}
    </details>
  </div>
}

function PartTile({ p, nums, lang, observed }: { p: Part; nums: boolean; lang: Lang; observed: Observed }) {
  const pt = lang === 'pt'
  const Icon = TYPE_ICON[p.type]
  const c = TONE_VAR[p.tone]
  return <div data-testid={`part-${p.type}`} data-state={p.state} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px', background: 'var(--bg-card)', minWidth: 0 }}>
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12.5, fontWeight: 600 }}><Icon size={14} />{p.name}</div>
    <div style={{ ...muted, fontSize: 11.5, margin: '1px 0 6px' }}>{p.question}</div>
    {p.state === 'none' && <div style={{ fontSize: 13, color: 'var(--text-secondary)', padding: '6px 0' }}>{p.word}</div>}
    {p.state === 'history' && <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)' }}>{p.word}</div>}
    {p.state === 'scored' && <>
      <div style={{ fontSize: 24, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: c }}>{p.pct}%<small style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)' }}>{p.points} {pt ? 'de' : 'of'} {p.max} {pt ? 'pontos' : 'points'}</small></div>
      <Bar value={p.pct ?? 0} tone={p.tone} />
      <div style={{ fontSize: 12, fontWeight: 700, marginTop: 7, color: c }}>{p.word}</div>
    </>}
    {nums && p.rows.length > 0 && <ul style={{ listStyle: 'none', margin: '8px 0 0', padding: '7px 0 0', borderTop: '1px solid var(--border)', fontSize: 11, color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: 5 }}>
      {p.rows.map(r => <PartLine key={r.key} r={r} lang={lang} observed={observed} />)}
    </ul>}
    {nums && p.rows.length === 0 && p.state !== 'none' && <div style={{ ...muted, marginTop: 6 }}>{pt ? 'Nenhum número neste tipo.' : 'No figures in this type.'}</div>}
  </div>
}

function PartLine({ r, lang, observed }: { r: PartRow; lang: Lang; observed: Observed }) {
  const pt = lang === 'pt'
  const m = r.metric ? observed.metrics[r.metric] : null
  return <li data-testid={r.metric ? `metric-${r.metric}` : undefined} data-measured={r.measured ? 'yes' : 'no'}>
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}><span style={{ minWidth: 0 }}>{r.label}</span><b data-testid={r.metric ? `metric-${r.metric}-value` : undefined} style={{ color: 'var(--text-primary)', fontWeight: 600, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{r.value}</b></div>
    <div style={{ opacity: 0.85 }} data-testid={r.metric ? `metric-${r.metric}-sub` : undefined}>{r.sub}</div>
    {r.metric && m && <details style={{ marginTop: 2 }}>
      <summary style={{ cursor: 'pointer' }}><Info size={11} /> {pt ? 'origem do número' : 'where this number comes from'}</summary>
      <div style={{ display: 'grid', gap: 3, marginTop: 4 }}>
        <p style={{ margin: 0 }}>{METRIC_PLAIN[r.metric][pt ? 0 : 1]}</p>
        {m.interval && <p style={{ margin: 0 }}>{fmtInterval(r.metric, m.interval, lang)} — {intervalMethod(m.interval, lang)}.</p>}
        {m.gaps.length > 0 && <p style={{ margin: 0 }}><strong>{pt ? 'Ficou de fora' : 'Left out'}:</strong> {m.gaps.map(g => gapText(g, lang)).join('; ')}.</p>}
        <p style={{ margin: 0 }}><strong>{pt ? 'Fontes' : 'Sources'}:</strong> {m.origin.records.map(x => SOURCE_LABEL[x]?.[pt ? 0 : 1] ?? x).join('; ')}.</p>
        <p style={{ margin: 0, opacity: 0.8 }}><strong>{pt ? 'Fórmula (técnica)' : 'Formula (technical)'}:</strong> {formulaText(r.metric, m.origin.formula, lang)}</p>
      </div>
    </details>}
  </li>
}

function scopeLine(o: Observed, lang: Lang): string {
  const s = o.scope
  return lang === 'pt'
    ? `${nf(o.deliveries, lang, 0)} entregas consideradas: ${nf(s.published, lang, 0)} publicadas e ${nf(s.open, lang, 0)} em andamento; ${nf(s.withPhaseHistory, lang, 0)} têm histórico de fases.`
    : `${nf(o.deliveries, lang, 0)} deliveries considered: ${nf(s.published, lang, 0)} published and ${nf(s.open, lang, 0)} in progress; ${nf(s.withPhaseHistory, lang, 0)} have a phase history.`
}

function scopeExclusions(o: Observed, lang: Lang): string {
  const a = o.scope.abandonedWithSessions
  return lang === 'pt'
    ? `Tarefas sem início, ideias adiadas e trabalho abandonado não contam como entrega${a ? ` (${nf(a, lang, 0)} abandonadas só entram no custo desperdiçado)` : ''}.`
    : `Unstarted tasks, deferred ideas and abandoned work are not deliveries${a ? ` (${nf(a, lang, 0)} abandoned only feed wasted cost)` : ''}.`
}

const muted: React.CSSProperties = { color: 'var(--text-tertiary)', fontSize: 12, lineHeight: 1.45 }
const empty: React.CSSProperties = { padding: '16px 4px', color: 'var(--text-secondary)', fontSize: 13 }
const how: React.CSSProperties = {
  display: 'inline-flex', gap: 7, alignItems: 'center', color: 'var(--text-primary)', textDecoration: 'none', fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap',
  background: 'color-mix(in srgb, var(--accent-cyan, var(--accent-blue)) 12%, transparent)', border: '1px solid var(--accent-cyan, var(--accent-blue))', borderRadius: 8, padding: '7px 12px',
}
const toggle: React.CSSProperties = { appearance: 'none', marginLeft: 'auto', background: 'none', border: '1px solid var(--border)', color: 'var(--text-secondary)', borderRadius: 999, font: 'inherit', fontSize: 11.5, padding: '3px 11px', cursor: 'pointer' }

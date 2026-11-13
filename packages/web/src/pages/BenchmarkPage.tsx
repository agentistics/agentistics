import React, { useEffect, useState } from 'react'
import { Link, useOutletContext } from 'react-router-dom'
import { FlaskConical, Info, Scale } from 'lucide-react'
import type { Observed } from '@agentistics/core/benchmark'
import type { AppContext } from '../lib/app-context'
import {
  METRIC_LABEL, METRIC_ORDER, METRIC_PLAIN, SOURCE_LABEL, benchmarkQuery, cardCoverage, cardHeadline, cardSubline, fmtInterval, formulaText, gapText,
  harnessReason, harnessState, intervalMethod, nf, type Lang, type MetricKey, type Money,
} from '../lib/benchmarkFormat'

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

export function BenchmarkContent({ lang, observed, status = observed ? 'ready' : 'loading', experiments = [], currency = 'USD', brlRate, costBasis = 'api', period }: {
  lang: AppContext['lang']; observed: Observed | null; status?: Status; experiments?: unknown[] | null
  currency?: 'USD' | 'BRL'; brlRate?: number; costBasis?: AppContext['costBasis']
  period?: { fromMs: number | null; toMs: number | null }
}) {
  const pt = lang === 'pt'
  const L = lang as Lang
  const money: Money = { currency, brlRate }
  const day = (ms: number) => {
    const d = new Date(ms), p = (n: number) => String(n).padStart(2, '0')
    const y = d.getUTCFullYear(), m = p(d.getUTCMonth() + 1), dd = p(d.getUTCDate())
    return pt ? `${dd}/${m}/${y}` : `${y}-${m}-${dd}`
  }
  const periodText = period ? `${pt ? 'Período' : 'Period'}: ${period.fromMs && period.fromMs > 0 ? day(period.fromMs) : (pt ? 'início' : 'start')} – ${period.toMs ? day(period.toMs) : (pt ? 'hoje' : 'today')}. ` : ''
  const basisText = costBasis === 'plan'
    ? (pt ? 'O custo aqui é sempre o equivalente à API (tokens × tabela de preços), não o valor do plano. ' : 'Cost here is always the API-equivalent figure (tokens × price table), not the plan price. ')
    : ''
  return <main data-testid="benchmark-page" style={{ maxWidth: 1180, margin: '0 auto', display: 'grid', gap: 8 }}>
    <header style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>Benchmark <span style={beta}>beta</span></h1>
        <span style={muted}>{pt ? 'Histórico observado e experimentos controlados, sem inventar números.' : 'Observed history and controlled experiments, without invented numbers.'}</span>
      </div>
      <Link to="/benchmark/como-funciona" style={link}>{pt ? 'Como funciona?' : 'How it works'}</Link>
    </header>
    <section style={card} aria-label={pt ? 'Histórico observado' : 'Observed history'}>
      <div style={sectionTitle}><Scale size={16} /> {pt ? 'Observado, com viés' : 'Observed, biased'} <span style={tag}>{pt ? 'histórico' : 'history'}</span>
        <span style={{ ...muted, fontWeight: 400 }}>{pt ? 'Trabalho difícil tende a seguir o caminho pesado: descreve o passado, não é um veredito.' : 'Hard work tends to take the heavier path: this describes the past, it is not a verdict.'}</span></div>
      {status === 'loading' && <div data-testid="benchmark-loading" style={empty}>{pt ? 'Carregando dados reais…' : 'Loading real data…'}</div>}
      {status === 'error' && <div data-testid="benchmark-error" style={empty}>{pt ? 'Não foi possível ler os dados reais agora. Nenhum número é mostrado no lugar.' : 'The real data could not be read right now. No number is shown in its place.'}</div>}
      {status === 'ready' && observed && <>
        <p data-testid="benchmark-scope" style={{ ...muted, margin: '4px 0 6px' }}>{periodText}{basisText}{scopeLine(observed, L)}{' '}
          <details style={{ display: 'inline', marginLeft: 6 }}><summary style={{ display: 'inline', cursor: 'pointer' }}>{pt ? 'o que não conta' : 'what does not count'}</summary> {scopeExclusions(observed, L)}</details></p>
        <div style={grid}>{METRIC_ORDER.map(k => <Metric key={k} k={k} observed={observed} lang={L} money={money} />)}</div>
        <div style={coverage} data-testid="benchmark-coverage"><strong>{pt ? 'Cobertura por harness' : 'Coverage by harness'}</strong>
          {Object.entries(observed.coverage).map(([h, c]) => {
            const state = harnessState(c), why = harnessReason(c, L)
            return <span key={h} data-state={state} title={why} style={tag}>{h}: {state === 'measured' ? (pt ? `${c.withCost}/${c.sessions} com custo` : `${c.withCost}/${c.sessions} with cost`)
              : state === 'partial' ? (pt ? `parcial ${c.withCost}/${c.sessions} com custo` : `partial ${c.withCost}/${c.sessions} with cost`)
              : (pt ? `sem medição (0/${c.sessions})` : `not measured (0/${c.sessions})`)}{why && state !== 'measured' ? ` · ${why}` : ''}</span>
          })}
          {Object.keys(observed.coverage).length === 0 && <span style={muted}>{pt ? 'sem sessões registradas' : 'no sessions recorded'}</span>}
        </div>
      </>}
    </section>
    <section style={card} data-testid="benchmark-experiment-empty">
      <div style={sectionTitle}><FlaskConical size={16} /> {pt ? 'Experimento' : 'Experiment'} <span style={tag}>{pt ? 'ainda não executado' : 'not run yet'}</span>
        <span style={{ ...muted, fontWeight: 400 }}>{experiments && experiments.length > 0
          ? (pt ? `${experiments.length} experimento(s) registrado(s)` : `${experiments.length} experiment(s) recorded`) : ''}</span></div>
      <div style={{ ...empty, padding: '8px 2px 0' }}><strong>{pt ? 'Sem dados suficientes — nenhum experimento rodado' : 'Not enough data — no experiment has run'}</strong>
        <span style={{ ...muted, marginLeft: 8 }}>{pt ? 'Falta: 8 tarefas, 2 repetições por braço, 5 entregas aceitas por braço e custo medido em 100% das execuções. Sem isso, nenhum veredito.' : 'Missing: 8 tasks, 2 repetitions per arm, 5 accepted deliveries per arm and measured cost for 100% of runs. Without that, no verdict.'}</span></div>
    </section>
  </main>
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

function Metric({ k, observed, lang, money }: { k: MetricKey; observed: Observed; lang: Lang; money: Money }) {
  const pt = lang === 'pt'
  const m = observed.metrics[k]
  const head = cardHeadline(k, observed, lang, money)
  const label = METRIC_LABEL[k][pt ? 0 : 1]
  return <article data-testid={`metric-${k}`} data-measured={head.measured ? 'yes' : 'no'} style={metricCard}>
    <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{label}</div>
    <div style={{ fontSize: 19, fontWeight: 750, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{head.value}</div>
    <div style={{ ...muted, fontSize: 11, minHeight: 15 }} data-testid={`metric-${k}-sub`}>{cardSubline(k, observed, lang, money)}</div>
    <div style={muted}>{cardCoverage(k, observed, lang)}</div>
    <details style={{ marginTop: 4, fontSize: 11 }}>
      <summary style={{ cursor: 'pointer' }}><Info size={12} /> {pt ? 'origem do número' : 'where this number comes from'}</summary>
      <div style={{ ...muted, display: 'grid', gap: 3, marginTop: 4 }}>
        <p style={{ margin: 0 }}>{METRIC_PLAIN[k][pt ? 0 : 1]}</p>
        <p style={{ margin: 0 }}><strong>{pt ? 'Amostra' : 'Sample'}:</strong> {cardCoverage(k, observed, lang)}.
          {m.interval && <> {fmtInterval(k, m.interval, lang, money)} — {intervalMethod(m.interval, lang)}.</>}</p>
        {m.gaps.length > 0 && <p style={{ margin: 0 }}><strong>{pt ? 'Ficou de fora' : 'Left out'}:</strong> {m.gaps.map(g => gapText(g, lang)).join('; ')}.</p>}
        <p style={{ margin: 0 }}><strong>{pt ? 'Fontes' : 'Sources'}:</strong> {m.origin.records.map(r => SOURCE_LABEL[r]?.[pt ? 0 : 1] ?? r).join('; ')}.</p>
        <p style={{ margin: 0, opacity: 0.8 }}><strong>{pt ? 'Fórmula (técnica)' : 'Formula (technical)'}:</strong> {formulaText(k, m.origin.formula, lang)}</p>
      </div>
    </details>
  </article>
}

export function BenchmarkHowItWorksPage() {
  const { lang } = useOutletContext<AppContext>(); const pt = lang === 'pt'
  return <main style={{ maxWidth: 760, margin: '0 auto', display: 'grid', gap: 14 }}><Link to="/benchmark" style={link}>← {pt ? 'Voltar ao Benchmark' : 'Back to Benchmark'}</Link><section style={card}><h1 style={{ marginTop: 0 }}>{pt ? 'Como funciona o Benchmark' : 'How the Benchmark works'}</h1><p style={muted}>{pt ? 'O benchmark compara braços com as mesmas tarefas, começa do mesmo código e só produz um veredito quando a amostra e a cobertura são suficientes.' : 'The benchmark compares arms on the same tasks, from the same code, and only produces a verdict when sample and coverage are sufficient.'}</p><p style={muted}>{pt ? 'O histórico observado é separado dos experimentos: ele é útil para contexto, mas não diz que um método compensa.' : 'Observed history is kept separate from experiments: it provides context, but does not say a method pays off.'}</p><p style={muted}>{pt ? 'Custo é tokens por turno vezes a tabela de preços. Quando falta preço ou tokens, mostramos “—” e o motivo.' : 'Cost is per-turn tokens times the price table. When price or tokens are missing, we show “—” and the reason.'}</p></section></main>
}

const card: React.CSSProperties = { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 14, padding: 10 }
const metricCard: React.CSSProperties = { ...card, padding: 8, minWidth: 0, borderRadius: 10 }
const grid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(158px,1fr))', gap: 8 }
const coverage: React.CSSProperties = { display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center', marginTop: 8, fontSize: 11 }
const sectionTitle: React.CSSProperties = { display: 'flex', gap: 7, alignItems: 'center', fontWeight: 700, fontSize: 15, flexWrap: 'wrap' }
const muted: React.CSSProperties = { color: 'var(--text-tertiary)', fontSize: 12, lineHeight: 1.45 }
const empty: React.CSSProperties = { padding: '16px 4px', color: 'var(--text-secondary)', fontSize: 13 }
const tag: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: 999, padding: '2px 8px', fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)' }
const link: React.CSSProperties = { color: 'var(--accent-blue)', fontSize: 13, textDecoration: 'none' }
const beta: React.CSSProperties = { ...tag, color: 'var(--accent-blue)', verticalAlign: 'middle' }

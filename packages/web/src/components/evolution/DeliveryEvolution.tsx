/**
 * DeliveryEvolution — the "Evolução de entregas" screen (BETA), in Métricas. A narrative in steps: the summary and its
 * cards, where the time goes, where the curves are heading, who and why, and the deliveries behind all of it.
 *
 * It reads ONE reply (`GET /api/deliveries/metrics`, computed by core's `buildMetrics` — the function
 * `agentistics_delivery_metrics` and `agentop flow evolucao` call), so what an agent is told and what this shows can
 * never differ. The period and harness come from the app's fixed filters bar; the version, stage, author model, QA
 * result, priority, task and "group by" come from the extra dimensions that bar offers only on this page
 * (`lib/evolutionFilters.ts`). Nothing here measures anything: a figure the reply could not measure reads "—".
 */
import { useEffect, useMemo, type ReactNode } from 'react'
import { BarChart3, Coins, Layers, List, RotateCcw, Ban, Clock, Hourglass } from 'lucide-react'
import { fmtCost, type Filters } from '@agentistics/core'
import { BetaTag } from '../BetaTag'
import { CenteredLoader } from '../CenteredLoader'
import { Section } from '../Section'
import { useIsMobile } from '../../hooks/useIsMobile'
import { getDateRangeFilter } from '../../hooks/useData'
import { evolutionQuery, setEvolutionOptions, useEvolutionFilters } from '../../lib/evolutionFilters'
import { dialogButtonStyle } from '../../pages/settings/primitives'
import { BottleneckCall, CostTrend, Funnel, LeadTrend, QualityTrend, StageStack } from './EvolutionCharts'
import { EvolutionTable, HBars, blockBars, costBars, qaBars, queueBars } from './EvolutionDetails'
import { EvolutionKpis } from './EvolutionKpis'
import { emptyKind, leadSentence } from './evolutionModel'
import { TEXT, pick } from './evolutionText'
import { useDeliveryMetrics } from './useDeliveryMetrics'

/** PURE: the fixed bar's period and harnesses → the metrics query's base. 'all' with no custom dates is an open range. */
export function baseOf(filters: Pick<Filters, 'dateRange' | 'customStart' | 'customEnd' | 'harnesses' | 'harness'>): { from?: string; to?: string; harnesses?: string[] } {
  const open = filters.dateRange === 'all' && !filters.customStart && !filters.customEnd
  const range = open ? null : getDateRangeFilter(filters.dateRange, filters.customStart, filters.customEnd)
  const harnesses = filters.harnesses?.length ? [...filters.harnesses] : filters.harness ? [filters.harness] : []
  return { ...(range ? { from: range.start.toISOString(), to: range.end.toISOString() } : {}), ...(harnesses.length ? { harnesses } : {}) }
}

function Step({ n, title }: { n: number; title: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', margin: '4px 0 -2px' }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, borderRadius: 10, background: 'var(--anthropic-orange-dim)', color: 'var(--anthropic-orange-light)', fontSize: 11 }}>{n}</span>
      {title}
    </div>
  )
}

function Card({ icon, title, caption, children, id }: { icon: ReactNode; title: string; caption?: string; children: ReactNode; id: string }) {
  return (
    <div data-evo-card={id} style={{ minWidth: 0, display: 'flex' }}>
      <Section style={{ flex: 1, minWidth: 0 }} title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13.5 }}><span style={{ display: 'inline-flex', color: 'var(--text-tertiary)' }}>{icon}</span>{title}</span>}>
        {caption && <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', margin: '-2px 0 8px' }}>{caption}</div>}
        {children}
      </Section>
    </div>
  )
}

export function DeliveryEvolution({ lang, filters, currency, brlRate }: { lang: 'pt' | 'en'; filters: Filters; currency: 'USD' | 'BRL'; brlRate: number }) {
  const pt = lang === 'pt'
  const isMobile = useIsMobile()
  const extra = useEvolutionFilters()
  const base = useMemo(() => baseOf(filters), [filters])
  const query = useMemo(() => evolutionQuery(base, extra), [base, extra])
  const { reply, loading, error, reload } = useDeliveryMetrics(query)
  const cost = (usd: number) => fmtCost(usd, currency, brlRate)

  useEffect(() => { if (reply) setEvolutionOptions(reply.options) }, [reply])

  const group = reply ? ({ day: pt ? 'dia' : 'day', week: pt ? 'semana' : 'week', version: pt ? 'versão' : 'version', model: pt ? 'modelo' : 'model' } as const)[reply.groupBy] : ''
  const kind = reply ? emptyKind(reply) : 'none'
  const cols = (n: number) => (isMobile ? 'minmax(0, 1fr)' : `repeat(${n}, minmax(0, 1fr))`)
  const grid = (n: number, extraStyle: React.CSSProperties = {}): React.CSSProperties => ({ display: 'grid', gap: 12, gridTemplateColumns: cols(n), alignItems: 'stretch', ...extraStyle })

  return (
    <div data-evo-page style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: isMobile ? '4px 2px 24px' : '4px 4px 20px', minWidth: 0 }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <h1 style={{ margin: 0, fontSize: isMobile ? 20 : 22, fontWeight: 700, color: 'var(--text-primary)' }}>{pick(TEXT.title, pt)}</h1>
          <BetaTag what={pick(TEXT.beta, pt)} lang={lang} />
        </div>
        <p style={{ margin: '4px 0 0', fontSize: 12.5, color: 'var(--text-secondary)', maxWidth: 860 }}>{pick(TEXT.subtitle, pt)}</p>
      </div>

      {!reply && loading && <CenteredLoader label={pick(TEXT.loading, pt)} />}
      {!reply && error && (
        <div data-evo-error style={{ padding: 20, textAlign: 'center', color: 'var(--text-secondary)', fontSize: 13 }}>
          <div style={{ marginBottom: 10 }}>{pick(TEXT.loadError, pt)}</div>
          <button type="button" onClick={() => void reload()} style={dialogButtonStyle('secondary', isMobile)}>{pick(TEXT.retry, pt)}</button>
        </div>
      )}

      {reply && kind !== 'none' && (
        <div data-evo-empty={kind} style={{ padding: '36px 16px', textAlign: 'center', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)' }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{pick(kind === 'no-data' ? TEXT.emptyNoData : TEXT.emptyNoMatch, pt)}</div>
          <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)', marginTop: 4 }}>{pick(kind === 'no-data' ? TEXT.emptyNoDataHint : TEXT.emptyNoMatchHint, pt)}</div>
        </div>
      )}

      {reply && kind === 'none' && (
        <>
          <Step n={1} title={pick(TEXT.step1, pt)} />
          <div data-evo-lead style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: isMobile ? '12px 14px' : '14px 18px', fontSize: 14, lineHeight: 1.5, color: 'var(--text-primary)' }}>
            {leadSentence(reply, pt, cost)}
            <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginTop: 6 }}>{pick(TEXT.startedFrom, pt)}</div>
          </div>
          <EvolutionKpis reply={reply} pt={pt} cost={cost} />

          <Step n={2} title={pick(TEXT.step2, pt)} />
          <div style={grid(2, isMobile ? {} : { gridTemplateColumns: 'minmax(0, 3fr) minmax(0, 2fr)' })}>
            <Card id="funnel" icon={<Layers size={14} />} title={pick(TEXT.funnel, pt)} caption={pick(TEXT.funnelCap, pt)}>
              <Funnel rows={reply.funnel} blockedAny={reply.summary.blockedAny} blockedMs={reply.summary.blockMs} bottleneck={reply.bottleneck} pt={pt} />
            </Card>
            <Card id="bottleneck" icon={<Hourglass size={14} />} title={pick(TEXT.bottleneck, pt)}>
              <BottleneckCall b={reply.bottleneck} pt={pt} />
            </Card>
          </div>
          <Card id="stages" icon={<BarChart3 size={14} />} title={pick(TEXT.stageTime(group), pt)} caption={pick(TEXT.stageTimeCap, pt)}>
            <StageStack groups={reply.groups} pt={pt} height={isMobile ? 200 : 220} />
          </Card>

          <Step n={3} title={pick(TEXT.step3, pt)} />
          <div style={grid(3)}>
            <Card id="lead" icon={<Clock size={14} />} title={pick(TEXT.leadTitle, pt)} caption={pick(TEXT.leadCap(group), pt)}><LeadTrend reply={reply} pt={pt} height={190} /></Card>
            <Card id="quality" icon={<RotateCcw size={14} />} title={pick(TEXT.qualityTitle, pt)} caption={pick(TEXT.qualityCap(reply.groupBy === 'day'), pt)}><QualityTrend reply={reply} pt={pt} height={190} /></Card>
            <Card id="cost" icon={<Coins size={14} />} title={pick(TEXT.costTitle, pt)} caption={pick(TEXT.costCap(reply.groupBy === 'day' ? pick(TEXT.weekWord, pt) : group), pt)}><CostTrend reply={reply} pt={pt} height={190} cost={cost} /></Card>
          </div>

          <Step n={4} title={pick(TEXT.step4, pt)} />
          <div style={grid(2)}>
            <Card id="qa-by-model" icon={<RotateCcw size={14} />} title={pick(TEXT.qaByModel, pt)} caption={pick(TEXT.qaByModelCap, pt)}>
              <HBars bars={qaBars(reply, pt)} empty={pick(TEXT.noQaBars, pt)} />
            </Card>
            <Card id="blocks" icon={<Ban size={14} />} title={pick(TEXT.blocksTitle, pt)} caption={pick(TEXT.blocksCap, pt)}>
              <HBars bars={blockBars(reply, pt)} empty={pick(TEXT.noBlocks, pt)} />
            </Card>
            <Card id="queue" icon={<Hourglass size={14} />} title={pick(TEXT.queueTitle, pt)} caption={pick(TEXT.queueCap, pt)}>
              <HBars bars={queueBars(reply, pt)} empty={pick(TEXT.noQueue, pt)} />
            </Card>
            <Card id="cost-by" icon={<Coins size={14} />} title={pick(TEXT.costByModel, pt)} caption={pick(TEXT.costBarsCap, pt)}>
              <HBars bars={costBars(reply, pt, cost, 'author')} empty={pick(TEXT.noCostBars, pt)} />
              {reply.costByHarness.length > 0 && (
                <>
                  <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-secondary)', margin: '12px 0 6px' }}>{pick(TEXT.costByHarness, pt)}</div>
                  <HBars bars={costBars(reply, pt, cost, 'harness')} empty="" />
                </>
              )}
            </Card>
          </div>

          <Step n={5} title={pick(TEXT.step5, pt)} />
          <Card id="table" icon={<List size={14} />} title={pick(TEXT.tableTitle, pt)} caption={pick(TEXT.tableCap, pt)}>
            <EvolutionTable rows={reply.rows} total={reply.rowsTotal} pt={pt} cost={cost} maxHeight={isMobile ? null : 380} />
          </Card>
        </>
      )}
    </div>
  )
}

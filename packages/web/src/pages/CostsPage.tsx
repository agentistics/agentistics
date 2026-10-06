import React from 'react'
import { useOutletContext } from 'react-router-dom'
import { TrendingUp, Zap, Target, Sparkles, Sigma, Cpu } from 'lucide-react'
import { planAllocation } from '@agentistics/core'
import type { AppContext } from '../lib/app-context'
import { useIsMobile } from '../hooks/useIsMobile'
import { Section } from '../components/Section'
import { ModelBreakdown } from '../components/ModelBreakdown'
import { BudgetPanel } from '../components/BudgetPanel'
import { CacheHitRatePanel } from '../components/CacheHitRatePanel'
import { TokenTotalsPanel } from '../components/TokenTotalsPanel'
import { NativeUsagePanel } from '../components/NativeUsagePanel'
import { useNativeUsage } from '../lib/nativeUsage'
import { modelCostByHarness } from '../lib/costBasis'

export default function CostsPage() {
  const ctx = useOutletContext<AppContext>()
  const {
    derived, statsCache, filters,
    lang, currency, brlRate,
    monthlyBudgetUSD, updateBudget,
    setExpandedChart,
  } = ctx
  const isMobile = useIsMobile()
  // The native harness's own calls; absent only without an engine; with one and no calls the card shows an empty state.
  const native = useNativeUsage()

  return (
    <>
      <PageHeader
        icon={<Sparkles size={16} />}
        title={lang === 'pt' ? 'Custos & orçamento' : 'Costs & budget'}
        subtitle={lang === 'pt'
          ? 'Uso por modelo, projeção mensal e eficiência de cache — tudo relacionado a gastos.'
          : 'Model usage, monthly forecast and cache efficiency — everything related to spending.'}
      />

      {/* The totals come FIRST: every figure below is a slice of these four numbers, and the panel
          is where the word "tokens" is defined for the whole product. */}
      <Section flashId="token-totals" title={<><Sigma size={14} /> {lang === 'pt' ? 'Totais de tokens' : 'Token totals'}</>}>
        <TokenTotalsPanel tokens={derived.tokenTotals} filters={filters} lang={lang} />
      </Section>

      <Section flashId="models" title={<><TrendingUp size={14} /> {lang === 'pt' ? 'Uso por modelo' : 'Model usage & cost'}</>} onExpand={() => setExpandedChart('models')}>
        <ModelBreakdown
          modelUsage={derived.modelUsage}
          currency={currency}
          planFactor={ctx.costBasis === 'plan' && ctx.planBasis.basis ? planAllocation(ctx.planBasis.basis).aggregateFactor : null}
          planFactors={ctx.costBasis === 'plan' && ctx.planBasis.basis ? planAllocation(ctx.planBasis.basis).byHarness : null}
          costByHarness={modelCostByHarness(derived.modelUsage, derived.filteredSessions)}
          brlRate={brlRate}
          lang={lang}
          fallbackInputTokens={filters.projects.length > 0 ? derived.inputTokens : undefined}
          fallbackOutputTokens={filters.projects.length > 0 ? derived.outputTokens : undefined}
          fallbackCostUSD={filters.projects.length > 0 ? derived.totalCostUSD : undefined}
          note={
            filters.dateRange !== 'all' || filters.customStart || filters.customEnd
              ? (lang === 'pt'
                ? '* Valores aproximados: tokens rateados pelo total diário.'
                : '* Approximate values: tokens prorated from daily totals.')
              : undefined
          }
        />
      </Section>

      {native.show && (
        <Section flashId="native" title={<><Cpu size={14} /> {lang === 'pt' ? 'Agentistics (nativo)' : 'Agentistics (native)'}</>}>
          <NativeUsagePanel usage={native.usage} currency={currency} brlRate={brlRate} lang={lang} />
        </Section>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 16, alignItems: 'stretch' }}>
        <Section flashId="budget" style={{ height: '100%' }} title={<><Target size={14} /> {lang === 'pt' ? 'Orçamento & projeção' : 'Budget & forecast'}</>}>
          <BudgetPanel statsCache={statsCache} budgetUSD={monthlyBudgetUSD} onBudgetChange={updateBudget} currency={currency} brlRate={brlRate} lang={lang} monthlyCommitmentUSD={ctx.monthCommitment?.usd ?? null} commitmentPartial={ctx.monthCommitment?.partial ?? false} />
        </Section>
        <Section flashId="cache" style={{ height: '100%' }} title={<><Zap size={14} /> {lang === 'pt' ? 'Eficiência de cache' : 'Cache efficiency'}</>}>
          <CacheHitRatePanel hitRate={derived.cacheHitRate} cacheTotals={derived.cacheTotals} grossSavedUSD={derived.cacheGrossSavedUSD} writeOverheadUSD={derived.cacheWriteOverheadUSD} netSavedUSD={derived.cacheNetSavedUSD} perModel={derived.cachePerModel} currency={currency} brlRate={brlRate} costBasis={ctx.costBasis} lang={lang} />
        </Section>
      </div>
    </>
  )
}

function PageHeader({ icon, title, subtitle }: { icon: React.ReactNode; title: string; subtitle: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>
        <span style={{ color: 'var(--anthropic-orange)' }}>{icon}</span>
        {title}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>{subtitle}</div>
    </div>
  )
}

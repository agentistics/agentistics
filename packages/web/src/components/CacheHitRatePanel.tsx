import React from 'react'
import { Zap, Lightbulb, TrendingDown, TrendingUp, Info } from 'lucide-react'
import { fmt, formatModel, getModelColor, fmtCost } from '@agentistics/core'
import type { Lang, SurfaceHarnessId } from '@agentistics/core'
import { useIsMobile } from '../hooks/useIsMobile'
import { NAtag } from './NAtag'
import { MetricNote } from './MetricNote'
import { capable } from '../lib/harness'

interface Props {
  hitRate: number
  cacheTotals: {
    inputTokens: number
    cacheReadInputTokens: number
    cacheCreationInputTokens: number
  }
  grossSavedUSD: number
  writeOverheadUSD: number
  netSavedUSD: number
  perModel: Record<string, { hitRate: number; cacheReadTokens: number; inputTokens: number }>
  currency: 'USD' | 'BRL'
  brlRate: number
  /** The page's active basis. This panel NEVER converts — it only says so when the rest has. */
  costBasis?: 'api' | 'plan'
  lang: Lang
  /**
   * The active harness filter (undefined = unified / all-harness view).
   * When a harness does not support tokens (!capable(harness, 'tokens')),
   * cache data is meaningless — show N/A instead of a misleading 0%.
   */
  harness?: SurfaceHarnessId
}


type Tier = 'low' | 'medium' | 'high'

function getTier(rate: number): Tier {
  if (rate < 0.3) return 'low'
  if (rate < 0.6) return 'medium'
  return 'high'
}

function tierColor(tier: Tier): string {
  if (tier === 'low') return '#ef4444'
  if (tier === 'medium') return '#f59e0b'
  return 'var(--accent-green, #22c55e)'
}

function tierLabel(tier: Tier, pt: boolean): string {
  if (tier === 'low') return pt ? 'Baixo' : 'Low'
  if (tier === 'medium') return pt ? 'Razoável' : 'Fair'
  return pt ? 'Excelente' : 'Excellent'
}

const TIPS = {
  low: {
    pt: [
      'Cache hit baixo significa que o Claude está relendo boa parte do contexto em cada turno e você está pagando preço cheio por isso.',
      'Evite reiniciar sessões muito cedo — cache só é válido por alguns minutos; continuar a mesma conversa amortiza o custo do write.',
      'Mantenha o CLAUDE.md estável. Toda mudança invalida o cache do prefixo do prompt.',
      'Agrupe perguntas curtas na mesma sessão em vez de abrir várias novas.',
    ],
    en: [
      'Low cache hit means Claude is re-reading most of the context each turn and you\'re paying full price for it.',
      'Avoid restarting sessions too early — cache only lives a few minutes; continuing the same chat amortises the write cost.',
      'Keep CLAUDE.md stable. Every change invalidates the cached prompt prefix.',
      'Group short questions in the same session instead of opening new ones.',
    ],
  },
  medium: {
    pt: [
      'Cache está ajudando, mas dá pra extrair mais. Sessões mais longas no mesmo projeto tendem a elevar a taxa.',
      'Arquivos lidos repetidamente (como CLAUDE.md ou arquivos grandes de contexto) se beneficiam muito do cache — vale mantê-los estáveis.',
      'Skills e subagents compartilham o prefixo cacheado da conversa principal, então usá-los em uma sessão já aquecida é barato.',
    ],
    en: [
      'Cache is helping but you can squeeze out more. Longer sessions in the same project tend to push the rate up.',
      'Files re-read often (like CLAUDE.md or big context files) benefit a lot from cache — keep them stable.',
      'Skills and subagents share the cached prefix of the main conversation, so using them in an already-warm session is cheap.',
    ],
  },
  high: {
    pt: [
      'Ótimo aproveitamento. Seu contexto (CLAUDE.md, arquivos de referência) está sendo reutilizado de forma eficiente.',
      'Cache read custa ~10× menos que input normal — cada ponto percentual acima de 60% é dinheiro que você não está gastando.',
      'Continue usando sessões longas e CLAUDE.md estável. Só vale invalidar o cache quando há mudança real de contexto.',
    ],
    en: [
      'Great utilisation. Your context (CLAUDE.md, reference files) is being reused efficiently.',
      'Cache read costs ~10× less than regular input — every percentage point above 60% is money you\'re not spending.',
      'Keep using long sessions and a stable CLAUDE.md. Only bust the cache when context really changes.',
    ],
  },
} as const

export function CacheHitRatePanel({
  hitRate,
  cacheTotals,
  grossSavedUSD,
  writeOverheadUSD,
  netSavedUSD,
  perModel,
  currency,
  brlRate,
  costBasis = 'api',
  lang,
  harness,
}: Props) {
  const pt = lang === 'pt'
  const isMobile = useIsMobile()

  // Only show N/A when the active harness explicitly lacks token capability.
  // A 0% cache hit for a token-capable harness (e.g. codex, gemini) is a real 0 — fine.
  if (harness && !capable(harness, 'tokens')) {
    return <NAtag harness={harness} label="Cache efficiency" />
  }

  const totalRelevant = cacheTotals.inputTokens + cacheTotals.cacheReadInputTokens + cacheTotals.cacheCreationInputTokens

  if (totalRelevant === 0) {
    return (
      <div style={{
        padding: '32px 0',
        textAlign: 'center',
        color: 'var(--text-tertiary)',
        fontSize: 13,
      }}>
        <Zap size={16} style={{ opacity: 0.4, marginRight: 6, verticalAlign: 'middle' }} />
        {pt ? 'Sem dados de cache no período selecionado' : 'No cache data in the selected period'}
      </div>
    )
  }

  const tier = getTier(hitRate)
  const color = tierColor(tier)
  const tips = TIPS[tier][pt ? 'pt' : 'en']
  const pct = Math.round(hitRate * 100)

  const perModelEntries = Object.entries(perModel)
    .filter(([, v]) => v.inputTokens + v.cacheReadTokens > 0)
    .sort((a, b) => (b[1].cacheReadTokens + b[1].inputTokens) - (a[1].cacheReadTokens + a[1].inputTokens))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* What is prompt cache */}
      <div style={{
        fontSize: 11,
        color: 'var(--text-secondary)',
        lineHeight: 1.5,
        padding: '8px 10px',
        background: 'var(--bg-elevated)',
        borderRadius: 8,
        border: '1px solid var(--border-subtle)',
      }}>
        {pt
          ? <>O <strong style={{ color: 'var(--text-primary)' }}>prompt cache</strong> reutiliza partes do contexto entre turnos — CLAUDE.md, arquivos abertos, histórico da conversa. Tokens lidos do cache custam <strong style={{ color: 'var(--text-primary)' }}>~10× menos</strong> que input normal; criá-lo custa ~1,25× (pago uma vez, amortizado nas leituras seguintes).</>
          : <>The <strong style={{ color: 'var(--text-primary)' }}>prompt cache</strong> reuses context across turns — CLAUDE.md, open files, conversation history. Cache reads cost <strong style={{ color: 'var(--text-primary)' }}>~10× less</strong> than regular input; writing costs ~1.25× (paid once, amortised over subsequent reads).</>}
      </div>

      {/* Hero gauge + money stats */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: isMobile ? '1fr' : '200px 1fr',
        gap: 10,
        alignItems: 'stretch',
      }}>
        <div style={{
          background: 'var(--bg-elevated)',
          border: `1px solid ${color}33`,
          borderRadius: 10,
          padding: '12px 14px',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          gap: 6,
        }}>
          <div style={{ fontSize: 10, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>
            Cache hit rate
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
            <span style={{ fontSize: 32, fontWeight: 700, color, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
              {pct}
            </span>
            <span style={{ fontSize: 15, fontWeight: 600, color, opacity: 0.7 }}>%</span>
            <span style={{
              marginLeft: 'auto',
              fontSize: 9,
              fontWeight: 700,
              padding: '2px 7px',
              borderRadius: 999,
              background: `${color}22`,
              color,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
            }}>
              {tierLabel(tier, pt)}
            </span>
          </div>
          <div style={{ height: 5, background: 'var(--bg-card)', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{
              width: `${pct}%`,
              height: '100%',
              background: `linear-gradient(90deg, ${color}, ${color}cc)`,
              transition: 'width 0.6s ease',
            }} />
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>
            {pt
              ? `${fmt(cacheTotals.cacheReadInputTokens)} de ${fmt(totalRelevant)} tokens do cache`
              : `${fmt(cacheTotals.cacheReadInputTokens)} of ${fmt(totalRelevant)} tokens from cache`}
          </div>
        </div>

        {/* Money impact */}
        <div className="ag-grid cols-3" style={{ gap: 8 }}>
          <Stat
            label={pt ? 'Economia bruta' : 'Gross savings'}
            value={fmtCost(grossSavedUSD, currency, brlRate)}
            sub={pt ? 'vs. input normal' : 'vs. regular input'}
            accent="var(--accent-green, #22c55e)"
            icon={<TrendingDown size={11} />}
          />
          <Stat
            label={pt ? 'Custo write' : 'Write overhead'}
            value={fmtCost(writeOverheadUSD, currency, brlRate)}
            sub={pt ? 'prêmio para criar cache' : 'premium to create cache'}
            accent="#f59e0b"
            icon={<TrendingUp size={11} />}
          />
          <Stat
            label={pt ? 'Economia líquida' : 'Net savings'}
            value={fmtCost(netSavedUSD, currency, brlRate)}
            sub={pt ? 'no período' : 'in period'}
            accent={netSavedUSD >= 0 ? 'var(--anthropic-orange)' : '#ef4444'}
            icon={<Zap size={11} />}
          />
        </div>
      </div>

      {/* These figures stay in API basis, ALWAYS, and say so when the rest of the page has moved.
          Cache does not reduce a subscription bill — the plan costs the same either way; what it
          buys you is more work inside the same rate limit. A "saving" converted to plan basis
          would be a number invented to match the toggle. This is the same N/A-versus-a-confident-0
          rule HARNESS_CAPABILITIES applies to metrics, applied to a basis. */}
      {costBasis === 'plan' && (
        <div style={{
          fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.5,
          borderLeft: '2px solid var(--border)', paddingLeft: 9, marginTop: 2,
        }}>
          <strong style={{ color: 'var(--text-secondary)' }}>{pt ? 'Em preços de API.' : 'In API pricing.'}</strong>{' '}
          {pt
            ? 'O cache não reduz o valor de uma assinatura — o plano custa o mesmo. O que ele rende é mais trabalho dentro do mesmo limite de uso.'
            : 'Cache does not reduce a subscription bill — the plan costs the same. What it buys you is more work inside the same rate limit.'}
        </div>
      )}

      {/* Per-model breakdown */}
      {perModelEntries.length > 1 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            {pt ? 'Por modelo' : 'Per model'}
          </div>
          {perModelEntries.map(([modelId, v]) => {
            const mPct = Math.round(v.hitRate * 100)
            const mColor = getModelColor(modelId)
            return (
              <div key={modelId} style={{
                display: 'grid',
                gridTemplateColumns: isMobile ? '100px 1fr 44px' : '130px 1fr 44px',
                gap: 8,
                alignItems: 'center',
                fontSize: 11,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <div style={{ width: 7, height: 7, borderRadius: '50%', background: mColor, flexShrink: 0 }} />
                  <span style={{ color: 'var(--text-primary)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {formatModel(modelId)}
                  </span>
                </div>
                <div style={{ position: 'relative', height: 4, background: 'var(--bg-elevated)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{
                    position: 'absolute', left: 0, top: 0, bottom: 0,
                    width: `${mPct}%`,
                    background: mColor,
                    opacity: 0.7,
                    borderRadius: 3,
                  }} />
                </div>
                <span style={{ color: 'var(--text-primary)', fontWeight: 600, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                  {mPct}%
                </span>
              </div>
            )
          })}
        </div>
      )}

      {/* The denominator is the thing people get wrong here, and it is the reason the rate can look
          high on a session whose bill is mostly output. */}
      <MetricNote>
        {pt
          ? 'A taxa é leitura de cache dividida por tudo que o modelo LEU — entrada nova + leitura + escrita de cache. A saída fica de fora porque saída é produzida, não lida; incluí-la diluiria a taxa numa sessão que escreveu muito. Este painel é sempre em preço de API: cache não reduz uma assinatura, ele estica o limite de uso.'
          : 'The rate is cache reads over everything the model READ — fresh input + cache read + cache write. Output is excluded because output is produced, not read; including it would dilute the rate on a session that wrote a lot. This panel is always in API prices: cache does not reduce a subscription, it extends a rate limit.'}
      </MetricNote>

      {/* Tips — show only first 2 */}
      <div style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 8,
        padding: '10px 12px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 6 }}>
          <Lightbulb size={12} style={{ color }} />
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)' }}>
            {pt ? 'Como melhorar' : 'How to improve'}
          </span>
        </div>
        <ul style={{ margin: 0, paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {tips.slice(0, 2).map((tip, i) => (
            <li key={i} style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.45 }}>
              {tip}
            </li>
          ))}
        </ul>
      </div>

      {/* How it's calculated */}
      <div style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 5,
        fontSize: 10,
        color: 'var(--text-tertiary)',
        lineHeight: 1.4,
      }}>
        <Info size={10} style={{ flexShrink: 0, marginTop: 1, opacity: 0.6 }} />
        <span>
          {pt
            ? 'hit rate = cacheRead ÷ (input + cacheRead + cacheCreation). Read ~10% do preço; write ~125% — amortizado em ≥ 2 reuses.'
            : 'hit rate = cacheRead ÷ (input + cacheRead + cacheCreation). Read ~10% of input price; write ~125% — amortised over ≥ 2 reuses.'}
        </span>
      </div>
    </div>
  )
}

function Stat({ label, value, sub, accent, icon }: {
  label: string
  value: string
  sub: string
  accent: string
  icon: React.ReactNode
}) {
  return (
    <div style={{
      background: 'var(--bg-elevated)',
      border: '1px solid var(--border-subtle)',
      borderRadius: 8,
      padding: '10px 12px',
      display: 'flex',
      flexDirection: 'column',
      gap: 2,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: 'var(--text-tertiary)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        <span style={{ color: accent, display: 'flex' }}>{icon}</span>
        {label}
      </div>
      <div style={{ fontSize: 16, fontWeight: 700, color: accent, lineHeight: 1.1 }}>
        {value}
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>{sub}</div>
    </div>
  )
}


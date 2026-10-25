import React, { useState } from 'react'
import { FileText, ArrowDownWideNarrow } from 'lucide-react'
import type { Lang } from '@agentistics/core'
import { fmt, t } from '@agentistics/core'
import { useIsMobile } from '../hooks/useIsMobile'
import { MetricNote } from './MetricNote'

interface Props {
  toolCounts: Record<string, number>
  toolOutputTokens: Record<string, number>
  agentFileReads: Record<string, number>
  lang: Lang
  /** Forces a specific view mode and hides the toggle (for catalog variants). */
  forcedMode?: ViewMode
  /** Hides the agent file reads panel. */
  hideAgentReads?: boolean
}

type ViewMode = 'calls' | 'tokens'


export function ToolMetricsPanel({ toolCounts, toolOutputTokens, agentFileReads, lang, forcedMode, hideAgentReads }: Props) {
  const isMobile = useIsMobile()
  const pt = lang === 'pt'
  const [viewMode, setViewMode] = useState<ViewMode>(forcedMode ?? 'calls')
  const effectiveMode: ViewMode = forcedMode ?? viewMode
  const showToggle = forcedMode === undefined

  const data = effectiveMode === 'calls' ? toolCounts : toolOutputTokens
  const total = Object.values(data).reduce((s, v) => s + v, 0)
  const entries = Object.entries(data)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)

  const max = Math.max(...entries.map(([, v]) => v), 1)

  const agentEntries = Object.entries(agentFileReads)
    .sort((a, b) => b[1] - a[1])
  const totalAgentReads = agentEntries.reduce((s, [, v]) => s + v, 0)

  const hasTokenData = Object.keys(toolOutputTokens).length > 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* View toggle — hidden when forcedMode is set */}
      {showToggle && (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
        <button
          onClick={() => setViewMode('calls')}
          style={{
            padding: '4px 10px',
            borderRadius: 6,
            border: `1px solid ${effectiveMode === 'calls' ? 'var(--accent-green)' : 'var(--border)'}`,
            background: effectiveMode === 'calls' ? 'rgba(34,197,94,0.12)' : 'transparent',
            color: effectiveMode === 'calls' ? 'var(--accent-green)' : 'var(--text-tertiary)',
            cursor: 'pointer',
            fontSize: 11,
            fontWeight: 600,
            fontFamily: 'inherit',
            transition: 'all 0.15s',
          }}
        >
          {t('tools.by_calls', lang)}
        </button>
        {hasTokenData && (
          <button
            onClick={() => setViewMode('tokens')}
            style={{
              padding: '4px 10px',
              borderRadius: 6,
              border: `1px solid ${effectiveMode === 'tokens' ? 'var(--anthropic-orange)' : 'var(--border)'}`,
              background: effectiveMode === 'tokens' ? 'rgba(217,119,6,0.12)' : 'transparent',
              color: effectiveMode === 'tokens' ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
              cursor: 'pointer',
              fontSize: 11,
              fontWeight: 600,
              fontFamily: 'inherit',
              transition: 'all 0.15s',
            }}
          >
            {t('tools.by_tokens', lang)}
          </button>
        )}
        <span style={{ fontSize: 10, color: 'var(--text-tertiary)', marginLeft: 'auto' }}>
          {t('tools.total', lang)}: {fmt(total)}
          {effectiveMode === 'tokens' ? ' tokens' : ` ${t('tools.calls', lang)}`}
        </span>
      </div>
      )}

      {/* Ranked bar chart — 2-column grid */}
      {entries.length === 0 ? (
        <div style={{ color: 'var(--text-tertiary)', fontSize: 13, textAlign: 'center', padding: 16 }}>
          {t('tools.no_data', lang)}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(2, 1fr)', gap: '5px 20px' }}>
          {entries.map(([name, value]) => {
            const pct = value / max
            const shareOfTotal = total > 0 ? value / total : 0
            // Villain classification only applies in token spend mode
            const isVillain = effectiveMode === 'tokens' && shareOfTotal > 0.4 && entries.length > 2

            const barBackground = isVillain
              ? 'linear-gradient(90deg, #ef4444, #f97316)'
              : effectiveMode === 'tokens'
                ? 'rgba(217, 119, 6, 0.25)'
                : 'rgba(74, 222, 128, 0.25)'

            return (
              <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{
                  width: isMobile ? 100 : 90,
                  fontSize: 11,
                  fontWeight: isVillain ? 700 : 500,
                  color: isVillain ? '#ef4444' : 'var(--text-secondary)',
                  textAlign: 'right',
                  whiteSpace: 'normal',
                  overflowWrap: 'anywhere',
                  flexShrink: 0,
                }}>
                  {name}
                </div>
                <div style={{
                  flex: 1,
                  height: 16,
                  background: 'var(--bg-elevated)',
                  borderRadius: 4,
                  overflow: 'hidden',
                  position: 'relative',
                }}>
                  <div style={{
                    width: `${pct * 100}%`,
                    height: '100%',
                    background: barBackground,
                    borderRadius: 4,
                    transition: 'width 0.3s ease',
                  }} />
                </div>
                <div style={{
                  width: 60,
                  fontSize: 10,
                  color: 'var(--text-tertiary)',
                  textAlign: 'right',
                  flexShrink: 0,
                  fontVariantNumeric: 'tabular-nums',
                }}>
                  {fmt(value)}
                  <span style={{ opacity: 0.6, marginLeft: 2 }}>
                    ({Math.round(shareOfTotal * 100)}%)
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* The token mode is an ATTRIBUTION, not a measurement, and the difference matters here more
          than almost anywhere: a "villain" badge is an accusation built on a fair split. */}
      {effectiveMode === 'tokens' && entries.length > 0 && (
        <MetricNote tone="warn">
          {pt
            ? 'Estimativa, não medição: só os tokens de SAÍDA são atribuídos aqui, e um turno que chamou várias ferramentas divide a saída dele em partes iguais entre elas. O que uma ferramenta fez o modelo LER depois — o resultado dela — é cobrado como entrada e cache do turno seguinte, e não aparece nesta barra.'
            : 'An estimate, not a measurement: only OUTPUT tokens are attributed here, and a turn that called several tools splits its output equally between them. What a tool then made the model READ — its result — is billed as the next turn\u2019s input and cache, and does not appear in this bar.'}
        </MetricNote>
      )}

      {/* Agent file reads section */}
      {!hideAgentReads && totalAgentReads > 0 && (
        <div style={{
          marginTop: 8,
          padding: '12px 14px',
          borderRadius: 8,
          background: 'rgba(99,102,241,0.06)',
          border: '1px solid rgba(99,102,241,0.15)',
        }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            marginBottom: 10,
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--text-primary)',
          }}>
            <FileText size={12} style={{ color: '#6366f1' }} />
            {t('tools.agent_file_reads', lang)}
            <span style={{
              fontSize: 10,
              color: '#6366f1',
              background: 'rgba(99,102,241,0.12)',
              padding: '1px 6px',
              borderRadius: 10,
              fontWeight: 700,
              marginLeft: 4,
            }}>
              {totalAgentReads}
            </span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {agentEntries.map(([name, count]) => (
              <div
                key={name}
                style={{
                  padding: '3px 9px',
                  borderRadius: 16,
                  background: 'rgba(99,102,241,0.10)',
                  border: '1px solid rgba(99,102,241,0.20)',
                  fontSize: 11,
                  color: 'var(--text-secondary)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5,
                }}
              >
                {name}
                <span style={{ opacity: 0.6, fontSize: 10, fontWeight: 600 }}>{count}</span>
              </div>
            ))}
          </div>
          {totalAgentReads > 20 && (
            <div style={{
              marginTop: 8,
              fontSize: 10,
              color: 'var(--text-tertiary)',
              lineHeight: 1.5,
            }}>
              <ArrowDownWideNarrow size={10} style={{ verticalAlign: 'middle', marginRight: 3 }} />
              {t('tools.agent_file_tip', lang)}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

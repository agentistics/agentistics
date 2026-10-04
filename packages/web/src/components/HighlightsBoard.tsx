import React, { useState } from 'react'
import { Clock, Download, Upload, MessageSquare, Wrench, FolderOpen } from 'lucide-react'
import type { SessionMeta, Project, SurfaceHarnessId } from '@agentistics/core'
import { fmt, formatProjectName, sessionLabel } from '@agentistics/core'
import { useIsMobile } from '../hooks/useIsMobile'
import { NAtag } from './NAtag'
import { capable } from '../lib/harness'
import { sessionTime } from '../lib/sessionTime'


function fmtDuration(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = Math.round(minutes % 60)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function avg(arr: number[]): number {
  if (arr.length === 0) return 0
  return arr.reduce((a, b) => a + b, 0) / arr.length
}

function multiplier(value: number, mean: number): string | null {
  if (mean === 0 || value === 0) return null
  const x = value / mean
  if (x < 1.5) return null
  return `${x.toFixed(1)}× avg`
}

interface HighlightsBoardProps {
  sessions: SessionMeta[]
  projects: Project[]
  lang: 'pt' | 'en'
  /**
   * The active harness filter (undefined = unified / all-harness view).
   * Individual highlight cards are gated per capability — e.g. the
   * "Most tool calls" card is hidden for harnesses where tools=false.
   * In the unified view (harness undefined) all cards are shown.
   */
  harness?: SurfaceHarnessId
}

export function HighlightsBoard({ sessions, projects, lang, harness }: HighlightsBoardProps) {
  const pt = lang === 'pt'
  const isMobile = useIsMobile()

  if (sessions.length === 0) {
    return (
      <div style={{ color: 'var(--text-tertiary)', fontSize: 13, textAlign: 'center', padding: 24 }}>
        {pt ? 'Sem dados de sessão disponíveis' : 'No session data available'}
      </div>
    )
  }

  // Record finders
  // sessions[0] is guaranteed defined because of the sessions.length === 0 guard above
  const firstSession = sessions[0]!
  // Ranked by ACTIVE time (Σ per-turn), falling back to wall clock only when NO session in the
  // set has an active figure — see lib/sessionTime.ts and docs/harness-contract.md. Ranking by
  // wall clock crowns whichever session merely stayed open longest.
  const anyActive = sessions.some(s => s.active_minutes !== undefined)
  const sessionRank = (s: SessionMeta) =>
    anyActive ? (s.active_minutes ?? -1) : (s.duration_minutes ?? 0)
  const longestSession = sessions.reduce((b, s) => sessionRank(s) > sessionRank(b) ? s : b, firstSession)

  const mostInputTokens = sessions.reduce((b, s) =>
    (s.input_tokens ?? 0) > (b.input_tokens ?? 0) ? s : b, firstSession)

  const mostOutputTokens = sessions.reduce((b, s) =>
    (s.output_tokens ?? 0) > (b.output_tokens ?? 0) ? s : b, firstSession)

  const mostMessages = sessions.reduce((b, s) => {
    const v = (s.user_message_count ?? 0) + (s.assistant_message_count ?? 0)
    const bv = (b.user_message_count ?? 0) + (b.assistant_message_count ?? 0)
    return v > bv ? s : b
  }, firstSession)

  const mostToolCalls = sessions.reduce((b, s) => {
    const v = Object.values(s.tool_counts ?? {}).reduce((a, x) => a + x, 0)
    const bv = Object.values(b.tool_counts ?? {}).reduce((a, x) => a + x, 0)
    return v > bv ? s : b
  }, firstSession)

  const projectSessionCounts: Record<string, number> = {}
  for (const s of sessions) {
    if (s.project_path) projectSessionCounts[s.project_path] = (projectSessionCounts[s.project_path] ?? 0) + 1
  }
  const topProjectEntry = Object.entries(projectSessionCounts).sort((a, b) => b[1] - a[1])[0]

  // Averages for comparison
  // Compared against the same quantity the record is ranked by, so "3.2× the average" is honest.
  const avgDuration = avg(sessions
    .map(s => anyActive ? (s.active_minutes ?? 0) : (s.duration_minutes ?? 0))
    .filter(v => v > 0))
  const avgInput    = avg(sessions.map(s => s.input_tokens ?? 0).filter(v => v > 0))
  const avgOutput   = avg(sessions.map(s => s.output_tokens ?? 0).filter(v => v > 0))
  const avgMessages = avg(sessions.map(s => (s.user_message_count ?? 0) + (s.assistant_message_count ?? 0)).filter(v => v > 0))
  const avgTools    = avg(sessions.map(s => Object.values(s.tool_counts ?? {}).reduce((a, b) => a + b, 0)).filter(v => v > 0))

  function truncate(str: string | undefined, len: number) {
    if (!str) return pt ? 'Sem título' : 'Untitled'
    return str.length > len ? str.slice(0, len) + '…' : str
  }

  return (
    <>
      <style>{`
        .hl-card {
          background: var(--bg-card);
          border: 1px solid var(--border);
          border-radius: var(--radius-lg);
          padding: 20px 22px 18px;
          position: relative;
          overflow: hidden;
          transition: border-color 0.2s, transform 0.2s, box-shadow 0.2s;
          cursor: default;
        }
        .hl-card:hover {
          transform: translateY(-2px);
          box-shadow: 0 8px 32px rgba(0,0,0,0.18);
        }
        .hl-value {
          font-size: 38px;
          font-weight: 800;
          line-height: 1;
          letter-spacing: -0.02em;
          color: var(--text-primary);
        }
        .hl-prompt {
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
          font-size: 12px;
          line-height: 1.5;
          color: var(--text-secondary);
          font-style: italic;
        }
        @media (max-width: 767px) {
          .hl-card { padding: 12px 13px 11px; border-radius: var(--radius-md); }
          .hl-value { font-size: 24px; }
          .hl-prompt { font-size: 11px; }
        }
      `}</style>

      {/* Number of cards: 5 always + 1 conditional (topProjectEntry) */}
      {(() => {
        // When the active harness does not support tools, the tool-calls card is
        // replaced with an N/A placeholder that still occupies the same grid slot
        // so the layout stays consistent.
        const canTools = !harness || capable(harness, 'tools')
        const cardCount = topProjectEntry ? 6 : 5
        const cols = isMobile ? 2 : 3
        // last card's column span: fill leftover columns when not aligned to cols
        const lastSpan = cardCount % cols === 0 ? 1 : cols - (cardCount % cols) + 1
        const lastStyle = lastSpan > 1 ? { gridColumn: `span ${lastSpan}` } : {}

      return (
      <div className="ag-grid cols-3" style={{ gap: isMobile ? 10 : 14 }}>

        <HighlightCard
          label={pt ? 'Sessão mais longa' : 'Longest session'}
          icon={<Clock size={14} />}
          accent="#a855f7"
          value={sessionTime(longestSession, pt ? 'pt' : 'en').active
            ?? sessionTime(longestSession, pt ? 'pt' : 'en').elapsed}
          valueTitle={sessionTime(longestSession, pt ? 'pt' : 'en').tooltip}
          valueSub={sessionTime(longestSession, pt ? 'pt' : 'en').activeLabel}
          detail={(() => {
            const t = sessionTime(longestSession, pt ? 'pt' : 'en')
            // Both quantities NAMED (valueSub says "active", this says "elapsed"); the
            // definitions stay in the value tooltip — spelled out here they wrap and blow up
            // the card's height next to the other highlights.
            return [`${t.elapsed} ${t.elapsedLabel}`]
          })()}
          comparison={multiplier(sessionRank(longestSession), avgDuration)}
          prompt={truncate(sessionLabel(longestSession), 90)}
          project={formatProjectName(longestSession.project_path ?? '')}
        />

        <HighlightCard
          label={pt ? 'Mais tokens de entrada' : 'Most input tokens'}
          icon={<Download size={14} />}
          accent="#3b82f6"
          value={fmt(mostInputTokens.input_tokens ?? 0)}
          comparison={multiplier(mostInputTokens.input_tokens ?? 0, avgInput)}
          prompt={truncate(sessionLabel(mostInputTokens), 90)}
          project={formatProjectName(mostInputTokens.project_path ?? '')}
        />

        <HighlightCard
          label={pt ? 'Mais tokens de saída' : 'Most output tokens'}
          icon={<Upload size={14} />}
          accent="#8b5cf6"
          value={fmt(mostOutputTokens.output_tokens ?? 0)}
          comparison={multiplier(mostOutputTokens.output_tokens ?? 0, avgOutput)}
          prompt={truncate(sessionLabel(mostOutputTokens), 90)}
          project={formatProjectName(mostOutputTokens.project_path ?? '')}
        />

        <HighlightCard
          label={pt ? 'Mais mensagens' : 'Most messages'}
          icon={<MessageSquare size={14} />}
          accent="#e8690b"
          value={fmt((mostMessages.user_message_count ?? 0) + (mostMessages.assistant_message_count ?? 0))}
          comparison={multiplier(
            (mostMessages.user_message_count ?? 0) + (mostMessages.assistant_message_count ?? 0),
            avgMessages
          )}
          prompt={truncate(sessionLabel(mostMessages), 90)}
          project={formatProjectName(mostMessages.project_path ?? '')}
        />

        {/* Tool calls card — gated by tools capability. When capability is false,
            an N/A placeholder occupies the same grid slot so layout is unchanged. */}
        {canTools ? (
          <HighlightCard
            label={pt ? 'Mais chamadas de ferramentas' : 'Most tool calls'}
            icon={<Wrench size={14} />}
            accent="#10b981"
            value={fmt(Object.values(mostToolCalls.tool_counts ?? {}).reduce((a, b) => a + b, 0))}
            comparison={multiplier(
              Object.values(mostToolCalls.tool_counts ?? {}).reduce((a, b) => a + b, 0),
              avgTools
            )}
            prompt={truncate(sessionLabel(mostToolCalls), 90)}
            project={formatProjectName(mostToolCalls.project_path ?? '')}
            style={topProjectEntry ? {} : lastStyle}
          />
        ) : (
          <div
            className="hl-card"
            style={{ borderColor: 'var(--border)', ...(topProjectEntry ? {} : lastStyle) }}
          >
            {harness && <NAtag harness={harness} label={pt ? 'Mais chamadas de ferramentas' : 'Most tool calls'} />}
          </div>
        )}

        {topProjectEntry && (
          <HighlightCard
            label={pt ? 'Projeto mais ativo' : 'Most active project'}
            icon={<FolderOpen size={14} />}
            accent="#06b6d4"
            value={String(topProjectEntry[1])}
            valueSub={pt ? 'sessões' : 'sessions'}
            comparison={topProjectEntry[1] > 1
              ? `${Math.round((topProjectEntry[1] / sessions.length) * 100)}% ${pt ? 'do período' : 'of period'}`
              : null}
            prompt={formatProjectName(topProjectEntry[0])}
            project={`${topProjectEntry[0]}`}
            style={lastStyle}
          />
        )}

      </div>
      )
      })()}
    </>
  )
}

function HighlightCard({
  label, icon, accent, value, valueSub, valueTitle, detail, comparison, prompt, project,
  style: extraStyle,
}: {
  label: string
  icon: React.ReactNode
  accent: string
  value: string
  valueSub?: string
  /** Short lines under the value that name and explain each quantity the card reports. */
  detail?: string[]
  /** Native tooltip on the value — explains a headline that needs a qualifier (e.g. how a
   *  session's active time was measured vs its wall clock). */
  valueTitle?: string
  comparison?: string | null
  prompt?: string
  project?: string
  style?: React.CSSProperties
}) {
  const [hovered, setHovered] = useState(false)
  const isMobile = useIsMobile()
  const gap = isMobile ? 8 : 14

  return (
    <div
      className="hl-card"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ borderColor: hovered ? `${accent}50` : 'var(--border)', ...extraStyle }}
    >
      {/* Ambient glow — top-left radial */}
      <div style={{
        position: 'absolute', inset: 0, pointerEvents: 'none',
        background: `radial-gradient(ellipse at -10% -10%, ${accent}22 0%, transparent 65%)`,
        transition: 'opacity 0.3s',
        opacity: hovered ? 1 : 0.6,
      }} />

      {/* Accent bar — left edge */}
      <div style={{
        position: 'absolute', top: 0, left: 0, bottom: 0, width: 3,
        background: `linear-gradient(180deg, ${accent}, ${accent}00)`,
        borderRadius: '0 0 0 var(--radius-lg)',
      }} />

      {/* Label + icon */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 7,
        marginBottom: gap,
      }}>
        <span style={{
          width: isMobile ? 22 : 26, height: isMobile ? 22 : 26, borderRadius: 7,
          background: `${accent}20`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: accent, flexShrink: 0,
        }}>
          {icon}
        </span>
        <span style={{
          fontSize: 10, fontWeight: 700, color: 'var(--text-tertiary)',
          textTransform: 'uppercase', letterSpacing: '0.08em',
        }}>
          {label}
        </span>
      </div>

      {/* Value */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 4 }} title={valueTitle}>
        <div className="hl-value" style={{ color: hovered ? accent : 'var(--text-primary)', transition: 'color 0.2s', cursor: valueTitle ? 'help' : undefined }}>
          {value}
        </div>
        {valueSub && (
          <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-tertiary)' }}>
            {valueSub}
          </span>
        )}
      </div>

      {/* What each reported quantity means — a number nobody can name is not information. */}
      {detail && detail.length > 0 && (
        <div style={{ marginBottom: 8, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {detail.map((line, i) => (
            <span key={i} style={{ fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.35 }}>
              {line}
            </span>
          ))}
        </div>
      )}

      {/* Comparison badge */}
      {comparison && (
        <div style={{
          display: 'inline-flex', alignItems: 'center',
          fontSize: 11, fontWeight: 600,
          color: accent,
          background: `${accent}18`,
          border: `1px solid ${accent}30`,
          borderRadius: 20,
          padding: '2px 8px',
          marginBottom: gap,
        }}>
          {comparison}
        </div>
      )}
      {!comparison && <div style={{ marginBottom: gap }} />}

      {/* Divider */}
      <div style={{ height: 1, background: 'var(--border)', marginBottom: isMobile ? 8 : 12 }} />

      {/* Prompt */}
      {prompt && (
        <div className="hl-prompt" title={prompt} style={{ marginBottom: project ? 8 : 0 }}>
          "{prompt}"
        </div>
      )}

      {/* Project */}
      {project && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 5,
          fontSize: 11, color: 'var(--text-tertiary)',
          overflow: 'hidden',
        }}>
          <FolderOpen size={10} style={{ flexShrink: 0, color: accent }} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {project}
          </span>
        </div>
      )}
    </div>
  )
}

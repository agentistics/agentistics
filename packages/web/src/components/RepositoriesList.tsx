import React from 'react'
import { useNavigate } from 'react-router-dom'
import { GitBranch, Users, Zap, GitCommit, Clock, Link2Off, EyeOff } from 'lucide-react'
import { fmt, fmtCost, formatProjectName, NO_REPO_KEY, totalTokens, totalTokensExplained } from '@agentistics/core'
import type { RepoStat } from '../hooks/useData'
import { canonicalRepoKey } from '../lib/shareRepos'
import { PLURAL_COPY, interpolate, plural } from './team/copy'
import { withheldMarkStyle } from './team/withheldStyle'
import { planCostOf } from '../lib/topUsage'

interface Props {
  repos: RepoStat[]
  isCentral?: boolean
  currency?: 'USD' | 'BRL'
  brlRate?: number
  lang: 'pt' | 'en'
  onOpen: (repo: RepoStat) => void
  /** Task 13 — canonical repo key (or `NO_REPO_KEY`) -> labels of the connections hiding it.
   *  Absent/empty means nothing is hidden from anywhere. */
  deniedRepoLabels?: Map<string, string[]>
  planFactors?: Readonly<Record<string, number | null>> | null
}

/** The `EyeOff` badge: "Hidden from N central(s)" plus the names on a second line. Clicking it
 *  (without also opening the repo card underneath) goes to the Settings page that owns the rule. */
function HiddenBadge({ labels, lang }: { labels: string[]; lang: 'pt' | 'en' }) {
  const navigate = useNavigate()
  return (
    <div
      role="button"
      tabIndex={0}
      title={labels.join(', ')}
      onClick={e => { e.stopPropagation(); navigate('/settings/connection') }}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); navigate('/settings/connection') }
      }}
      style={{
        display: 'flex', flexDirection: 'column', gap: 1, padding: '4px 8px', borderRadius: 7,
        background: withheldMarkStyle().background,
        cursor: 'pointer', minWidth: 0,
      }}
    >
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 700,
        color: withheldMarkStyle().color,
      }}>
        <EyeOff size={11} />
        {interpolate(plural(PLURAL_COPY.hiddenFromN[lang], labels.length), { n: labels.length })}
      </span>
      <span style={{
        fontSize: 9.5, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {labels.join(', ')}
      </span>
    </div>
  )
}

/** Colour a host chip by its provider so github / gitlab / bitbucket read at a glance. */
function hostColor(host: string): string {
  if (host.includes('github')) return '#8b95a5'
  if (host.includes('gitlab')) return '#fc6d26'
  if (host.includes('bitbucket')) return '#2684ff'
  return 'var(--text-tertiary)'
}

function relativeTime(iso: string, lang: 'pt' | 'en'): string {
  if (!iso) return '—'
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return '—'
  const diffMs = Date.now() - then
  const day = 86_400_000
  const days = Math.floor(diffMs / day)
  if (days <= 0) return lang === 'pt' ? 'hoje' : 'today'
  if (days === 1) return lang === 'pt' ? 'ontem' : 'yesterday'
  if (days < 30) return lang === 'pt' ? `há ${days}d` : `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return lang === 'pt' ? `há ${months}mes` : `${months}mo ago`
  return lang === 'pt' ? `há ${Math.floor(months / 12)}a` : `${Math.floor(months / 12)}y ago`
}

/** Tiny inline SVG sparkline of activity-by-day, no external deps. */
function Sparkline({ byDay, color }: { byDay: Record<string, number>; color: string }) {
  const days = Object.keys(byDay).sort()
  if (days.length < 2) return <div style={{ height: 22 }} />
  const vals = days.map(d => byDay[d] ?? 0)
  const max = Math.max(...vals, 1)
  const W = 100, H = 22
  const step = W / (vals.length - 1)
  const pts = vals.map((v, i) => `${(i * step).toFixed(1)},${(H - (v / max) * (H - 2) - 1).toFixed(1)}`).join(' ')
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', height: 22, display: 'block' }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" opacity={0.85} />
    </svg>
  )
}

function Metric({ label, value, title }: { label: string; value: React.ReactNode; title?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }} title={title}>
      <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</span>
      <span style={{ fontSize: 9.5, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</span>
    </div>
  )
}

/** Provider brand mark (inline SVG — lucide-react no longer ships brand icons).
 *  Falls back to GitBranch for unknown hosts and Link2Off for unlinked repos. */
function ProviderLogo({ host, linked, size = 15, color }: { host: string; linked: boolean; size?: number; color?: string }) {
  const style: React.CSSProperties = { flexShrink: 0, color }
  if (!linked) return <Link2Off size={size} color={color} style={{ flexShrink: 0 }} />
  if (host.includes('github')) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" style={style} aria-label="GitHub">
        <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222 0 1.606-.014 2.898-.014 3.293 0 .322.216.694.825.576C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
      </svg>
    )
  }
  if (host.includes('gitlab')) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" style={style} aria-label="GitLab">
        <path d="m23.6004 9.5927-.0337-.0862L20.3.9814a.851.851 0 0 0-.3362-.405.8748.8748 0 0 0-.9997.0539.8748.8748 0 0 0-.29.4399l-2.2055 6.748H7.5375l-2.2057-6.748a.8573.8573 0 0 0-.29-.4412.8748.8748 0 0 0-.9997-.0537.8585.8585 0 0 0-.3362.4049L.4332 9.5015l-.0325.0862a6.0657 6.0657 0 0 0 2.0119 7.0105l.0113.0087.03.0213 4.976 3.7264 2.462 1.8633 1.4995 1.1321a1.0085 1.0085 0 0 0 1.2197 0l1.4995-1.1321 2.462-1.8633 5.006-3.7489.0125-.01a6.0682 6.0682 0 0 0 2.0094-7.003z" />
      </svg>
    )
  }
  if (host.includes('bitbucket')) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" style={style} aria-label="Bitbucket">
        <path d="M.778 1.213a.768.768 0 0 0-.768.892l3.263 19.81c.084.5.515.868 1.022.873H19.95a.772.772 0 0 0 .77-.646l3.27-20.03a.768.768 0 0 0-.768-.891zM14.52 15.53H9.522L8.17 8.466h7.561z" />
      </svg>
    )
  }
  return <GitBranch size={size} color={color} style={{ flexShrink: 0 }} />
}

export function RepositoriesList({ repos, isCentral, currency = 'USD', brlRate = 1, lang, onOpen, deniedRepoLabels, planFactors = null }: Props) {
  const pt = lang === 'pt'
  if (repos.length === 0) {
    return (
      <div style={{ color: 'var(--text-tertiary)', fontSize: 13, textAlign: 'center', padding: 32 }}>
        {pt ? 'Nenhum repositório no período/filtros selecionados.' : 'No repositories for the selected period/filters.'}
      </div>
    )
  }
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
      {repos.map(r => {
        const host = r.linked ? r.remote.split('/')[0]! : ''
        const title = r.name || (pt ? 'Sem repositório' : 'No repository')
        const subtitle = r.path ? formatProjectName(r.path) : ''
        const accent = r.linked ? 'var(--anthropic-orange)' : 'var(--text-tertiary)'
        // Keyed by the CANONICAL repo key, the same one the denylist and the picker use — keying
        // by the raw (already-normalized) remote would silently miss a rule stored under a
        // differently-cased or SSH-aliased spelling of the same repository.
        const hiddenKey = r.linked ? canonicalRepoKey(r.remote) : NO_REPO_KEY
        const hiddenLabels = deniedRepoLabels?.get(hiddenKey)
        return (
          <div
            key={r.id}
            onClick={() => onOpen(r)}
            role="button"
            tabIndex={0}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(r) } }}
            style={{
              display: 'flex', flexDirection: 'column', gap: 10,
              padding: '14px 15px',
              background: 'var(--bg-card)',
              borderRadius: 'var(--radius-lg)',
              border: r.linked ? '1px solid var(--border)' : '1px dashed var(--border)',
              cursor: 'pointer', transition: 'border-color 0.15s, transform 0.1s',
              minWidth: 0,
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.borderColor = accent + '80' }}
            onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.borderColor = r.linked ? 'var(--border)' : 'var(--border)' }}
          >
            {/* Header: icon + title + host chip, with a full-path subtitle for every card */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <ProviderLogo host={host} linked={r.linked} size={16} color={accent} />
                <span title={r.linked ? r.remote : r.path} style={{
                  fontSize: 13.5, fontWeight: 700, color: 'var(--text-primary)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
                }}>{title}</span>
                {host && (
                  <span style={{
                    marginLeft: 'auto', flexShrink: 0, fontSize: 9.5, fontWeight: 500,
                    color: hostColor(host), background: 'var(--bg-elevated)',
                    padding: '2px 6px', borderRadius: 5, whiteSpace: 'nowrap', opacity: 0.9,
                  }}>{host}</span>
                )}
              </div>
              {/* The path is a machine-local detail — meaningless on the central, where a repo is
                  keyed by its remote and the title already shows org/repo. Hide it there. */}
              {subtitle && !isCentral && (
                <span title={r.path} style={{
                  fontSize: 10.5, color: 'var(--text-tertiary)', paddingLeft: 23,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
                }}>{subtitle}</span>
              )}
            </div>

            {hiddenLabels && hiddenLabels.length > 0 && (
              <HiddenBadge labels={hiddenLabels} lang={lang} />
            )}

            {/* Sparkline */}
            <Sparkline byDay={r.activityByDay} color={accent} />

            {/* Primary metrics */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
              <Metric label={pt ? 'sessões' : 'sessions'} value={r.sessions} />
              <Metric label={pt ? 'custo' : 'cost'} value={fmtCost(planFactors ? planCostOf(r.costByHarness, planFactors) : r.costUSD, currency, brlRate)} />
              <Metric
                label="tokens"
                value={fmt(totalTokens(r.tokens))}
                title={totalTokensExplained(r.tokens, pt ? 'pt' : 'en')}
              />
            </div>

            {/* Footer chips: commits, members (central), actions, last active */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 11, color: 'var(--text-tertiary)' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }} title={pt ? 'commits' : 'commits'}>
                <GitCommit size={11} /> {r.gitCommits}
              </span>
              {isCentral && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }} title={pt ? 'membros' : 'members'}>
                  <Users size={11} /> {r.members.length}
                </span>
              )}
              {r.ciSessions > 0 && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--accent-blue)' }} title="GitHub Actions">
                  <Zap size={11} /> {r.ciSessions}
                </span>
              )}
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, marginLeft: 'auto' }}>
                <Clock size={11} /> {relativeTime(r.lastActive, lang)}
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

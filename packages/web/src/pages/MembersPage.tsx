import React, { useMemo, useState } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell as BarCell,
} from 'recharts'
import { useOutletContext } from 'react-router-dom'
import { Users, Search, Monitor, User as UserIcon, GitBranch, FolderOpen, Cpu, Terminal } from 'lucide-react'
import type { AppContext } from '../lib/app-context'
import { fmt, fmtCost, formatModel, repoShortName, type SurfaceHarnessId } from '@agentistics/core'
import { aggregateMemberMetrics, withStatsCacheTotals, presenceFilterCaches, LOCAL_KEY, type MemberGroupBy, type MemberMetrics } from '../lib/member-metrics'
import { cacheTotalsUsable } from '../lib/topUsage'
import { MetricNote } from '../components/MetricNote'
import { HARNESS_LABELS, HARNESS_COLORS } from '../lib/harness'
import { Section } from '../components/Section'
import { SortControl } from '../components/SortControl'
import { useIsMobile } from '../hooks/useIsMobile'

type MemberSortKey = 'cost' | 'sessions' | 'tokens' | 'lastActive' | 'name'

/**
 * B7 — per-member / per-machine metrics.
 *
 * A pure client of `/api/data` (`derived.filteredSessions`): the central already scopes that
 * payload to the signed-in principal, so a team-scoped user only ever sees their own members —
 * this page adds no endpoint and bypasses no scoping.
 */
export default function MembersPage() {
  const ctx = useOutletContext<AppContext>()
  const { derived, currency, brlRate, lang, machines, data, filters, me } = ctx
  const pt = lang === 'pt'
  const isMobile = useIsMobile()

  const [groupBy, setGroupBy] = useState<MemberGroupBy>('machine')
  const [query, setQuery] = useState('')
  const [sortKey, setSortKey] = useState<MemberSortKey>('cost')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  // Totals come from the per-member/-machine statsCaches, not from the sessions: the caches are the
  // history, the session documents only the part Claude Code has not pruned. Summing sessions made
  // this page report a person at R$58.7k against the dashboard's R$93.6k — and the dashboard was
  // right. Under a filter the caches cannot represent, `undefined` keeps the per-session sum.
  //
  // The zero-row filter runs AFTER that substitution, never before: a member whose visible sessions
  // are all gone still has real history in the cache, and filtering first would delete them.
  const rows = useMemo(() => {
    const base = aggregateMemberMetrics(derived.filteredSessions, groupBy)
    const rawCaches = groupBy === 'machine' ? data?.machineStatsCaches : data?.userStatsCaches
    // Scope the caches to the SAME presence the header total is built from — otherwise a
    // machine/member the header excludes by the central's "online only" default kept showing
    // its full, all-time history here, dwarfing the header's own number with nothing on screen
    // explaining either one. See `presenceFilterCaches`.
    const caches = presenceFilterCaches(rawCaches, groupBy, derived.presenceScope.allowedUsers, data?.machineOwners)
    return withStatsCacheTotals(
      base,
      derived.filteredSessions,
      groupBy,
      cacheTotalsUsable(filters) ? caches : undefined,
    ).filter(r => r.sessions > 0 || r.totalTokens > 0 || r.costUSD > 0)
  }, [derived.filteredSessions, derived.presenceScope, groupBy, data?.machineStatsCaches, data?.userStatsCaches, data?.machineOwners, filters])

  /** The signed-in principal, matched the way the rest of the app keys a member: by display name
   *  (the token doc `user`, which follows the owner account's name). Undefined off a central. */
  const myName = (me?.name ?? '').trim()
  const isMe = (r: MemberMetrics): boolean =>
    myName !== '' && (r.user.trim() === myName || (groupBy === 'user' && r.key.trim() === myName))

  /** memberId → machine display name (the central names machines on the minted token). */
  const machineName = useMemo(() => {
    const m: Record<string, string> = {}
    for (const mc of machines) m[mc.id] = mc.name
    return m
  }, [machines])

  const titleOf = (r: MemberMetrics): string => {
    if (groupBy === 'machine') {
      if (r.key === LOCAL_KEY) return pt ? 'Esta máquina' : 'This machine'
      return machineName[r.key] || r.user || `${r.key.slice(0, 10)}…`
    }
    return r.key === LOCAL_KEY ? (pt ? 'Local' : 'Local') : r.key
  }

  const subtitleOf = (r: MemberMetrics): string => {
    if (groupBy === 'machine') return r.user || (pt ? 'sem usuário' : 'no user')
    const n = r.machineCount
    if (n === 0) return pt ? 'sem máquina' : 'no machine'
    return pt ? `${n} máquina${n === 1 ? '' : 's'}` : `${n} machine${n === 1 ? '' : 's'}`
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return rows
    return rows.filter(r => `${titleOf(r)} ${r.user} ${r.topProject?.key ?? ''} ${r.topModel?.key ?? ''}`.toLowerCase().includes(q))
    // `titleOf` is re-created every render; its real inputs (machineName/groupBy/pt) are the deps.
  }, [rows, query, machineName, groupBy, pt])

  const sorted = useMemo(() => {
    const val = (r: MemberMetrics): number | string => {
      switch (sortKey) {
        case 'cost': return r.costUSD
        case 'sessions': return r.sessions
        case 'tokens': return r.totalTokens
        case 'lastActive': return r.lastActivity ? Date.parse(r.lastActivity) || 0 : 0
        case 'name': return titleOf(r).toLowerCase()
      }
    }
    const s = [...filtered].sort((a, b) => {
      const va = val(a), vb = val(b)
      if (typeof va === 'string' && typeof vb === 'string') return va.localeCompare(vb)
      return (va as number) - (vb as number)
    })
    return sortDir === 'desc' ? s.reverse() : s
    // Same as above: the 'name' sort reads `titleOf`, whose inputs are machineName/groupBy/pt.
  }, [filtered, sortKey, sortDir, machineName, groupBy, pt])

  // Comparative chart: the top rows by the chosen metric, always ranked by THAT metric (independent
  // of the list's sort, which the reader may have set to something else like name or last activity).
  const [chartMetric, setChartMetric] = useState<'costUSD' | 'sessions' | 'totalTokens'>('costUSD')
  const chartData = useMemo(() => {
    return [...filtered]
      // A zero-length bar carries no comparison and still costs a labelled row — e.g. ranking by
      // tokens on a harness that reports none. The count of what was dropped is shown below.
      .filter(r => r[chartMetric] > 0)
      .sort((a, b) => b[chartMetric] - a[chartMetric])
      .slice(0, 12) // beyond a dozen bars the labels stop being readable
      .map(r => ({
        name: titleOf(r) + (isMe(r) ? (pt ? ' (você)' : ' (you)') : ''),
        value: r[chartMetric],
        harness: r.topHarness?.key ?? null,
        me: isMe(r),
        color: r.topHarness ? (HARNESS_COLORS[r.topHarness.key] ?? 'var(--anthropic-orange)') : 'var(--text-tertiary)',
      }))
      .reverse() // recharts draws a vertical layout bottom-up; reversing puts the biggest on top
  }, [filtered, chartMetric, machineName, groupBy, pt, myName])

  /** Rows the chart left out because they have none of the selected metric. Stated rather than
   *  silently dropped — a hidden row is exactly the kind of omission that reads as "nobody else". */
  const chartHidden = useMemo(
    () => filtered.filter(r => r[chartMetric] <= 0).length,
    [filtered, chartMetric],
  )

  /** Legend entries: only the harnesses actually painted in the chart, in the order they rank.
   *  The bars are coloured by dominant harness — without this the colour is an unexplained code. */
  const chartLegend = useMemo(() => {
    const seen = new Map<SurfaceHarnessId, number>()
    for (const d of chartData) if (d.harness) seen.set(d.harness, (seen.get(d.harness) ?? 0) + 1)
    return [...seen.entries()]
      .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
      .map(([id, count]) => ({ id, count, color: HARNESS_COLORS[id] ?? 'var(--text-tertiary)' }))
  }, [chartData])

  const sortOptions: { key: MemberSortKey; label: string }[] = [
    { key: 'cost', label: pt ? 'Custo' : 'Cost' },
    { key: 'sessions', label: pt ? 'Sessões' : 'Sessions' },
    { key: 'tokens', label: 'Tokens' },
    { key: 'lastActive', label: pt ? 'Última atividade' : 'Last active' },
    { key: 'name', label: pt ? 'Nome' : 'Name' },
  ]

  const totalCost = rows.reduce((a, r) => a + r.costUSD, 0)
  const totalSessions = rows.reduce((a, r) => a + r.sessions, 0)
  const totalTokens = rows.reduce((a, r) => a + r.totalTokens, 0)
  const maxCost = Math.max(...rows.map(r => r.costUSD), 1e-9)

  const fmtDate = (iso: string | null): string => {
    if (!iso) return '—'
    const t = Date.parse(iso)
    if (!Number.isFinite(t)) return '—'
    return new Date(t).toLocaleDateString(pt ? 'pt-BR' : 'en-US', { day: '2-digit', month: 'short', year: '2-digit' })
  }

  const toggleBtn = (active: boolean): React.CSSProperties => ({
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5,
    minHeight: 44, padding: '0 12px', flex: isMobile ? 1 : undefined,
    fontSize: 12, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', borderRadius: 8,
    border: active ? '1px solid rgba(217,119,6,0.5)' : '1px solid var(--border)',
    background: active ? 'var(--anthropic-orange-dim)' : 'var(--bg-elevated)',
    color: active ? 'var(--anthropic-orange)' : 'var(--text-secondary)',
  })

  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>
          <span style={{ color: 'var(--anthropic-orange)' }}><Users size={16} /></span>
          {pt ? 'Membros' : 'Members'}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
          {pt
            ? 'Perfil de uso por membro e por máquina: onde mais trabalhou (repositório ou pasta, o que tiver mais sessões), modelo e harness mais usados, além de sessões, tokens e custo. Respeita os filtros ativos.'
            : 'Usage profile per member and per machine: where they worked the most (repository or folder, whichever has more sessions), most used model and harness, plus sessions, tokens and cost. Honors active filters.'}
        </div>
      </div>

      {/* Totals — same KPI grid utility used across the app */}
      <div className="ag-grid cols-4">
        <Kpi label={groupBy === 'machine' ? (pt ? 'Máquinas' : 'Machines') : (pt ? 'Membros' : 'Members')} value={String(rows.length)} />
        <Kpi label={pt ? 'Sessões' : 'Sessions'} value={fmt(totalSessions)} />
        <Kpi label="Tokens" value={fmt(totalTokens)} />
        <Kpi label={pt ? 'Custo' : 'Cost'} value={fmtCost(totalCost, currency, brlRate)} accent />
      </div>
      <MetricNote>{pt ? 'Tokens somam os quatro contadores cobrados: entrada nova, saída, leitura e escrita de cache. A leitura de cache é a maior fatia do volume na maioria das máquinas — é a conversa relida a cada turno, a cerca de 1/10 do preço da entrada nova.' : 'Tokens add all four billed counters: fresh input, output, cache read and cache write. Cache read is the largest share of the volume on most machines — the conversation re-read every turn, at roughly 1/10 the price of fresh input.'}</MetricNote>

      {/* Comparative charts. The cards below rank one row at a time; a chart is what makes the
          SPREAD visible — who is an outlier and by how much. The metric is switchable because
          "most expensive" and "most active" are different questions and often different people. */}
      {sorted.length > 1 && (
        <div style={{
          background: 'var(--bg-card)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)', padding: 16, marginBottom: 16, minWidth: 0,
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            gap: 10, flexWrap: 'wrap', marginBottom: 12,
          }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
              {pt ? 'Comparativo' : 'Comparison'}
            </span>
            <div style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 7, overflow: 'hidden' }}>
              {(['costUSD', 'sessions', 'totalTokens'] as const).map((m, i) => {
                const active = chartMetric === m
                const label = m === 'costUSD' ? (pt ? 'Custo' : 'Cost')
                  : m === 'sessions' ? (pt ? 'Sessões' : 'Sessions') : 'Tokens'
                return (
                  <button
                    key={m}
                    onClick={() => setChartMetric(m)}
                    style={{
                      padding: '0 12px', minHeight: 36, fontSize: 12,
                      fontWeight: active ? 700 : 500, fontFamily: 'inherit',
                      background: active ? 'var(--anthropic-orange-dim)' : 'transparent',
                      color: active ? 'var(--anthropic-orange)' : 'var(--text-secondary)',
                      border: 'none', borderLeft: i === 0 ? 'none' : '1px solid var(--border)',
                      cursor: active ? 'default' : 'pointer',
                    }}
                  >{label}</button>
                )
              })}
            </div>
          </div>
          {/* Horizontal bars: names are long and read far better along the Y axis than rotated
              under a vertical chart. Height grows with the row count so labels never collide. */}
          <div style={{ width: '100%', height: Math.max(140, Math.min(chartData.length, 12) * 34 + 30) }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} layout="vertical" margin={{ top: 0, right: 16, bottom: 0, left: 0 }}>
                <CartesianGrid horizontal={false} stroke="var(--border-subtle)" />
                <XAxis
                  type="number"
                  tick={{ fontSize: 10, fill: 'var(--text-tertiary)' }}
                  tickFormatter={(v: number) => (chartMetric === 'costUSD' ? fmtCost(v, currency, brlRate) : fmt(v))}
                  stroke="var(--border)"
                />
                <YAxis
                  type="category"
                  dataKey="name"
                  width={isMobile ? 92 : 150}
                  tick={{ fontSize: 11, fill: 'var(--text-secondary)' }}
                  stroke="var(--border)"
                />
                <Tooltip
                  cursor={{ fill: 'var(--bg-elevated)' }}
                  contentStyle={{
                    background: 'var(--bg-card)', border: '1px solid var(--border)',
                    borderRadius: 8, fontSize: 12,
                  }}
                  // recharts defaults the label and item text to near-black, which is invisible on
                  // this dark card — contentStyle only covers the container, never the text inside.
                  labelStyle={{ color: 'var(--text-primary)', fontWeight: 600, marginBottom: 2 }}
                  itemStyle={{ color: 'var(--text-secondary)' }}
                  formatter={(v) => {
                    const n = typeof v === 'number' ? v : Number(v ?? 0)
                    return [
                      chartMetric === 'costUSD' ? fmtCost(n, currency, brlRate) : fmt(n),
                      chartMetric === 'costUSD' ? (pt ? 'Custo' : 'Cost')
                        : chartMetric === 'sessions' ? (pt ? 'Sessões' : 'Sessions') : 'Tokens',
                    ] as [string, string]
                  }}
                />
                <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                  {/* Coloured by the row's dominant harness, so the chart also shows WHICH tool
                      each person leans on without a second chart. The signed-in row is outlined
                      instead of recoloured — the fill already means "harness", and one channel
                      cannot carry two meanings. */}
                  {chartData.map(d => (
                    <BarCell
                      key={d.name}
                      fill={d.color}
                      stroke={d.me ? 'var(--text-primary)' : undefined}
                      strokeWidth={d.me ? 1.5 : undefined}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Colour legend. The bar colour is the row's most used harness — without this it looks
              like an arbitrary palette, and "why is only one person blue?" has no answer on screen.
              Colour is never the only cue: the harness is also named in every card. */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
            marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border-subtle)',
            fontSize: 11, color: 'var(--text-tertiary)',
          }}>
            <span>{pt ? 'Cor = harness mais usado:' : 'Colour = most used harness:'}</span>
            {chartLegend.map(l => (
              <span key={l.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 9, height: 9, borderRadius: 2, background: l.color, flexShrink: 0 }} />
                <span style={{ color: 'var(--text-secondary)' }}>{HARNESS_LABELS[l.id] ?? l.id}</span>
                <span>({l.count})</span>
              </span>
            ))}
            {myName && chartData.some(d => d.me) && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <span style={{
                  width: 9, height: 9, borderRadius: 2, background: 'transparent',
                  border: '1.5px solid var(--text-primary)', flexShrink: 0,
                }} />
                <span style={{ color: 'var(--text-secondary)' }}>{pt ? 'você' : 'you'}</span>
              </span>
            )}
            {chartHidden > 0 && (
              <span style={{ marginLeft: 'auto' }}>
                {pt
                  ? `+${chartHidden} sem ${chartMetric === 'costUSD' ? 'custo' : chartMetric === 'sessions' ? 'sessões' : 'tokens'} no período`
                  : `+${chartHidden} with no ${chartMetric === 'costUSD' ? 'cost' : chartMetric === 'sessions' ? 'sessions' : 'tokens'} in range`}
              </span>
            )}
          </div>
        </div>
      )}

      <Section
        flashId="members"
        title={<><Users size={14} /> {groupBy === 'machine'
          ? (pt ? `${sorted.length} máquina${sorted.length === 1 ? '' : 's'}` : `${sorted.length} machine${sorted.length === 1 ? '' : 's'}`)
          : (pt ? `${sorted.length} membro${sorted.length === 1 ? '' : 's'}` : `${sorted.length} member${sorted.length === 1 ? '' : 's'}`)}</>}
        action={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {rows.length > 1 && (
              <SortControl lang={lang} options={sortOptions} sortKey={sortKey} dir={sortDir}
                onKey={setSortKey} onDir={() => setSortDir(d => (d === 'desc' ? 'asc' : 'desc'))} />
            )}
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
              <Search size={13} color="var(--text-tertiary)" style={{ position: 'absolute', left: 8, pointerEvents: 'none' }} />
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder={pt ? 'Buscar…' : 'Search…'}
                style={{
                  fontSize: 12, fontFamily: 'inherit', color: 'var(--text-primary)',
                  background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 7,
                  padding: '5px 8px 5px 26px', width: isMobile ? 120 : 140, outline: 'none', minHeight: 34,
                }}
              />
            </div>
          </div>
        }
      >
        {/* Grouping toggle — one row per machine, or machines folded into their owner */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          <button onClick={() => setGroupBy('machine')} style={toggleBtn(groupBy === 'machine')}>
            <Monitor size={13} /> {pt ? 'Por máquina' : 'By machine'}
          </button>
          <button onClick={() => setGroupBy('user')} style={toggleBtn(groupBy === 'user')}>
            <UserIcon size={13} /> {pt ? 'Por membro' : 'By member'}
          </button>
        </div>

        {sorted.length === 0 ? (
          <div style={{ color: 'var(--text-tertiary)', fontSize: 13, padding: 24, textAlign: 'center', lineHeight: 1.6 }}>
            {pt
              ? 'Nenhuma sessão para os filtros atuais. Conecte máquinas à central (agentop member connect) para ver métricas por membro.'
              : 'No sessions for the current filters. Connect machines to the central (agentop member connect) to see per-member metrics.'}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {sorted.map((r, i) => (
              <MemberCard
                key={r.key}
                rank={i + 1}
                row={r}
                me={isMe(r)}
                showMachines={groupBy === 'user'}
                machineName={machineName}
                title={titleOf(r)}
                subtitle={subtitleOf(r)}
                share={maxCost > 0 ? (r.costUSD / maxCost) * 100 : 0}
                pt={pt}
                isMobile={isMobile}
                currency={currency}
                brlRate={brlRate}
                fmtDate={fmtDate}
              />
            ))}
          </div>
        )}
      </Section>
    </>
  )
}

function Kpi({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div style={{
      background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)',
      padding: '14px 16px', minWidth: 0, boxSizing: 'border-box',
    }}>
      <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>{label}</div>
      <div style={{
        marginTop: 6, fontSize: 19, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        color: accent ? 'var(--anthropic-orange)' : 'var(--text-primary)',
      }}>{value}</div>
    </div>
  )
}

function MemberCard({ rank, row, me, showMachines, machineName, title, subtitle, share, pt, isMobile, currency, brlRate, fmtDate }: {
  rank: number
  row: MemberMetrics
  /** The signed-in principal's own row. */
  me: boolean
  /** Only the by-member grouping needs the fleet breakdown — a machine row IS one machine. */
  showMachines: boolean
  machineName: Record<string, string>
  title: string
  subtitle: string
  share: number
  pt: boolean
  isMobile: boolean
  currency: 'USD' | 'BRL'
  brlRate: number
  fmtDate: (iso: string | null) => string
}) {
  const harness = row.topHarness?.key
  const harnessColor = harness ? (HARNESS_COLORS[harness as SurfaceHarnessId] ?? 'var(--text-tertiary)') : 'var(--text-tertiary)'
  const projectLabel = row.topProject
    ? (row.topProject.kind === 'repo' ? repoShortName(row.topProject.key) : shortPath(row.topProject.key))
    : '—'

  return (
    <div style={{
      background: 'var(--bg-elevated)', borderRadius: 10,
      // The signed-in row gets a ring, not a different fill colour: fills are the harness code.
      border: me ? '1px solid var(--anthropic-orange)' : '1px solid var(--border-subtle)',
      padding: isMobile ? '11px 12px' : '12px 14px', minWidth: 0,
    }}>
      {/* Identity row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        <span style={{ fontSize: 12, fontWeight: 800, color: rank === 1 ? 'var(--anthropic-orange)' : 'var(--text-tertiary)', width: 22, flexShrink: 0 }}>#{rank}</span>
        <span style={{
          width: 30, height: 30, borderRadius: '50%', background: 'var(--bg-card)',
          border: me ? '1px solid var(--anthropic-orange)' : '1px solid var(--border)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700,
          color: me ? 'var(--anthropic-orange)' : 'var(--text-secondary)', textTransform: 'uppercase', flexShrink: 0,
        }}>{title.slice(0, 2)}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            <span style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
            {me && (
              <span style={{
                flexShrink: 0, fontSize: 9.5, fontWeight: 700, letterSpacing: '0.04em',
                textTransform: 'uppercase', padding: '1px 6px', borderRadius: 999,
                background: 'var(--anthropic-orange-dim)', color: 'var(--anthropic-orange)',
              }}>{pt ? 'você' : 'you'}</span>
            )}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{subtitle}</div>
        </div>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--anthropic-orange)', flexShrink: 0, textAlign: 'right' }}>
          {fmtCost(row.costUSD, currency, brlRate)}
        </span>
      </div>

      {/* Cost share bar */}
      <div style={{ height: 4, background: 'var(--bg-card)', borderRadius: 2, overflow: 'hidden', margin: '8px 0 10px' }}>
        <div style={{ height: '100%', width: `${Math.min(100, share)}%`, background: 'var(--anthropic-orange)', borderRadius: 2 }} />
      </div>

      {/* Profile — the "what do they actually use" half */}
      <div className="ag-grid cols-3" style={{ gap: 8, marginBottom: 8 }}>
        <Fact
          icon={row.topProject?.kind === 'repo' ? <GitBranch size={11} /> : <FolderOpen size={11} />}
          label={row.topProject
            ? (row.topProject.kind === 'repo' ? (pt ? 'Repositório principal' : 'Top repository') : (pt ? 'Pasta principal' : 'Top folder'))
            : (pt ? 'Projeto principal' : 'Top project')}
          value={projectLabel}
          hint={row.topProject ? `${row.topProject.sessions} ${pt ? 'sessões' : 'sessions'}` : undefined}
          title={row.topProject?.key}
        />
        <Fact
          icon={<Cpu size={11} />}
          label={pt ? 'Modelo mais usado' : 'Most used model'}
          value={row.topModel ? formatModel(row.topModel.key) : (pt ? 'Sem dado' : 'No data')}
          hint={row.topModel ? `${row.topModel.sessions} ${pt ? 'sessões' : 'sessions'}` : undefined}
          title={row.topModel?.key}
          muted={!row.topModel}
        />
        <Fact
          icon={<Terminal size={11} />}
          label={pt ? 'Harness mais usado' : 'Most used harness'}
          value={harness ? (HARNESS_LABELS[harness as SurfaceHarnessId] ?? harness) : (pt ? 'Sem dado' : 'No data')}
          hint={row.topHarness ? `${row.topHarness.sessions} ${pt ? 'sessões' : 'sessions'}` : undefined}
          color={harness ? harnessColor : undefined}
          muted={!harness}
        />
      </div>

      {/* Volume — the obvious counters */}
      <div className="ag-grid cols-5" style={{ gap: 8 }}>
        <Fact label={pt ? 'Sessões' : 'Sessions'} value={fmt(row.sessions)} />
        <Fact label="Tokens" value={fmt(row.totalTokens)} hint={`${fmt(row.inputTokens)} in · ${fmt(row.outputTokens)} out`} />
        <Fact label="Cache" value={fmt(row.cacheReadTokens + row.cacheWriteTokens)} hint={`${fmt(row.cacheReadTokens)} r · ${fmt(row.cacheWriteTokens)} w`} />
        <Fact label={pt ? 'Primeira' : 'First'} value={fmtDate(row.firstActivity)} />
        <Fact label={pt ? 'Última' : 'Last'} value={fmtDate(row.lastActivity)} />
      </div>

      {/* Fleet — WHERE this member's work happened. A member row folds several machines together,
          and until now the card said "3 máquinas" without ever naming one. The first chip is the
          machine that spent the most, so the heavy one is identifiable at a glance.

          The chips are built from the VISIBLE sessions, while the row's headline totals come from
          the statsCaches (the full history — the session documents are only the part Claude Code
          has not pruned). So the chips can add up to LESS than the row, and the header says so
          rather than leaving the reader to notice the arithmetic does not close. */}
      {showMachines && row.machines.length > 0 && (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border-subtle)' }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 4, marginBottom: 6,
            fontSize: 10, fontWeight: 600, letterSpacing: '0.03em', textTransform: 'uppercase',
            color: 'var(--text-tertiary)',
          }}>
            <Monitor size={11} />
            {pt
              ? `${row.machineCount} máquina${row.machineCount === 1 ? '' : 's'}`
              : `${row.machineCount} machine${row.machineCount === 1 ? '' : 's'}`}
            {row.totalsFromCache && (
              <span
                title={pt
                  ? 'O total do card vem do histórico completo da máquina; estes valores por máquina somam apenas as sessões visíveis no período/filtro, então podem somar menos.'
                  : "The card's total comes from the full machine history; these per-machine figures sum only the sessions visible under the current period/filter, so they can add up to less."}
                style={{ fontWeight: 500, textTransform: 'none', letterSpacing: 0, cursor: 'help', color: 'var(--text-tertiary)' }}
              >
                · {pt ? 'das sessões visíveis' : 'from visible sessions'}
              </span>
            )}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {row.machines.map((m, i) => {
              const name = machineName[m.key] || `${m.key.slice(0, 10)}…`
              const top = i === 0 && row.machines.length > 1
              return (
                <span
                  key={m.key}
                  title={`${name} · ${m.sessions} ${pt ? 'sessões' : 'sessions'} · ${fmt(m.totalTokens)} tok · ${fmtCost(m.costUSD, currency, brlRate)}`}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%',
                    padding: '3px 9px', borderRadius: 999, fontSize: 11,
                    background: 'var(--bg-card)',
                    border: top ? '1px solid var(--anthropic-orange)' : '1px solid var(--border-subtle)',
                    color: 'var(--text-secondary)', minWidth: 0,
                  }}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-primary)', fontWeight: top ? 700 : 500 }}>{name}</span>
                  <span style={{ flexShrink: 0, color: 'var(--text-tertiary)', fontVariantNumeric: 'tabular-nums' }}>
                    {fmtCost(m.costUSD, currency, brlRate)}
                  </span>
                  {top && (
                    <span style={{ flexShrink: 0, fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', color: 'var(--anthropic-orange)' }}>
                      {pt ? 'maior uso' : 'top'}
                    </span>
                  )}
                </span>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

function Fact({ icon, label, value, hint, color, muted, title }: {
  icon?: React.ReactNode
  label: string
  value: string
  hint?: string
  color?: string
  muted?: boolean
  title?: string
}) {
  return (
    <div style={{ minWidth: 0, background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '7px 9px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, fontWeight: 600, letterSpacing: '0.03em', textTransform: 'uppercase', color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {icon}{label}
      </div>
      <div title={title} style={{
        marginTop: 3, fontSize: 12.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        color: muted ? 'var(--text-tertiary)' : (color ?? 'var(--text-primary)'),
      }}>{value}</div>
      {hint && (
        <div style={{ marginTop: 2, fontSize: 10.5, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{hint}</div>
      )}
    </div>
  )
}

/** Last two path segments — a full project path never fits a card at 390px. */
function shortPath(p: string): string {
  const parts = p.split('/').filter(Boolean)
  return parts.length <= 2 ? p : `…/${parts.slice(-2).join('/')}`
}

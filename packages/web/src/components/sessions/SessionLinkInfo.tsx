/**
 * SessionLinkInfo — the ⓘ beside a session's title, present ONLY when the session has a link
 * (a parent, children it started, or a linked Agentask task). It replaces the "created by …" strip.
 *
 * Basic information, never insistent: a neutral glyph, no badge, no animation. Clicking opens a
 * compact PORTALED popover (the `SessionStatsMenu` pattern: outside click, Escape, and
 * `scrollIsOutside` for scroll) whose rows navigate. The links themselves are decided by the pure
 * `sessionLinks`; where each row leads is `linkTargets`, so the click handlers hold no routing.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, ChevronRight, Clock3, Info, List, Pause, Play, RefreshCw, Search } from 'lucide-react'
import { sessionRunning } from '@agentistics/tui/control/session-dimensions'
import type { ControlSession } from '@agentistics/tui/control/session-fleet'
import { HARNESS_LABELS } from '../../lib/harness'
import { scrollIsOutside } from '../../lib/popoverScroll'
import { sessionPath } from '../../lib/sessionRoute'
import { filterByTitle, newestFirst, type SessionLinks } from '../../lib/sessionParent'
import { messageTime } from '../../lib/messageTime'
import { STATE_COLOR } from '../../lib/sessionCardStyle'
import { inputStyle } from './formBits'
import { HarnessMark } from './HarnessMark'
import { leaderTitleFor, roleOriginLabel, setSessionRole, useSessionRole, useSessionRoleOrigin, type SessionRole } from '../../lib/sessionRoles'
import { sessionIdentityKey } from '../../lib/sessionIdentity'
import { isInsidePortalledMenu } from '../../lib/rowMenu'
import { TabSelect } from '../../pages/settings/primitives'
import { RoleChip } from './RoleChip'
import { ToggleSwitch } from '../ToggleSwitch'
import { CHECKIN_ITEMS, clockLabel, formatNextRun, useCheckin, type CheckinConfig } from '../../lib/checkin'
import { parseSnooze, SNOOZE_PRESETS } from '../../lib/nayNotify'

export interface LinkTarget { kind: 'parent' | 'child' | 'task'; key: string; label: string; harness?: string; state?: string; stateLabel?: string; startedAt?: number; path: string | null }

export function linkTargets(links: SessionLinks): LinkTarget[] {
  const out: LinkTarget[] = []
  if (links.parent) {
    out.push({ kind: 'parent', key: `p:${links.parent.id}`, label: links.parent.title ?? links.parent.id.slice(0, 8),
      path: links.parent.openable ? sessionPath(links.parent.id) : null })
  }
  for (const c of newestFirst(links.children)) {
    out.push({ kind: 'child', key: `c:${c.id}`, label: c.title, harness: c.harness, state: c.state, ...(c.stateLabel ? { stateLabel: c.stateLabel } : {}), ...(c.startedAt ? { startedAt: c.startedAt } : {}), path: sessionPath(c.id) })
  }
  if (links.task) out.push({ kind: 'task', key: `t:${links.task.id}`, label: links.task.label ?? links.task.id, path: `/tasks/${encodeURIComponent(links.task.id)}` })
  return out
}

function when(ms: number | undefined, pt: boolean): string | null {
  if (!ms) return null
  const d = new Date(ms).toLocaleString(pt ? 'pt-BR' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' })
  return pt ? `Iniciada em ${d}` : `Started ${d}`
}

const SECTION = { fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-tertiary)', margin: '8px 0 2px' } as const

const ROW_STYLE = {
  all: 'unset', boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: 8, width: '100%',
  padding: '5px 6px', borderRadius: 6, fontSize: 12.5, color: 'var(--text-primary)', minHeight: 28,
} as const

const CHECKIN_ROW = { display: 'flex', alignItems: 'center', gap: 7, minHeight: 28, fontSize: 12, color: 'var(--text-secondary)' } as const

function CheckinPanel({ state, pt, isMobile, onGo, update, runNow, taskPath, bare = false }: {
  state: NonNullable<ReturnType<typeof useCheckin>['state']>; pt: boolean; isMobile: boolean; bare?: boolean
  onGo: (path: string) => void; update: (partial: Partial<CheckinConfig>) => Promise<void>; runNow: () => Promise<boolean>; taskPath: string | null
}) {
  const paused = state.paused !== null
  const [ran, setRan] = useState<null | 'busy' | 'ok' | 'refused'>(null)
  const run = async () => { setRan('busy'); setRan(await runNow() ? 'ok' : 'refused') }
  const setInterval = (intervalMin: CheckinConfig['intervalMin']) => void update({ intervalMin })
  const togglePause = () => void update({ paused: paused ? null : { until: null } })
  const checklist = state.checklist.length ? state.checklist : CHECKIN_ITEMS.map(item => ({ id: item.id, enabled: true }))
  const last = state.last ? `${state.last.state === 'needs_you' ? (pt ? 'precisa de você' : 'needs you') : state.last.summary}` : (pt ? 'ainda não rodou' : 'not run yet')
  return <div data-testid="checkin-panel" style={bare ? {} : { borderTop: '1px solid var(--border)', marginTop: 8, paddingTop: 7 }}>
    <div style={{ ...SECTION, display: bare ? 'none' : 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 0 }}>
      <span>{pt ? 'Check-in' : 'Check-in'}</span>
      <span style={{ color: paused ? 'var(--text-tertiary)' : 'var(--accent-green)' }}>{paused ? (pt ? 'pausado' : 'paused') : (pt ? `ligado · a cada ${state.intervalMin} min` : `on · every ${state.intervalMin} min`)}</span>
    </div>
    <div style={{ display: 'grid', gap: 2 }}>
      <div style={CHECKIN_ROW}><Clock3 size={15} /><span>{pt ? 'Próxima rodada' : 'Next round'}</span><span style={{ marginLeft: 'auto', color: 'var(--text-primary)' }}>{formatNextRun(state.nextRunAt, Date.now(), pt)}</span></div>
      <div style={CHECKIN_ROW}><Check size={15} /><span>{pt ? 'Última' : 'Last'}</span><span style={{ marginLeft: 'auto', color: 'var(--text-primary)', textAlign: 'right' }}>{state.lastRunAt ? `${clockLabel(state.lastRunAt, pt)} · ${last}` : last}</span></div>
      <div style={CHECKIN_ROW}><RefreshCw size={15} /><span>{pt ? 'Intervalo' : 'Interval'}</span><select aria-label={pt ? 'Intervalo do check-in' : 'Check-in interval'} value={state.intervalMin} onChange={e => setInterval(Number(e.target.value) as CheckinConfig['intervalMin'])} style={{ marginLeft: 'auto', background: 'var(--bg-elevated)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 5, padding: '4px 6px', font: 'inherit' }}><option value={15}>15 min</option><option value={30}>30 min</option><option value={60}>1 h</option><option value={120}>2 h</option></select></div>
      <div style={CHECKIN_ROW}><Pause size={15} /><span>{pt ? 'Pausar check-in' : 'Pause check-in'}</span><span style={{ marginLeft: 'auto', display: 'inline-flex' }}><ToggleSwitch on={paused} onToggle={togglePause} label={pt ? 'Pausar check-in' : 'Pause check-in'} tap={isMobile ? 44 : undefined} /></span></div>
      {paused && <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap', padding: '0 0 3px 22px', fontSize: 11 }}><span style={{ color: 'var(--text-tertiary)' }}>{pt ? 'Pausar até:' : 'Pause until:'}</span>{SNOOZE_PRESETS.map(p => <button key={p.ms} type="button" onClick={() => { const parsed = parseSnooze(`${p.ms / 60_000}m`); if (parsed.ok) void update({ paused: { until: Date.now() + parsed.ms } }) }} style={{ all: 'unset', cursor: 'pointer', color: 'var(--anthropic-orange)' }}>{p.label[pt ? 'pt' : 'en']}</button>)}<button type="button" onClick={() => void update({ paused: { until: null } })} style={{ all: 'unset', cursor: 'pointer', color: 'var(--anthropic-orange)' }}>{pt ? 'até religar' : 'until resumed'}</button></div>}
    </div>
    <div style={{ borderTop: '1px solid var(--border)', paddingTop: 6, marginTop: 4 }}>
      <div style={{ fontSize: 12, color: 'var(--text-tertiary)', padding: '2px 0' }}>{pt ? 'Roteiro: o que o líder confere' : 'Checklist: what the leader checks'}</div>
      {CHECKIN_ITEMS.map(item => { const current = checklist.find(x => x.id === item.id); const enabled = current?.enabled ?? true; return <div key={item.id} style={{ ...CHECKIN_ROW, minHeight: isMobile ? 40 : 28 }}><span style={{ color: enabled ? 'var(--text-secondary)' : 'var(--text-tertiary)' }}>{item[pt ? 'pt' : 'en']}</span><span style={{ marginLeft: 'auto', display: 'inline-flex' }}><ToggleSwitch on={enabled} onToggle={() => void update({ checklist: checklist.map(x => x.id === item.id ? { ...x, enabled: !enabled } : x) })} label={item[pt ? 'pt' : 'en']} tap={isMobile ? 44 : undefined} /></span></div> })}
    </div>
    <div style={{ display: 'flex', gap: 6, marginTop: 7, flexWrap: 'wrap' }}><button type="button" disabled={ran === 'busy'} onClick={() => void run()} style={{ ...ROW_STYLE, width: 'auto', cursor: 'pointer', border: '1px solid var(--border)', ...(isMobile ? { minHeight: 44 } : {}) }}><Play size={14} />{pt ? 'Rodar agora' : 'Run now'}</button>{taskPath && <button type="button" onClick={() => onGo(taskPath)} style={{ ...ROW_STYLE, width: 'auto', cursor: 'pointer', border: '1px solid var(--border)', color: 'var(--text-secondary)', ...(isMobile ? { minHeight: 44 } : {}) }}><List size={14} />{pt ? 'Ver registro' : 'View log'}</button>}</div>
    {ran && ran !== 'busy' && <div role="status" style={{ fontSize: 11.5, marginTop: 5, color: ran === 'ok' ? 'var(--accent-green)' : 'var(--accent-red)' }}>{ran === 'ok' ? (pt ? 'Check-in enviado ao líder.' : 'Check-in sent to the leader.') : (pt ? 'O líder não aceitou o check-in agora (ocupado, num diálogo ou parado). Tente de novo em instantes.' : 'The leader did not take the check-in now (busy, on a dialog or stopped). Try again shortly.')}</div>}
  </div>
}

function Row({ t, pt, onGo, touch }: { t: LinkTarget; pt: boolean; onGo: (path: string) => void; touch: boolean }) {
  const harness = t.harness ? (HARNESS_LABELS as Record<string, string>)[t.harness] ?? t.harness : null
  const at = t.startedAt ? messageTime(new Date(t.startedAt).toISOString(), pt ? 'pt' : 'en') : null
  // The TITLE wins the width; the meta keeps its natural size and wraps under the title when it must.
  const inner = (
    <>
      <span style={{ minWidth: 0, flexBasis: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.label}</span>
      <span style={{ fontSize: 11, color: 'var(--text-tertiary)', flex: '0 1 auto', display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' }}>
        {t.harness && <span role="img" aria-label={harness ?? ''} title={harness ?? ''} style={{ display: 'inline-flex' }}><HarnessMark harness={t.harness} size={12} /></span>}
        {at && <span title={at.full}>· {at.label}</span>}
        {t.state && <span data-state-word={t.state}
          style={{ color: STATE_COLOR[t.state as keyof typeof STATE_COLOR] ?? 'var(--text-tertiary)' }}>· {t.stateLabel ?? t.state}</span>}
      </span>
    </>
  )
  const min = touch ? { minHeight: 44 } : {}
  const wrap = { flexWrap: 'wrap', rowGap: 2, alignContent: 'center' } as const
  return t.path ? (
    <button type="button" data-link-kind={t.kind} onClick={() => onGo(t.path!)} style={{ ...ROW_STYLE, ...wrap, ...min, cursor: 'pointer' }}>{inner}</button>
  ) : (
    <div data-link-kind={t.kind} style={{ ...ROW_STYLE, ...wrap, ...min, color: 'var(--text-tertiary)' }}
      title={pt ? 'Não está mais na frota' : 'No longer in the fleet'}>{inner}</div>
  )
}

/** The check-in block on its own, for a surface that shows it as a card of its own (the phone's
 *  session drawer). The server answers 404 for a session that is not a leader, so this renders
 *  nothing there — the same rule the ⓘ panel follows. */
export function SessionCheckinCard({ sessionId, links, pt, isMobile = false, onGo, frame }: {
  sessionId?: string; links: SessionLinks; pt: boolean; isMobile?: boolean; onGo: (path: string) => void
  /** The host's own section chrome: given the card's status line and its body. */
  frame: (summary: ReactNode, body: ReactNode) => ReactNode
}) {
  const checkin = useCheckin(sessionId)
  if (!checkin.state) return null
  const paused = checkin.state.paused !== null
  const needsYou = !paused && checkin.state.last?.state === 'needs_you'
  // The folded card's glance figure, like the other drawer rows: a status dot + one short word.
  const mins = checkin.state.nextRunAt === null ? null : Math.max(0, Math.ceil((checkin.state.nextRunAt - Date.now()) / 60_000))
  const glance = paused ? (pt ? 'pausado' : 'paused')
    : needsYou ? (pt ? 'precisa de você' : 'needs you')
    : mins === null ? (pt ? 'ligado' : 'on') : (pt ? `em ${mins} min` : `in ${mins} min`)
  const dot = paused ? 'var(--text-tertiary)' : needsYou ? 'var(--accent-red)' : 'var(--accent-green)'
  const summary = <span data-testid="checkin-glance" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: '50%', background: dot }} /><span style={{ fontWeight: 650 }}>{glance}</span></span>
  return <>{frame(summary, <CheckinPanel bare state={checkin.state} pt={pt} isMobile={isMobile} onGo={onGo} update={checkin.update} runNow={checkin.runNow} taskPath={links.task ? `/tasks/${encodeURIComponent(links.task.id)}?tab=activity&filter=checkins` : null} />)}</>
}

export function SessionLinkPanel({ links, startedAt, sessionId, roleFallbackId, pt, onGo, isMobile = false, hideCheckin = false }: {
  links: SessionLinks; startedAt?: number; sessionId?: string; roleFallbackId?: string; pt: boolean; onGo: (path: string) => void; isMobile?: boolean
  /** The phone drawer draws the check-in as a card of its own (`SessionCheckinCard`). */
  hideCheckin?: boolean
}) {
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState('')
  const [endedOpen, setEndedOpen] = useState(false)
  const [rolePickerOpen, setRolePickerOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const primaryRole = useSessionRole(sessionId ?? '')
  const fallbackRole = useSessionRole(roleFallbackId ?? '')
  const role = primaryRole ?? fallbackRole
  const primaryOrigin = useSessionRoleOrigin(sessionId ?? '')
  const fallbackOrigin = useSessionRoleOrigin(roleFallbackId ?? '')
  const roleOrigin = primaryRole ? primaryOrigin : fallbackOrigin
  const checkin = useCheckin(role === 'leader' && !hideCheckin ? sessionId : undefined)
  useEffect(() => { if (searching) inputRef.current?.focus() }, [searching])

  const targets = linkTargets(links)
  const groups: Array<[LinkTarget['kind'], string]> = [
    ['parent', pt ? 'Sessão de origem' : 'Started by'],
    ['child', pt ? 'Sessões que ela iniciou' : 'Sessions it started'],
    ['task', pt ? 'Tarefa' : 'Task'],
  ]
  const started = when(startedAt, pt)
  const rowOf = (t: LinkTarget) => <Row key={t.key} t={t} pt={pt} onGo={onGo} touch={isMobile} />
  const searchLabel = pt ? 'Buscar nas sessões' : 'Search sessions'
  const close = () => { setSearching(false); setQuery('') }
  return (
    <div data-testid="session-link-panel">
      {sessionId && <div>
        <div style={SECTION}>{pt ? 'Tipo' : 'Type'}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 6px', fontSize: 12 }}>
          <RoleChip role={role} pt={pt} />
          <span style={{ color: 'var(--text-tertiary)', fontSize: 10.5 }}>{role ? roleOriginLabel(roleOrigin, pt, leaderTitleFor(roleOrigin, links.parent)) : (pt ? 'deduzido pelo sistema' : 'inferred by system')}</span>
          <button type="button" aria-label={pt ? 'Trocar tipo' : 'Change type'} aria-expanded={rolePickerOpen} onClick={() => setRolePickerOpen(open => !open)} style={{ all: 'unset', marginLeft: 'auto', color: 'var(--anthropic-orange)', cursor: 'pointer', fontSize: 11, padding: '3px 5px', borderRadius: 5, ...(isMobile ? { boxSizing: 'border-box', display: 'inline-flex', alignItems: 'center', minHeight: 44, minWidth: 44, justifyContent: 'center' } : {}) }}>{pt ? 'Trocar' : 'Change'}</button>
        </div>
        {rolePickerOpen && (
          <div data-testid="session-role-picker" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setRolePickerOpen(false) } }} style={{ padding: '2px 6px 8px', overflowX: 'auto' }}>
            <TabSelect
              options={[{ value: 'automatic', label: pt ? 'Automático' : 'Automatic' }, { value: 'leader', label: pt ? 'Líder' : 'Leader' }, { value: 'worker', label: 'Worker' }]}
              value={role ?? 'automatic'}
              onChange={value => { setSessionRole(sessionId, value === 'automatic' ? null : value as SessionRole); setRolePickerOpen(false) }}
              {...(isMobile ? { buttonMinHeight: 44 } : {})}
            />
          </div>
        )}
      </div>}
      {groups.map(([kind, title]) => {
        let rows = targets.filter(t => t.kind === kind)
        if (!rows.length) return null
        if (kind !== 'child') return <div key={kind}><div style={SECTION}>{title}</div>{rows.map(rowOf)}</div>
        const total = rows.length
        { const keep = new Set(filterByTitle(rows.map(t => ({ title: t.label, t })), query).map(x => x.t)); rows = rows.filter(t => keep.has(t)) }
        const running = rows.filter(t => sessionRunning({ state: (t.state ?? 'unknown') as never }))
        const ended = rows.filter(t => !running.includes(t))
        const showEnded = endedOpen || query.trim() !== ''
        const size = isMobile ? 44 : 24
        return (
          <div key={kind}>
            <div style={{ ...SECTION, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span>{title}</span>
              <button type="button" aria-label={searchLabel} title={searchLabel} aria-expanded={searching}
                data-testid="link-search-toggle" onClick={() => (searching ? close() : setSearching(true))}
                style={{ all: 'unset', boxSizing: 'border-box', cursor: 'pointer', width: size, height: size, display: 'inline-flex',
                  alignItems: 'center', justifyContent: 'center', color: 'var(--text-tertiary)' }}><Search size={13} /></button>
            </div>
            {searching && (
              <input ref={inputRef} value={query} onChange={e => setQuery(e.target.value)} data-testid="link-search"
                onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); close() } }}
                placeholder={searchLabel} aria-label={searchLabel}
                style={{ ...inputStyle, paddingLeft: 10, marginBottom: 4, ...(isMobile ? { fontSize: 16, minHeight: 44 } : {}) }} />
            )}
            {running.map(rowOf)}
            {rows.length === 0 && total > 0 && (
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)', padding: '5px 6px' }}>{pt ? 'Nenhuma sessão encontrada' : 'No sessions found'}</div>
            )}
            {ended.length > 0 && (
              <>
                <button type="button" data-testid="ended-toggle" aria-expanded={showEnded} onClick={() => setEndedOpen(o => !o)}
                  style={{ ...ROW_STYLE, cursor: 'pointer', color: 'var(--text-tertiary)', ...(isMobile ? { minHeight: 44 } : {}) }}>
                  {showEnded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  <span>{pt ? `Encerradas (${ended.length})` : `Ended (${ended.length})`}</span>
                </button>
                {showEnded && ended.map(rowOf)}
              </>
            )}
          </div>
        )
      })}
      {started && <div style={{ ...SECTION, textTransform: 'none', letterSpacing: 0, fontWeight: 400, marginTop: 10 }}>{started}</div>}
      {role === 'leader' && !hideCheckin && checkin.state && <CheckinPanel state={checkin.state} pt={pt} isMobile={isMobile} onGo={onGo} update={checkin.update} runNow={checkin.runNow} taskPath={links.task ? `/tasks/${encodeURIComponent(links.task.id)}?tab=activity&filter=checkins` : null} />}
    </div>
  )
}

export function SessionLinkInfo({ session, links, lang, onGo, isMobile = false }: {
  session: Partial<Pick<ControlSession, 'id' | 'startedAt' | 'conversationId'>>
  links: SessionLinks | null
  lang: 'pt' | 'en'
  onGo: (path: string) => void
  /** Touch target: 44px on a phone, 22px on desktop. */
  isMobile?: boolean
}) {
  const pt = lang === 'pt'
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const away = (e: Event) => {
      const t = e.target as Node
      if (btnRef.current?.contains(t) || panelRef.current?.contains(t) || isInsidePortalledMenu(t)) return
      setOpen(false)
    }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); btnRef.current?.focus() } }
    const scroll = (e: Event) => { if (scrollIsOutside(panelRef.current, e.target)) setOpen(false) }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', esc)
    window.addEventListener('scroll', scroll, true)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', esc)
      window.removeEventListener('scroll', scroll, true)
    }
  }, [open])

  if (!session.id && !links) return null
  const label = pt ? 'Vínculos desta sessão' : 'Session links'
  const toggle = () => {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect()
      const width = Math.min(320, window.innerWidth - 24)
      setPos({ top: r.bottom + 6, left: Math.max(12, Math.min(r.left, window.innerWidth - width - 12)) })
    }
    setOpen(o => !o)
  }
  const size = isMobile ? 44 : 22
  return (
    <>
      <button ref={btnRef} type="button" onClick={toggle} aria-label={label} title={label}
        aria-haspopup="dialog" aria-expanded={open} data-testid="session-link-info"
        style={{
          all: 'unset', boxSizing: 'border-box', cursor: 'pointer', flexShrink: 0, width: size, height: size,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6,
          color: open ? 'var(--text-secondary)' : 'var(--text-tertiary)',
        }}
        onMouseEnter={e => { e.currentTarget.style.color = 'var(--text-secondary)' }}
        onMouseLeave={e => { e.currentTarget.style.color = open ? 'var(--text-secondary)' : 'var(--text-tertiary)' }}
      ><Info size={14} /></button>
      {open && pos && createPortal(
        <div ref={panelRef} role="dialog" aria-label={label} style={{
          position: 'fixed', top: pos.top, left: pos.left, width: Math.min(320, window.innerWidth - 24), zIndex: 1200,
          maxHeight: 'calc(60vh / var(--ui-zoom, 1))', overflowY: 'auto', padding: '4px 10px 10px', borderRadius: 10,
          background: 'var(--bg-card)', border: '1px solid var(--border)', boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
        }}>
          <SessionLinkPanel links={links ?? { parent: null, children: [], task: null }} {...(session.startedAt ? { startedAt: session.startedAt } : {})} sessionId={session.id ? sessionIdentityKey(session as { id: string; conversationId?: string }) : undefined} roleFallbackId={session.id} pt={pt} isMobile={isMobile}
            onGo={p => { setOpen(false); onGo(p) }} />
        </div>, document.body)}
    </>
  )
}

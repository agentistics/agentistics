/**
 * PROTOTYPE (UI.SESSION-TABS T1) — dev-only page, never in the build (`vite.config.ts` builds
 * `index.html` only). Open `/proto/session-tabs.html?opt=A|B|C&theme=dark|light` for the tab options
 * and `?view=leaders&lo=1|2` for the "leaders only" aside options. Fixture data, real components:
 * `STATE_COLOR`, `RoleChip`, `SessionFacts`, `HarnessMark`, `AwayChip`, `Toggle`, `tabStripEdge`,
 * the `.tabscroll` / `.ag-hint-pulse` / `.ag-attn-*` classes.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { Bell, ChevronDown, Folder, KeyRound, LayoutList, Moon, MoreHorizontal, Pin, Plus, Search, Send, Filter, X, Crown } from 'lucide-react'
import '../src/index.css'
import { STATE_COLOR } from '../src/lib/sessionCardStyle'
import { RoleChip, SESSION_CHIP_STYLE } from '../src/components/sessions/RoleChip'
import { SessionFacts } from '../src/components/sessions/SessionFacts'
import { HarnessMark } from '../src/components/sessions/HarnessMark'
import { Toggle } from '../src/pages/settings/primitives'
import { tabStripEdgeFade, tabStripFadeMask } from '../src/lib/tabStripEdge'
import { closeTab, openTab, stripOrder } from './sessionTabsModel'
import type { ControlSession } from '@agentistics/tui/control/session-fleet'

const q = new URLSearchParams(location.search)
const OPT = (q.get('opt') ?? 'A').toUpperCase() as 'A' | 'B' | 'C'
const VIEW = q.get('view') ?? 'tabs'
const LO = q.get('lo') ?? '1'
const MENU = q.get('menu') === '1'
document.documentElement.setAttribute('data-theme', q.get('theme') === 'light' ? 'light' : 'dark')

type Row = ControlSession & { role?: 'leader' | 'worker'; away?: boolean; folder?: string }
const S = (id: string, title: string, harness: string, state: ControlSession['state'], stateLabel: string, extra: Partial<Row> = {}): Row =>
  ({ id, title, harness, state, stateLabel, cwd: '~/agentistics/.claude/worktrees/' + id, project: 'agentistics', model: harness === 'codex' ? 'gpt-6.1-sol' : 'claude-opus-5-5', ...extra } as unknown as Row)

const ROWS: Row[] = [
  S('fe4e2521', '[ LÍDER ] - Side Tasks (sessão 48)', 'claude', 'waiting', 'precisa de você', { role: 'leader', away: true, folder: 'Agentistics Side Tasks/Líderes', task: 'Coordenação side' }),
  S('04ba1182', 'UI.SESSION-TABS T1 · mapa + protótipos', 'claude', 'working', 'trabalhando', { role: 'worker', folder: 'Agentistics Side Tasks/Em andamento' }),
  S('bd64fd04', 'PLAN.ACCOUNTS C2 · UI de contas', 'codex', 'waiting-approval', 'precisa de aprovação', { role: 'worker', folder: 'Contas/Em andamento' }),
  S('ac1b959d', 'AWAY.LOOK fix r1 · menu mobile', 'claude', 'waiting', 'precisa de você', { role: 'worker', folder: 'Agentistics Side Tasks/Em andamento' }),
  S('a98aeaee', 'Engine F4 · release rel-f4', 'claude', 'exited', 'encerrada', { role: 'worker', folder: 'Motor/Finalizadas' }),
  S('484b9c91', '[ LÍDER ] - UPX Discovery', 'claude', 'waiting', 'precisa de você', { role: 'leader', folder: 'UPX/Líderes', project: 'upx' }),
  S('6250ef1c', 'QA f4a-live · Gemini', 'gemini', 'working', 'trabalhando', { role: 'worker', folder: 'Motor/Em andamento' }),
  S('0962b891', '[ LÍDER ] - Engine completa', 'claude', 'working', 'trabalhando', { role: 'leader', folder: 'Motor/Líderes' }),
  S('a06acdb3', 'acct-ui-design · protótipo', 'codex', 'lost', 'perdida', { role: 'worker', folder: 'Contas/Em andamento' }),
]
const byId = new Map(ROWS.map(r => [r.id, r]))
const mobile = () => window.innerWidth < 768

// ── the status mark every tab carries ──────────────────────────────────────────────────────────
function TabStatus({ s, size = 8 }: { s: Row; size?: number }) {
  const c = STATE_COLOR[s.state]
  const ended = s.state === 'exited' || s.state === 'closed' || s.state === 'lost' || s.state === 'unknown'
  return (
    <span role="img" aria-label={s.stateLabel} title={s.stateLabel} style={{ position: 'relative', display: 'inline-flex', width: size, height: size, flexShrink: 0 }}>
      {s.state === 'waiting-approval' && <span className="ag-mic-pulse" aria-hidden style={{ position: 'absolute', inset: -3, borderRadius: '50%', border: `1.5px solid ${c}` }} />}
      <span aria-hidden className={s.state === 'working' ? 'ag-hint-pulse' : undefined} style={{
        width: size, height: size, borderRadius: '50%', boxSizing: 'border-box',
        background: ended ? 'transparent' : c, border: ended ? `1.5px solid ${c}` : 'none',
      }} />
    </span>
  )
}

// ── one tab, three shapes ──────────────────────────────────────────────────────────────────────
function Tab({ s, active, pinned, shape, onPick, onClose }: { s: Row; active: boolean; pinned: boolean; shape: 'A' | 'B' | 'C'; onPick: () => void; onClose: () => void }) {
  const m = mobile()
  const ended = ['exited', 'closed', 'lost'].includes(s.state)
  const needs = s.state === 'waiting' || s.state === 'waiting-approval'
  const [hover, setHover] = useState(false)
  const title = s.title.replace(/^\[ LÍDER \] - /, '')
  const base: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 7, flexShrink: 0, cursor: 'pointer', fontFamily: 'inherit',
    fontSize: 12, whiteSpace: 'nowrap', color: active ? 'var(--text-primary)' : ended ? 'var(--text-tertiary)' : 'var(--text-secondary)',
    fontWeight: active || needs ? 650 : 500, border: 'none', minHeight: m ? 44 : undefined, scrollSnapAlign: 'center',
  }
  const shapeStyle: React.CSSProperties = shape === 'A'
    ? { height: m ? 44 : 34, padding: '0 10px 0 12px', background: active ? 'var(--bg-card, var(--bg-elevated))' : 'transparent',
        boxShadow: active ? 'inset 0 2px 0 var(--anthropic-orange)' : needs ? 'inset 0 -2px 0 var(--anthropic-orange)' : 'none',
        borderRight: '1px solid var(--border-subtle)' }
    : shape === 'B'
      ? { height: m ? 44 : 30, padding: '0 8px 0 10px', borderRadius: 8, background: active ? 'var(--bg-elevated)' : 'transparent',
          outline: active ? '1px solid var(--border)' : 'none' }
      : { height: m ? 44 : 26, padding: '0 10px', borderRadius: 999, background: active ? 'var(--bg-elevated)' : 'transparent',
          border: `1px solid ${active ? 'var(--border)' : needs ? 'color-mix(in srgb, var(--anthropic-orange) 45%, transparent)' : 'var(--border-subtle)'}`, fontSize: 11.5 }
  return (
    <div
      role="tab" aria-selected={active} tabIndex={active ? 0 : -1}
      title={`${s.title}\n${s.stateLabel} · ${s.cwd}`}
      onClick={onPick}
      onAuxClick={e => { if (e.button === 1) { e.preventDefault(); onClose() } }}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ ...base, ...shapeStyle }}
    >
      <TabStatus s={s} />
      {shape !== 'C' && <HarnessMark harness={s.harness} size={14} />}
      {s.role === 'leader' && <Crown size={11} aria-label="Líder" style={{ color: 'var(--accent-purple)', flexShrink: 0 }} />}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: pinned && shape !== 'B' ? 120 : shape === 'C' ? 140 : 180, textDecoration: ended ? 'none' : undefined }}>{title}</span>
      {pinned
        ? <Pin size={11} aria-label="Fixada" style={{ color: 'var(--anthropic-orange)', flexShrink: 0 }} />
        : <span role="button" aria-label="Fechar aba" onClick={e => { e.stopPropagation(); onClose() }}
            style={{ display: 'flex', width: m ? 28 : 16, height: m ? 28 : 16, alignItems: 'center', justifyContent: 'center', borderRadius: 4,
              color: 'var(--text-tertiary)', opacity: active || hover || m ? 1 : 0 }}><X size={12} /></span>}
    </div>
  )
}

// ── the strip (shared scroll/fade/overflow logic) ──────────────────────────────────────────────
function Strip({ shape, order, pins, active, setActive, close }: { shape: 'A' | 'B' | 'C'; order: string[]; pins: string[]; active: string | null; setActive: (id: string) => void; close: (id: string) => void }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [edges, setEdges] = useState({ left: false, right: false })
  const [menu, setMenu] = useState(MENU)
  const measure = useCallback(() => { const el = ref.current; if (el) setEdges(tabStripEdgeFade({ scrollLeft: el.scrollLeft, clientWidth: el.clientWidth, scrollWidth: el.scrollWidth })) }, [])
  useEffect(() => { measure(); window.addEventListener('resize', measure); return () => window.removeEventListener('resize', measure) }, [measure, order.length])
  const fade = tabStripFadeMask(edges)
  const m = mobile()
  return (
    <div style={{ display: 'flex', alignItems: 'center', minWidth: 0, flex: 1, gap: shape === 'A' ? 0 : 4, position: 'relative' }}>
      <div ref={ref} className="tabscroll" role="tablist" aria-label="Sessões abertas" onScroll={measure}
        style={{ display: 'flex', alignItems: 'center', gap: shape === 'A' ? 0 : 4, overflowX: 'auto', flex: 1, minWidth: 0, scrollSnapType: 'x proximity',
          ...(fade ? { maskImage: fade, WebkitMaskImage: fade } : null) }}>
        {order.map((id, i) => {
          const s = byId.get(id)!
          const sep = shape !== 'A' && i === pins.length && pins.length > 0
          return (
            <React.Fragment key={id}>
              {sep && <span aria-hidden style={{ width: 1, height: 16, background: 'var(--border)', flexShrink: 0, margin: '0 2px' }} />}
              <Tab s={s} shape={shape} active={id === active} pinned={pins.includes(id)} onPick={() => setActive(id)} onClose={() => close(id)} />
            </React.Fragment>
          )
        })}
      </div>
      <button aria-label="Todas as abas abertas" aria-haspopup="menu" onClick={() => setMenu(v => !v)}
        style={{ display: 'flex', alignItems: 'center', gap: 3, flexShrink: 0, height: m ? 44 : 28, padding: '0 8px', borderRadius: 7, border: 'none',
          background: menu ? 'var(--bg-elevated)' : 'transparent', color: 'var(--text-tertiary)', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11 }}>
        {order.length}<ChevronDown size={13} />
      </button>
      {menu && (
        <div role="menu" style={{ position: 'absolute', right: 0, top: '100%', marginTop: 6, zIndex: 50, width: 300, borderRadius: 12, border: '1px solid var(--border-subtle)',
          background: 'var(--bg-elevated)', boxShadow: 'var(--ag-shadow-menu)', padding: 6 }}>
          {order.map(id => { const s = byId.get(id)!; return (
            <div key={id} role="menuitem" onClick={() => { setActive(id); setMenu(false) }} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: m ? '12px 8px' : '6px 8px', borderRadius: 6, cursor: 'pointer', fontSize: 12,
              background: id === active ? 'var(--bg-card, var(--bg-secondary))' : 'transparent', color: 'var(--text-secondary)' }}>
              <TabStatus s={s} /><span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.title}</span>
              <span style={{ fontSize: 10.5, color: STATE_COLOR[s.state] }}>{s.stateLabel}</span>
              {pins.includes(id) && <Pin size={11} style={{ color: 'var(--anthropic-orange)' }} />}
            </div>) })}
          <div style={{ borderTop: '1px solid var(--border-subtle)', margin: '6px 0 0', paddingTop: 6, display: 'flex', gap: 6 }}>
            {['Fechar outras', 'Fechar encerradas', 'Fechar todas'].map(t => <button key={t} style={{ flex: 1, fontSize: 11, padding: '6px 4px', borderRadius: 6, border: '1px solid var(--border-subtle)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontFamily: 'inherit' }}>{t}</button>)}
          </div>
        </div>
      )}
    </div>
  )
}

// ── fake chrome around it: the App's top strip, the aside, a conversation ──────────────────────
const iconBtn: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-tertiary)', flexShrink: 0 }
function RightCluster() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
      <span style={{ ...iconBtn, width: 'auto', padding: '0 10px', gap: 6, fontSize: 12 }}><Moon size={13} />Ausente</span>
      <span style={iconBtn}><KeyRound size={14} /></span>
      <span style={iconBtn}><Bell size={14} /></span>
      <span style={iconBtn}><MoreHorizontal size={14} /></span>
    </div>
  )
}
function TitleBlock({ s }: { s: Row }) {
  return (
    <div style={{ minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 7, flexShrink: 1 }}>
      <span style={{ fontSize: '0.8438rem', fontWeight: 650, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.title}</span>
      {s.away && <span style={{ ...SESSION_CHIP_STYLE, color: 'var(--accent-purple)' }}><Moon size={11} />Ausente</span>}
      <span style={{ fontSize: '0.6875rem', color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 1000 }}>{s.stateLabel} · {s.cwd}</span>
    </div>
  )
}
function Conversation({ s }: { s: Row }) {
  const bubble = (who: 'me' | 'ai', t: string) => (
    <div style={{ alignSelf: who === 'me' ? 'flex-end' : 'flex-start', maxWidth: '72%', padding: '9px 12px', borderRadius: 12, fontSize: 13, lineHeight: 1.5,
      background: who === 'me' ? 'var(--bg-elevated)' : 'transparent', color: 'var(--text-secondary)', border: who === 'ai' ? '1px solid var(--border-subtle)' : 'none' }}>{t}</div>)
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 10, padding: 18, overflow: 'hidden' }}>
      {bubble('me', `Abra ${s.title.slice(0, 40)} e continue de onde parou.`)}
      {bubble('ai', 'Mapeei os componentes do cabeçalho e do aside. Próximo passo: protótipos com três formatos de aba e as duas opções do filtro de líderes.')}
      {bubble('me', 'Mostre as opções lado a lado, desktop e 390.')}
      <div style={{ flex: 1 }} />
      <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: '12px 14px', fontSize: 13, color: 'var(--text-tertiary)' }}>Escreva para a sessão…</div>
    </div>
  )
}
function MiniAside({ active, setActive, pins }: { active: string | null; setActive: (id: string) => void; pins: string[] }) {
  return (
    <aside style={{ width: 290, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 6, padding: 10, borderRadius: 10, border: '1px solid var(--border-subtle)', background: 'var(--bg-secondary, var(--bg-card))', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, border: '1px solid var(--border-subtle)', borderRadius: 9, padding: '7px 9px', color: 'var(--text-tertiary)', fontSize: 12 }}><Search size={13} />Buscar sessões</div>
      <div style={{ fontSize: 10.5, color: 'var(--text-tertiary)', padding: '4px 4px 0', fontWeight: 600 }}>FIXADAS</div>
      {ROWS.map(s => (
        <button key={s.id} onClick={() => setActive(s.id)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 9px 8px 14px', borderRadius: 9, border: 'none', textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit',
          background: s.id === active ? 'var(--bg-elevated)' : 'transparent', color: 'var(--text-secondary)',
          boxShadow: s.id === active ? 'inset 3px 0 0 var(--text-primary)' : `inset 3px 0 0 ${STATE_COLOR[s.state]}` }}>
          <SessionFacts session={s} selected={s.id === active} />
          {s.role && <RoleChip role={s.role} pt />}
          {pins.includes(s.id) && <Pin size={12} style={{ color: 'var(--anthropic-orange)', flexShrink: 0 }} />}
        </button>
      ))}
    </aside>
  )
}

function TabsView() {
  const [pins] = useState<string[]>(['fe4e2521', '484b9c91'])
  const [open, setOpen] = useState<string[]>(['04ba1182', 'bd64fd04', 'ac1b959d', 'a98aeaee', '6250ef1c', 'a06acdb3'])
  const [active, setActiveRaw] = useState<string | null>('04ba1182')
  const order = stripOrder(open, pins)
  const setActive = (id: string) => { setOpen(o => openTab(o, id, active, pins)); setActiveRaw(id) }
  const close = (id: string) => { const r = closeTab(order, id, active, pins); setOpen(r.open); setActiveRaw(r.active) }
  const s = byId.get(active ?? '') ?? ROWS[1]
  const strip = <Strip shape={OPT} order={order} pins={pins} active={active} setActive={setActive} close={close} />
  const label = { A: 'A · faixa própria sob o cabeçalho', B: 'B · abas no lugar do título', C: 'C · pílulas compactas' }[OPT]

  if (mobile()) {
    return (
      <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column', background: 'var(--bg-primary)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 48, padding: '0 12px', borderBottom: '1px solid var(--border-subtle)' }}>
          <TitleBlock s={s} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', padding: OPT === 'A' ? 0 : '4px 6px', borderBottom: '1px solid var(--border-subtle)' }}>{strip}</div>
        <Conversation s={s} />
        <div style={{ height: 56, borderTop: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'space-around', color: 'var(--text-tertiary)', fontSize: 10.5 }}>
          {['Início', 'Sessões', 'Custos', 'Repos', 'Mais'].map(t => <span key={t}>{t}</span>)}
        </div>
        <ProtoLabel text={label + ' · 390'} />
      </div>
    )
  }
  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg-primary)', color: 'var(--text-primary)' }}>
      {/* the App's fixed 44px top strip */}
      <div style={{ height: 44, display: 'flex', alignItems: 'center', gap: 10, padding: '0 14px', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0 }}>
        <img src="/logo.png" alt="" style={{ width: 22, height: 22 }} />
        {OPT === 'B' ? strip : <TitleBlock s={s} />}
        {OPT !== 'B' && <div style={{ flex: 1 }} />}
        <RightCluster />
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', gap: 6, padding: 6 }}>
        <MiniAside active={active} setActive={setActive} pins={pins} />
        <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', borderRadius: 10, border: '1px solid var(--border-subtle)', background: 'var(--bg-secondary, var(--bg-card))', overflow: 'visible' }}>
          {OPT !== 'B' && <div style={{ display: 'flex', alignItems: 'center', padding: OPT === 'A' ? 0 : '6px 8px', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0 }}>{strip}</div>}
          {OPT === 'B' && <div style={{ padding: '6px 14px', fontSize: 11, color: 'var(--text-tertiary)', borderBottom: '1px solid var(--border-subtle)', display: 'flex', gap: 8, alignItems: 'center' }}>
            <TabStatus s={s} /><span style={{ color: STATE_COLOR[s.state] }}>{s.stateLabel}</span><span>·</span><span>{s.cwd}</span>{s.away && <span style={{ ...SESSION_CHIP_STYLE, color: 'var(--accent-purple)' }}><Moon size={11} />Ausente</span>}
          </div>}
          <Conversation s={s} />
        </main>
      </div>
      <ProtoLabel text={label} />
    </div>
  )
}

function ProtoLabel({ text }: { text: string }) {
  return <div style={{ position: 'fixed', left: 10, bottom: 8, fontSize: 10, padding: '3px 7px', borderRadius: 5, background: 'var(--anthropic-orange)', color: '#141414', fontWeight: 700, zIndex: 99 }}>PROTÓTIPO · {text}</div>
}

// ── T4: leaders-only view of the aside ─────────────────────────────────────────────────────────
function LeadersView() {
  const [only, setOnly] = useState(q.get('on') !== '0')
  const rows = only ? ROWS.filter(r => r.role === 'leader') : ROWS
  const tree = new Map<string, Map<string, Row[]>>()
  for (const r of rows) {
    const [top, sub] = (r.folder ?? 'Sem pasta/').split('/')
    if (!tree.has(top!)) tree.set(top!, new Map())
    const m = tree.get(top!)!; if (!m.has(sub!)) m.set(sub!, []); m.get(sub!)!.push(r)
  }
  const m = mobile()
  const btn: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, minHeight: m ? 44 : 36, borderRadius: 9, border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)', color: 'var(--text-tertiary)', position: 'relative' }
  const leaders = ROWS.filter(r => r.role === 'leader').length
  const counts = { active: ROWS.filter(r => r.state !== 'exited' && r.state !== 'lost').length, working: ROWS.filter(r => r.state === 'working').length, needs: ROWS.filter(r => r.state.startsWith('waiting')).length }
  return (
    <div style={{ minHeight: '100vh', display: 'flex', gap: 14, padding: m ? 0 : 14, background: 'var(--bg-primary)', alignItems: 'flex-start' }}>
      <aside style={{ width: m ? '100%' : 320, boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 8, padding: 10, borderRadius: m ? 0 : 10, border: '1px solid var(--border-subtle)', background: 'var(--bg-secondary, var(--bg-card))' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, border: '1px solid var(--border-subtle)', borderRadius: 9, padding: m ? '12px 9px' : '7px 9px', color: 'var(--text-tertiary)', fontSize: 12 }}><Search size={13} />Buscar sessões</div>
        {/* the existing summary line — option 1 adds a persisted "líderes N" part to it */}
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', fontSize: 11, color: 'var(--text-tertiary)', padding: '0 2px' }}>
          {[`${counts.active} ativas`, `${counts.working} trabalhando`, `${counts.needs} precisam de você`].map((t, i) => (
            <span key={t} style={{ display: 'inline-flex', alignItems: 'center' }}>{i > 0 && '·'}<span style={{ padding: m ? '12px 5px' : '2px 4px', color: i === 2 ? 'var(--anthropic-orange)' : undefined, fontWeight: i === 2 ? 600 : 400 }}>{t}</span></span>))}
          {LO === '1' && (<><span aria-hidden>·</span>
            <button aria-pressed={only} onClick={() => setOnly(v => !v)} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, border: 'none', font: 'inherit', cursor: 'pointer', borderRadius: 6, padding: m ? '12px 6px' : '2px 5px',
              background: only ? 'color-mix(in srgb, var(--accent-purple) 18%, transparent)' : 'transparent', color: only ? 'var(--accent-purple)' : 'inherit', fontWeight: only ? 650 : 400 }}>
              <Crown size={11} />{leaders} líderes{only && <X size={11} />}
            </button></>)}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <span style={{ ...btn, background: 'var(--anthropic-orange)', borderColor: 'var(--anthropic-orange)', color: '#141414' }}><Plus size={18} /></span>
          <span style={btn}><Send size={14} /></span>
          <span style={btn}><Filter size={14} /></span>
          <span style={{ ...btn, ...(LO === '2' ? { borderColor: 'var(--anthropic-orange)', background: 'var(--anthropic-orange-dim)', color: 'var(--anthropic-orange)' } : null) }}><LayoutList size={14} />
            {LO === '2' && only && <span style={{ position: 'absolute', top: 3, right: 3, minWidth: 13, height: 13, borderRadius: 7, background: 'var(--anthropic-orange)', color: '#fff', fontSize: 8.5, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>1</span>}
          </span>
        </div>
        {only && <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--accent-purple)', padding: '4px 6px', borderRadius: 7, background: 'color-mix(in srgb, var(--accent-purple) 10%, transparent)' }}>
          <Crown size={11} />Mostrando só líderes · {ROWS.length - leaders} sessões ocultas<span style={{ flex: 1 }} /><button onClick={() => setOnly(false)} style={{ border: 'none', background: 'transparent', color: 'inherit', font: 'inherit', cursor: 'pointer', textDecoration: 'underline', minHeight: m ? 44 : undefined }}>mostrar todas</button></div>}
        <div style={{ fontSize: 10.5, color: 'var(--text-tertiary)', padding: '4px 4px 0', fontWeight: 600 }}>GRUPOS</div>
        {[...tree].map(([top, subs]) => (
          <div key={top} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', padding: '6px 4px' }}><Folder size={13} />{top}<span style={{ color: 'var(--text-tertiary)', fontWeight: 400 }}>{[...subs.values()].flat().length}</span></div>
            {[...subs].map(([sub, rs]) => (
              <div key={sub} style={{ marginLeft: 12, borderLeft: '1px solid var(--border-subtle)', paddingLeft: 8, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)', padding: '3px 2px', display: 'flex', gap: 5, alignItems: 'center' }}><Folder size={11} />{sub} {rs.length}</div>
                {rs.map(s => (
                  <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 9px 8px 14px', borderRadius: 9, minHeight: m ? 44 : undefined, color: 'var(--text-secondary)',
                    background: `color-mix(in srgb, ${STATE_COLOR[s.state]} 10%, transparent)`, boxShadow: `inset 3px 0 0 ${STATE_COLOR[s.state]}` }}>
                    <SessionFacts session={s} /><RoleChip role={s.role} pt />
                  </div>))}
              </div>))}
          </div>))}
      </aside>
      {LO === '2' && (
        <div role="dialog" aria-label="Opções de exibição" style={{ width: m ? 'calc(100% - 24px)' : 300, position: m ? 'fixed' : 'static', left: 12, top: 160, borderRadius: 12, border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)', padding: 10, boxShadow: 'var(--ag-shadow-menu)', display: 'grid', gap: 10 }}>
          <section style={{ borderRadius: 10, border: '1px solid var(--border-subtle)', background: 'var(--bg-secondary, var(--bg-card))', padding: 6 }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: 'var(--text-tertiary)', padding: '6px 8px 4px' }}>Mostrar</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', minHeight: m ? 44 : undefined, fontSize: 12, color: 'var(--text-secondary)' }}>
              <Crown size={13} style={{ color: 'var(--accent-purple)' }} /><span style={{ flex: 1 }}>Só sessões líderes</span>
              <Toggle label="Só sessões líderes" on={only} onToggle={() => setOnly(v => !v)} />
            </div>
            <p style={{ margin: 0, padding: '2px 8px 6px', fontSize: 11, lineHeight: 1.45, color: 'var(--text-tertiary)' }}>As pastas continuam; as que não têm líder somem até você desligar.</p>
          </section>
          <section style={{ borderRadius: 10, border: '1px solid var(--border-subtle)', background: 'var(--bg-secondary, var(--bg-card))', padding: 6, opacity: 0.55 }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: 'var(--text-tertiary)', padding: '6px 8px 4px' }}>Agrupamento · Exibição · Ordenação…</div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', padding: '2px 8px 6px' }}>(seções existentes do menu, inalteradas)</div>
          </section>
        </div>
      )}
      <ProtoLabel text={`T4 · opção ${LO} · ${LO === '1' ? 'parte "líderes" na linha de resumo' : 'interruptor no menu de exibição'}`} />
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(VIEW === 'leaders' ? <LeadersView /> : <TabsView />)

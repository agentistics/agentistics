/**
 * SessionLinkInfo — the ⓘ beside a session's title, present ONLY when the session has a link
 * (a parent, children it started, or a linked Agentask task). It replaces the "created by …" strip.
 *
 * Basic information, never insistent: a neutral glyph, no badge, no animation. Clicking opens a
 * compact PORTALED popover (the `SessionStatsMenu` pattern: outside click, Escape, and
 * `scrollIsOutside` for scroll) whose rows navigate. The links themselves are decided by the pure
 * `sessionLinks`; where each row leads is `linkTargets`, so the click handlers hold no routing.
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Info } from 'lucide-react'
import type { ControlSession } from '@agentistics/tui/control/session-fleet'
import { HARNESS_LABELS } from '../../lib/harness'
import { scrollIsOutside } from '../../lib/popoverScroll'
import { sessionPath } from '../../lib/sessionRoute'
import type { SessionLinks } from '../../lib/sessionParent'

export interface LinkTarget { kind: 'parent' | 'child' | 'task'; key: string; label: string; harness?: string; state?: string; path: string | null }

export function linkTargets(links: SessionLinks): LinkTarget[] {
  const out: LinkTarget[] = []
  if (links.parent) {
    out.push({ kind: 'parent', key: `p:${links.parent.id}`, label: links.parent.title ?? links.parent.id.slice(0, 8),
      path: links.parent.openable ? sessionPath(links.parent.id) : null })
  }
  for (const c of links.children) {
    out.push({ kind: 'child', key: `c:${c.id}`, label: c.title, harness: c.harness, state: c.state, path: sessionPath(c.id) })
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

export function SessionLinkPanel({ links, startedAt, pt, onGo }: {
  links: SessionLinks; startedAt?: number; pt: boolean; onGo: (path: string) => void
}) {
  const targets = linkTargets(links)
  const groups: Array<[LinkTarget['kind'], string]> = [
    ['parent', pt ? 'Sessão de origem' : 'Started by'],
    ['child', pt ? 'Sessões que ela iniciou' : 'Sessions it started'],
    ['task', pt ? 'Tarefa' : 'Task'],
  ]
  const started = when(startedAt, pt)
  return (
    <div data-testid="session-link-panel">
      {groups.map(([kind, title]) => {
        const rows = targets.filter(t => t.kind === kind)
        if (!rows.length) return null
        return (
          <div key={kind}>
            <div style={SECTION}>{title}</div>
            {rows.map(t => {
              const meta = [t.harness ? (HARNESS_LABELS as Record<string, string>)[t.harness] ?? t.harness : null, t.state].filter(Boolean).join(' · ')
              const inner = (
                <>
                  <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.label}</span>
                  {meta && <span style={{ fontSize: 11, color: 'var(--text-tertiary)', flexShrink: 0 }}>{meta}</span>}
                </>
              )
              const style = {
                all: 'unset', boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                padding: '5px 6px', borderRadius: 6, fontSize: 12.5, color: 'var(--text-primary)', minHeight: 28,
              } as const
              return t.path ? (
                <button key={t.key} type="button" data-link-kind={t.kind} onClick={() => onGo(t.path!)}
                  style={{ ...style, cursor: 'pointer' }}>{inner}</button>
              ) : (
                <div key={t.key} data-link-kind={t.kind} style={{ ...style, color: 'var(--text-tertiary)' }}
                  title={pt ? 'Não está mais na frota' : 'No longer in the fleet'}>{inner}</div>
              )
            })}
          </div>
        )
      })}
      {started && <div style={{ ...SECTION, textTransform: 'none', letterSpacing: 0, fontWeight: 400, marginTop: 10 }}>{started}</div>}
    </div>
  )
}

export function SessionLinkInfo({ session, links, lang, onGo, isMobile = false }: {
  session: Pick<ControlSession, 'startedAt'>
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
      if (btnRef.current?.contains(t) || panelRef.current?.contains(t)) return
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

  if (!links) return null
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
          maxHeight: '60vh', overflowY: 'auto', padding: '4px 10px 10px', borderRadius: 10,
          background: 'var(--bg-card)', border: '1px solid var(--border)', boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
        }}>
          <SessionLinkPanel links={links} {...(session.startedAt ? { startedAt: session.startedAt } : {})} pt={pt}
            onGo={p => { setOpen(false); onGo(p) }} />
        </div>, document.body)}
    </>
  )
}

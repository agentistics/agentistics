/**
 * SubtaskSessions — the sessions filed under one subtask, wherever a subtask is drawn.
 *
 * **A subtask holds ANY NUMBER of sessions.** That is new — the cell it replaces was
 * `Subtask.sessionId`, ONE session written straight onto the subtask record, which could not
 * express the ordinary case (a piece of work picked up again the next morning is a second session
 * on the same subtask) and was a second place the link lived: the server's `task-attach.ts` decides
 * where a session is filed, and a field on the other record was a rule nothing enforced. So this
 * reads the SESSIONS and asks which subtask each names, never the other way round. (A session may
 * also be filed on the delivery directly, under no subtask at all — see `task-attach.ts` and
 * docs/superpowers/specs/2026-09-10-task-session-hierarchy-design.md §4.1; that branch is drawn
 * elsewhere, not by this component.)
 *
 * `Subtask.sessionId` still exists on records written before this and is deliberately NOT read
 * here. It is not evidence: `TaskSessionRow.subtaskId` is what every rollup, every filter and the
 * server's own invariant are written against, and rendering a second, unreconciled source beside it
 * would put a session in a subtask the delivery's own arithmetic does not have it in.
 *
 * **ONE `⋯` MENU, not a chip plus a loose `×` plus a loose "mais uma" link.** Product feedback,
 * verbatim: the cell used to show the chip, an unfile `×` right beside it, and a text link that read
 * "filiar" with nothing filed and "mais uma" with something — three controls of three different
 * shapes, wrapping onto their own line the moment the chip's title ran long. Every verb it offered
 * already existed (`onLink`/`onUnfile`/`onOpen`, unchanged below) — this only changes how they are
 * REACHED: the chip stays a chip (openable exactly as before), the `×` and the text link both move
 * into one labeled popover behind a single `MoreHorizontal` trigger — the same trigger-plus-portal-
 * plus-labeled-rows shape `SubtaskActionsMenu`'s gear menu already draws one column to the left of
 * this one, in the same table row (two popovers of the same shape read as one design, not two).
 * With SEVERAL sessions filed, the chips also stop wrapping unbounded: they collapse into one
 * compact "N sessions" pill that opens its OWN small list (each row still opens its own session) —
 * a separate control from the actions menu, because "which one do I open" and "add or remove one"
 * are different questions once there is more than one.
 *
 * **`sessionCellPlan.ts` decides WHAT the menu offers; this file only draws it.** The plan is pure
 * (filtering, the display shape, which of open/unlink/link apply) and is unit-tested directly —
 * this component's own hooks (the two popovers' open/step state) cannot be exercised outside an
 * actual React render, which this repo has no harness for (see `subtaskActionsPlan.ts`'s identical
 * split for `SubtaskActionsMenu`). Every call site MOUNTS this component conditionally
 * (`{!isMember && <SubtaskSessions .../>}`), which is an ordinary conditional render, not a
 * conditional hook call — its hooks only ever run while it is actually mounted.
 */

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ExternalLink, MoreHorizontal, Plus, Unlink, X } from 'lucide-react'
import { microLabel, pill, surface } from './board'
import { SessionRef } from './SessionRef'
import { planSessionCell } from './sessionCellPlan'
import type { Lang } from './copy'
import type { TaskSessionRow } from '../../lib/tasks'

export interface SubtaskSessionsProps {
  /**
   * The ids whose filed sessions should show here — every real caller passes exactly `[id]` today
   * (a plain subtask's own id, or a §F GROUP's own id). This used to be "the subtask's id plus
   * every sibling sharing its `groupId`" under §B's shared-bucket model (docs/superpowers/specs/
   * 2026-09-11-alm-session-linking-ux.md §B.4), where a session filed under ANY member showed on
   * every sibling's chip list. §F (same doc, §F.1) SUPERSEDED that: a group MEMBER can never hold a
   * session of its own (`task-attach.ts`'s `subtask_in_group` refusal), so there is no longer a
   * union of members to compute — a group's chip list is just the sessions filed on the group's own
   * id, exactly like a loose subtask. The field stays an array rather than a bare id because a
   * caller passing one id and a caller passing several cost this component nothing to tell apart.
   */
  subtaskIds: readonly string[]
  /** Where a NEW session gets filed — this row's own id, never a sibling's. */
  subtaskId: string
  /** The DELIVERY's sessions — every one of them. This filters to the ones filed here. */
  sessions: readonly TaskSessionRow[]
  lang: Lang
  /** Offer this subtask a session (the old "filiar"/"mais uma" flow — unchanged). */
  onLink: (subtaskId: string) => void
  /** Take one out of it (the old loose `×` — unchanged). */
  onUnfile: (sessionId: string) => void
  /** Open the session's own screen. Absent renders labels instead of controls. */
  onOpen?: (sessionId: string) => void
  mobile?: boolean
}

type MenuStep = 'menu' | 'unlink'

const rowButtonStyle = (mobile: boolean | undefined, danger = false): React.CSSProperties => ({
  display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-start',
  background: 'none', border: 'none', borderRadius: 6,
  padding: '7px 8px', textAlign: 'left',
  color: danger ? 'var(--accent-red)' : 'var(--text-primary)',
  cursor: 'pointer', fontSize: 12, fontFamily: 'inherit',
  minHeight: mobile ? 44 : undefined, width: '100%',
})

const menuTrigger: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-tertiary)',
  borderRadius: 5, padding: '4px 5px', cursor: 'pointer', flexShrink: 0,
}

/** A portal-positioned popover, measured from its trigger and clamped to the viewport — the exact
 *  shape `SubtaskActionsMenu`'s gear menu already uses one column to the left of this cell, so a
 *  table cut short by `overflow-x: auto` never clips either one. */
function usePopover(width: number) {
  const [open, setOpen] = useState(false)
  const [at, setAt] = useState<{ left: number; top: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => {
      const t = e.target as Node
      if (triggerRef.current?.contains(t)) return
      if (boxRef.current && !boxRef.current.contains(t)) setOpen(false)
    }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', down)
      document.removeEventListener('keydown', key)
    }
  }, [open])

  const toggle = () => {
    if (open) { setOpen(false); return }
    const r = triggerRef.current?.getBoundingClientRect()
    if (r) setAt({ left: Math.min(r.left, window.innerWidth - width - 8), top: r.bottom + 6 })
    setOpen(true)
  }

  return { open, setOpen, at, triggerRef, boxRef, toggle }
}

export function SubtaskSessions(p: SubtaskSessionsProps) {
  const pt = p.lang === 'pt'
  const plan = planSessionCell(p.sessions, p.subtaskIds, p.onOpen !== undefined)
  const openTarget = plan.open
  const unlinkTarget = plan.unlink.kind === 'one' ? plan.unlink.session : null

  const menu = usePopover(220)
  const [step, setStep] = useState<MenuStep>('menu')
  const closeMenu = () => { menu.setOpen(false); setStep('menu') }

  // Only ever opened when `plan.display.kind === 'multi'` — see the render below.
  const list = usePopover(240)

  const runLink = () => { closeMenu(); p.onLink(p.subtaskId) }
  const runUnfile = (id: string) => { closeMenu(); p.onUnfile(id) }
  const runOpen = (id: string) => { closeMenu(); p.onOpen?.(id) }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
      {/* One chip, exactly as before — still opens the session on its own click. */}
      {plan.display.kind === 'single' && (
        <SessionRef
          id={plan.display.session.id}
          title={plan.display.session.label}
          harness={plan.display.session.harness}
          lang={p.lang}
          historical={plan.display.session.historical === true}
          onOpen={p.onOpen}
        />
      )}

      {/* Several: a compact count instead of an unbounded wrap of chips — its OWN small list still
          lets you open each one, separately from the actions menu below. */}
      {plan.display.kind === 'multi' && (
        <button
          ref={list.triggerRef}
          onClick={list.toggle}
          className="ag-tap"
          style={{
            ...pill(), cursor: 'pointer', fontFamily: 'inherit', fontSize: 11.5,
            border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-secondary)',
          }}
        >
          {plan.sessions.length} {pt ? 'sessões' : 'sessions'}
        </button>
      )}

      {plan.display.kind === 'multi' && list.open && list.at && createPortal(
        <div
          ref={list.boxRef}
          style={{
            position: 'fixed', left: list.at.left, top: list.at.top, width: 240, zIndex: 60,
            ...surface, background: 'var(--bg-elevated)', padding: 8, display: 'grid', gap: 5,
            boxShadow: 'var(--shadow-elevated)', maxHeight: '60vh', overflowY: 'auto',
          }}
        >
          <span style={microLabel}>{pt ? 'Sessões' : 'Sessions'}</span>
          {plan.sessions.map(s => (
            <SessionRef
              key={s.id}
              id={s.id}
              title={s.label}
              harness={s.harness}
              lang={p.lang}
              historical={s.historical === true}
              onOpen={p.onOpen ? id => { list.setOpen(false); p.onOpen!(id) } : undefined}
            />
          ))}
        </div>,
        document.body,
      )}

      {/* The ONE actions menu — every verb it offers already existed (`onLink`/`onUnfile`/`onOpen`);
          this is only where they are reached from now. `sessionCellPlan.ts` decides which rows this
          count of sessions may offer; this only draws them. */}
      <button
        ref={menu.triggerRef}
        onClick={menu.toggle}
        title={pt ? 'Ações de sessão' : 'Session actions'}
        aria-label={pt ? 'Ações de sessão' : 'Session actions'}
        className="ag-tap-icon"
        style={menuTrigger}
      ><MoreHorizontal size={13} /></button>

      {menu.open && menu.at && createPortal(
        <div
          ref={menu.boxRef}
          style={{
            position: 'fixed', left: menu.at.left, top: menu.at.top, width: 220, zIndex: 60,
            ...surface, background: 'var(--bg-elevated)', padding: 8, display: 'grid', gap: 2,
            boxShadow: 'var(--shadow-elevated)', maxHeight: '60vh', overflowY: 'auto',
          }}
        >
          {step === 'unlink' && (
            <button
              onClick={() => setStep('menu')}
              style={{
                display: 'flex', alignItems: 'center', gap: 4, background: 'none', border: 'none',
                color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: 11, padding: '2px 0',
                fontFamily: 'inherit', justifySelf: 'start',
              }}
            ><ChevronLeft size={12} /> {pt ? 'Voltar' : 'Back'}</button>
          )}

          {step === 'menu' && (
            <>
              <button onClick={runLink} style={rowButtonStyle(p.mobile)}>
                <Plus size={13} />
                {plan.link === 'link'
                  ? (pt ? 'Associar sessão' : 'Link a session')
                  : (pt ? 'Adicionar mais uma' : 'Add another')}
              </button>

              {/* Only when exactly one filed session is a live, openable target — see
                  `sessionCellPlan.ts`'s own doc comment for the historical/several exclusions. */}
              {openTarget && (
                <button onClick={() => runOpen(openTarget.id)} style={rowButtonStyle(p.mobile)}>
                  <ExternalLink size={13} /> {pt ? 'Abrir sessão' : 'Open session'}
                </button>
              )}

              {unlinkTarget && (
                <button onClick={() => runUnfile(unlinkTarget.id)} style={rowButtonStyle(p.mobile, true)}>
                  <Unlink size={13} /> {pt ? 'Desassociar sessão' : 'Unlink session'}
                </button>
              )}
              {plan.unlink.kind === 'pick' && (
                <button onClick={() => setStep('unlink')} style={rowButtonStyle(p.mobile, true)}>
                  <Unlink size={13} /> {pt ? 'Desassociar sessão' : 'Unlink session'}
                </button>
              )}
            </>
          )}

          {step === 'unlink' && (
            <>
              <span style={microLabel}>{pt ? 'Desassociar qual?' : 'Unlink which?'}</span>
              {plan.sessions.map(s => (
                <button
                  key={s.id}
                  onClick={() => runUnfile(s.id)}
                  style={{ ...rowButtonStyle(p.mobile, true), justifyContent: 'space-between' }}
                >
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {s.label?.trim() || s.id.slice(0, 8)}
                  </span>
                  <X size={12} style={{ flexShrink: 0 }} />
                </button>
              ))}
            </>
          )}
        </div>,
        document.body,
      )}
    </span>
  )
}

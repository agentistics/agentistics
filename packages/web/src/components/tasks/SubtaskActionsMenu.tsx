/**
 * SubtaskActionsMenu — the ONE actions menu for a subtask/group row, opened from a single gear
 * icon LEADING the row (before the title column).
 *
 * Direct, blunt product feedback on the row this replaces: "I want the dispatch and create-session
 * options more visible and understandable — today it's horrible, nobody knows what it means. The
 * row is also gigantic." The row had accumulated a pile of small icon-only buttons with no visible
 * text — a "bloqueado por" badge, a group-forming trigger, a staged-session compose/edit/fire icon
 * set, and a bare delete icon — each with only a `title=` tooltip to say what it did. This is one
 * trigger, one popover, every action a labeled text row.
 *
 * It absorbs what used to be `SubtaskGroupMenu`'s and `SubtaskBlockedBy`'s own standalone popovers
 * as STEPS of this same menu, rather than leaving them as separate triggers beside a new one — two
 * triggers next to each other would be the pile rearranged, not reduced. Both former components are
 * gone; nothing else in the app rendered them on their own.
 *
 * The staged-session block is OPTIONAL (`p.staged`). `TaskTable.tsx`'s inline subitem rows have
 * never had the compose-dialog/fire wiring threaded down to them — no `taskFiles`, no
 * `onSaveStagedSession`, nothing. That is a pre-existing gap in that surface, not something this
 * pass invents, so passing no `staged` prop there simply omits the section: both surfaces share one
 * component and one interaction pattern (the gear, the popover, the labeled rows), and each shows
 * only the actions it can actually run.
 *
 * "Blocked by" and the group gestures get their own STEP (not a single tap-and-done action) because
 * each needs its own follow-on UI — a list of current blockers with per-row remove, a picker to add
 * one; a picker to choose who to form a group with, or which group to join. `ChevronLeft` returns to
 * the top-level list, so the whole thing stays one popover rather than opening a second one.
 */

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Ban, ChevronLeft, Plus, Rocket, Settings, SquarePen, Trash2, Users, XCircle,
} from 'lucide-react'
import { useIsMobile } from '../../hooks/useIsMobile'
import { Select } from '../../pages/settings/primitives'
import { STATUS, microLabel, pill, surface, type BoardStatus } from './board'
import { statusLabel, type Lang } from './copy'
import { createGroupCandidates, groupMembers, groupOf, joinGroupCandidates } from './subtaskGroups'
import { planSubtaskActions } from './subtaskActionsPlan'
import type { StatusRefusalReason, StatusWriteResult, Subtask, SubtaskPatch } from '../../lib/tasks'

export interface SubtaskActionsMenuProps {
  subtask: Subtask
  /** The delivery's OTHER subtasks — the only pool blocked-by and group candidates come from. */
  siblings: readonly Subtask[]
  lang: Lang
  /** Patch ANY subtask of this delivery by id — used for this row and, while forming a group, for
   *  the sibling being joined to it. */
  onPatch: (id: string, patch: SubtaskPatch) => Promise<StatusWriteResult>
  onRemove: (id: string) => void | Promise<void>
  /** Mint a new GROUP subtask (§F.1) and return its id, or `null` on failure. */
  onCreateGroup: (title: string) => Promise<string | null>
  /**
   * The staged-session lifecycle (t-918cc82233) — absent on a surface with no compose/fire wiring
   * (see file doc comment). Gated on the subtask NOT being a group member (`subtaskActionsPlan.ts`),
   * same as every other session-filing control on this row: a group member can never hold a session
   * of its own.
   */
  staged?: {
    hasDraft: boolean
    /** This subtask's own fire-in-progress flag, so the row reads busy instead of inert. */
    preparing: boolean
    onCompose: () => void
    onEdit: () => void
    onFire: () => void
  }
}

function refusalText(pt: boolean, reason: StatusRefusalReason | undefined): string {
  switch (reason) {
    case 'invalid_group':
      return pt
        ? 'Esse grupo não existe mais, ou pertence a outra entrega.'
        : 'That group no longer exists, or belongs to another delivery.'
    case 'subtask_has_sessions':
      return pt
        ? 'Essa subtarefa já tem uma sessão filiada — desfilie antes de agrupar.'
        : 'That subtask already has a session filed under it — unfile it before grouping.'
    case 'group_field_conflict':
      return pt
        ? 'Conflito com um agrupamento antigo desta subtarefa.'
        : 'Conflicts with a legacy grouping already on this subtask.'
    default:
      return pt ? 'Não foi possível concluir a ação.' : 'Could not complete that action.'
  }
}

type Step = 'menu' | 'blocked-by' | 'pick-member' | 'pick-group'

const rowButtonStyle = (mobile: boolean, danger = false): React.CSSProperties => ({
  display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-start',
  background: 'none', border: 'none', borderRadius: 6,
  padding: '7px 8px', textAlign: 'left',
  color: danger ? 'var(--accent-red)' : 'var(--text-primary)',
  cursor: 'pointer', fontSize: 12, fontFamily: 'inherit',
  minHeight: mobile ? 44 : undefined, width: '100%',
})

const sectionStyle: React.CSSProperties = {
  display: 'grid', gap: 2, paddingBottom: 4, borderBottom: '1px solid var(--border-subtle)',
}

export function SubtaskActionsMenu(p: SubtaskActionsMenuProps) {
  const isMobile = useIsMobile()
  const pt = p.lang === 'pt'
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<Step>('menu')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [pickingBlocker, setPickingBlocker] = useState(false)
  const [at, setAt] = useState<{ left: number; top: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  const close = () => { setOpen(false); setStep('menu'); setError(null); setPickingBlocker(false) }

  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => {
      const t = e.target as Node
      if (triggerRef.current?.contains(t)) return
      if (boxRef.current && !boxRef.current.contains(t)) close()
    }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', down)
      document.removeEventListener('keydown', key)
    }
  }, [open])

  const toggle = () => {
    if (open) { close(); return }
    const r = triggerRef.current?.getBoundingClientRect()
    if (r) setAt({ left: Math.min(r.left, window.innerWidth - 280 - 8), top: r.bottom + 6 })
    setOpen(true)
  }

  const runPatch = async (id: string, patch: SubtaskPatch) => {
    setBusy(true)
    const result = await p.onPatch(id, patch)
    setBusy(false)
    if (!result.ok) { setError(refusalText(pt, result.reason)); return false }
    return true
  }

  // The single source of "which actions may this row offer" — see `subtaskActionsPlan.ts`'s own doc
  // comment. Nothing below re-derives a gate this plan already answered; the rendering only reads
  // the candidate LISTS it needs for a picker's options once the plan says that picker is offered.
  const plan = planSubtaskActions(p.subtask, p.siblings, {
    hasStagedDraft: p.staged?.hasDraft ?? false,
    stagedWired: p.staged !== undefined,
  })
  const isGroup = plan.group.kind === 'group'
  const isMember = plan.group.kind === 'member'
  const parent = isMember ? groupOf(p.subtask, p.siblings) : undefined
  const members = isGroup ? groupMembers(p.subtask.id, p.siblings) : []
  const createCandidates = plan.group.kind === 'loose' && plan.group.canCreate
    ? createGroupCandidates(p.subtask.id, p.siblings) : []
  const joinCandidates = plan.group.kind === 'loose' && plan.group.canJoin
    ? joinGroupCandidates(p.siblings) : []

  const blockedBy = p.subtask.blockedBy ?? []
  const blockers = blockedBy
    .map(id => p.siblings.find(s => s.id === id))
    .filter((s): s is Subtask => s !== undefined)
  const openBlockers = blockers.filter(b => !b.done)

  const setBlockedBy = async (ids: string[]) => { await p.onPatch(p.subtask.id, { blockedBy: ids }) }

  const createGroupWith = async (memberId: string) => {
    const sibling = p.siblings.find(s => s.id === memberId)
    if (!sibling) { setError(refusalText(pt, undefined)); return }
    setBusy(true)
    const groupId = await p.onCreateGroup(`${p.subtask.title} + ${sibling.title}`)
    setBusy(false)
    if (!groupId) { setError(refusalText(pt, undefined)); return }
    if (!(await runPatch(p.subtask.id, { parentGroupId: groupId }))) return
    if (!(await runPatch(memberId, { parentGroupId: groupId }))) return
    close()
  }

  const joinGroup = async (groupId: string) => {
    if (await runPatch(p.subtask.id, { parentGroupId: groupId })) close()
  }

  const leaveGroup = async () => {
    if (await runPatch(p.subtask.id, { parentGroupId: null })) close()
  }

  const dissolveGroup = async () => {
    setBusy(true)
    await p.onRemove(p.subtask.id)
    setBusy(false)
    close()
  }

  const title = pt ? 'Ações da subtarefa' : 'Subtask actions'
  const stepTitle: Record<Step, string> = {
    menu: title,
    'blocked-by': pt ? 'Bloqueada por' : 'Blocked by',
    'pick-member': pt ? 'Criar grupo com…' : 'Create group with…',
    'pick-group': pt ? 'Entrar em grupo existente…' : 'Join existing group…',
  }

  return (
    <>
      {/* Icon-only, small on purpose — `.ag-tap-icon` projects the mobile 44px hit area around it
          (index.css) without painting a 44x44 box in a table cell that has no room to spare. */}
      <button
        ref={triggerRef} onClick={toggle} title={title} aria-label={title}
        className="ag-tap-icon"
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-tertiary)',
          borderRadius: 5, padding: '4px 5px', cursor: 'pointer', flexShrink: 0,
        }}
      ><Settings size={13} /></button>

      {open && at && createPortal(
        <div
          ref={boxRef}
          style={{
            position: 'fixed', left: at.left, top: at.top, width: 280, zIndex: 60,
            ...surface, background: 'var(--bg-elevated)', padding: 10, display: 'grid', gap: 6,
            boxShadow: 'var(--shadow-elevated)', maxHeight: '70vh', overflowY: 'auto',
          }}
        >
          {step !== 'menu' && (
            <button
              onClick={() => { setStep('menu'); setError(null); setPickingBlocker(false) }}
              style={{
                display: 'flex', alignItems: 'center', gap: 4, background: 'none', border: 'none',
                color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: 11, padding: '2px 0',
                fontFamily: 'inherit', justifySelf: 'start',
              }}
            ><ChevronLeft size={12} /> {pt ? 'Voltar' : 'Back'}</button>
          )}
          <span style={microLabel}>{stepTitle[step]}</span>

          {error && (
            <div style={{
              display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 11,
              color: 'var(--accent-red)', lineHeight: 1.4,
            }}>
              <XCircle size={12} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>{error}</span>
            </div>
          )}

          {step === 'menu' && (
            <>
              {/* Staged-session dispatch — the "dispatch and create-session" the feedback named
                  directly. `plan.staged` is `null` on a group MEMBER (can never hold a session of
                  its own) and on a surface with no compose/fire wiring at all (`p.staged` absent) —
                  see `subtaskActionsPlan.ts`. */}
              {plan.staged && p.staged && (
                <div style={sectionStyle}>
                  {plan.staged === 'fire-or-edit' ? (
                    <>
                      <button
                        onClick={() => { close(); p.staged!.onFire() }} disabled={p.staged.preparing}
                        style={{
                          ...rowButtonStyle(isMobile), color: 'var(--anthropic-orange)', fontWeight: 650,
                          cursor: p.staged.preparing ? 'wait' : 'pointer', opacity: p.staged.preparing ? 0.6 : 1,
                        }}
                      >
                        <Rocket size={13} />
                        {p.staged.preparing
                          ? (pt ? 'Preparando…' : 'Preparing…')
                          : (pt ? 'Disparar sessão' : 'Fire session')}
                      </button>
                      <button onClick={() => { close(); p.staged!.onEdit() }} style={rowButtonStyle(isMobile)}>
                        <SquarePen size={13} /> {pt ? 'Editar sessão preparada' : 'Edit staged session'}
                      </button>
                    </>
                  ) : (
                    <button onClick={() => { close(); p.staged!.onCompose() }} style={rowButtonStyle(isMobile)}>
                      <Rocket size={13} /> {pt ? 'Preparar sessão' : 'Stage a session'}
                    </button>
                  )}
                </div>
              )}

              <button onClick={() => setStep('blocked-by')} style={rowButtonStyle(isMobile)}>
                <Ban size={13} />
                <span style={{ flex: 1 }}>{pt ? 'Bloqueada por…' : 'Blocked by…'}</span>
                {openBlockers.length > 0 && (
                  <span style={{ fontSize: 10.5, color: 'var(--accent-red)', fontWeight: 700 }}>
                    {openBlockers.length}
                  </span>
                )}
              </button>

              <div style={sectionStyle}>
                {plan.group.kind === 'group' && (
                  <>
                    <div style={{ fontSize: 11, color: 'var(--text-tertiary)', padding: '2px 8px' }}>
                      {pt
                        ? `${members.length} subtarefa(s) neste grupo.`
                        : `${members.length} subtask(s) in this group.`}
                    </div>
                    <button disabled={busy} onClick={() => void dissolveGroup()} style={rowButtonStyle(isMobile, true)}>
                      <Users size={13} /> {pt ? 'Dissolver grupo' : 'Dissolve group'}
                    </button>
                  </>
                )}
                {plan.group.kind === 'member' && (
                  <>
                    <div style={{ fontSize: 11, color: 'var(--text-tertiary)', padding: '2px 8px' }}>
                      {parent?.title ?? (pt ? '(grupo não encontrado)' : '(group not found)')}
                    </div>
                    <button disabled={busy} onClick={() => void leaveGroup()} style={rowButtonStyle(isMobile, true)}>
                      <Users size={13} /> {pt ? 'Sair do grupo' : 'Leave group'}
                    </button>
                  </>
                )}
                {plan.group.kind === 'loose' && (plan.group.canCreate || plan.group.canJoin) && (
                  <>
                    {plan.group.canCreate && (
                      <button onClick={() => setStep('pick-member')} style={rowButtonStyle(isMobile)}>
                        <Users size={13} /> {pt ? 'Criar grupo com…' : 'Create group with…'}
                      </button>
                    )}
                    {plan.group.canJoin && (
                      <button onClick={() => setStep('pick-group')} style={rowButtonStyle(isMobile)}>
                        <Users size={13} /> {pt ? 'Entrar em grupo existente…' : 'Join existing group…'}
                      </button>
                    )}
                  </>
                )}
              </div>

              {/* `plan.canRemove` is always true today — kept as an explicit read rather than a
                  bare unconditional render so a future rule that DOES need to withhold it has one
                  place to change (see `subtaskActionsPlan.ts`). */}
              {plan.canRemove && (
                <button onClick={() => void p.onRemove(p.subtask.id)} style={rowButtonStyle(isMobile, true)}>
                  <Trash2 size={13} /> {pt ? 'Remover subtarefa' : 'Remove subtask'}
                </button>
              )}
            </>
          )}

          {step === 'blocked-by' && (
            <>
              {blockers.length === 0 && (
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                  {pt ? 'Nada bloqueia esta subtarefa.' : 'Nothing is blocking this subtask.'}
                </div>
              )}
              {blockers.map(b => (
                <div key={b.id} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <span style={{
                    fontSize: 11.5, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    textDecoration: b.done ? 'line-through' : 'none',
                    color: b.done ? 'var(--text-tertiary)' : 'var(--text-secondary)',
                  }}>{b.title}</span>
                  <span style={pill(STATUS[b.status as BoardStatus]?.color)}>
                    {statusLabel(b.status, p.lang)}
                  </span>
                  <button
                    onClick={() => void setBlockedBy(blockedBy.filter(x => x !== b.id))}
                    style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', display: 'flex' }}
                    title={pt ? 'Remover' : 'Remove'}
                  ><XCircle size={12} /></button>
                </div>
              ))}
              {pickingBlocker
                ? (
                  <Select
                    value=""
                    placeholder={pt ? 'Escolher uma subtarefa…' : 'Pick a subtask…'}
                    searchPlaceholder={pt ? 'Buscar…' : 'Search…'}
                    options={p.siblings
                      .filter(s => s.id !== p.subtask.id && !blockedBy.includes(s.id))
                      .map(s => ({ value: s.id, label: s.title, hint: statusLabel(s.status, p.lang) }))}
                    onChange={v => { if (v) void setBlockedBy([...blockedBy, v]); setPickingBlocker(false) }}
                  />
                )
                : (
                  <button
                    onClick={() => setPickingBlocker(true)}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 5, justifySelf: 'start',
                      background: 'none', border: '1px dashed var(--border)', borderRadius: 6,
                      padding: '5px 8px', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 11.5,
                      minHeight: isMobile ? 34 : undefined,
                    }}
                  ><Plus size={12} /> {pt ? 'Adicionar bloqueio' : 'Add blocker'}</button>
                )}
            </>
          )}

          {step === 'pick-member' && (
            <Select
              value=""
              placeholder={pt ? 'Escolher uma subtarefa…' : 'Pick a subtask…'}
              searchPlaceholder={pt ? 'Buscar…' : 'Search…'}
              options={createCandidates.map(s => ({ value: s.id, label: s.title }))}
              onChange={v => { if (v) void createGroupWith(v) }}
            />
          )}

          {step === 'pick-group' && (
            <Select
              value=""
              placeholder={pt ? 'Escolher um grupo…' : 'Pick a group…'}
              searchPlaceholder={pt ? 'Buscar…' : 'Search…'}
              options={joinCandidates.map(s => ({ value: s.id, label: s.title }))}
              onChange={v => { if (v) void joinGroup(v) }}
            />
          )}
        </div>,
        document.body,
      )}
    </>
  )
}

/**
 * SubtaskGroupMenu — the group-forming gestures for one subtask row (§F.1 of docs/superpowers/specs/
 * 2026-09-11-alm-session-linking-ux.md: a "grupo de subtasks" is a real hierarchy level, a peer of a
 * loose subtask in the same listing, never a nested sub-list).
 *
 * Same popover shape as `SubtaskBlockedBy` — a small trigger badge, a portal panel positioned under
 * it — for the same reason: this sits inside a table row where a person is scanning many of them,
 * and a control that stays collapsed until asked for is what keeps the row a row.
 *
 * One component draws all four shapes a row can be in:
 *  - a LOOSE subtask (neither a group nor a member) offers "Criar grupo com…" / "Entrar em grupo
 *    existente…";
 *  - a GROUP shows its member count and offers "Dissolver grupo";
 *  - a MEMBER shows which group it belongs to and offers "Sair do grupo".
 *
 * Every write goes through the SAME primitives the row already has (`onPatch`/`onCreateGroup`/
 * `onRemove`) — this component orchestrates the multi-step "mint a group, then join two rows to it"
 * flow, but the server is still the only place a group write can actually be refused
 * (`checkParentGroup`, `task-attach.ts`'s `invalid_group`/`subtask_has_sessions`/
 * `group_field_conflict`). A refusal is always shown in words, never swallowed — the same standard
 * `DoneNeedsSessionDialog` already holds this board to.
 */

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Users, XCircle } from 'lucide-react'
import { useIsMobile } from '../../hooks/useIsMobile'
import { Select } from '../../pages/settings/primitives'
import { microLabel, surface } from './board'
import type { Lang } from './copy'
import {
  createGroupCandidates, groupMembers, groupOf, isGroupMember, isGroupSubtask, joinGroupCandidates,
} from './subtaskGroups'
import type { StatusRefusalReason, StatusWriteResult, Subtask } from '../../lib/tasks'

export interface SubtaskGroupMenuProps {
  subtask: Subtask
  /** The delivery's OTHER subtasks — the only pool a group or a member can come from (§F.1: a
   *  group can never span two parent tasks). */
  siblings: readonly Subtask[]
  lang: Lang
  /** Patch ANY subtask of this delivery by id — used both for this row and, while forming a group,
   *  for the sibling being joined to it. */
  onPatch: (id: string, patch: { parentGroupId?: string | null }) => Promise<StatusWriteResult>
  /** Mint a new GROUP subtask and return its id, or `null` on failure. */
  onCreateGroup: (title: string) => Promise<string | null>
  /** Delete a subtask by id — used to dissolve a group (the store already folds its former members
   *  back into ordinary loose subtasks, see `task-store.ts`'s `removeSubtask`). */
  onRemove: (id: string) => void | Promise<void>
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

type Step = 'menu' | 'pick-member' | 'pick-group'

const triggerStyle = (color: string, mobile: boolean): React.CSSProperties => ({
  display: 'inline-flex', alignItems: 'center', gap: 3,
  border: `1px solid ${color}`, background: 'transparent', color,
  borderRadius: 5, padding: '3px 6px', cursor: 'pointer', fontSize: 10,
  // 44px is the MOBILE touch-target floor — the glyph stays small, the tappable box does not.
  minHeight: mobile ? 44 : undefined, minWidth: mobile ? 44 : undefined,
})

const menuButtonStyle = (mobile: boolean): React.CSSProperties => ({
  display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-start',
  background: 'none', border: '1px dashed var(--border)', borderRadius: 6,
  padding: '5px 8px', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 11.5,
  minHeight: mobile ? 44 : undefined, width: '100%',
})

const dangerButtonStyle = (mobile: boolean): React.CSSProperties => ({
  display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-start',
  background: 'none', border: '1px solid var(--accent-red)', borderRadius: 6,
  padding: '5px 8px', color: 'var(--accent-red)', cursor: 'pointer', fontSize: 11.5,
  minHeight: mobile ? 44 : undefined, width: '100%',
})

export function SubtaskGroupMenu(p: SubtaskGroupMenuProps) {
  const isMobile = useIsMobile()
  const pt = p.lang === 'pt'
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<Step>('menu')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [at, setAt] = useState<{ left: number; top: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  const close = () => { setOpen(false); setStep('menu'); setError(null) }

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
    if (r) setAt({ left: Math.min(r.left, window.innerWidth - 260 - 8), top: r.bottom + 6 })
    setOpen(true)
  }

  const runPatch = async (id: string, patch: { parentGroupId?: string | null }) => {
    setBusy(true)
    const result = await p.onPatch(id, patch)
    setBusy(false)
    if (!result.ok) { setError(refusalText(pt, result.reason)); return false }
    return true
  }

  const isGroup = isGroupSubtask(p.subtask)
  const isMember = isGroupMember(p.subtask)
  const parent = isMember ? groupOf(p.subtask, p.siblings) : undefined
  const members = isGroup ? groupMembers(p.subtask.id, p.siblings) : []
  const createCandidates = !isGroup && !isMember ? createGroupCandidates(p.subtask.id, p.siblings) : []
  const joinCandidates = !isGroup && !isMember ? joinGroupCandidates(p.siblings) : []

  // A loose subtask with nothing to group with or join draws no control at all — an offer that
  // always refuses is noise on every row, the same reasoning `SubtaskBlockedBy` applies to its own
  // trigger when there is nothing to say yet.
  if (!isGroup && !isMember && createCandidates.length === 0 && joinCandidates.length === 0) return null

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

  const title = isGroup
    ? (pt ? 'Grupo de subtarefas' : 'Subtask group')
    : isMember
      ? (pt ? 'Parte de um grupo' : 'Part of a group')
      : (pt ? 'Agrupar subtarefas' : 'Group subtasks')

  return (
    <>
      <button
        ref={triggerRef} onClick={toggle} title={title}
        style={triggerStyle(
          isGroup ? 'var(--accent-purple)' : isMember ? 'var(--accent-blue)' : 'var(--text-tertiary)',
          isMobile,
        )}
      >
        <Users size={11} />
        {isGroup && members.length}
      </button>

      {open && at && createPortal(
        <div
          ref={boxRef}
          style={{
            position: 'fixed', left: at.left, top: at.top, width: 250, zIndex: 60,
            ...surface, background: 'var(--bg-elevated)', padding: 10, display: 'grid', gap: 8,
            boxShadow: 'var(--shadow-elevated)',
          }}
        >
          <span style={microLabel}>{title}</span>

          {error && (
            <div style={{
              display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 11,
              color: 'var(--accent-red)', lineHeight: 1.4,
            }}>
              <XCircle size={12} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>{error}</span>
            </div>
          )}

          {isGroup && (
            <>
              <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                {pt
                  ? `${members.length} subtarefa(s) neste grupo.`
                  : `${members.length} subtask(s) in this group.`}
              </div>
              <button disabled={busy} style={dangerButtonStyle(isMobile)} onClick={() => void dissolveGroup()}>
                {pt ? 'Dissolver grupo' : 'Dissolve group'}
              </button>
            </>
          )}

          {isMember && (
            <>
              <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                {parent?.title ?? (pt ? '(grupo não encontrado)' : '(group not found)')}
              </div>
              <button disabled={busy} style={dangerButtonStyle(isMobile)} onClick={() => void leaveGroup()}>
                {pt ? 'Sair do grupo' : 'Leave group'}
              </button>
            </>
          )}

          {!isGroup && !isMember && step === 'menu' && (
            <>
              {createCandidates.length > 0 && (
                <button style={menuButtonStyle(isMobile)} onClick={() => setStep('pick-member')}>
                  {pt ? 'Criar grupo com…' : 'Create group with…'}
                </button>
              )}
              {joinCandidates.length > 0 && (
                <button style={menuButtonStyle(isMobile)} onClick={() => setStep('pick-group')}>
                  {pt ? 'Entrar em grupo existente…' : 'Join existing group…'}
                </button>
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

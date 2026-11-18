/**
 * rowMenuCascade.ts — PURE: regroups the session row menu's FLAT entry list into the approved
 * "Cascata por assunto" layout (SESSAO.MENU-AGRUPADO, owner 2026-11-17: "opção A").
 *
 * It composes NO entry of its own except the two disabled team rows a leader is told about (the
 * prototype shows them with "Um líder não entra em equipe."). Every other item is one the flat
 * builders (`rowMenuEntries`, `taskMenuEntries`, the group / role / team / notify extras) already
 * produced, moved to where its subject lives. An action this module does not know stays at the top
 * level — an unknown entry is never dropped, so no action can become unreachable by being forgotten
 * here.
 *
 *   top      Renomear · Abrir ▸ · Parar o que está fazendo · Reabrir
 *   ───
 *   middle   Tarefa ▸ (task name as hint) · Organizar ▸ · Tipo ▸ (current type as hint) · Silenciar
 *   ───
 *   bottom   Encerrar sessão (red) · Arquivar · Remover da lista
 */

import type { MenuEntry } from './rowMenu'
import { LINK_TASK, UNLINK_TASK } from './rowMenu'
import { TEAM_MOVE, TEAM_UNLINK } from './teamMenu'
import { NOTIFY_TOGGLE } from './notifyMenu'
import { NAY_UNDOCK_SESSION } from './nayDockBridge'

export const OPEN_BESIDE = '__open_beside__'
export const PIN_TOGGLE = '__pin_toggle__'

export interface CascadeContext {
  pt: boolean
  /** The task name of the row, when it has one. */
  task?: string | undefined
  /** A leader never joins a team — its two team rows are shown disabled, with the reason. */
  isLeader?: boolean
}

const isRole = (a: string) => a.startsWith('session-role:')

export function cascadeRowMenu(flat: readonly MenuEntry[], ctx: CascadeContext): MenuEntry[] {
  const { pt } = ctx
  const take = (pred: (e: MenuEntry) => boolean) => flat.filter(pred)
  const by = (...actions: string[]) => take(e => actions.includes(e.action))
  const claimed = new Set<MenuEntry>()
  const claim = (list: MenuEntry[]) => { list.forEach(e => claimed.add(e)); return list }

  const rename = claim(by('rename'))
  const open = claim([...by(OPEN_BESIDE), ...by(NAY_UNDOCK_SESSION)])
  const interrupt = claim(by('interrupt'))
  // A DISABLED, reason-less Reabrir on a live row is noise (nothing to explain, nothing to do): the
  // prototype leaves it out. With a reason, or enabled, it stays.
  const resume = claim(by('resume')).filter(e => e.enabled || e.reason)
  const taskEntries = claim(take(e => e.action === LINK_TASK || e.action === UNLINK_TASK))
  const pin = claim(by(PIN_TOGGLE))
  const group = claim(by('move-to-group', 'remove-from-group'))
  let team = claim(by(TEAM_MOVE, TEAM_UNLINK))
  const roles = claim(take(e => isRole(e.action)))
  claim(by('session-role-label'))
  const notify = claim(by(NOTIFY_TOGGLE))
  const kill = claim(by('kill'))
  const archive = claim(by('archive'))
  const forget = claim(by('forget'))
  const rest = flat.filter(e => !claimed.has(e))

  if (team.length === 0 && ctx.isLeader && (group.length > 0 || pin.length > 0)) {
    const reason = pt ? 'Um líder não entra em equipe.' : 'A leader does not join a team.'
    team = [
      { action: TEAM_MOVE, label: pt ? 'Mover para a equipe de…' : "Move to a leader's team…", enabled: false, reason },
      { action: TEAM_UNLINK, label: pt ? 'Tirar da equipe' : 'Take out of the team', enabled: false, reason },
    ]
  }

  const clean = (e: MenuEntry): MenuEntry => { const { separatorBefore: _s, ...r } = e; return r }
  const sub = (label: string, icon: string, children: MenuEntry[], extra: Partial<MenuEntry> = {}): MenuEntry[] =>
    children.length === 0 ? [] : [{ action: `submenu:${icon}`, label, icon, enabled: true, children, ...extra }]

  // Tarefa: filed → [open, move, unlink] under the task's name; unfiled → the one "file" entry.
  const link = taskEntries.filter(e => e.action === LINK_TASK)
  const unlink = taskEntries.filter(e => e.action === UNLINK_TASK)
  const taskChildren: MenuEntry[] = ctx.task && link.length >= 2
    ? [
      { ...clean(link[0]!), label: pt ? 'Abrir a tarefa' : 'Open the task' },
      { ...clean(link[1]!), label: pt ? 'Mover para outra tarefa…' : 'Move to another task…' },
      ...unlink.map(e => ({ ...clean(e), label: pt ? 'Desvincular da tarefa' : 'Unlink from the task' })),
    ]
    : taskEntries.map(clean)
  const tarefa = sub(pt ? 'Tarefa' : 'Task', 'task', taskChildren, {
    ...(ctx.task ? { hint: ctx.task, heading: ctx.task } : {}),
  })

  const sep = (e: MenuEntry): MenuEntry => ({ ...e, separatorBefore: true })
  const organizar = sub(pt ? 'Organizar' : 'Organize', 'folder', [
    ...pin.map(clean),
    ...group.map((e, i) => (i === 0 && pin.length > 0 ? sep(clean(e)) : clean(e))),
    ...team.map((e, i) => (i === 0 && (pin.length + group.length) > 0 ? sep(clean(e)) : clean(e))),
  ])

  const current = roles.find(r => r.checked)
  const tipo = sub(pt ? 'Tipo' : 'Type', 'crown', roles.map(clean), current ? { hint: current.label } : {})

  const abrir = sub(pt ? 'Abrir' : 'Open', 'panel', open.map(clean))

  const withIcon = (list: MenuEntry[], icon: string, extra: Partial<MenuEntry> = {}) => list.map(e => ({ ...clean(e), icon, ...extra }))
  const top: MenuEntry[] = [
    ...withIcon(rename, 'pencil'),
    ...abrir,
    ...withIcon(interrupt, 'stop'),
    ...withIcon(resume, 'resume'),
    ...rest.map(clean),
  ]
  const middle: MenuEntry[] = [...tarefa, ...organizar, ...tipo, ...withIcon(notify, 'bell')]
  const bottom: MenuEntry[] = [
    ...withIcon(kill, 'power', { danger: true }),
    ...withIcon(archive, 'archive'),
    ...withIcon(forget, 'trash'),
  ]

  const out: MenuEntry[] = []
  for (const block of [top, middle, bottom]) {
    block.forEach((e, i) => out.push(i === 0 && out.length > 0 ? sep(e) : e))
  }
  return out
}

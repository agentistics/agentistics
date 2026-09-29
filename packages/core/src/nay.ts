/**
 * nay.ts — PURE: what makes a session a NAY conversation, and how it is filed.
 *
 * A Nay conversation is an ordinary managed session whose cwd is Nay's own directory
 * (`~/.agentistics/nay-chat`, `NAY_CHAT_DIR` on the server). The cwd is a fact the registry already
 * records for every session, so no new field is needed and nothing can disagree about it — see
 * docs/superpowers/specs/2026-09-29-nay-as-sessions-design.md.
 */

import { planGroupOp, type GroupOpResult, type SessionUserGroupsValue } from './sessionGroups'

/** The user group every Nay conversation is filed under. */
export const NAY_GROUP_NAME = 'Nay'

/** The directory, relative to the home directory. */
export const NAY_DIR_SUFFIX = '/.agentistics/nay-chat'

/** True for a session running in Nay's own directory. Separator- and trailing-slash-tolerant. */
export function isNayCwd(cwd: string | undefined | null): boolean {
  if (!cwd) return false
  const norm = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  return norm.endsWith(NAY_DIR_SUFFIX)
}

/**
 * File a new Nay session under the "Nay" group — creating the group the first time. Pure: the plan
 * over the stored groups and pins, never a write.
 */
export function planNayFiling(groups: SessionUserGroupsValue, pins: readonly string[], key: string): GroupOpResult {
  const add = planGroupOp(groups, pins, { type: 'add', group: NAY_GROUP_NAME, key })
  if (add.ok || add.code !== 'no_such_group') return add
  return planGroupOp(groups, pins, { type: 'create', name: NAY_GROUP_NAME, keys: [key] })
}

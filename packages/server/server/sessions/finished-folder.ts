/**
 * finished-folder.ts — PURE: which sidebar folder means "this work is over".
 *
 * Two callers ask the same question from opposite sides, so the rule lives once:
 *  - the spawn-filing planner (`spawn-filing.ts`) derives a NEW session's folder from where its
 *    task's other sessions already sit, and must SKIP a finished folder — a fresh worker filed under
 *    "Finalizadas" because the last session of its task was retired there is filed as done on birth;
 *  - the hand-off (S6) retires a predecessor INTO the finished folder near the one it was in.
 *
 * The rule is a NAME, `Finalizadas` / `Finished`, compared trimmed and case-insensitively — the two
 * words the owner's sidebar and the briefing already use. A folder nested inside one is finished
 * too (folders nest one level deep, `sessionGroups.ts`), so a batch kept under "Finished/Batch 1"
 * is not mistaken for live work.
 */

import type { SessionUserGroup, SessionUserGroupsValue } from '@agentistics/core'

const FINISHED_NAMES = new Set(['finalizadas', 'finished'])

/** Whether a folder NAME is the finished-folder name. */
export function isFinishedFolderName(name: string): boolean {
  return FINISHED_NAMES.has(name.trim().toLowerCase())
}

/** Whether a folder is finished: named so, or nested inside one that is. */
export function isFinishedFolder(groups: SessionUserGroupsValue, g: SessionUserGroup): boolean {
  if (isFinishedFolderName(g.name)) return true
  const parent = g.parentId ? groups.groups.find(p => p.id === g.parentId) : undefined
  return parent !== undefined && isFinishedFolderName(parent.name)
}

/**
 * The finished folder for work that was in folder `nearId`: a finished child of that folder's TOP
 * folder (or the top folder itself when it is the finished one), else a TOP-LEVEL finished folder,
 * else `undefined` — and the caller says so in words rather than inventing a folder.
 */
export function findFinishedFolder(groups: SessionUserGroupsValue, nearId?: string): SessionUserGroup | undefined {
  const near = nearId ? groups.groups.find(g => g.id === nearId) : undefined
  const top = near?.parentId ? groups.groups.find(g => g.id === near.parentId) ?? near : near
  if (top) {
    if (isFinishedFolderName(top.name)) return top
    const child = groups.groups.find(g => g.parentId === top.id && isFinishedFolderName(g.name))
    if (child) return child
  }
  if (near && isFinishedFolderName(near.name)) return near
  return groups.groups.find(g => !g.parentId && isFinishedFolderName(g.name))
}

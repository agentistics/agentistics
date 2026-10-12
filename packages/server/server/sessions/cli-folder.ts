/**
 * cli-folder.ts — `--folder` for `agentop session …`: resolve a folder BEFORE anything is spawned,
 * file a session into it right after, and print the folder tree.
 *
 * It holds no folder rule: resolution is core's `resolveFolderRef` and the move is `planGroupOp`'s
 * `add` — the same planner `/api/session-groups` runs — written through `updatePreferences`, whose
 * file lock makes it safe from a one-shot CLI process beside the running server. A folder is never
 * created here: an unknown ref is a refusal that lists what exists.
 */

import {
  folderLabel, folderPath, planGroupOp, resolveFolderRef, sessionIdentityKey,
  type SessionUserGroupsValue,
} from '@agentistics/core'
import { readPreferences, updatePreferences, type Preferences } from '../preferences'

export interface FolderDeps {
  read: () => Promise<Preferences>
  update: typeof updatePreferences
}
const defaultDeps: FolderDeps = { read: readPreferences, update: updatePreferences }

const groupsOf = (p: Preferences): SessionUserGroupsValue => ({ groups: (p.sessionGroups?.groups ?? []).map(g => ({ ...g, sessionKeys: [...g.sessionKeys] })) })

export type FolderResolution = { ok: true; id: string; path: string } | { ok: false; message: string }

/** Resolve every distinct ref up front; the first refusal wins, so nothing starts on a bad ref. */
export async function resolveFolders(refs: readonly (string | undefined)[], deps: FolderDeps = defaultDeps): Promise<{ ok: true; byRef: Map<string, { id: string; path: string; siblings: string[] }> } | { ok: false; message: string }> {
  const wanted = [...new Set(refs.filter((r): r is string => !!r))]
  const byRef = new Map<string, { id: string; path: string; siblings: string[] }>()
  if (wanted.length === 0) return { ok: true, byRef }
  const groups = groupsOf(await deps.read())
  for (const ref of wanted) {
    const r = resolveFolderRef(groups, ref)
    if (r.ok) {
      const siblings = groups.groups.filter(g => g.id !== r.group.id && g.parentId === r.group.parentId && !!r.group.parentId).map(g => folderPath(groups, g))
      byRef.set(ref, { id: r.group.id, path: r.path, siblings })
      continue
    }
    const all = groups.groups.map(g => `  ${folderLabel(groups, g)}`).join('\n')
    const message = r.code === 'ambiguous_group'
      ? `Folder "${ref}" is ambiguous. Use one of:\n${r.matches.map(m => `  ${m}`).join('\n')}`
      : `No folder matches "${ref}".${all ? ` Folders:\n${all}` : ' There are no folders yet.'}`
    return { ok: false, message }
  }
  return { ok: true, byRef }
}

/** File one session into a resolved folder (a MOVE: it leaves any other folder and is unpinned). */
export async function fileInFolder(
  folderId: string, row: { id: string; conversationId?: string | undefined }, deps: FolderDeps = defaultDeps,
): Promise<boolean> {
  const key = sessionIdentityKey(row)
  let ok = false
  await deps.update(cur => {
    const plan = planGroupOp(groupsOf(cur), cur.pinnedSessions ?? [], { type: 'add', group: folderId, key })
    if (!plan.ok) return undefined
    ok = true
    return { sessionGroups: { groups: plan.groups.groups }, pinnedSessions: plan.pins }
  })
  return ok
}

export interface FolderLine { id: string; path: string; sessions: number }

export async function folderTree(deps: FolderDeps = defaultDeps): Promise<FolderLine[]> {
  const groups = groupsOf(await deps.read())
  const line = (g: SessionUserGroupsValue['groups'][number]): FolderLine => ({ id: g.id, path: folderPath(groups, g), sessions: g.sessionKeys.length })
  const out: FolderLine[] = []
  for (const top of groups.groups.filter(g => !g.parentId)) {
    out.push(line(top))
    for (const child of groups.groups.filter(g => g.parentId === top.id)) out.push(line(child))
  }
  // A child whose parent is gone is still a folder a leader may need to name.
  for (const g of groups.groups) if (g.parentId && !groups.groups.some(p => p.id === g.parentId)) out.push(line(g))
  return out
}

export const folderLineText = (l: FolderLine): string => `${l.path} (${l.id}) · ${l.sessions} ${l.sessions === 1 ? 'session' : 'sessions'}`

/** True when the session running this command is a LEADER (its stored role, by managed or conversation id). */
export async function callerIsLeader(
  callerId: string | undefined,
  lookup: (keys: (string | undefined)[]) => Promise<string | undefined>,
  conversationOf: (id: string) => Promise<string | undefined>,
): Promise<boolean> {
  if (!callerId) return false
  return (await lookup([callerId, await conversationOf(callerId)])) === 'leader'
}

export const NO_FOLDER_WARNING = 'no --folder: the session was left outside the folders — use --folder "<folder>" (see `agentop session folders`).'

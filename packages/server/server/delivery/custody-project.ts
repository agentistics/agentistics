/**
 * delivery/custody-project.ts — which PROJECT a piece belongs to (ENTREGA.GARANTIDA §5.2.6, S7a). PURE: the host reads the board,
 * the registry and the sidebar folders and hands them in.
 *
 *   1. `normalizeGitRemote(Task.repo)`, shortened to `org/repo`;
 *   2. else the repository of the piece's sessions (`ManagedSession.repo`, from `repo-facts.ts`) — ANY session filed on the piece:
 *      the spec says "the piece's sessions", not "its workers", and a leader's own session is as good a witness of the repo;
 *   3. else the SIDEBAR FOLDER the piece's sessions are filed in: the top-level folder (a nested `Project/Active` folder names its
 *      PARENT — the child is a state of the work, not a place), keyed `folder:<name>` so it can never collide with `org/repo`;
 *   4. else `''` — unknown. Such a piece is queued; it is never handed to a leader of another project.
 *
 * Every step errs toward `''`: two different repositories (or two different folders) among a piece's sessions is a CONFLICT, not
 * a vote, and a guessed project is a piece handed to the wrong leader.
 */
import { normalizeGitRemote, repoShortName, sessionIdentityKey, type SessionUserGroupsValue } from '@agentistics/core'

export interface CustodyProjectSession { id: string; conversationId?: string | undefined; taskId?: string | undefined; subtaskId?: string | undefined; repo?: string | undefined }
export interface CustodyProjectInput {
  pieces: ReadonlyArray<{ taskId: string; subtaskId: string }>
  /** `Task.repo` by task id, as stored (a remote or a path; `normalizeGitRemote` decides). */
  taskRepos: ReadonlyMap<string, string>
  sessions: readonly CustodyProjectSession[]
  groups: SessionUserGroupsValue
}

/** The folder key of a group: its top-level folder's name, lowercase and trimmed. */
export function folderProjectOf(groups: SessionUserGroupsValue, sessionKey: string): string {
  const g = groups.groups.find(x => x.sessionKeys.includes(sessionKey))
  if (!g) return ''
  const top = g.parentId ? groups.groups.find(p => p.id === g.parentId) ?? g : g
  const name = top.name.trim().toLowerCase()
  return name ? `folder:${name}` : ''
}

const only = (values: readonly string[]): string => {
  const set = new Set(values.filter(Boolean))
  return set.size === 1 ? [...set][0]! : ''
}

export function resolveCustodyProjects(i: CustodyProjectInput): Map<string, string> {
  const out = new Map<string, string>()
  for (const p of i.pieces) {
    const fromTask = i.taskRepos.get(p.taskId) ?? ''
    const remote = fromTask ? repoShortName(normalizeGitRemote(fromTask)) : ''
    if (remote) { out.set(p.subtaskId, remote); continue }
    const own = i.sessions.filter(s => s.subtaskId === p.subtaskId || (!s.subtaskId && s.taskId === p.taskId && p.subtaskId === p.taskId))
    const repo = only(own.map(s => (s.repo?.includes('/') ? s.repo : '')))
    if (repo) { out.set(p.subtaskId, repo); continue }
    out.set(p.subtaskId, only(own.map(s => folderProjectOf(i.groups, sessionIdentityKey(s)))))
  }
  return out
}

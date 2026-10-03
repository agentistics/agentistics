/**
 * wizard-places.ts — PURE: which of the host's places the code wizard's folder step offers (NW-04).
 *
 * Recent repositories and places worked in: a directory the home walk merely FOUND is not one (the
 * walk lists every folder of `$HOME`, `~/.cache` included). A git checkout names its repository — the
 * remote's short name, or its own folder when it has no remote — which is what earns it a "new
 * worktree" row in `folderRows`.
 */
import type { ProjectOption } from './types'

export function wizardPlaces(options: readonly ProjectOption[]): ProjectOption[] {
  return options
    .filter(o => o.git || o.source !== 'folder')
    .map(o => (o.git && !o.repo ? { ...o, repo: o.label } : o))
}

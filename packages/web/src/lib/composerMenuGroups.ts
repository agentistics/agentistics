/** Pure decisions and per-viewer persistence for the composer's grouped menu. */

export type ComposerMenuGroupId = 'message' | 'model' | 'notifications'

export interface ComposerMenuVisibility {
  isMobile: boolean
  answeringNow: boolean
  hasPrompts: boolean
  dictationReady: boolean
  hasModel: boolean
}

export function visibleComposerMenuGroups(input: ComposerMenuVisibility): ComposerMenuGroupId[] {
  if (input.answeringNow) return []
  const groups: ComposerMenuGroupId[] = []
  if (!input.dictationReady || (input.isMobile && input.hasPrompts)) groups.push('message')
  if (input.hasModel) groups.push('model')
  groups.push('notifications')
  return groups
}

export const COMPOSER_MENU_STORAGE_KEY = 'agentistics-composer-menu-folded-v1'

export function readComposerMenuFolded(storage?: Storage): Set<ComposerMenuGroupId> {
  try {
    const raw = (storage ?? globalThis.localStorage).getItem(COMPOSER_MENU_STORAGE_KEY)
    if (!raw) return new Set()
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((id): id is ComposerMenuGroupId => id === 'message' || id === 'model' || id === 'notifications'))
  } catch {
    return new Set()
  }
}

export function writeComposerMenuFolded(folded: ReadonlySet<ComposerMenuGroupId>, storage?: Storage): void {
  try {
    ;(storage ?? globalThis.localStorage).setItem(COMPOSER_MENU_STORAGE_KEY, JSON.stringify([...folded]))
  } catch { /* private mode or unavailable storage: keep the choice for this visit */ }
}

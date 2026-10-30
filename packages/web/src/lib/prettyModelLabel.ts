import { formatModel, modelLabel } from '@agentistics/core'
/** A model id as a person reads it: the menu's own label, else the harness catalogue ("haiku" →
 *  "Haiku 4.5"), else the known-id table, else a tidy form of a raw id ("claude-opus-5-5" → "Opus 5.5"). */
export function prettyModelLabel(harness: string, id: string, menuLabel?: string): string {
  if (menuLabel && menuLabel !== id) return menuLabel
  const fromCatalogue = modelLabel(harness, id)
  if (fromCatalogue !== id) return fromCatalogue
  const known = formatModel(id)
  if (known !== id) return known
  const m = /^(?:claude-)?(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?(?:-\d{8})?$/i.exec(id)
  if (m) return `${m[1]!.charAt(0).toUpperCase()}${m[1]!.slice(1).toLowerCase()} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
  return id
}

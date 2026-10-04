/**
 * The `:vault` chip in the CLI-session composer (VAULT.PERSONAL §8.5) — the PURE half, copying the
 * `#` session chip's shape (`sessionMention.ts`): a trigger query, an apply, the chip's ranges for the
 * mirror, and an expand at send time.
 *
 * The chip in the DRAFT carries NAMES only (`🔐«3 credenciais · grupo pelvie»`); the selection itself
 * (ids) lives in the composer's state. On send the chip becomes the `vault://` REFERENCES the server
 * granted — never a value — and the briefing is appended. One chip per draft: choosing again edits it.
 */
export interface VaultSelection { items: { id: string; name: string }[]; groups: { id: string; name: string }[] }

/** Is the caret right after a `:vault` that opens the text or follows whitespace? → where it starts. */
export function vaultTrigger(before: string): number | null {
  const m = /(?:^|\s)(:vault)$/i.exec(before)
  return m ? before.length - m[1]!.length : null
}

export function vaultChipLabel(sel: VaultSelection, pt: boolean): string {
  const parts: string[] = []
  const n = sel.items.length
  if (n === 1 && sel.groups.length === 0) parts.push(sel.items[0]!.name)
  else if (n > 0) parts.push(pt ? `${n} ${n === 1 ? 'credencial' : 'credenciais'}` : `${n} credential${n === 1 ? '' : 's'}`)
  for (const g of sel.groups) parts.push(`${pt ? 'grupo' : 'group'} ${g.name}`)
  return parts.join(' · ').replace(/[«»\n]/g, ' ').slice(0, 80)
}
export const vaultChipToken = (sel: VaultSelection, pt: boolean) => `🔐«${vaultChipLabel(sel, pt)}»`

const CHIP = /🔐«[^«»\n]+»/g
export function vaultChipTokens(draft: string): { start: number; end: number }[] {
  return [...draft.matchAll(CHIP)].map(m => ({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }))
}
export const hasVaultChip = (draft: string) => vaultChipTokens(draft).length > 0

/** Put the chip where `:vault` was (or replace the existing chip; or append) — caret after it. */
export function applyVaultChip(draft: string, caret: number, sel: VaultSelection, pt: boolean): { text: string; caret: number } {
  const token = vaultChipToken(sel, pt)
  const existing = vaultChipTokens(draft)[0]
  if (existing) {
    const text = draft.slice(0, existing.start) + token + draft.slice(existing.end)
    return { text, caret: existing.start + token.length }
  }
  const at = Math.max(0, Math.min(caret, draft.length))
  const start = vaultTrigger(draft.slice(0, at))
  if (start === null) {
    const head = draft.replace(/\s+$/, '')
    const text = head ? `${head} ${token} ` : `${token} `
    return { text, caret: text.length }
  }
  const after = draft.slice(at)
  const ins = after.startsWith(' ') ? token : `${token} `
  return { text: draft.slice(0, start) + ins + after, caret: start + ins.length }
}

/** Drop the chip (the selection was cleared). */
export function removeVaultChip(draft: string): string {
  return draft.replace(CHIP, '').replace(/ {2,}/g, ' ')
}

/** On send: the chip becomes the granted references; the briefing goes after the person's words. */
export function expandVaultChip(text: string, refs: readonly string[], briefing: string): string {
  if (!hasVaultChip(text)) return text
  return `${text.replace(CHIP, refs.join(' '))}\n\n${briefing}`
}

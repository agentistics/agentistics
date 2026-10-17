/**
 * patch-detail.ts — the detail of an `apply_patch` call. PURE.
 *
 * A patch names its files on `*** Update File: <path>` / `*** Add File:` / `*** Delete File:` lines,
 * and the readers used to keep only the FIRST line of it (`*** Begin Patch`), so no surface could
 * tell which files a call touched. The patch text is kept, bounded: when it is longer than the cap
 * it is cut at a line boundary and every remaining file header line is appended, so the targets
 * survive however large the hunks are.
 */
export const PATCH_DETAIL_MAX = 4096
/** Ceiling on the WHOLE output (prefix + appended headers); past it the tail says how many files are left out. */
export const PATCH_DETAIL_TOTAL_MAX = 8192

/** The tools whose argument IS a patch. Any other tool keeps its ordinary detail priority. */
const PATCH_TOOLS = new Set(['apply_patch', 'applypatch'])
export function isPatchTool(name: unknown): boolean {
  return typeof name === 'string' && PATCH_TOOLS.has(name.trim().toLowerCase().replace(/[-\s]/g, '_').replace(/^_+|_+$/g, ''))
}

const FILE_HEADER = /^\*\*\* (?:Update|Add|Delete) File: .+$/m
const FILE_HEADER_G = /^\*\*\* (?:Update|Add|Delete) File: .+$/gm

/** Whether `text` is a patch in the `*** Begin Patch` envelope. */
export function looksLikePatch(text: string): boolean {
  const t = text.trimStart()
  return t.startsWith('*** Begin Patch') || (t.startsWith('*** ') && FILE_HEADER.test(t))
}

/** The patch text bounded to `PATCH_DETAIL_MAX`, keeping every file header; null when not a patch. */
export function patchDetail(text: unknown): string | null {
  if (typeof text !== 'string' || !looksLikePatch(text)) return null
  const t = text.trim()
  if (t.length <= PATCH_DETAIL_MAX) return t
  const cut = t.slice(0, PATCH_DETAIL_MAX)
  const head = cut.slice(0, Math.max(cut.lastIndexOf('\n'), 0))
  const seen = new Set(head.match(FILE_HEADER_G) ?? [])
  const rest = (t.match(FILE_HEADER_G) ?? []).filter(h => !seen.has(h))
  const lines = [head, '…']
  let size = head.length + 2
  for (let i = 0; i < rest.length; i++) {
    const h = rest[i]!
    if (size + h.length + 1 > PATCH_DETAIL_TOTAL_MAX) { lines.push(`… +${rest.length - i} more files`); break }
    lines.push(h)
    size += h.length + 1
  }
  return lines.join('\n')
}

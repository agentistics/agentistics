/**
 * columnDefaultWidth — PURE: the DEFAULT width of an Agentask column, wide enough for its header and
 * a typical cell.
 *
 * A `ColumnDef.width` was a number someone picked once, in one language; "DURAÇÃO" (uppercase, with
 * the grip, and PT is longer than EN) and "ativo 0min" were both cut off by it. The default is now
 * the larger of that number and what the title and a typical value need. It only ever applies to a
 * column the person never resized: `resolveWidths` lays a saved width over it untouched.
 *
 * The estimate is per-character because the default must exist before anything is rendered (a
 * DOM measure would need the table first and move every column after paint). It errs a few pixels
 * wide on purpose — a slightly roomy column is invisible, a clipped one is a bug report.
 */

/** Header: 11px uppercase with letter-spacing. */
const HEADER_CHAR_PX = 8
/** Cell text: 12.5px body. */
const CELL_CHAR_PX = 7
/** Cell padding both sides. */
const CELL_PAD = 22
/** The drag grip (12px + gap), the sort arrow and the resize handle that share the header. */
const GRIP_PX = 18
const SORT_PX = 18
const HANDLE_PX = 8

export function estimateHeaderWidth(label: string, opts: { sortable?: boolean; grip?: boolean } = {}): number {
  return Math.ceil(label.length * HEADER_CHAR_PX + CELL_PAD + HANDLE_PX
    + (opts.sortable ? SORT_PX : 0) + (opts.grip ? GRIP_PX : 0))
}

export function estimateContentWidth(samples: ReadonlyArray<string>): number {
  const longest = samples.reduce((m, s) => Math.max(m, s.length), 0)
  return longest === 0 ? 0 : Math.ceil(longest * CELL_CHAR_PX + CELL_PAD)
}

/** The default width: the configured one, or more when the header or a typical value needs it. */
export function defaultColumnWidth(args: {
  base: number
  label: string
  samples?: ReadonlyArray<string>
  sortable?: boolean
  grip?: boolean
}): number {
  return Math.max(
    args.base,
    estimateHeaderWidth(args.label, { sortable: args.sortable, grip: args.grip }),
    estimateContentWidth(args.samples ?? []),
  )
}

/**
 * A typical (longest ordinary) value per column id, in the reader's language. Only columns whose
 * content is text of a known shape need one; the rest are bounded by their header.
 */
export function sampleFor(id: string, lang: 'pt' | 'en'): string[] {
  const pt = lang === 'pt'
  switch (id) {
    case 'duration': return [pt ? 'ativo 12h 30min' : 'active 12h 30m']
    case 'started': case 'completed': case 'created': case 'updated': case 'due': return ['28 set 14:32']
    case 'cost': return ['R$ 1.234,56']
    case 'tokens': return ['123,4M']
    case 'rounds': return [pt ? '1.234 rodadas' : '1,234 rounds']
    case 'sessions': return [pt ? '12 sessões' : '12 sessions']
    default: return []
  }
}

/** Defaults for a set of columns: id → width. */
export function defaultWidths(
  cols: ReadonlyArray<{ id: string; width: number; sort?: unknown }>,
  labelOf: (id: string) => string,
  lang: 'pt' | 'en',
  grip = true,
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const c of cols) {
    out[c.id] = defaultColumnWidth({
      base: c.width, label: labelOf(c.id), samples: sampleFor(c.id, lang), sortable: c.sort !== undefined, grip,
    })
  }
  return out
}

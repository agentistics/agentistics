/**
 * StatusChip — the one way to set a status, in the same place on every surface.
 *
 * There used to be six: the detail rail's chip, the table's own status cell, a kanban drag, the
 * batch bar, and two standalone buttons (`Mark delivered` / `Mark abandoned`) that did what two of
 * the menu rows already did. Each was reasonable and together they meant a reader had to learn
 * where the control was on THIS screen before they could use it. Jira moved its status dropdown
 * once and moved it back after the complaints: position stability is worth more than another way in.
 *
 * So: one component, drawn at the same point on the row, on the card and at the top of the
 * delivery. The kanban keeps its drag — that is what a board is FOR, and it is a different gesture
 * rather than a second control. `blocked` still opens its reason dialog, because the server refuses
 * a `blocked` with nothing to say and every surface inherits that refusal.
 *
 * It is a thin specialisation of `ChipSelect` on purpose: the panel, the mobile sheet, the
 * keyboard handling and the 44px targets are already solved there, and a second implementation of
 * a dropdown is a second set of those decisions.
 */

import type { TaskStatusDef } from '@agentistics/core'
import { liveStatusMap, liveStatusOrder, type BoardStatus } from './board'
import { ChipSelect } from './ChipSelect'
import { statusLabel, type Lang } from './copy'

export interface StatusChipProps {
  value: string
  /** `blocked` reaches the caller like any other status — the reason dialog is the caller's. */
  onPick: (status: BoardStatus) => void
  lang: Lang
  /** The board's LIVE status list (`lib/tasks.ts`'s `useTaskStatuses`) — `null` while it loads,
   *  in which case the fixed legacy vocabulary is shown so the menu is never empty. */
  statuses: readonly TaskStatusDef[] | null
  /** Tight cells (a table row, a card) get the compact padding; a rail gets the roomier one. */
  compact?: boolean
  /** Fill the column. Off where the chip sits among other controls. */
  block?: boolean
  disabled?: boolean
}

export function StatusChip({ value, onPick, lang, statuses, compact, block = true, disabled }: StatusChipProps) {
  // Built here rather than passed in, so no caller can offer a different set of statuses — the
  // point of the component is that the menu is the same everywhere. Every entry's label/colour is
  // the LIVE one (a person's rename or custom status wins over any fixed word).
  const map = liveStatusMap(statuses)
  const order = liveStatusOrder(statuses)
  const options = order.map(id => ({
    value: id,
    // The seeded English defaults ("To do") read in the board's language; an explicit rename is kept verbatim (`statusLabel`).
    label: statusLabel(id, lang, statuses ?? undefined) !== id ? statusLabel(id, lang, statuses ?? undefined) : (map[id]?.label ?? id),
    color: map[id]?.color ?? 'var(--text-tertiary)',
    dim: map[id]?.dim ?? 'var(--border)',
  }))
  return (
    <ChipSelect
      value={value}
      options={options}
      onPick={v => onPick(v as BoardStatus)}
      title={statusLabel(value, lang, statuses ?? undefined)}
      {...(compact ? { compact } : {})}
      {...(disabled ? { disabled } : {})}
      block={block}
    />
  )
}

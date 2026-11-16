/**
 * ScheduleView — the Cronograma tab: the week as a tree task → group → subtask with a real-dates timeline
 * (`CronogramaTree`, rules in `lib/cronogramaTree.ts`). It replaced the two-day "releases + pieces by priority" strip.
 */
import type { CalMark, CalPiece, CalVersion } from '@agentistics/core'
import { CronogramaTree } from './CronogramaTree'

export function ScheduleView({ anchor, nowMs, pieces, pt, onOpenPiece, selected }: {
  mobile?: boolean
  anchor: string; nowMs: number; versions?: readonly CalVersion[]; pieces: readonly CalPiece[]; marks?: readonly CalMark[]; pt: boolean
  onOpenPiece: (key: string, e: React.MouseEvent) => void
  onOpenVersion?: (version: string, e: React.MouseEvent) => void
  onOpenMark?: (m: CalMark, e: React.MouseEvent) => void
  selected: string | null
}) {
  return <CronogramaTree mode="week" anchor={anchor} nowMs={nowMs} pieces={pieces} pt={pt} selected={selected} onOpenPiece={onOpenPiece} />
}

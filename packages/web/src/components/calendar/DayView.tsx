/**
 * DayView — the day as a CRONOGRAMA of the day: the same tree as the week (task → group → subtask) on an hour scale,
 * done part solid and forecast hatched; a piece with no real time shows only the "sem horário" chip.
 * (`CronogramaTree`, rules in `lib/cronogramaTree.ts`.) The old one-column-per-piece grid is gone.
 */
import type { CalMark, CalPiece, CalVersion } from '@agentistics/core'
import { CronogramaTree } from './CronogramaTree'

export function DayView({ day, nowMs, pieces, pt, onOpenPiece, selected }: {
  day: string; nowMs: number; versions?: readonly CalVersion[]; pieces: readonly CalPiece[]; marks?: readonly CalMark[]; pt: boolean
  onOpenPiece: (key: string, e: React.MouseEvent) => void
  onOpenVersion?: (version: string, e: React.MouseEvent) => void
  onOpenMark?: (m: CalMark, e: React.MouseEvent) => void
  selected: string | null
}) {
  return <CronogramaTree mode="day" anchor={day} nowMs={nowMs} pieces={pieces} pt={pt} selected={selected} onOpenPiece={onOpenPiece} />
}

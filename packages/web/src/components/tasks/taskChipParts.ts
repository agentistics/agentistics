import { elapsedMs, fmtElapsed } from '@agentistics/core'
import type { TaskTypeDef } from '@agentistics/core'
import { typeStyle } from './board'
import { fmtActive } from './subtaskRollup'

/** The header's one-line duration label. */
export function durationChipLabel(
  startedAt: string | undefined,
  deliveredAt: string | undefined,
  activeMinutes: number | null | undefined,
  lang: 'pt' | 'en',
): string | null {
  const wall = startedAt && deliveredAt ? elapsedMs(startedAt, deliveredAt) : null
  const duration = wall === null ? null : fmtElapsed(wall, lang)
  const active = typeof activeMinutes === 'number' ? fmtActive(activeMinutes, lang) : null
  if (!duration && !active) return null
  return [duration, active].filter(Boolean).join(' · ')
}

/** The type chip always names its field; an absent type is an explicit empty state. */
export function typeChipLabel(
  typeId: string | undefined,
  types: readonly TaskTypeDef[] | null,
  prefix: string,
  empty: string,
): string {
  if (!typeId) return `${prefix} ${empty}`
  return `${prefix} ${typeStyle(types, typeId).label}`
}

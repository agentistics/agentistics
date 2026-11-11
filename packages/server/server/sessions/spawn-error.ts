import type { SpawnPlanError } from './types'

/** The shared wording for a harness that is intentionally protocol-only. */
export function structuredOnlyNotice(e: Extract<SpawnPlanError, { code: 'structured-only' }>): string {
  return e.notice
}

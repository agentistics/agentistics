import { ProjectionUnavailable } from '@agentistics/core'

/** A refused projection route is a page-lifetime fallback to the legacy figures. */
export function shouldDisableProjectedOverlay(error: unknown): boolean {
  return error instanceof ProjectionUnavailable
}

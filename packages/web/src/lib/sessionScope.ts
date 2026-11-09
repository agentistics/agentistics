import type { Filters } from '@agentistics/core'

/** Top bar filters scope metrics. Session lists start unscoped and apply their own controls. */
export const SESSION_LIST_FILTERS: Filters = Object.freeze({
  dateRange: 'all', customStart: '', customEnd: '', projects: [], models: [],
})

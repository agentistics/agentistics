/** Rows from compact GET or an older server which ignored the format parameter. */
export function fleetLiveRows<T>(payload: { rows?: T[]; sessions?: T[] }): T[] {
  return Array.isArray(payload.rows) ? payload.rows : Array.isArray(payload.sessions) ? payload.sessions : []
}

export function fleetLiveUrl(lang: string): string {
  return `/api/fleet?lang=${encodeURIComponent(lang)}&format=compact-v1`
}

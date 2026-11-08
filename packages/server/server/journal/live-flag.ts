/** The journal's live feeder follows the master switch and defaults on for every install. */
export function journalLiveEnabled(journalEnabled: boolean, raw: string | undefined): boolean {
  return journalEnabled && !['0', 'false', 'off', 'no'].includes((raw ?? '').trim().toLowerCase())
}

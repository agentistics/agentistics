/** A leader's role is shown by its badge, leaving the name available for the session itself. */
export const LEADER_TITLE_PREFIX = /^\[ (?:LÍDER|LEADER) \] - /i
export const sessionDisplayTitle = (title: string): string => title.replace(LEADER_TITLE_PREFIX, '')
export const hasLeaderTitle = (title: string): boolean => LEADER_TITLE_PREFIX.test(title)

/**
 * SessionStateText — the state word a header/card shows for a session. While its close is pending it
 * says so ("encerrando"/"closing") instead of the last polled state ("precisa de você"): the session is
 * on its way out and nothing is asked of the reader.
 */
import { useIsClosing } from '../../lib/closingSessions'

export function closingStateLabel(label: string, closing: boolean, pt: boolean): string {
  return closing ? (pt ? 'encerrando' : 'closing') : label
}

export function SessionStateText({ id, label, pt }: { id: string; label: string; pt: boolean }) {
  return <>{closingStateLabel(label, useIsClosing(id), pt)}</>
}

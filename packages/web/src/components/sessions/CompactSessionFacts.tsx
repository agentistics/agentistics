import type { ReactNode } from 'react'
import { sessionDisplayTitle } from '../../lib/sessionDisplayTitle'
import type { ControlSession } from '@agentistics/tui/control/session-fleet'
import { HarnessMark } from './HarnessMark'

/** Compact identity shared by the rail and ended rows; complete names may wrap. */
export function CompactSessionFacts({ session, dot, titleBadge, showHarness = true }: { session: ControlSession; dot?: string | null; titleBadge?: ReactNode; showHarness?: boolean }) {
  const title = sessionDisplayTitle(session.title)
  const lastSpace = title.lastIndexOf(' ')
  return (
    <>
      {showHarness && <HarnessMark harness={session.harness} size={15} />}
      <span style={{ flex: 1, minWidth: 0, whiteSpace: 'normal', overflowWrap: 'anywhere', lineHeight: 1.4 }}>
        {titleBadge ? <>{lastSpace >= 0 ? title.slice(0, lastSpace + 1) : ''}<span style={{ whiteSpace: 'nowrap' }}>{title.slice(lastSpace + 1)}<span style={{ display: 'inline-block', marginLeft: 6, verticalAlign: 'middle' }}>{titleBadge}</span></span></> : title}
      </span>
      {dot && <span aria-hidden style={{ width: 7, height: 7, borderRadius: 4, background: dot, flexShrink: 0 }} />}
    </>
  )
}

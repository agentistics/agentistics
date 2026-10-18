import type { ReactNode } from 'react'
import { sessionDisplayTitle } from '../../lib/sessionDisplayTitle'
import type { ControlSession } from '@agentistics/tui/control/session-fleet'
import { HarnessMark } from './HarnessMark'

/** Compact identity shared by the rail and ended rows; complete names may wrap. */
export function CompactSessionFacts({ session, dot, titleBadge }: { session: ControlSession; dot?: string | null; titleBadge?: ReactNode }) {
  return (
    <>
      <HarnessMark harness={session.harness} size={15} />
      <span style={{ flex: 1, minWidth: 0, whiteSpace: 'normal', overflowWrap: 'anywhere', lineHeight: 1.4 }}>
        {sessionDisplayTitle(session.title)}{titleBadge && <span style={{ display: 'inline-block', marginLeft: 6, verticalAlign: 'middle' }}>{titleBadge}</span>}
      </span>
      {dot && <span aria-hidden style={{ width: 7, height: 7, borderRadius: 4, background: dot, flexShrink: 0 }} />}
    </>
  )
}

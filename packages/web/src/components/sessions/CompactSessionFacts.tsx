import type { ControlSession } from '@agentistics/tui/control/session-fleet'
import { HarnessMark } from './HarnessMark'

/** The single-line identity from the rail's folder list, shared with ended rows in the aside. */
export function CompactSessionFacts({ session, dot }: { session: ControlSession; dot?: string | null }) {
  return (
    <>
      <HarnessMark harness={session.harness} size={15} />
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {session.title}
      </span>
      {dot && <span aria-hidden style={{ width: 7, height: 7, borderRadius: 4, background: dot, flexShrink: 0 }} />}
    </>
  )
}

import type { CanonicalMode } from '@agentistics/core'
import { patchSession } from './registry'

/**
 * The mode the chip just set is written onto the registry row, because a row's `mode` was only the START
 * mode: a user kill + Reopen read it back (`inheritedLaunch`) and the session returned in the mode it was
 * born in, losing "Accept edits" / "No questions". Only a mode the session itself STATES is recorded — its
 * canonical twin; one with none (a harness's own word) leaves the row as it was.
 */
export async function recordChipMode(
  id: string,
  backend: { modeOf?(id: string): { canonical?: CanonicalMode } | null | undefined },
  patch: (id: string, p: { mode: CanonicalMode }) => Promise<boolean> = patchSession,
): Promise<void> {
  const canonical = backend.modeOf?.(id)?.canonical
  if (canonical) await patch(id, { mode: canonical }).catch(() => false)
}

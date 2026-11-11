/**
 * session-info.ts — what the browser needs to know about this instance before it draws anything:
 * the exposure profile, the local capabilities that profile grants, and the user's own switches.
 *
 * The flags are a UI hint, never the enforcement point (see capability-guard.ts).
 */

import { CAPS, PROFILE } from './exposure'
import { chatAllowed } from './chat-gate'
import { shellAllowedNow } from './sessions/shell-gate'
import { getShellOverride } from './sessions/shell-override-store'
import { editorAllowed } from './sessions/editor-gate'
import { readPreferences } from './preferences'
import { featureOn, projectionSurfaceOn } from '@agentistics/core'

const JSON_CT = { 'Content-Type': 'application/json' } as const

/**
 * The web's projected read path is on when the web surface reads the projections (the default;
 * `AGENTISTICS_PROJECTIONS_SURFACES=legacy` is the fallback), the projections themselves are on
 * (`AGENTISTICS_PROJECTIONS`), and the profile may read local transcripts (the route's capability).
 */
export function projectionsWebOn(env: Record<string, string | undefined>, localTranscripts: boolean): boolean {
  return localTranscripts && featureOn('journal', env) && featureOn('projections', env) && projectionSurfaceOn('web', env)
}

/** The first import's state for the web, or `null` when there is nothing to say. Never throws. */
export async function journalBackfillSummary(): Promise<{
  state: string; written: number; harness: string | null; done: number | null; total: number | null
} | null> {
  try {
    const [{ JOURNAL_ENABLED, JOURNAL_PATH, JOURNAL_BACKFILL_PATH }, { backfillComplete, readBackfillProgress }, { fileIdentity }] = await Promise.all([
      import('./config'), import('./journal/backfill'), import('./journal/shadow'),
    ])
    if (!JOURNAL_ENABLED) return null
    const p = readBackfillProgress(JOURNAL_BACKFILL_PATH)
    if (backfillComplete(p, fileIdentity(JOURNAL_PATH))) return null
    if (!p) return { state: 'pending', written: 0, harness: null, done: null, total: null }
    return { state: p.state === 'done' ? 'pending' : p.state, written: p.written, harness: p.harness ?? null, done: p.done ?? null, total: p.total ?? null }
  } catch {
    return null
  }
}

/** GET /api/session */
export async function handleSession(_req: Request): Promise<Response> {
  // Unreadable preferences read the same as ABSENT ones do for each of these three switches —
  // ON for all three when the profile is capable (`shellAllowed`/`editorAllowed`'s owner-decided rule,
  // 2026-09-14, and `chatAllowed`'s, 2026-09-29). A failed read is not a person answering "no";
  // it is simply not knowing, and each gate's own rule for "not knowing" applies exactly as it
  // would to a preferences file with the key missing.
  const prefs = await readPreferences().catch(() => ({} as {
    chatEnabled?: boolean; shellEnabled?: boolean; editorEnabled?: boolean
  }))
  return new Response(
    JSON.stringify({
      // The exposure profile and the local capabilities it grants. The web app uses these to
      // hide affordances the server would refuse anyway.
      profile: PROFILE,
      capabilities: {
        localShell: CAPS.localShell,
        localChat: CAPS.localChat,
        localTranscripts: CAPS.localTranscripts,
        mcpAdmin: CAPS.mcpAdmin,
      },
      // What the chat endpoints will ACTUALLY answer: the capability AND the user's switch.
      // Separate from `capabilities.localChat`, which stays the exposure profile's answer alone —
      // the Settings tab has to be able to say "your profile allows this, you have it off".
      chatEnabled: chatAllowed(CAPS.localChat, prefs.chatEnabled),
      // The same split, for the per-session utility SHELL. `shellAllowedNow` folds in the in-memory
      // "Enable now" override (`shell-override-store.ts`) — the EFFECTIVE answer every shell route
      // actually gives.
      shellEnabled: shellAllowedNow(CAPS.localShell, prefs.shellEnabled, getShellOverride()),
      // The override's OWN raw value, reported apart from the combined `shellEnabled` so the
      // Settings screen can say WHICH of the two is in force.
      shellOverride: getShellOverride(),
      // The same split, for the repository explorer. Rides the SAME capability as the shell — see
      // `sessions/editor-gate.ts` for why there is no dedicated `localEditor` flag.
      editorEnabled: editorAllowed(CAPS.localShell, prefs.editorEnabled),
      // Whether the web reads its session, cost and tool figures from the projections (A4.7).
      projectionsWeb: projectionsWebOn(process.env, CAPS.localTranscripts),
      // The journal's first import, for the web's one-line note (`journal/backfill.ts`); `null` when
      // there is nothing to say (complete, journal off).
      journalBackfill: await journalBackfillSummary(),
    }),
    { status: 200, headers: JSON_CT },
  )
}

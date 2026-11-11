/**
 * engine-book-host.ts — the host's side of a hand-off book takeover (engine-api 1.26, `EngineBookHost`).
 *
 * The engine's takeover run ORDERS; the host DOES, through the doors it already has:
 * - the successor starts through the fleet's own spawn (`runFleetSpawn`) as the predecessor's VERIFIED hand-off
 *   (`handoff: true`, `parentVerified: true`) — the same plan `agentop session <harness> --handoff` gets: the
 *   predecessor's folder, filing, title and launch defaults, the account router's pick. Never a raw CLI.
 * - an unconfirmed (or partial) successor is killed with the fleet's `kill` action;
 * - the confirmed predecessor is retired with `requestRetire`, the very call `retirePredecessor` makes (it is
 *   closed once it goes quiet);
 * - a takeover proof is checked with `verifySessionIdentity` (`session-identity.ts`): the host never hands the key
 *   or a minted token to the engine.
 *
 * `parentVerified: true` is the SERVER's statement here: the engine only calls this from a passage a verified
 * leader started for its own task (`/api/book/passagem` checks the proof, the role and `taskOf`).
 */
import type { EngineBookHost } from '@agentistics/engine-api'
import type { FleetSpawnBody } from '../sessions/fleet-spawn'

interface RegistryRow {
  id: string
  harness: string
  cwd: string
  taskId?: string
  endedAt?: string
}

export interface BookHostDeps {
  registry: () => Promise<readonly RegistryRow[]>
  spawn: (body: FleetSpawnBody) => Promise<{ ok: boolean; message: string; id?: string; queued?: unknown }>
  kill: (id: string) => Promise<{ ok: boolean }>
  requestRetire: (predecessorId: string, successorId: string) => Promise<boolean>
  verify: (id: unknown, token: unknown) => Promise<string | null>
}

export function createBookHost(d: BookHostDeps): EngineBookHost {
  const row = async (id: string) => (await d.registry().catch(() => [] as RegistryRow[])).find(r => r.id === id)
  return {
    async spawnSuccessor(req) {
      const pred = await row(req.predecessorId)
      if (!pred || pred.endedAt) return { ok: false, sentence: `The leader ${req.predecessorId} is not a live session on this machine, so it has no successor to start.` }
      const out = await d.spawn({
        harness: req.harness ?? pred.harness,
        cwd: pred.cwd,
        parent: pred.id,
        parentVerified: true,
        // An agent's passage, never the owner's privilege on an account that is off for agents.
        callerVerified: true,
        handoff: true,
        prompt: req.prompt,
        ...(req.model ? { model: req.model } : {}),
        ...(req.account ? { account: req.account } : {}),
      }).catch((e: unknown) => ({ ok: false, message: e instanceof Error ? e.message : String(e) }) as { ok: boolean; message: string; id?: string })
      // A queued start has no session yet: the passage cannot reserve it, so it is a refusal (the queue may still start it).
      if (!out.ok || !out.id) return { ok: false, sentence: out.message }
      return { ok: true, sessionId: out.id }
    },
    async stop(sessionId) {
      return { closed: (await d.kill(sessionId).catch(() => ({ ok: false }))).ok }
    },
    async retire(predecessorId, successorId) {
      return { retired: await d.requestRetire(predecessorId, successorId).catch(() => false) }
    },
    async isAlive(sessionId) {
      const r = await row(sessionId)
      return !!r && !r.endedAt
    },
    async taskOf(sessionId) {
      return (await row(sessionId))?.taskId
    },
    async verifySession(id, token) {
      return !!id && !!token && (await d.verify(id, token).catch(() => null)) === id
    },
  }
}

/** The real members, over the fleet's and the registry's own functions, loaded on first use. */
export function hostBookPort(lang: () => 'en' | 'pt'): EngineBookHost {
  return createBookHost({
    registry: async () => (await import('../sessions/registry')).readRegistry(),
    spawn: async body => (await import('../sessions/fleet-web')).runFleetSpawn(lang(), body),
    kill: async id => (await import('../sessions/fleet-web')).runFleetAction(lang(), { id, action: 'kill' }),
    requestRetire: async (predecessorId, successorId) => (await import('../sessions/team-links-io')).requestRetire(predecessorId, successorId),
    verify: async (id, token) => (await import('../sessions/session-identity')).verifySessionIdentity(id, token),
  })
}

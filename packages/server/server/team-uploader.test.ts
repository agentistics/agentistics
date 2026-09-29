/**
 * team-uploader.test.ts — unit tests for pure functions (sessionHash, selectDeltas) PLUS
 * integration tests for the per-connection IO paths (status, sent-state, removal, the shared
 * push-cycle context, and the concurrency cap) using real localhost mock servers and a tmp
 * connection-state directory. The latter never touch the developer's real ~/.agentistics or
 * ~/.claude — see the `beforeAll`/`afterAll` below and the DI seams each impure function accepts
 * (`deps`), added specifically so these tests do not have to.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import {
  sessionHash, selectDeltas, emptyStatusFor, getUploaderStatus,
  pushOnceDetailed, removeConnection, runConnectionCycle,
  buildPushContext, getPushContext, invalidatePushContext,
  __setNotifierForTests, saveSentState,
  acquireSlot, MAX_CONCURRENT_PUSHES, __activeSlotsForTests, matchConnectionForLeave,
  __setRestrictedForTests, __hasPendingOnChangeForTests, __clearOnChangeTimerForTests,
  __teardownConnectionForTests,
  scheduleOnChangeTrigger, loadSentState, reconcileUploaderNow, MAX_SUPPRESSED_STREAK,
  replayForgetJournals, getResyncProgress, guardedManualPush, peekPushContext,
  AUTH_FAIL_SUSTAIN_MS, __setAuthErrSinceForTests,
  type PushCycleContext,
} from './team-uploader'
import { handleTeamStatus } from './team-connections'
import { updateTeamConfigAt, type TeamConfigMutator, type Preferences } from './preferences'
import { __setTeamConnDirForTests, AGENTISTICS_DATA_DIR, TEAM_CONN_DIR, teamSentFile, teamSyncFile, teamForgetFile } from './config'
import { loadRulesState, saveRulesState, emptyRulesState } from './team-rules'
import { convertSentStateV1 } from './team-migrate'
import {
  buildPathRepoIndex, buildSharedStatsCache, deniedDeltaByDay, filterShared, normalizeDenied,
  type PathRepoIndex,
} from './share-rules'
import type { SessionMeta, TeamConnection, StatsCache, TeamConfig, WorkflowRun, ShareSource } from '@agentistics/core'
import { NO_REPO_KEY } from '@agentistics/core'
import type { ServerProject } from './data'
import type { IngestBody } from './team-store'

// Minimal SessionMeta factory — only the fields needed for hashing/keying
function makeSession(id: string, extra?: Partial<SessionMeta>): SessionMeta {
  return {
    session_id: id,
    project_path: `/projects/${id}`,
    start_time: '2026-01-01T00:00:00.000Z',
    duration_minutes: 60,
    user_message_count: 10,
    assistant_message_count: 8,
    tool_counts: {},
    tool_output_tokens: {},
    agent_file_reads: {},
    languages: [],
    git_commits: 0,
    git_pushes: 0,
    input_tokens: 600,
    output_tokens: 400,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    first_prompt: 'hello',
    user_interruptions: 0,
    user_response_times: [],
    tool_errors: 0,
    tool_error_categories: {},
    uses_task_agent: false,
    uses_mcp: false,
    uses_web_search: false,
    uses_web_fetch: false,
    lines_added: 5,
    lines_removed: 2,
    files_modified: 1,
    message_hours: [],
    user_message_timestamps: [],
    model: 'claude-sonnet-4-6',
    harness: 'claude',
    ...extra,
  } as SessionMeta
}

describe('sessionHash', () => {
  const s = (over: Partial<SessionMeta> = {}): SessionMeta => ({
    session_id: 's1', project_path: '/p', start_time: '2026-07-01T10:00:00.000Z',
    ...over,
  } as SessionMeta)

  it('is a 64-char lowercase hex digest', () => {
    expect(sessionHash(s())).toMatch(/^[a-f0-9]{64}$/)
  })

  it('is stable for equal inputs and differs for a changed field', () => {
    expect(sessionHash(s())).toBe(sessionHash(s()))
    expect(sessionHash(s({ project_path: '/q' }))).not.toBe(sessionHash(s()))
  })

  // THE property the v1->v2 migration depends on: the v1 stored value IS JSON.stringify(session),
  // so sha256 of that value must equal the new digest of the same session. Without this, every
  // migrated member re-pushes its whole history on the first boot after upgrading.
  it('equals sha256 of the v1 stored value for the same session', () => {
    const session = s()
    const v1 = { s1: JSON.stringify(session) }
    const converted = convertSentStateV1(v1)
    expect(converted?.hashes.s1).toBe(sessionHash(session))
  })
})

describe('selectDeltas — credential scrubbing before the wire', () => {
  it('a secret pasted into first_prompt never reaches the outgoing payload', () => {
    const s = { ...makeSession('s1'), first_prompt: 'MONGO_URL=mongodb+srv://appuser:s3cr3tP4ssw0rd@cluster.mongodb.net/db' }
    const { toSend } = selectDeltas([s], {})
    expect(toSend).toHaveLength(1)
    expect(toSend[0]!.first_prompt).not.toContain('s3cr3tP4ssw0rd')
    expect(toSend[0]!.first_prompt).toContain('[REDACTED]')
  })

  it('the input session is not mutated — the local store keeps the original text', () => {
    const s = { ...makeSession('s1'), first_prompt: 'PASSWORD=sup3rS3cretValue' }
    selectDeltas([s], {})
    expect(s.first_prompt).toBe('PASSWORD=sup3rS3cretValue')
  })

  it('redaction does NOT cause an endless re-send loop', () => {
    // The hash is taken over the redacted session, so a second run with the same input sees the
    // same hash and sends nothing. Hashing the raw session instead would re-send it forever.
    const s = { ...makeSession('s1'), first_prompt: 'MONGO_URL=mongodb+srv://u:pw12345678@h/db' }
    const first = selectDeltas([s], {})
    expect(first.toSend).toHaveLength(1)
    expect(selectDeltas([s], first.nextSent).toSend).toHaveLength(0)
  })
})

describe('selectDeltas', () => {
  it('sends all sessions when sent state is empty', () => {
    const sessions = [makeSession('a'), makeSession('b')]
    const { toSend, nextSent } = selectDeltas(sessions, {})
    expect(toSend).toHaveLength(2)
    expect(nextSent).toHaveProperty('a', sessionHash(sessions[0]!))
    expect(nextSent).toHaveProperty('b', sessionHash(sessions[1]!))
  })

  it('does not resend a session whose hash is unchanged', () => {
    const s = makeSession('already')
    const sent = { already: sessionHash(s) }
    const { toSend, nextSent } = selectDeltas([s], sent)
    expect(toSend).toHaveLength(0)
    // The unchanged session's hash must still be preserved in nextSent
    expect(nextSent['already']).toBe(sessionHash(s))
  })

  it('resends a session whose hash changed and updates nextSent', () => {
    const old = makeSession('changed', { input_tokens: 100 })
    const updated = makeSession('changed', { input_tokens: 200 })
    const sent = { changed: sessionHash(old) }
    const { toSend, nextSent } = selectDeltas([updated], sent)
    expect(toSend).toHaveLength(1)
    expect(toSend[0]!.session_id).toBe('changed')
    expect(nextSent['changed']).toBe(sessionHash(updated))
  })

  it('sends new sessions while preserving unchanged sessions in nextSent', () => {
    const existing = makeSession('existing', { input_tokens: 42 })
    const brand_new = makeSession('new_session')
    const sent = { existing: sessionHash(existing) }

    const { toSend, nextSent } = selectDeltas([existing, brand_new], sent)
    // Only the new session should be sent
    expect(toSend).toHaveLength(1)
    expect(toSend[0]!.session_id).toBe('new_session')
    // Both sessions should be present in nextSent
    expect(nextSent).toHaveProperty('existing', sessionHash(existing))
    expect(nextSent).toHaveProperty('new_session', sessionHash(brand_new))
  })

  it('skips sessions with no session_id', () => {
    const noId = { ...makeSession('dummy'), session_id: '' } as unknown as SessionMeta
    const { toSend, nextSent } = selectDeltas([noId], {})
    expect(toSend).toHaveLength(0)
    expect(Object.keys(nextSent)).toHaveLength(0)
  })
})

describe('selectDeltas — per-connection sent-state isolation', () => {
  it('sent-state is per connection — one central advancing never marks another as sent', () => {
    const s = (id: string) => ({ session_id: id }) as unknown as SessionMeta
    const sessions = [s('a'), s('b')]
    const a = selectDeltas(sessions, {})
    expect(a.toSend).toHaveLength(2)
    // A second connection starts from ITS OWN empty state, not from the first one's result.
    const b = selectDeltas(sessions, {})
    expect(b.toSend).toHaveLength(2)
    // And a connection that already has one of them sends only the other.
    const c = selectDeltas(sessions, { a: sessionHash(s('a')) })
    expect(c.toSend.map(x => x.session_id)).toEqual(['b'])
  })
})

describe('emptyStatusFor', () => {
  it('a fresh connection reports no success and no error', () => {
    const st = emptyStatusFor('c_0123456789ab')
    expect(st.lastSuccessAt).toBeNull()
    expect(st.errKind).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Integration tests — real localhost mock servers, real (tmp-dir) sent-state files, no mocking
// of the filesystem or of team-uploader's own modules. `TEAM_CONN_DIR` is redirected for the
// WHOLE process (see the note on `__setTeamConnDirForTests`) to a tmp dir before any of these
// run, and restored after, so a real developer's ~/.agentistics/connections is never touched.
// ---------------------------------------------------------------------------

function randomConnId(): string {
  return 'c_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12)
}

/** Mirrors `@agentistics/core`'s legacy migration: `deniedRepos` entries become typed `repo`
 *  sources, `NO_REPO_KEY` becomes the typed `none` bucket. Lets every existing `deniedRepos`-based
 *  fixture below keep working unchanged against the Task 4 code path (which reads
 *  `sources`/`shareMode`, never `deniedRepos`) — pass `sources`/`shareMode` explicitly in `extra`
 *  to override this derivation (e.g. for a project rule or allowlist mode). */
function fakeConn(id: string, port: number, extra?: Partial<TeamConnection>): TeamConnection {
  const deniedRepos = extra?.deniedRepos ?? []
  const sources: ShareSource[] = deniedRepos.map(v =>
    v === NO_REPO_KEY ? { type: 'none' as const, value: '' } : { type: 'repo' as const, value: v })
  return {
    id,
    endpoint: `http://127.0.0.1:${port}`,
    org: 'default',
    user: 'test-user',
    token: 'test-token',
    deniedRepos,
    shareMode: 'denylist',
    sources,
    ...extra,
  }
}

function makeCtx(overrides?: Partial<PushCycleContext>): PushCycleContext {
  return {
    realStatsCache: null,
    liveSessions: [],
    storedSessions: [],
    projects: [],
    workflows: [],
    index: { resolved: new Map(), conflicts: new Map() },
    builtAt: Date.now(),
    ...overrides,
  }
}

/** A `deps.readPreferences` fake for `runConnectionCycle` — a single connection, member mode,
 *  properly typed against the real `Preferences` shape so drift in `readPreferences`'s signature
 *  fails `tsc` instead of being silently cast away. */
function fakeReadPreferences(conn: TeamConnection): () => Promise<Preferences> {
  const prefs: Preferences = { team: { schema: 2, mode: 'member', connections: [conn] } }
  return async () => prefs
}

// Captured from the LIVE binding at import time — this is whatever config.ts actually resolved
// (the real ~/.agentistics/connections, or another test file's override if one already ran and
// redirected it first). Restoring THIS value, not a fabricated path, is what actually undoes the
// override.
const _origConnDir = TEAM_CONN_DIR
let _tmpConnDir: string

beforeAll(async () => {
  // A fresh machine has no ~/.agentistics — exactly what a CI runner is — and on one the pushes
  // below never settle: 42 of these tests ran into their timeouts (5-15 s each, the whole suite
  // going from ~45 s to 300 s) while every one passes in ~1 s the moment the directory exists.
  // The suite only ever passed on runners because an EARLIER test file happened to create it, an
  // ordering nobody chose. Creating it here makes the file independent of that.
  await mkdir(AGENTISTICS_DATA_DIR, { recursive: true })
  // Redirect TEAM_CONN_DIR (a live `let` binding, see config.ts) at the module level, for the
  // whole rest of this bun test process — restored to `_origConnDir` in afterAll below.
  _tmpConnDir = join(tmpdir(), `agentistics-team-conn-${crypto.randomUUID()}`)
  await mkdir(_tmpConnDir, { recursive: true })
  __setTeamConnDirForTests(_tmpConnDir)
  // Every error/recovery/removal notification in these tests goes through this no-op instead of
  // sse.ts's real broadcastNotification, which would otherwise append a real entry to the
  // developer's ~/.agentistics/notifications.json.
  __setNotifierForTests(() => {})
})

afterAll(async () => {
  __setNotifierForTests(null)
  __setTeamConnDirForTests(_origConnDir)
  try { await rm(_tmpConnDir, { recursive: true, force: true }) } catch { /* best-effort cleanup */ }
})

describe('getUploaderStatus — per-connection divergence', () => {
  it('two connections pushed independently end up with independent status entries', async () => {
    const idOk = randomConnId()
    const idBad = randomConnId()
    await using serverOk = Bun.serve({ port: 0, fetch: () => Response.json({ ok: true }) })
    await using serverBad = Bun.serve({ port: 0, fetch: () => new Response('nope', { status: 401 }) })

    const connOk = fakeConn(idOk, serverOk.port!)
    const connBad = fakeConn(idBad, serverBad.port!)
    // A non-null statsCache forces pushOnceDetailed to actually contact the central even with an
    // empty storedSessions — otherwise the "nothing to push" branch never calls fetch at all.
    const ctx = makeCtx({ realStatsCache: { totalCostUSD: 0 } as unknown as StatsCache })

    await pushOnceDetailed(connOk, ctx)
    await pushOnceDetailed(connBad, ctx)

    const status = getUploaderStatus()
    expect(status[idOk]?.errKind).toBeNull()
    expect(status[idOk]?.lastSuccessAt).not.toBeNull()
    expect(status[idBad]?.errKind).toBe('auth')
    // The failing connection's status must not leak onto (or be shared with) the healthy one —
    // this is exactly what the pre-decomposition singletons could not express.
    expect(status[idOk]?.errKind).not.toBe(status[idBad]?.errKind)
  })

  it('emptyStatusFor is shape-compatible with a real cycle status — the fallback handleTeamStatus serves for a connection that never ran', async () => {
    // M1: `emptyStatusFor` had no production caller and a test that asserted the literal it
    // returns. It is now what `handleTeamStatus` falls back to for a connection with no entry in
    // `getUploaderStatus()`, so the property worth pinning is PARITY with a real entry: a missing
    // field here would silently drop `latencyMs` (or a future field) from that response.
    const id = randomConnId()
    await using server = Bun.serve({ port: 0, fetch: () => Response.json({ ok: true }) })
    await pushOnceDetailed(fakeConn(id, server.port!), makeCtx({ realStatsCache: { totalCostUSD: 0 } as unknown as StatsCache }))
    const real = getUploaderStatus()[id]
    expect(real).toBeDefined()
    expect(Object.keys(emptyStatusFor(id)).sort()).toEqual(Object.keys(real!).sort())
  })
})

describe('pushOnceDetailed — credentials gate (F1: token || open-central endpoint, not user)', () => {
  it('a connection with an empty user but a valid token resolves its identity via whoami and pushes', async () => {
    const id = randomConnId()
    const whoamiCalls: string[] = []
    await using server = Bun.serve({
      port: 0,
      fetch: (req) => {
        const url = new URL(req.url)
        if (url.pathname === '/api/team/whoami' && req.method === 'GET') {
          whoamiCalls.push(req.headers.get('authorization') ?? '')
          return Response.json({ ok: true, user: 'resolved-name', org: 'default' })
        }
        if (url.pathname === '/api/team/ingest' && req.method === 'POST') {
          return Response.json({ ok: true, count: 1 })
        }
        return new Response('not found', { status: 404 })
      },
    })

    const conn = fakeConn(id, server.port!, { user: '', token: 'valid-token' })
    const ctx = makeCtx({ storedSessions: [makeSession('needs-a-name')] })

    // In-memory fake, same shape as removeConnection's test double above — proves the resolved
    // name was persisted, without touching the developer's real preferences file.
    let store: TeamConfig = { schema: 2, mode: 'member', connections: [conn] }
    const fakeUpdateTeamConfig = async (mutate: TeamConfigMutator): Promise<TeamConfig> => {
      const next = mutate(store)
      if (next !== undefined) store = next
      return store
    }

    const result = await pushOnceDetailed(conn, ctx, { updateTeamConfig: fakeUpdateTeamConfig })

    // The push actually went through (not silently swallowed as count:0 the way the old
    // `!conn.user` gate did) — this is the behavior the review asked to prove: a connection
    // holding a live socket but refusing to push is exactly what F1 closes.
    expect(result.count).toBe(1)
    expect(result.error).toBeUndefined()
    expect(whoamiCalls).toEqual(['Bearer valid-token'])
    // The resolved name was persisted into the connection entry, so later cycles never re-resolve.
    expect(store.connections[0]?.user).toBe('resolved-name')
  })

  it('a connection with an empty user and no way to resolve it (whoami unreachable) still yields count:0, not a throw', async () => {
    const id = randomConnId()
    await using server = Bun.serve({ port: 0, fetch: () => new Response('nope', { status: 500 }) })
    const conn = fakeConn(id, server.port!, { user: '', token: 'valid-token' })
    const ctx = makeCtx({ storedSessions: [makeSession('s1')] })
    let store: TeamConfig = { schema: 2, mode: 'member', connections: [conn] }
    const fakeUpdateTeamConfig = async (mutate: TeamConfigMutator): Promise<TeamConfig> => {
      const next = mutate(store)
      if (next !== undefined) store = next
      return store
    }

    const result = await pushOnceDetailed(conn, ctx, { updateTeamConfig: fakeUpdateTeamConfig })

    expect(result).toEqual({ count: 0 })
    // Nothing was persisted — the connection's user is still unresolved, to be retried next cycle.
    expect(store.connections[0]?.user).toBe('')
  })

  it('an endpoint-only connection (no token — an open/legacy central) still attempts the push instead of refusing on sight', async () => {
    const id = randomConnId()
    // M2: the whoami hits are RECORDED, because `{ count: 0 }` alone cannot tell this apart from
    // the very failure the test claims to rule out — a connection refused on sight, before any
    // network call, returns the identical value. The assertion that matters is that the request
    // happened at all, exactly once.
    const whoamiCalls: string[] = []
    await using server = Bun.serve({
      port: 0,
      fetch: (req) => {
        const url = new URL(req.url)
        if (url.pathname === '/api/team/whoami') {
          whoamiCalls.push(req.headers.get('authorization') ?? '')
          // An open central with no token has nothing to authenticate — no usable identity.
          return Response.json({ ok: false })
        }
        return new Response('not found', { status: 404 })
      },
    })
    const conn = fakeConn(id, server.port!, { user: '', token: '' })
    const ctx = makeCtx({ storedSessions: [makeSession('s1')] })

    const result = await pushOnceDetailed(conn, ctx, { updateTeamConfig: async () => ({ schema: 2, mode: 'member', connections: [conn] }) })

    // Cannot resolve an identity against this open central — count:0, not an error/throw. The
    // important thing this test proves is the ENDPOINT alone was enough to attempt the whoami
    // call at all (the old gate would have refused before ever reaching the network).
    expect(result).toEqual({ count: 0 })
    // Exactly one attempt, and with NO Authorization header (there is no token to send).
    expect(whoamiCalls).toEqual([''])
  })
})

describe('B-1 — a central that accepts the connection and never responds', () => {
  it('the ingest fetch does not hang forever — it times out and returns an error result', async () => {
    const id = randomConnId()
    // Accepts the TCP connection (Bun.serve always does) and never resolves the handler —
    // exactly the "wedged reverse proxy" scenario named in the review. Before the fix, the
    // ingest fetch carried no AbortSignal at all and this would have hung the test until Bun's
    // own default test timeout killed it, holding a concurrency-cap slot the whole time.
    await using hung = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => { /* never resolves */ }) })
    const conn = fakeConn(id, hung.port!)
    // A short injected timeout (see PushCycleContext.ingestTimeoutMs) proves the SAME mechanism
    // production uses (DEFAULT_INGEST_TIMEOUT_MS) without this test waiting out the real 15s.
    const ctx = makeCtx({
      storedSessions: [makeSession('mid-flight')],
      ingestTimeoutMs: 200,
    })

    const start = Date.now()
    const result = await pushOnceDetailed(conn, ctx)
    const elapsed = Date.now() - start

    expect(elapsed).toBeLessThan(2_000) // resolved by the injected timeout, not by hanging
    expect(result.error).toBeDefined() // the abort surfaces as a push error, not a silent success
    expect(getUploaderStatus()[id]?.errKind).toBe('net')
  }, 10_000)

  it('a hung connection does not stall a second connection pushed afterward', async () => {
    const idHung = randomConnId()
    const idOk = randomConnId()
    await using hung = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) })
    await using ok = Bun.serve({ port: 0, fetch: () => Response.json({ ok: true }) })

    const ctx = makeCtx({ storedSessions: [makeSession('s1')], ingestTimeoutMs: 200 })
    await pushOnceDetailed(fakeConn(idHung, hung.port!), ctx)

    // The slot the hung push held is released once its fetch aborts (see acquireSlot/releaseSlot
    // in team-uploader.ts) — a second, otherwise-independent connection pushed afterward must
    // complete promptly rather than inheriting a permanently-exhausted cap.
    const start = Date.now()
    const okResult = await pushOnceDetailed(fakeConn(idOk, ok.port!), ctx)
    expect(Date.now() - start).toBeLessThan(2_000)
    expect(okResult.error).toBeUndefined()
    expect(getUploaderStatus()[idOk]?.errKind).toBeNull()
  }, 10_000)
})

describe('buildPushContext — ordering and pairing', () => {
  it('calls buildApiResponse before loadConsolidated (the store must be written before it is read)', async () => {
    const order: string[] = []
    const ctx = await buildPushContext({
      buildApiResponse: async () => {
        order.push('buildApiResponse')
        return { sessions: [makeSession('live-1')], statsCache: null, projects: [], workflows: [] }
      },
      loadConsolidated: async () => {
        order.push('loadConsolidated')
        return new Map([['stored-1', makeSession('stored-1')]])
      },
    })
    expect(order).toEqual(['buildApiResponse', 'loadConsolidated'])
    // And the two arrays it returns are the DIFFERENT ones the brief requires — never conflated.
    expect(ctx.liveSessions.map(s => s.session_id)).toEqual(['live-1'])
    expect(ctx.storedSessions.map(s => s.session_id)).toEqual(['stored-1'])
  })

  it('a failed buildApiResponse yields an empty liveSessions/null statsCache pair, never a raw-cache/empty-array mismatch', async () => {
    const ctx = await buildPushContext({
      buildApiResponse: async () => { throw new Error('boom') },
      loadConsolidated: async () => new Map(),
    })
    expect(ctx.liveSessions).toEqual([])
    expect(ctx.realStatsCache).toBeNull() // never a raw-file fallback paired with an empty array
  })
})

describe('getPushContext cache — invalidation (B-3)', () => {
  it('serves a cached snapshot within the TTL, and notifyDataChanged\'s invalidation forces a rebuild that sees a mid-window change', async () => {
    let call = 0
    const deps = {
      buildApiResponse: async () => ({ sessions: [], statsCache: null, projects: [], workflows: [] }),
      loadConsolidated: async () => {
        call++
        const sessions = call === 1 ? [makeSession('s1')] : [makeSession('s1'), makeSession('s2')]
        return new Map(sessions.map(s => [s.session_id, s]))
      },
    }

    const ctx1 = await getPushContext(deps)
    expect(ctx1.storedSessions.map(s => s.session_id)).toEqual(['s1'])

    // Within the TTL window, a second call reuses the cached snapshot — s2 (which "landed" in
    // the store between the two calls) is NOT yet visible. This is the bug: without invalidation
    // a deferred retry reusing this snapshot would find no delta and silently wait a full
    // interval anyway.
    const stale = await getPushContext(deps)
    expect(stale.storedSessions.map(s => s.session_id)).toEqual(['s1'])
    expect(call).toBe(1) // loadConsolidated was NOT called again — proves the cache is real

    // The fix: the same invalidation notifyDataChanged() performs.
    invalidatePushContext()
    const fresh = await getPushContext(deps)
    expect(call).toBe(2)
    expect(fresh.storedSessions.map(s => s.session_id).sort()).toEqual(['s1', 's2'])

    // And selectDeltas against the FRESH context (not the stale one) actually surfaces s2 as a
    // delta — this is what lets a deferred push carry the mid-cycle change instead of no-op'ing.
    const { nextSent } = selectDeltas(ctx1.storedSessions, {})
    const { toSend } = selectDeltas(fresh.storedSessions, nextSent)
    expect(toSend.map(s => s.session_id)).toEqual(['s2'])
  })
})

describe('runConnectionCycle — pendingTrigger deferral', () => {
  it('a second trigger arriving while the first is running is deferred, not dropped, and the connection pushes again on the next call', async () => {
    const connId = randomConnId()
    let ingestCalls = 0
    let policyCalls = 0
    await using server = Bun.serve({
      port: 0,
      fetch: (req) => {
        const url = new URL(req.url)
        if (url.pathname === '/api/team/ingest') { ingestCalls++; return Response.json({ ok: true }) }
        policyCalls++
        return Response.json({ pushIntervalSec: 30, instanceId: null }) // /api/team/policy
      },
    })
    const conn = fakeConn(connId, server.port!)
    const deps = {
      readPreferences: fakeReadPreferences(conn),
      migrateTeamStateOnce: async () => {},
      // Injected explicitly (N-1) — `runConnectionPushCycle` would otherwise call the internal,
      // un-DI'd `getPushContext()`, which touches the real ~/.claude/~/.agentistics UNLESS a
      // neighbouring test happens to have left a still-fresh fake context cached from an earlier
      // call — an accident this test must not depend on for its own isolation.
      ctx: makeCtx({ storedSessions: [] }), // nothing to push — this test is about the GUARD, not content
    }

    // `runConnectionCycle` runs synchronously up to its first `await`, setting `_running` before
    // yielding — so calling it twice back-to-back deterministically reproduces "a trigger arrives
    // while the connection is already mid-cycle": the second call sees `_running` already set and
    // defers instead of racing the first for the same connId.
    const first = runConnectionCycle(connId, deps)
    const second = runConnectionCycle(connId, deps)
    await Promise.all([first, second])

    // The deferred trigger did NOT cause a second, concurrent CYCLE — only one policy fetch (one
    // full cycle) ran, proving `second` truly deferred instead of racing `first` for the same
    // connId (which would have raced two `saveSentState` calls for the same sent-state file).
    // ctx.storedSessions is empty, so the ingest endpoint is never even hit — asserted at 0, not
    // "at most 1", since a non-zero count here would mean the deferred trigger DID cause an
    // unexpected push.
    expect(policyCalls).toBe(1)
    expect(ingestCalls).toBe(0)

    // The guard was properly released (not left stuck "running" forever) and the deferred flag
    // was consumed — a further call runs the cycle again for real rather than being silently
    // swallowed.
    await runConnectionCycle(connId, deps)
    expect(policyCalls).toBe(2)
    expect(ingestCalls).toBe(0)
  })
})

describe('runConnectionCycle — concurrency cap under real contention (B-1 slot release)', () => {
  it('two hung connections occupy both slots; a third pushed concurrently is DELAYED until one times out and releases its slot', async () => {
    const idH1 = randomConnId()
    const idH2 = randomConnId()
    const idOk = randomConnId()

    // Answers /api/team/policy immediately (so the connection reaches acquireSlot() quickly) but
    // NEVER answers /api/team/ingest — the exact "central that accepts the connection and never
    // responds" scenario, this time exercised through the semaphore-guarded path
    // (runConnectionPushCycle), not pushOnceDetailed directly.
    const hungHandler = (req: Request): Response | Promise<Response> => {
      const url = new URL(req.url)
      if (url.pathname === '/api/team/ingest') return new Promise<Response>(() => { /* never resolves */ })
      return Response.json({ pushIntervalSec: 30, instanceId: null })
    }
    await using h1 = Bun.serve({ port: 0, fetch: hungHandler })
    await using h2 = Bun.serve({ port: 0, fetch: hungHandler })

    let okHitAt: number | null = null
    await using ok = Bun.serve({
      port: 0,
      fetch: (req) => {
        const url = new URL(req.url)
        if (url.pathname === '/api/team/ingest') { okHitAt = Date.now(); return Response.json({ ok: true }) }
        return Response.json({ pushIntervalSec: 30, instanceId: null })
      },
    })

    const connH1 = fakeConn(idH1, h1.port!)
    const connH2 = fakeConn(idH2, h2.port!)
    const connOk = fakeConn(idOk, ok.port!)

    const ingestTimeoutMs = 300
    const ctxFor = (label: string) => makeCtx({ storedSessions: [makeSession(`s-${label}`)], ingestTimeoutMs })

    // Start BOTH hung connections first, unawaited — with MAX_CONCURRENT_PUSHES = 2 they should
    // occupy both slots almost immediately (their own /api/team/policy round-trip is real
    // network, but to localhost, so this is fast).
    const h1Promise = runConnectionCycle(idH1, { readPreferences: fakeReadPreferences(connH1), migrateTeamStateOnce: async () => {}, ctx: ctxFor('h1') })
    const h2Promise = runConnectionCycle(idH2, { readPreferences: fakeReadPreferences(connH2), migrateTeamStateOnce: async () => {}, ctx: ctxFor('h2') })
    // Give the event loop time for both to reach acquireSlot() and occupy both slots before the
    // third (connOk) is started — generous relative to a localhost round-trip.
    await new Promise(resolve => setTimeout(resolve, 100))

    const okStart = Date.now()
    await runConnectionCycle(idOk, { readPreferences: fakeReadPreferences(connOk), migrateTeamStateOnce: async () => {}, ctx: ctxFor('ok') })
    const okElapsed = Date.now() - okStart

    await Promise.all([h1Promise, h2Promise]) // let the hung cycles finish (time out) too

    expect(okHitAt).not.toBeNull()
    // The ok push could only start once a hung connection's ingest fetch timed out and released
    // its slot — i.e. it was genuinely BLOCKED, not immediate. A generous lower bound (half the
    // injected timeout) avoids flaking on a loaded CI box while still failing hard if the old,
    // unbounded `Promise.all`-style dispatch (or a leaked slot) let it through immediately.
    expect(okElapsed).toBeGreaterThanOrEqual(ingestTimeoutMs / 2)
  }, 15_000)
})

describe('acquireSlot/releaseSlot — concurrency cap semaphore (B-5)', () => {
  it('a release racing a brand-new synchronous acquire never admits a third holder against the cap', async () => {
    expect(MAX_CONCURRENT_PUSHES).toBe(2)
    const cap = MAX_CONCURRENT_PUSHES

    const r1 = await acquireSlot()
    const r2 = await acquireSlot()
    expect(__activeSlotsForTests()).toBe(cap)

    // A third caller queues — the cap is full.
    const queued = acquireSlot()

    // Release one slot, then IMMEDIATELY (same synchronous tick — before the woken queued
    // caller's own suspended continuation gets a chance to run as a microtask) issue a
    // brand-new acquire call. This is the exact race the old decrement-then-signal
    // implementation lost: it would let this new call admit itself synchronously off the
    // stale (already-decremented) count, and the woken queued caller's continuation would THEN
    // ALSO increment — three grants against a cap of two.
    r1()
    const brandNew = acquireSlot()

    const rQueued = await queued
    // The critical assertion: right after the woken (transferred) caller has fully resolved, the
    // active count must still be exactly at the cap — never one over it. Verified this actually
    // catches the bug: temporarily reverting `releaseSlot`/`acquireSlot` to the old
    // decrement-then-signal implementation makes this specific assertion read 3 here and fail
    // (see the report for the red/green transcript).
    expect(__activeSlotsForTests()).toBeLessThanOrEqual(cap)

    // Free a slot for `brandNew` (still queued under the fix — nothing has released for it yet).
    r2()
    const rBrandNew = await brandNew
    expect(__activeSlotsForTests()).toBeLessThanOrEqual(cap)

    // Drain back to zero so this private module-level semaphore doesn't affect later tests.
    rQueued()
    rBrandNew()
    expect(__activeSlotsForTests()).toBe(0)
  })
})

describe('removeConnection — splices one entry, GCs only its own files (B-2)', () => {
  it('removes only the target connection; the OTHER connection\'s state files are untouched', async () => {
    const idA = randomConnId()
    const idB = randomConnId()
    const connA = fakeConn(idA, 1) // port is irrelevant — no network call in this test
    const connB = fakeConn(idB, 2)

    // Real files, under the tmp TEAM_CONN_DIR set in beforeAll.
    await saveSentState(idA, { s1: 'hash-a' })
    await saveSentState(idB, { s1: 'hash-b' })
    expect(await Bun.file(teamSentFile(idA)).exists()).toBe(true)
    expect(await Bun.file(teamSentFile(idB)).exists()).toBe(true)

    let store: TeamConfig = { schema: 2, mode: 'member', connections: [connA, connB] }
    let writes = 0
    const fakeUpdateTeamConfig = async (mutate: TeamConfigMutator): Promise<TeamConfig> => {
      const next = mutate(store)
      if (next === undefined) return store
      writes++
      store = next
      return store
    }

    await removeConnection(idA, 'manual', { updateTeamConfig: fakeUpdateTeamConfig })

    expect(writes).toBe(1)
    expect(store.connections.map(c => c.id)).toEqual([idB])
    expect(await Bun.file(teamSentFile(idA)).exists()).toBe(false) // GC'd
    expect(await Bun.file(teamSentFile(idB)).exists()).toBe(true) // untouched

    // Idempotent — a second removal of the same (now-gone) connection does not re-write.
    await removeConnection(idA, 'manual', { updateTeamConfig: fakeUpdateTeamConfig })
    expect(writes).toBe(1)
  })

  it('two concurrent removals for DIFFERENT connections both survive — exercised against the REAL enqueueWrite chain via updateTeamConfigAt (B-2)', async () => {
    const idA = randomConnId()
    const idB = randomConnId()
    const idC = randomConnId()
    const connA = fakeConn(idA, 1)
    const connB = fakeConn(idB, 2)
    const connC = fakeConn(idC, 3)
    await saveSentState(idA, {})
    await saveSentState(idB, {})
    await saveSentState(idC, {})

    // Real tmp preference files (never the developer's real ~/.agentistics/preferences.json) fed
    // through `updateTeamConfigAt` — the SAME path-parameterized function `updateTeamConfig`
    // binds to the real path in production, and the SAME module-level `enqueueWrite` chain in
    // preferences.ts. This is not a hand-rolled stand-in: it is the real atomicity mechanism.
    const primary = join(tmpdir(), `agentistics-prefs-${crypto.randomUUID()}`, 'preferences.json')
    const legacy = join(tmpdir(), `agentistics-prefs-legacy-${crypto.randomUUID()}`, 'agentistics-preferences.json')
    const seed: TeamConfig = { schema: 2, mode: 'member', connections: [connA, connB, connC] }
    await updateTeamConfigAt(primary, legacy, () => seed)

    const boundUpdateTeamConfig = (mutate: TeamConfigMutator) => updateTeamConfigAt(primary, legacy, mutate)

    // Fire both removals "concurrently" (before either's internal await resolves) through the
    // REAL write chain.
    await Promise.all([
      removeConnection(idA, 'manual', { updateTeamConfig: boundUpdateTeamConfig }),
      removeConnection(idB, 'manual', { updateTeamConfig: boundUpdateTeamConfig }),
    ])

    // Neither removal was lost, and neither resurrected the other's already-removed entry — read
    // back from the real tmp file, not from in-memory state, so this proves the WRITE, not just
    // the in-process return value.
    const finalRaw = await Bun.file(primary).text()
    const final = JSON.parse(finalRaw) as { team: TeamConfig }
    expect(final.team.connections.map(c => c.id).sort()).toEqual([idC])

    await rm(join(primary, '..'), { recursive: true, force: true }).catch(() => {})
    await rm(join(legacy, '..'), { recursive: true, force: true }).catch(() => {})
  })

  // Review finding I1 (second half): removeConnection used to warn-and-return `void` on a write
  // failure, so nothing downstream could tell a lock timeout from a real removal. It now returns
  // {removed:false, error} — assert that explicitly, not just the side effects.
  it('a write failure (e.g. a lock timeout) returns {removed:false, error} instead of asserting success', async () => {
    const id = randomConnId()
    const conn = fakeConn(id, 1)
    const store: TeamConfig = { schema: 2, mode: 'member', connections: [conn] }
    const failingUpdateTeamConfig = async (mutate: TeamConfigMutator): Promise<TeamConfig> => {
      mutate(store) // run it (so removedConn gets set internally) but then simulate the write failing
      throw new Error('preferences write lock timed out')
    }

    const result = await removeConnection(id, 'manual', { updateTeamConfig: failingUpdateTeamConfig })

    expect(result).toEqual({ removed: false, error: 'preferences write lock timed out' })
  })

  it('a successful removal returns {removed:true}', async () => {
    const id = randomConnId()
    const conn = fakeConn(id, 1)
    let store: TeamConfig = { schema: 2, mode: 'member', connections: [conn] }
    const fakeUpdateTeamConfig = async (mutate: TeamConfigMutator): Promise<TeamConfig> => {
      const next = mutate(store)
      if (next !== undefined) store = next
      return store
    }

    const result = await removeConnection(id, 'manual', { updateTeamConfig: fakeUpdateTeamConfig })

    expect(result).toEqual({ removed: true })
  })

  // Review finding N5: deps.log defaults to console; a caller (cli-member.ts's direct-fallback
  // path) can override it to silence the [team-uploader] lines instead of having them print into
  // its own terminal output — zero behavior change for the default (server/browser) path, which
  // never passes this.
  it('deps.log overrides console with zero change to default (unspecified) behavior', async () => {
    const id = randomConnId()
    const conn = fakeConn(id, 1)
    let store: TeamConfig = { schema: 2, mode: 'member', connections: [conn] }
    const fakeUpdateTeamConfig = async (mutate: TeamConfigMutator): Promise<TeamConfig> => {
      const next = mutate(store)
      if (next !== undefined) store = next
      return store
    }
    const logged: string[] = []
    const fakeLog = { info: (m: string) => logged.push(`info:${m}`), warn: (m: string) => logged.push(`warn:${m}`) }

    const result = await removeConnection(id, 'manual', { updateTeamConfig: fakeUpdateTeamConfig, log: fakeLog })

    expect(result).toEqual({ removed: true })
    expect(logged.some(l => l.startsWith('warn:') && l.includes('removed connection'))).toBe(true)
  })

  // Review the production incident this whole task fixes: a central answers 401 to a perfectly
  // valid token whenever it cannot find it in Mongo — its own state right after a rebuild that
  // recreates the volume, or while its database is still coming up. Two consecutive push cycles
  // (roughly a minute at the default interval) used to be enough to splice the connection out of
  // `connections[]` entirely, taking `deniedRepos` with it. removeConnection must no longer be
  // reachable from an auth failure at all — only a sustained one (past AUTH_FAIL_SUSTAIN_MS) may
  // mark the connection, and marking is never removal.
  it('reason === "revoked" also logs at console.warn, naming the connection + endpoint host, never the token', async () => {
    const id = randomConnId()
    const conn = fakeConn(id, 1, { token: 'super-secret-token' })
    let store: TeamConfig = { schema: 2, mode: 'member', connections: [conn] }
    const fakeUpdateTeamConfig = async (mutate: TeamConfigMutator): Promise<TeamConfig> => {
      const next = mutate(store)
      if (next !== undefined) store = next
      return store
    }
    const logged: string[] = []
    const fakeLog = { info: (m: string) => logged.push(`info:${m}`), warn: (m: string) => logged.push(`warn:${m}`) }

    await removeConnection(id, 'revoked', { updateTeamConfig: fakeUpdateTeamConfig, log: fakeLog })

    const warnLine = logged.find(l => l.startsWith('warn:') && l.includes('removed connection'))
    expect(warnLine).toBeDefined()
    expect(warnLine).toContain(id)
    expect(warnLine).toContain('127.0.0.1')
    expect(warnLine).not.toContain('super-secret-token')
  })
})

describe('sustained auth failure — durable mark, never removal (production-incident fix)', () => {
  /** A mock central whose /api/team/whoami and /api/team/ingest status codes can be flipped
   *  mid-test, and which records which paths were actually hit — the "stop pushing" assertion
   *  needs to see whether /api/team/ingest was ever called at all, not just its response. */
  function authFixture(initialStatus: number) {
    let ingestStatus = initialStatus
    let whoamiStatus = initialStatus
    const hits: string[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname
        hits.push(path)
        if (path === '/api/team/policy') {
          return Response.json({ pushIntervalSec: 30, instanceId: 'inst-1', capabilities: [] })
        }
        if (path === '/api/team/whoami') {
          if (whoamiStatus !== 200) return new Response('unauthorized', { status: whoamiStatus })
          return Response.json({ ok: true, user: 'test-user', org: 'default' })
        }
        // /api/team/ingest
        if (ingestStatus !== 200) return new Response('unauthorized', { status: ingestStatus })
        await req.json().catch(() => undefined)
        return Response.json({ ok: true, count: 0 })
      },
    })
    return {
      port: server.port!,
      hits,
      setIngestStatus: (s: number) => { ingestStatus = s },
      setWhoamiStatus: (s: number) => { whoamiStatus = s },
      stop: () => server.stop(true),
    }
  }

  it('two consecutive 401 cycles no longer remove the connection, and deniedRepos survives', async () => {
    const fx = authFixture(401)
    try {
      const id = randomConnId()
      const conn = fakeConn(id, fx.port, { deniedRepos: ['github.com/org/secret', 'github.com/org/other'] })
      let store: TeamConfig = { schema: 2, mode: 'member', connections: [conn] }
      const fakeUpdateTeamConfig = async (mutate: TeamConfigMutator): Promise<TeamConfig> => {
        const next = mutate(store)
        if (next !== undefined) store = next
        return store
      }
      const ctx = makeCtx({ realStatsCache: buildRealCacheFor([]) })

      // Two consecutive cycles — the OLD threshold (AUTH_ERR_RESET_THRESHOLD = 2) used to splice
      // the connection out right here.
      await pushOnceDetailed(conn, ctx, { updateTeamConfig: fakeUpdateTeamConfig })
      await pushOnceDetailed(conn, ctx, { updateTeamConfig: fakeUpdateTeamConfig })
      // handleAuthError runs fire-and-forget off the 401 branch — yield one tick so its (would-be)
      // write has landed before asserting on it. Without this the old removeConnection call from
      // the SECOND cycle's un-awaited promise would not have flushed yet either, and this test
      // would have gone green against the very removal it names.
      await new Promise(resolve => setTimeout(resolve, 0))

      expect(store.connections.map(c => c.id)).toEqual([id])
      expect(store.connections[0]!.deniedRepos).toEqual(['github.com/org/secret', 'github.com/org/other'])
      // Not sustained yet either (real elapsed time between two immediate calls is far below
      // AUTH_FAIL_SUSTAIN_MS) — so not even the new durable mark has landed.
      expect(store.connections[0]!.authFailedAt).toBeUndefined()
    } finally {
      fx.stop()
    }
  })

  it('a sustained auth failure (past AUTH_FAIL_SUSTAIN_MS) sets the persisted flag and stops pushing', async () => {
    const fx = authFixture(401)
    try {
      const id = randomConnId()
      const conn = fakeConn(id, fx.port, { deniedRepos: [] })
      let store: TeamConfig = { schema: 2, mode: 'member', connections: [conn] }
      const fakeUpdateTeamConfig = async (mutate: TeamConfigMutator): Promise<TeamConfig> => {
        const next = mutate(store)
        if (next !== undefined) store = next
        return store
      }
      const ctx = makeCtx({ realStatsCache: { totalCostUSD: 0 } as unknown as StatsCache })

      // Fast-forward the connection's failure clock past the sustain threshold instead of
      // actually waiting AUTH_FAIL_SUSTAIN_MS in real time.
      __setAuthErrSinceForTests(id, Date.now() - AUTH_FAIL_SUSTAIN_MS - 1_000)

      await pushOnceDetailed(conn, ctx, { updateTeamConfig: fakeUpdateTeamConfig })
      // handleAuthError runs fire-and-forget off the 401 branch (same as the pre-existing
      // notifyPushError path) — yield one tick so its `markAuthFailed` write has landed before
      // asserting on it, exactly like the existing "after the bound elapses" test above does.
      await new Promise(resolve => setTimeout(resolve, 0))

      // Marked, not removed.
      expect(store.connections.map(c => c.id)).toEqual([id])
      expect(typeof store.connections[0]!.authFailedAt).toBe('string')
      expect(store.connections[0]!.authFailedAt!.length).toBeGreaterThan(0)

      const hitsBefore = fx.hits.length
      fx.hits.length = 0

      // Next cycle: re-read the (now-marked) connection, same as the real supervisor loop would.
      const marked = store.connections[0]!
      const result = await pushOnceDetailed(marked, ctx, { updateTeamConfig: fakeUpdateTeamConfig })

      expect(result).toEqual({ count: 0 })
      // Only the cheap whoami probe was attempted — never the full ingest payload — while the
      // central still rejects the token.
      expect(fx.hits).toEqual(['/api/team/whoami'])
      expect(hitsBefore).toBeGreaterThan(0) // sanity: the marking cycle did contact the central
    } finally {
      fx.stop()
    }
  })

  it('a success after a sustained failure clears the flag and resumes pushing, with no human action', async () => {
    const fx = authFixture(401)
    try {
      const id = randomConnId()
      const conn = fakeConn(id, fx.port, { deniedRepos: [] })
      // Start already marked, as if a previous process (or a previous test cycle) set it.
      const markedAt = new Date(Date.now() - 60_000).toISOString()
      let store: TeamConfig = {
        schema: 2, mode: 'member', connections: [{ ...conn, authFailedAt: markedAt }],
      }
      const fakeUpdateTeamConfig = async (mutate: TeamConfigMutator): Promise<TeamConfig> => {
        const next = mutate(store)
        if (next !== undefined) store = next
        return store
      }
      const ctx = makeCtx({ realStatsCache: { totalCostUSD: 0 } as unknown as StatsCache })

      // The central is unauthorized no more.
      fx.setWhoamiStatus(200)
      fx.setIngestStatus(200)

      const marked = store.connections[0]!
      const result = await pushOnceDetailed(marked, ctx, { updateTeamConfig: fakeUpdateTeamConfig })

      // Flag cleared — no human had to do anything.
      expect(store.connections[0]!.authFailedAt).toBeUndefined()
      // And THIS SAME cycle already resumed pushing (the probe's success falls through into the
      // normal push path) rather than waiting a whole extra interval to notice.
      expect(fx.hits).toContain('/api/team/whoami')
      expect(fx.hits).toContain('/api/team/ingest')
      expect(result.count).toBe(0) // no session deltas in this ctx — just the statsCache/keep-alive push
    } finally {
      fx.stop()
    }
  })

  // Important 1 from review: an AGENTISTICS_INGEST_ONLY central 404s every route except
  // POST /api/team/ingest and POST /api/team/forget by design — so treating anything short of a
  // 2xx from GET /api/team/whoami as "still rejected" would strand a member on such a central
  // forever, even after the operator restores the token, with disconnect+reconnect (minting a new
  // token/identity) as the only escape. Only an explicit 401/403 may keep the connection paused.
  it('a marked connection recovers against a central where whoami 404s but ingest itself accepts the token (ingest-only central)', async () => {
    const fx = authFixture(401)
    try {
      const id = randomConnId()
      const conn = fakeConn(id, fx.port, { deniedRepos: [] })
      const markedAt = new Date(Date.now() - 60_000).toISOString()
      let store: TeamConfig = {
        schema: 2, mode: 'member', connections: [{ ...conn, authFailedAt: markedAt }],
      }
      const fakeUpdateTeamConfig = async (mutate: TeamConfigMutator): Promise<TeamConfig> => {
        const next = mutate(store)
        if (next !== undefined) store = next
        return store
      }
      const ctx = makeCtx({ realStatsCache: { totalCostUSD: 0 } as unknown as StatsCache })

      // whoami is not a route this central serves at all (ingest-only) — but the token itself
      // works again, proven by ingest accepting it.
      fx.setWhoamiStatus(404)
      fx.setIngestStatus(200)

      const marked = store.connections[0]!
      const result = await pushOnceDetailed(marked, ctx, { updateTeamConfig: fakeUpdateTeamConfig })

      // The probe could not prove recovery from whoami alone (404, not 2xx) — but a 404 is not a
      // rejection either, so the mark is cleared and the real push is trusted to decide.
      expect(store.connections[0]!.authFailedAt).toBeUndefined()
      expect(fx.hits).toContain('/api/team/whoami')
      expect(fx.hits).toContain('/api/team/ingest')
      expect(result.count).toBe(0)
    } finally {
      fx.stop()
    }
  })

  it('a marked connection stays paused while whoami still explicitly answers 401/403, never escalating past the probe', async () => {
    const fx = authFixture(401)
    try {
      const id = randomConnId()
      const conn = fakeConn(id, fx.port, { deniedRepos: [] })
      const markedAt = new Date(Date.now() - 60_000).toISOString()
      let store: TeamConfig = {
        schema: 2, mode: 'member', connections: [{ ...conn, authFailedAt: markedAt }],
      }
      const fakeUpdateTeamConfig = async (mutate: TeamConfigMutator): Promise<TeamConfig> => {
        const next = mutate(store)
        if (next !== undefined) store = next
        return store
      }
      const ctx = makeCtx({ realStatsCache: { totalCostUSD: 0 } as unknown as StatsCache })
      // whoamiStatus/ingestStatus both default to 401 from authFixture(401) — still explicitly
      // rejected.

      const marked = store.connections[0]!
      const result = await pushOnceDetailed(marked, ctx, { updateTeamConfig: fakeUpdateTeamConfig })

      expect(store.connections[0]!.authFailedAt).toBe(markedAt) // untouched — still paused
      expect(fx.hits).toEqual(['/api/team/whoami']) // never reached ingest
      expect(result).toEqual({ count: 0 })
    } finally {
      fx.stop()
    }
  })

  it('a network error/timeout during the probe also keeps the connection paused', async () => {
    const id = randomConnId()
    // Port 1 is not a listening server on this machine — the probe's fetch will error/timeout.
    const conn = fakeConn(id, 1, { deniedRepos: [] })
    const markedAt = new Date(Date.now() - 60_000).toISOString()
    let store: TeamConfig = {
      schema: 2, mode: 'member', connections: [{ ...conn, authFailedAt: markedAt }],
    }
    const fakeUpdateTeamConfig = async (mutate: TeamConfigMutator): Promise<TeamConfig> => {
      const next = mutate(store)
      if (next !== undefined) store = next
      return store
    }
    const ctx = makeCtx({ realStatsCache: { totalCostUSD: 0 } as unknown as StatsCache })

    const marked = store.connections[0]!
    const result = await pushOnceDetailed(marked, ctx, { updateTeamConfig: fakeUpdateTeamConfig })

    expect(store.connections[0]!.authFailedAt).toBe(markedAt) // untouched — a down central stays paused
    expect(result).toEqual({ count: 0 })
  })

  it('Disconnect (manual) and `member leave` still remove a connection, even one currently marked auth-failed', async () => {
    const id = randomConnId()
    const conn = fakeConn(id, 1, { authFailedAt: new Date().toISOString() })
    let store: TeamConfig = { schema: 2, mode: 'member', connections: [conn] }
    const fakeUpdateTeamConfig = async (mutate: TeamConfigMutator): Promise<TeamConfig> => {
      const next = mutate(store)
      if (next !== undefined) store = next
      return store
    }

    const result = await removeConnection(id, 'manual', { updateTeamConfig: fakeUpdateTeamConfig })

    expect(result).toEqual({ removed: true })
    expect(store.connections).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// I2 — POST /api/team/leave-central's endpoint→connection mapping.
//
// This route exists ONLY for an old cached SPA, and that caller cannot send a token
// (`redactPreferences` blanks it), so the endpoint comparison is the whole mechanism. It was the
// last comparison on the branch still using a raw `replace(/\/+$/,'')` string compare while every
// other one uses `normalizeEndpointKey`.
// ---------------------------------------------------------------------------

describe('matchConnectionForLeave', () => {
  const conns: TeamConnection[] = [
    { id: 'c_0123456789ab', endpoint: 'https://central.example.com', org: 'default', user: 'lucas', token: 'tok-a', deniedRepos: [] },
    { id: 'c_ba9876543210', endpoint: 'http://other.example.com:48080', org: 'default', user: 'lucas', token: 'tok-b', deniedRepos: [] },
  ]

  it('matches a differently-cased host — the exact case the raw string compare missed', () => {
    // A cached tab posting the host as the user once typed it must still find the connection.
    expect(matchConnectionForLeave(conns, 'https://Central.Example.com', '')?.id).toBe('c_0123456789ab')
    expect(matchConnectionForLeave(conns, 'https://central.example.com/', '')?.id).toBe('c_0123456789ab')
    expect(matchConnectionForLeave(conns, 'https://central.example.com:443', '')?.id).toBe('c_0123456789ab')
  })

  it('still matches by token when one is supplied, and matches nothing for an unknown central', () => {
    expect(matchConnectionForLeave(conns, 'https://elsewhere.example.com', 'tok-b')?.id).toBe('c_ba9876543210')
    expect(matchConnectionForLeave(conns, 'https://elsewhere.example.com', '')).toBeUndefined()
  })

  it('never matches on an empty endpoint or an empty token', () => {
    // A token-less connection would otherwise be matched by ANY empty-token request, disconnecting
    // an unrelated central.
    const tokenless: TeamConnection[] = [{ ...conns[0]!, token: '' }]
    expect(matchConnectionForLeave(tokenless, '', '')).toBeUndefined()
    expect(matchConnectionForLeave(conns, '', 'tok-a')?.id).toBe('c_0123456789ab')
  })
})

// ---------------------------------------------------------------------------
// pushOnceDetailed with a denylist — the point of Task 3: filterShared/hasRestrictions/
// buildSplitStatsCache/filterSharedWorkflows, all pure and already tested in share-rules.test.ts,
// actually get CALLED on the push path, in the order that keeps a denied session out of the
// sent-state forever (filterShared BEFORE selectDeltas).
// ---------------------------------------------------------------------------

/** A local ingest fixture, in the style the rest of this file already uses (real Bun.serve on
 *  port 0, never a fetch monkey-patch): it records every body it receives so the assertions can
 *  be made about what actually crossed the wire. */
function ingestFixture(): { port: number; bodies: IngestBody[]; stop: () => void } {
  const bodies: IngestBody[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname === '/api/team/policy') {
        return Response.json({ pushIntervalSec: 30, instanceId: 'inst-1', capabilities: ['forget.sessions'] })
      }
      bodies.push(await req.json() as IngestBody)
      return Response.json({ ok: true, count: 0 })
    },
  })
  return { port: server.port!, bodies, stop: () => server.stop(true) }
}

/**
 * A `StatsCache` consistent with the sessions passed in, whose `lastComputedDate` precedes every
 * one of their days — i.e. a cache `buildSplitStatsCache` treats as fully decomposable (no
 * prehistory at all).
 *
 * Built as `buildSharedStatsCache(live)` — the SAME accumulation `buildSplitStatsCache` uses
 * internally to verify its same-array precondition — with `lastComputedDate` stamped onto a fixed
 * date safely before any test fixture's `start_time` (2026-01-01+). Leaving it `''` would instead
 * hit `buildSplitStatsCache`'s "no watermark yet reports nonzero totalSessions" refusal, since
 * `buildSharedStatsCache` always reports real totals for the sessions it was built from — refusing
 * for the WRONG reason is exactly what the brief warns this helper must not do.
 */
function buildRealCacheFor(live: SessionMeta[]): StatsCache {
  const cache = buildSharedStatsCache(live)
  cache.lastComputedDate = '2020-01-01'
  return cache
}

describe('pushOnceDetailed with a denylist', () => {
  const claudeSession = (id: string, remote: string, path = `/p/${id}`) =>
    makeSession(id, { git_remote: remote, project_path: path, harness: 'claude' })

  // THE assertion of this task: a denied session must not reach the wire AND must not enter the
  // sent-state. Had it entered, un-blocking the repo later would never re-push it — its hash
  // would already be recorded as sent, and nothing re-derives that.
  it('never sends a denied session and never records it as sent', async () => {
    const fx = ingestFixture()
    const id = randomConnId()
    try {
      const ctx = makeCtx({
        storedSessions: [
          claudeSession('keep', 'github.com/org/pub'),
          claudeSession('hide', 'github.com/org/secret'),
        ],
      })
      await pushOnceDetailed(fakeConn(id, fx.port, { deniedRepos: ['github.com/org/secret'] }), ctx)
      const sentIds = fx.bodies.flatMap(b => b.sessions.map(s => s.session_id))
      expect(sentIds).toEqual(['keep'])
      expect(Object.keys(await loadSentState(id))).toEqual(['keep'])
    } finally {
      fx.stop()
    }
  })

  it('pushes the real statsCache byte-for-byte when the denylist is empty', async () => {
    const fx = ingestFixture()
    const id = randomConnId()
    try {
      const real = { lastComputedDate: '2026-07-01', dailyActivity: [], totalSessions: 0, hourCounts: {} } as unknown as StatsCache
      const ctx = makeCtx({ realStatsCache: real, storedSessions: [claudeSession('a', 'github.com/org/pub')] })
      await pushOnceDetailed(fakeConn(id, fx.port), ctx)
      expect(fx.bodies[0]!.statsCache).toEqual(real)
    } finally {
      fx.stop()
    }
  })

  // hasRestrictions, not a count comparison (R3): a repo blocked before any session exists in it
  // must switch the cache the moment the rule is declared, not when the first session lands.
  // Nothing here is filtered, and the pushed cache must STILL be the split one.
  it('pushes a split statsCache whenever restrictions are declared, even with nothing filtered', async () => {
    const fx = ingestFixture()
    const id = randomConnId()
    try {
      const live = [claudeSession('a', 'github.com/org/pub')]
      const real = buildRealCacheFor(live) // helper: a cache consistent with `live`, watermark in the past
      const ctx = makeCtx({ realStatsCache: real, liveSessions: live, storedSessions: live })
      await pushOnceDetailed(fakeConn(id, fx.port, { deniedRepos: ['github.com/org/never-seen'] }), ctx)
      // With nothing actually denied the split is a NO-OP, so it deep-equals `real` — that is the
      // anchor invariant of buildSplitStatsCache, asserted here on the wire rather than assumed.
      expect(fx.bodies[0]!.statsCache).toEqual(real)
      // Prove the split is not merely refusing (undefined): a refusal would ALSO satisfy the
      // previous assertion by omitting statsCache, which would be the wrong reason to pass.
      expect(fx.bodies[0]!.statsCache).not.toBeUndefined()
    } finally {
      fx.stop()
    }
  })

  // The refusal path. A missing cache is recoverable; a leaked one is not.
  it('omits statsCache entirely when the split refuses', async () => {
    const fx = ingestFixture()
    const id = randomConnId()
    try {
      // Cold-store signature: a populated cache while the store yields no Claude session.
      const real = { lastComputedDate: '2026-07-01', dailyActivity: [{ date: '2026-06-30', sessionCount: 9, messageCount: 20, toolCallCount: 3 }], totalSessions: 9, hourCounts: { '9': 9 } } as unknown as StatsCache
      // A shared (non-denied) session guarantees there IS a delta to push, so this test actually
      // forces a POST rather than potentially asserting over an empty `fx.bodies` (a vacuous pass
      // a focused run of the ORIGINAL version of this test exposed: `1 pass` with NO
      // `expect() calls` recorded). This is the refusal path — a leak here is unrecoverable — so
      // it must be genuinely exercised, not merely reachable.
      const ctx = makeCtx({
        realStatsCache: real,
        liveSessions: [],
        storedSessions: [claudeSession('kept', 'github.com/org/pub')],
      })
      await pushOnceDetailed(fakeConn(id, fx.port, { deniedRepos: ['github.com/org/secret'] }), ctx)
      expect(fx.bodies.length).toBe(1)
      // What was pushed carries NO statsCache — never the unsplit one.
      expect(fx.bodies[0]!.statsCache).toBeUndefined()
    } finally {
      fx.stop()
    }
  })

  it('drops a workflow run whose session is denied, and one whose session is unknown locally', async () => {
    const fx = ingestFixture()
    const id = randomConnId()
    try {
      const ctx = makeCtx({
        storedSessions: [claudeSession('keep', 'github.com/org/pub'), claudeSession('hide', 'github.com/org/secret')],
        workflows: [
          { runId: 'r1', sessionId: 'keep', name: 'ok' } as WorkflowRun,
          { runId: 'r2', sessionId: 'hide', name: 'secret-work' } as WorkflowRun,
          { runId: 'r3', sessionId: 'unknown-to-this-machine', name: 'orphan' } as WorkflowRun,
        ],
      })
      await pushOnceDetailed(fakeConn(id, fx.port, { deniedRepos: ['github.com/org/secret'] }), ctx)
      const runIds = fx.bodies.flatMap(b => (b.workflows ?? []).map(r => r.runId))
      expect(runIds).toEqual(['r1'])
    } finally {
      fx.stop()
    }
  })

  // The index is what covers non-Claude sessions: only copilot sets git_remote, so a Codex session
  // in the blocked repo's own directory has no remote of its own to match on.
  it('drops a remote-less session sitting in a denied repo directory', async () => {
    const fx = ingestFixture()
    const id = randomConnId()
    try {
      const ctx = makeCtx({
        storedSessions: [
          makeSession('claude-one', { git_remote: 'github.com/org/secret', project_path: '/work/secret', harness: 'claude' }),
          makeSession('codex-one', { git_remote: '', project_path: '/work/secret', harness: 'codex' }),
        ],
        projects: [{ path: '/work/secret', gitRemote: 'github.com/org/secret' } as ServerProject],
      })
      ctx.index = buildPathRepoIndex(ctx.storedSessions, ctx.projects)
      await pushOnceDetailed(fakeConn(id, fx.port, { deniedRepos: ['github.com/org/secret'] }), ctx)
      expect(fx.bodies.flatMap(b => b.sessions.map(s => s.session_id))).toEqual([])
    } finally {
      fx.stop()
    }
  })
})

// ---------------------------------------------------------------------------
// Task 4 — the routes/push cycle carrying the new typed-source shape (project rules, allowlist
// mode). The "manual check against a throwaway central" the plan calls for, run here as a real
// HTTP round-trip against `ingestFixture()` instead of a live central process (this worktree must
// not bind 47291/47292 — the user's own instance runs there).
// ---------------------------------------------------------------------------

describe('pushOnceDetailed — project rules and allowlist mode (Task 4)', () => {
  const claudeSession = (id: string, remote: string, path = `/p/${id}`) =>
    makeSession(id, { git_remote: remote, project_path: path, harness: 'claude' })

  it('a project rule (denylist mode) blocks those sessions and lets everything else through', async () => {
    const fx = ingestFixture()
    const id = randomConnId()
    try {
      const ctx = makeCtx({
        storedSessions: [
          claudeSession('keep', 'github.com/org/pub', '/p/other'),
          claudeSession('hide', '', '/p/secret-project'),
        ],
      })
      const conn = fakeConn(id, fx.port, { deniedRepos: [], sources: [{ type: 'project', value: '/p/secret-project' }] })
      await pushOnceDetailed(conn, ctx)
      const sentIds = fx.bodies.flatMap(b => b.sessions.map(s => s.session_id))
      expect(sentIds).toEqual(['keep'])
    } finally {
      fx.stop()
    }
  })

  it('allowlist mode with an empty source list shares nothing at all', async () => {
    const fx = ingestFixture()
    const id = randomConnId()
    try {
      const ctx = makeCtx({
        storedSessions: [claudeSession('a', 'github.com/org/pub'), claudeSession('b', 'github.com/org/other')],
      })
      const conn = fakeConn(id, fx.port, { deniedRepos: [], shareMode: 'allowlist', sources: [] })
      await pushOnceDetailed(conn, ctx)
      const sentIds = fx.bodies.flatMap(b => b.sessions.map(s => s.session_id))
      expect(sentIds).toEqual([])
    } finally {
      fx.stop()
    }
  })

  it('allowlist mode shares only the named repo/project, nothing else', async () => {
    const fx = ingestFixture()
    const id = randomConnId()
    try {
      const ctx = makeCtx({
        storedSessions: [
          claudeSession('allowed-repo', 'github.com/org/allowed'),
          claudeSession('allowed-project', 'github.com/org/other', '/p/allowed-project'),
          claudeSession('excluded', 'github.com/org/other', '/p/excluded'),
        ],
      })
      const conn = fakeConn(id, fx.port, {
        deniedRepos: [], shareMode: 'allowlist',
        sources: [{ type: 'repo', value: 'github.com/org/allowed' }, { type: 'project', value: '/p/allowed-project' }],
      })
      await pushOnceDetailed(conn, ctx)
      const sentIds = fx.bodies.flatMap(b => b.sessions.map(s => s.session_id)).sort()
      expect(sentIds).toEqual(['allowed-project', 'allowed-repo'])
    } finally {
      fx.stop()
    }
  })
})

// ---------------------------------------------------------------------------
// §5.3.4 — suppress the activity heartbeat on a restricted connection. An empty-delta cycle plus
// notifyDataChanged() would otherwise turn work inside a blocked repo into a ~2s-resolution
// timestamped heartbeat on the central (every request stamps lastSeenAt), from which session
// boundaries, working hours and intensity are reconstructable.
// ---------------------------------------------------------------------------

describe('restricted connections do not leak an activity heartbeat (§5.3.4)', () => {
  it('does not fan out on a local change for a restricted connection', () => {
    const id = randomConnId()
    __setRestrictedForTests(id, true)
    try {
      scheduleOnChangeTrigger(id)
      expect(__hasPendingOnChangeForTests(id)).toBe(false)
    } finally {
      __clearOnChangeTimerForTests(id)
    }
  })

  it('DOES still fan out on a local change for an unrestricted connection (control case)', () => {
    const id = randomConnId()
    __setRestrictedForTests(id, false)
    try {
      scheduleOnChangeTrigger(id)
      expect(__hasPendingOnChangeForTests(id)).toBe(true)
    } finally {
      // Clear the pending timer before it can fire and call runConnectionCycle against the real
      // readPreferences() — this test only asserts that scheduling happened, not that the cycle
      // it would trigger runs correctly (that is covered elsewhere in this file).
      __clearOnChangeTimerForTests(id)
    }
  })

  it('two consecutive unchanged cycles for a restricted connection produce exactly one POST', async () => {
    const fx = ingestFixture()
    const id = randomConnId()
    try {
      // Nothing to filter and nothing changing session-wise — the empty-delta keep-alive path,
      // with a non-null (if empty) split statsCache so there IS a payload to dedup against.
      const real = buildRealCacheFor([])
      const conn = fakeConn(id, fx.port, { deniedRepos: ['github.com/org/secret'] })
      const ctx = makeCtx({ realStatsCache: real, liveSessions: [], storedSessions: [], workflows: [] })
      await pushOnceDetailed(conn, ctx)
      await pushOnceDetailed(conn, ctx)
      expect(fx.bodies.length).toBe(1)
    } finally {
      fx.stop()
    }
  })

  // Important 1 from review: the dedup digest must be memoized only AFTER the central actually
  // accepts the POST. Recording it beforehand (or on a failed attempt) would permanently swallow
  // a payload whose first attempt failed — every later cycle with the same unchanged content
  // would match the memoized digest and never retry, silently losing that statsCache/workflow
  // update until unrelated content happens to change.
  it('retries an unchanged restricted keep-alive after its first POST failed', async () => {
    let attempts = 0
    const bodies: IngestBody[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        if (new URL(req.url).pathname === '/api/team/policy') {
          return Response.json({ pushIntervalSec: 30, instanceId: 'inst-1', capabilities: ['forget.sessions'] })
        }
        attempts++
        bodies.push(await req.json() as IngestBody)
        // First attempt fails (central rejects/errors); every later one succeeds.
        if (attempts === 1) return new Response('boom', { status: 500 })
        return Response.json({ ok: true, count: 0 })
      },
    })
    const id = randomConnId()
    try {
      const real = buildRealCacheFor([])
      const conn = fakeConn(id, server.port!, { deniedRepos: ['github.com/org/secret'] })
      const ctx = makeCtx({ realStatsCache: real, liveSessions: [], storedSessions: [], workflows: [] })
      await pushOnceDetailed(conn, ctx) // fails (500) — must NOT be memoized as delivered
      await pushOnceDetailed(conn, ctx) // identical payload — must retry, not be skipped as already-sent
      expect(bodies.length).toBe(2)
    } finally {
      server.stop(true)
    }
  })

  // Review round 2 — a genuine leak found end-to-end against a live central: the memo
  // (`_lastPushedPayloadHash`) was only ever WRITTEN from the restricted empty-delta branch, so a
  // batch push (which attaches the SAME `{statsCache, workflows}` pair to batch 0 whenever there
  // are session deltas) never updated it. A restricted → unrestricted → restricted transition
  // pushes its unsplit cache through the batch path in the middle step; if that never touches the
  // memo, the second restricted push's split cache — byte-identical to the first, since nothing
  // about the underlying data changed — matches the STALE memo from the first push and gets
  // wrongly suppressed, stranding the denied repository's per-day volume in the cache the central
  // already holds from the middle (unrestricted) push. Nothing recovers this until unrelated
  // content happens to change.
  const repoSession = (sid: string, remote: string) =>
    makeSession(sid, { git_remote: remote, project_path: `/p/${sid}`, harness: 'claude' })

  it('a restricted -> unrestricted (batch) -> restricted transition does not wrongly suppress the repeated split payload', async () => {
    const fx = ingestFixture()
    const id = randomConnId()
    try {
      const pub1 = repoSession('pub-1', 'github.com/org/public')
      const pub2 = repoSession('pub-2', 'github.com/org/public')
      const secret1 = repoSession('secret-1', 'github.com/org/secret')
      const secret2 = repoSession('secret-2', 'github.com/org/secret')
      const allLive = [pub1, pub2, secret1, secret2]
      const real = buildRealCacheFor(allLive)
      const ctx = makeCtx({ realStatsCache: real, liveSessions: allLive, storedSessions: allLive })

      // Prime the sent-state as if the two PUBLIC sessions were already delivered before this test
      // begins. The secret ones are deliberately NOT primed — filterShared keeps a denied session
      // out of the sent-state, which is this task's own invariant (the first test in the file
      // above pins it directly).
      await saveSentState(id, { 'pub-1': sessionHash(pub1), 'pub-2': sessionHash(pub2) })

      // Step 1 — restricted, empty session delta (both public sessions already match the primed
      // sent-state; the secret ones are filtered out before selectDeltas ever sees them). The
      // split cache is computed fresh and accepted.
      const connBlocked = fakeConn(id, fx.port, { deniedRepos: ['github.com/org/secret'] })
      await pushOnceDetailed(connBlocked, ctx)
      expect(fx.bodies.length).toBe(1)
      const splitFromStep1 = fx.bodies[0]!.statsCache
      expect(splitFromStep1).not.toEqual(real) // must actually be split, not the raw cache

      // Step 2 — unblocked: the two secret sessions are now genuine NEW deltas (never primed into
      // sent-state above), so this takes the BATCH path, carrying the UNSPLIT real cache on
      // batch 0. This is the writer the review found never touched the memo.
      const connUnblocked = fakeConn(id, fx.port, { deniedRepos: [] })
      await pushOnceDetailed(connUnblocked, ctx)
      expect(fx.bodies.length).toBe(2)
      expect(fx.bodies[1]!.statsCache).toEqual(real)

      // Step 3 — blocked again: identical fixtures to step 1, so the split cache recomputes to the
      // EXACT same bytes. The memo must have moved on at step 2, or this gets wrongly matched
      // against step 1's now-stale memo and silently suppressed.
      await pushOnceDetailed(connBlocked, ctx)
      expect(fx.bodies.length).toBe(3)
      expect(fx.bodies[2]!.statsCache).toEqual(splitFromStep1)
    } finally {
      fx.stop()
    }
  })

  // The other half of the same fix: a batch push that itself carries a (split) statsCache must
  // still correctly prime the dedup for the very next unchanged restricted cycle — proving the fix
  // is "the memo tracks every writer", not "never suppress" (which would reopen §5.3.4's leak).
  it('a batch push carrying a split statsCache correctly primes the dedup for the immediately-following unchanged cycle', async () => {
    const fx = ingestFixture()
    const id = randomConnId()
    try {
      const pub1 = repoSession('pub-1', 'github.com/org/public')
      const secret1 = repoSession('secret-1', 'github.com/org/secret')
      const allLive = [pub1, secret1]
      const real = buildRealCacheFor(allLive)
      const conn = fakeConn(id, fx.port, { deniedRepos: ['github.com/org/secret'] })
      const ctx = makeCtx({ realStatsCache: real, liveSessions: allLive, storedSessions: allLive })

      // First cycle: nothing primed in sent-state. `secret1` is filtered by filterShared before
      // selectDeltas ever sees it, so only `pub1` is a genuine new delta — the BATCH path, carrying
      // the split cache on batch 0.
      await pushOnceDetailed(conn, ctx)
      expect(fx.bodies.length).toBe(1)
      expect(fx.bodies[0]!.statsCache).not.toEqual(real)

      // Second cycle: identical ctx, nothing changed — pub1's hash already matches what the batch
      // path just wrote to the sent-state, so this is the empty-delta path. The memo the batch
      // write just set must match, and the POST must be suppressed exactly once: not zero (the
      // dedup would be broken), not sent again (a fix that never suppresses reopens the leak
      // §5.3.4 exists to close).
      await pushOnceDetailed(conn, ctx)
      expect(fx.bodies.length).toBe(1)
    } finally {
      fx.stop()
    }
  })

  // Review round 3 — the third deferred Minor turned into an Important once it was pinned down:
  // `markPushSuccess` on a suppressed cycle claimed contact that never happened, so a revoked
  // token, a wiped central, or a dead central was invisible for as long as a quiet blocked repo's
  // payload stayed unchanged. The fix bounds the suppression instead: at most
  // MAX_SUPPRESSED_STREAK in a row, then a real (unconditional) push re-verifies liveness. Its
  // timing is a function of the cycle count alone, never of local activity, so it does not reopen
  // the §5.3.4 correlation leak.
  describe('the suppression bound re-verifies liveness instead of claiming success forever', () => {
    it('the bound: N consecutive unchanged restricted cycles produce exactly one POST at the boundary — not N, not zero', async () => {
      const fx = ingestFixture()
      const id = randomConnId()
      try {
        const real = buildRealCacheFor([])
        const conn = fakeConn(id, fx.port, { deniedRepos: ['github.com/org/secret'] })
        const ctx = makeCtx({ realStatsCache: real, liveSessions: [], storedSessions: [], workflows: [] })

        await pushOnceDetailed(conn, ctx) // baseline — establishes the memo
        expect(fx.bodies.length).toBe(1)

        for (let i = 0; i < MAX_SUPPRESSED_STREAK; i++) {
          await pushOnceDetailed(conn, ctx)
        }
        // Exactly MAX_SUPPRESSED_STREAK suppressed cycles — zero additional POSTs (not N of them).
        expect(fx.bodies.length).toBe(1)

        await pushOnceDetailed(conn, ctx) // the (N+1)th — the bound elapses
        // Exactly one more POST (not zero — the bound must actually fire).
        expect(fx.bodies.length).toBe(2)
      } finally {
        fx.stop()
      }
    })

    it('after the bound elapses, a request IS attempted and an unreachable central is reported rather than staying healthy', async () => {
      const fx = ingestFixture()
      const id = randomConnId()
      const real = buildRealCacheFor([])
      const conn = fakeConn(id, fx.port, { deniedRepos: ['github.com/org/secret'] })
      const ctx = makeCtx({
        realStatsCache: real, liveSessions: [], storedSessions: [], workflows: [],
        ingestTimeoutMs: 500, // fail fast against the now-dead server, don't wait out the default
      })

      await pushOnceDetailed(conn, ctx) // baseline succeeds — establishes the memo
      expect(fx.bodies.length).toBe(1)
      expect(getUploaderStatus()[id]?.errKind ?? null).toBe(null)
      fx.stop() // the central becomes unreachable

      for (let i = 0; i < MAX_SUPPRESSED_STREAK; i++) {
        const r = await pushOnceDetailed(conn, ctx)
        expect(r.count).toBe(0)
        // Suppressed cycles must not claim success — no request was ever attempted against the
        // now-dead server, so the pill must not read healthy on the strength of nothing.
        expect(getUploaderStatus()[id]?.errKind ?? null).toBe(null)
      }

      // The (N+1)th cycle forces a real request against the dead server — it must fail and be
      // REPORTED, not silently re-suppressed.
      await pushOnceDetailed(conn, ctx)
      expect(getUploaderStatus()[id]?.errKind).toBe('net')
    })

    it('after the bound elapses, a 401 reaches the auth-error path instead of being invisible forever', async () => {
      let calls = 0
      const server = Bun.serve({
        port: 0,
        async fetch(req) {
          if (new URL(req.url).pathname === '/api/team/policy') {
            return Response.json({ pushIntervalSec: 30, instanceId: 'inst-1', capabilities: [] })
          }
          calls++
          await req.json()
          // First contact (the baseline) succeeds; the central revokes the token after that.
          if (calls === 1) return Response.json({ ok: true, count: 0 })
          return new Response('token revoked', { status: 401 })
        },
      })
      const id = randomConnId()
      try {
        const real = buildRealCacheFor([])
        const conn = fakeConn(id, server.port!, { deniedRepos: ['github.com/org/secret'] })
        const ctx = makeCtx({ realStatsCache: real, liveSessions: [], storedSessions: [], workflows: [] })

        await pushOnceDetailed(conn, ctx) // baseline — establishes the memo
        expect(calls).toBe(1)

        for (let i = 0; i < MAX_SUPPRESSED_STREAK; i++) {
          await pushOnceDetailed(conn, ctx)
        }
        // Still suppressed — no network reached the central yet, so no 401 could have been seen.
        expect(calls).toBe(1)

        // The (N+1)th cycle forces the real request, which the central answers with a 401.
        await pushOnceDetailed(conn, ctx)
        expect(calls).toBe(2)
        // fireHandleAuthError's synchronous portion (notifyPushError's _pushErrKind write) runs
        // before any awaited step, but yield one tick to be robust against microtask ordering.
        await new Promise(resolve => setTimeout(resolve, 0))
        expect(getUploaderStatus()[id]?.errKind).toBe('auth')
      } finally {
        server.stop(true)
      }
    })
  })
})

// ---------------------------------------------------------------------------
// Controller addition — close the fan-out window on a newly-declared denylist. `_restrictedConn`
// must be seeded from CONFIG (supervisorTick/reconcileUploaderNow), not only from a completed
// push, or the window between a denylist being declared and this connection's first push would
// still fan out on every local change and use an unjittered cadence — exactly the moment a user
// has just blocked a repo, which is when the timing leak matters most.
// ---------------------------------------------------------------------------

describe('a freshly-declared denylist is honored before any push has happened', () => {
  it('does not fan out on change once reconcileUploaderNow has seen the restriction in config', async () => {
    const id = randomConnId()
    const conn = fakeConn(id, 1, { deniedRepos: ['github.com/org/secret'] }) // port unused — no push happens
    try {
      // Sanity: nothing scheduled yet for this brand-new id.
      expect(__hasPendingOnChangeForTests(id)).toBe(false)
      await reconcileUploaderNow({ readPreferences: fakeReadPreferences(conn) })
      scheduleOnChangeTrigger(id)
      expect(__hasPendingOnChangeForTests(id)).toBe(false)
    } finally {
      // Clears the chain reconcileUploaderNow started (including its periodic timer) before it
      // could ever fire against the real readPreferences().
      __teardownConnectionForTests(id)
    }
  })
})

// ---------------------------------------------------------------------------
// The retroactive removal sequence, driven through a real cycle (§6.1 / §5.5b).
// ---------------------------------------------------------------------------

/** A minimal real StatsCache: `lastComputedDate` is all `attributionBoundary` reads, and the
 *  boundary is the day AFTER it. */
function fakeStatsCache(lastComputedDate: string): StatsCache {
  return { lastComputedDate, dailyActivity: [], totalSessions: 0, hourCounts: {} } as unknown as StatsCache
}

/** A mock central that answers policy/whoami/forget/ingest and records, for every forget POST,
 *  the sent-state and sync-file state AT THAT MOMENT — which is what makes the ordering
 *  assertions below real rather than end-state guesses. */
function mockCentral(opts: { canForget?: boolean; instanceId?: string } = {}) {
  const forgetBodies: string[][] = []
  const sentAtForget: string[][] = []
  const syncFileAtForget: boolean[] = []
  const ingests: IngestBody[] = []
  let connId = ''
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url)
      if (url.pathname === '/api/team/policy') {
        return Response.json({
          pushIntervalSec: 30,
          instanceId: opts.instanceId ?? 'inst-1',
          capabilities: opts.canForget === false ? ['leave'] : ['leave', 'forget.sessions'],
        })
      }
      if (url.pathname === '/api/team/whoami') return Response.json({ ok: true, user: 'test-user' })
      if (url.pathname === '/api/team/forget') {
        const body = await req.json() as { sessionIds: string[] }
        forgetBodies.push(body.sessionIds)
        const raw = readFileSync(teamSentFile(connId), 'utf-8')
        sentAtForget.push(Object.keys((JSON.parse(raw) as { hashes: Record<string, string> }).hashes))
        syncFileAtForget.push(existsSync(teamSyncFile(connId)))
        return Response.json({ ok: true, deleted: body.sessionIds.length, deletedRuns: 0 })
      }
      ingests.push(await req.json() as IngestBody)
      return Response.json({ ok: true })
    },
  })
  return {
    server, forgetBodies, sentAtForget, syncFileAtForget, ingests,
    watch(id: string) { connId = id },
    stop() { return server.stop(true) },
  }
}

describe('runConnectionCycle — the retroactive removal sequence', () => {
  it('a sig mismatch on a RESTRICTED connection forgets BEFORE the sent-state is cleared (§5.5b)', async () => {
    const connId = randomConnId()
    const central = mockCentral()
    central.watch(connId)
    try {
      const conn = fakeConn(connId, central.server.port!, { deniedRepos: ['github.com/o/secret'] })
      const pub = makeSession('pub-1', { git_remote: 'github.com/o/pub' })
      const denied = makeSession('denied-1', { git_remote: 'github.com/o/secret' })
      const ctx = makeCtx({
        storedSessions: [pub, denied],
        liveSessions: [pub, denied],
        index: buildPathRepoIndex([pub, denied]),
      })
      // Both sessions were already pushed to this central. No sync file exists for this brand-new
      // connection id, so the signature differs — the exact rotation/wipe case §5.5b is about.
      await saveSentState(connId, { 'pub-1': 'h-pub', 'denied-1': 'h-denied' })
      expect(existsSync(teamSyncFile(connId))).toBe(false)

      await runConnectionCycle(connId, {
        readPreferences: fakeReadPreferences(conn),
        migrateTeamStateOnce: async () => {},
        ctx,
      })

      // The forget named exactly the denied session…
      expect(central.forgetBodies).toEqual([['denied-1']])
      // …and it was issued while the sent-state STILL held it, before reconcileSyncState cleared
      // it. Clearing first would have stranded that session on the central with no way to name it.
      expect(central.sentAtForget[0]?.sort()).toEqual(['denied-1', 'pub-1'])
      expect(central.syncFileAtForget[0]).toBe(false)

      // Afterwards: the sig was reconciled (the sync file now exists), the shared session was
      // re-pushed and the denied one is gone from the sent-state for good.
      expect(existsSync(teamSyncFile(connId))).toBe(true)
      const finalSent = await loadSentState(connId)
      expect(Object.keys(finalSent)).toEqual(['pub-1'])
      // The rebuilt payload the central received names only the shared session.
      expect(central.ingests.flatMap(b => (b.sessions ?? []).map(s => s.session_id))).toEqual(['pub-1'])
      // No removal is in flight any more.
      expect(getResyncProgress(connId)).toBeNull()
    } finally {
      __teardownConnectionForTests(connId)
      await central.stop()
    }
  }, 10_000)

  it('does not persist the rules hash when the removal did not complete, and re-tries next cycle', async () => {
    const connId = randomConnId()
    // A central that is reachable for policy/whoami/ingest but rejects the forget with a 500 —
    // the "rules declared, central still holds the data" case.
    let forgetCalls = 0
    let failForget = true
    await using server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url)
        if (url.pathname === '/api/team/policy') {
          return Response.json({ pushIntervalSec: 30, instanceId: 'inst-1', capabilities: ['forget.sessions'] })
        }
        if (url.pathname === '/api/team/whoami') return Response.json({ ok: true, user: 'test-user' })
        if (url.pathname === '/api/team/forget') {
          forgetCalls++
          const body = await req.json() as { sessionIds: string[] }
          if (failForget) return new Response(JSON.stringify({ error: 'boom' }), { status: 500 })
          return Response.json({ ok: true, deleted: body.sessionIds.length, deletedRuns: 0 })
        }
        return Response.json({ ok: true })
      },
    })
    try {
      const conn = fakeConn(connId, server.port!, { deniedRepos: ['github.com/o/secret'] })
      const pub = makeSession('pub-2', { git_remote: 'github.com/o/pub' })
      const denied = makeSession('denied-2', { git_remote: 'github.com/o/secret', start_time: '2026-07-20T10:00:00.000Z' })
      const ctx = makeCtx({
        storedSessions: [pub, denied], liveSessions: [pub, denied],
        index: buildPathRepoIndex([pub, denied]),
        realStatsCache: fakeStatsCache('2026-07-01'),
      })
      await saveSentState(connId, { 'denied-2': 'h-denied' })
      const deps = { readPreferences: fakeReadPreferences(conn), migrateTeamStateOnce: async () => {}, ctx }

      await runConnectionCycle(connId, deps)
      expect(forgetCalls).toBe(1)
      // The id is still named locally (nothing was acked) and the rules state was NOT persisted —
      // the hash is what suppresses re-detection, so writing it here would make the machine stop
      // asking while the central still holds the session.
      expect(Object.keys(await loadSentState(connId))).toContain('denied-2')
      const afterFailure = await loadRulesState(connId)
      expect(afterFailure.rulesHash).toBe('')
      // …but the SEAL LEDGER did advance: it is not re-derivable (advanceSeal seals out of the
      // PERSISTED `prev.pending`), so a cycle whose removal failed must still have written it.
      expect(afterFailure.pending['2026-07-20']?.sessionCount).toBe(1)
      expect(afterFailure.boundary).toBe('2026-07-02')
      // The connection still pushed this cycle: an unreachable/failing forget must not stop it.
      expect(existsSync(teamForgetFile(connId))).toBe(true) // journal kept open for the retry

      // Next cycle, with the central healthy: the same plan is re-derived and the removal lands.
      failForget = false
      await runConnectionCycle(connId, deps)
      expect(forgetCalls).toBe(2)
      expect(Object.keys(await loadSentState(connId))).not.toContain('denied-2')
      expect(existsSync(teamForgetFile(connId))).toBe(false)
      // Only now is the rules hash persisted.
      expect((await loadRulesState(connId)).rulesHash).not.toBe('')
    } finally {
      __teardownConnectionForTests(connId)
    }
  }, 10_000)

  // Task 4: switching denylist→allowlist with the SAME source list can shrink the shared set
  // drastically (everything not explicitly listed flips from shared to hidden) — the plan
  // requires this to flow through the EXACT SAME forget sequence as editing the list, not a
  // special-cased path. Asserted here as the "manual check" the plan calls for: two real cycles
  // against a mock central, mode changing between them.
  it('switching denylist→allowlist (same sources) forgets everything the new mode no longer shares, exactly once', async () => {
    const connId = randomConnId()
    const central = mockCentral()
    central.watch(connId)
    try {
      const allowed = makeSession('allowed-1', { git_remote: 'github.com/o/allowed' })
      const other = makeSession('other-1', { git_remote: 'github.com/o/other' })
      const ctx = makeCtx({
        storedSessions: [allowed, other],
        liveSessions: [allowed, other],
        index: buildPathRepoIndex([allowed, other]),
      })

      // Cycle 1: plain denylist, sources empty — everything is shared and pushed.
      const denylistConn = fakeConn(connId, central.server.port!, { deniedRepos: [], shareMode: 'denylist', sources: [] })
      await runConnectionCycle(connId, {
        readPreferences: fakeReadPreferences(denylistConn),
        migrateTeamStateOnce: async () => {},
        ctx,
      })
      expect(Object.keys(await loadSentState(connId)).sort()).toEqual(['allowed-1', 'other-1'])
      expect(central.forgetBodies).toEqual([])

      // Cycle 2: SAME source list, switched to allowlist — only 'allowed-1' matches the one
      // listed repo, so 'other-1' must be forgotten even though the source list itself is
      // unchanged (rulesSignature folds the mode in, so this trips the detector like any edit).
      const allowlistConn = fakeConn(connId, central.server.port!, {
        deniedRepos: [], shareMode: 'allowlist', sources: [{ type: 'repo', value: 'github.com/o/allowed' }],
      })
      await runConnectionCycle(connId, {
        readPreferences: fakeReadPreferences(allowlistConn),
        migrateTeamStateOnce: async () => {},
        ctx,
      })
      expect(central.forgetBodies).toEqual([['other-1']])
      expect(Object.keys(await loadSentState(connId))).toEqual(['allowed-1'])

      // Cycle 3: nothing changed since cycle 2 — the removal must not run again.
      await runConnectionCycle(connId, {
        readPreferences: fakeReadPreferences(allowlistConn),
        migrateTeamStateOnce: async () => {},
        ctx,
      })
      expect(central.forgetBodies).toEqual([['other-1']]) // still just the one call
    } finally {
      __teardownConnectionForTests(connId)
      await central.stop()
    }
  }, 10_000)

  it('replays a journal found at boot, then stops replaying it once it completes', async () => {
    const connId = randomConnId()
    const central = mockCentral()
    central.watch(connId)
    try {
      // No denylist at all: the ONLY reason a forget happens is the journal a killed process left
      // behind. (Its ids are already out of the sent-state — the crash is assumed to have happened
      // after the ack and before the journal was closed, which is exactly the case nothing else
      // would ever notice.)
      const conn = fakeConn(connId, central.server.port!)
      const ctx = makeCtx({ storedSessions: [makeSession('pub-3')], liveSessions: [makeSession('pub-3')] })
      await saveSentState(connId, { 'pub-3': 'h-pub' })

      const queued = await replayForgetJournals({
        readPreferences: fakeReadPreferences(conn),
        loadForgetJournal: async () => ({
          state: 'forgetting', ids: ['crashed-1'], runIds: [], rulesHash: 'h-old',
          startedAt: '2026-07-30T10:00:00.000Z',
        }),
      })
      expect(queued).toBe(1)

      const deps = { readPreferences: fakeReadPreferences(conn), migrateTeamStateOnce: async () => {}, ctx }
      await runConnectionCycle(connId, deps)
      // Re-named to the central even though the local plan asks for nothing: replaying an
      // already-deleted id is a no-op there (`deleted: 0`), which is what makes this safe.
      expect(central.forgetBodies).toEqual([['crashed-1']])

      // Consumed: a second cycle does not replay it again.
      await runConnectionCycle(connId, deps)
      expect(central.forgetBodies).toEqual([['crashed-1']])
    } finally {
      __teardownConnectionForTests(connId)
      await central.stop()
    }
  }, 10_000)

  it('keeps pushing when the central is too old to forget, and never issues the request', async () => {
    const connId = randomConnId()
    const central = mockCentral({ canForget: false })
    central.watch(connId)
    try {
      const conn = fakeConn(connId, central.server.port!, { deniedRepos: ['github.com/o/secret'] })
      const pub = makeSession('pub-4', { git_remote: 'github.com/o/pub' })
      const denied = makeSession('denied-4', { git_remote: 'github.com/o/secret' })
      const ctx = makeCtx({ storedSessions: [pub, denied], liveSessions: [pub, denied], index: buildPathRepoIndex([pub, denied]) })
      await saveSentState(connId, { 'denied-4': 'h-denied' })

      await runConnectionCycle(connId, {
        readPreferences: fakeReadPreferences(conn),
        migrateTeamStateOnce: async () => {},
        ctx,
      })

      // No forget request at all — there is no fallback to a broader primitive.
      expect(central.forgetBodies).toEqual([])
      // The denied id stays named locally, so a later upgrade of the central can still remove it.
      expect(Object.keys(await loadSentState(connId))).toContain('denied-4')
      // And the connection still pushed its shared session this cycle.
      expect(central.ingests.flatMap(b => (b.sessions ?? []).map(s => s.session_id))).toEqual(['pub-4'])
    } finally {
      __teardownConnectionForTests(connId)
      await central.stop()
    }
  }, 10_000)

  // The coordinator's follow-up to the sibling incident fix: team-forget-client.ts's own 401/403
  // handling used to call `removeConnection(id, 'revoked')` on a SINGLE rejected request during an
  // active retroactive-removal sequence — strictly worse than the plain-push-cycle bug, because it
  // fires exactly when the user just changed their privacy rules, destroying `deniedRepos` at the
  // moment it matters most. Exercised through the FULL production stack (`runConnectionCycle`,
  // with the real `onRevoked: markAuthFailed` wiring from `runConnectionPushCycle`) against a fake
  // in-memory preferences store — never the developer's real `~/.agentistics/preferences.json`.
  it('a 401 mid-forget marks the connection auth-failed (never removes it), leaves the journal open and pushes nothing further this cycle — then a later success resumes and completes it', async () => {
    const connId = randomConnId()
    const conn = fakeConn(connId, 1, { deniedRepos: ['github.com/o/secret'] }) // port replaced below
    let store: TeamConfig = { schema: 2, mode: 'member', connections: [{ ...conn }] }
    const fakePrefs = async (): Promise<Preferences> => ({ team: store })
    const fakeUpdateTeamConfig = async (mutate: TeamConfigMutator): Promise<TeamConfig> => {
      const next = mutate(store)
      if (next !== undefined) store = next
      return store
    }

    let forgetAuthFail = true
    let forgetCalls = 0
    const ingestCalls: string[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === '/api/team/policy') {
          return Response.json({ pushIntervalSec: 30, instanceId: 'inst-1', capabilities: ['forget.sessions'] })
        }
        if (url.pathname === '/api/team/whoami') return Response.json({ ok: true, user: 'test-user' })
        if (url.pathname === '/api/team/forget') {
          forgetCalls++
          const body = await req.json() as { sessionIds: string[] }
          if (forgetAuthFail) return new Response('unauthorized', { status: 401 })
          return Response.json({ ok: true, deleted: body.sessionIds.length, deletedRuns: 0 })
        }
        ingestCalls.push(url.pathname)
        await req.json().catch(() => undefined)
        return Response.json({ ok: true })
      },
    })
    // Bind the connection to this server's actual port (fakeConn above used a placeholder).
    store.connections[0]!.endpoint = `http://127.0.0.1:${server.port}`

    try {
      const pub = makeSession('pub-5', { git_remote: 'github.com/o/pub' })
      const denied = makeSession('denied-5', { git_remote: 'github.com/o/secret' })
      const ctx = makeCtx({ storedSessions: [pub, denied], liveSessions: [pub, denied], index: buildPathRepoIndex([pub, denied]) })
      await saveSentState(connId, { 'denied-5': 'h-denied' })

      const deps = { readPreferences: fakePrefs, migrateTeamStateOnce: async () => {}, ctx, updateTeamConfig: fakeUpdateTeamConfig }

      // Cycle 1 — the forget batch is rejected with a 401.
      await runConnectionCycle(connId, deps)

      expect(forgetCalls).toBe(1)
      // Never removed: still exactly one connection, same id, deniedRepos intact.
      expect(store.connections.map(c => c.id)).toEqual([connId])
      expect(store.connections[0]!.deniedRepos).toEqual(['github.com/o/secret'])
      // Marked, durably, instead.
      expect(typeof store.connections[0]!.authFailedAt).toBe('string')
      // The journal stays open — the batch was journaled (step 2) before it was rejected (step 3).
      expect(existsSync(teamForgetFile(connId))).toBe(true)
      // The denied session is still named locally (nothing was acked).
      expect(Object.keys(await loadSentState(connId))).toContain('denied-5')
      // Nothing further was attempted this cycle — no fallback push against a central that just
      // rejected this same token.
      expect(ingestCalls).toEqual([])

      // Cycle 2 — the central now accepts the token again. No human touched the connection.
      forgetAuthFail = false
      await runConnectionCycle(connId, deps)

      expect(forgetCalls).toBe(2)
      expect(existsSync(teamForgetFile(connId))).toBe(false) // journal closed — the sequence completed
      expect(Object.keys(await loadSentState(connId))).not.toContain('denied-5')
      // Resumed and completed with no human action: the mark is cleared…
      expect(store.connections[0]!.authFailedAt).toBeUndefined()
      // …the connection is still exactly the one that was marked (same id, rules intact)…
      expect(store.connections.map(c => c.id)).toEqual([connId])
      expect(store.connections[0]!.deniedRepos).toEqual(['github.com/o/secret'])
      // …and pushing resumed (the rebuilt cache push, Step 4 of the sequence).
      expect(ingestCalls.length).toBeGreaterThan(0)
    } finally {
      __teardownConnectionForTests(connId)
      server.stop(true)
    }
  }, 10_000)
})

// ---------------------------------------------------------------------------
// Critical 1: the seal ledger is NOT re-derivable. `advanceSeal` seals out of the PERSISTED
// `prev.pending`, and its CALLER CONTRACT (share-rules.ts) is that it runs on every push cycle
// without skipping one — a skipped cycle whose window spans both the day entering `pending` AND
// the boundary crossing it loses that day's seal forever, and the denied repository's volume for
// that day then ships inside the undecomposable rollup. Deferring the whole RulesState write until
// a removal succeeded made every failing cycle exactly such a skip, in the common case (a central
// that is down, rejecting, or — as here — too old to forget, where it never succeeds at all).
// ---------------------------------------------------------------------------

describe('the seal ledger advances on every cycle even while the removal never completes', () => {
  it('seals a day that crosses the boundary between two failing cycles, with the rules hash still unwritten', async () => {
    const connId = randomConnId()
    const central = mockCentral({ canForget: false }) // never succeeds — needsForget stays true forever
    central.watch(connId)
    try {
      const conn = fakeConn(connId, central.server.port!, { deniedRepos: ['github.com/o/secret'] })
      const pub = makeSession('pub-5', { git_remote: 'github.com/o/pub', start_time: '2026-07-20T09:00:00.000Z' })
      const denied = makeSession('denied-5', { git_remote: 'github.com/o/secret', start_time: '2026-07-20T10:00:00.000Z' })
      const sessions = [pub, denied]
      const index = buildPathRepoIndex(sessions)
      await saveSentState(connId, { 'denied-5': 'h-denied' })

      // Cycle 1 — Claude's watermark is 2026-07-01, so the boundary is 07-02 and 07-20 is still
      // decomposable: the day is MEASURED into `pending`.
      await runConnectionCycle(connId, {
        readPreferences: fakeReadPreferences(conn),
        migrateTeamStateOnce: async () => {},
        ctx: makeCtx({ storedSessions: sessions, liveSessions: sessions, index, realStatsCache: fakeStatsCache('2026-07-01') }),
      })
      const afterFirst = await loadRulesState(connId)
      expect(afterFirst.pending['2026-07-20']?.sessionCount).toBe(1)
      expect(afterFirst.sealed['2026-07-20']).toBeUndefined()
      expect(afterFirst.rulesHash).toBe('') // the removal did not happen — the hash stays unwritten

      // Cycle 2 — the watermark has advanced past 07-20, so the day crosses into prehistory. It
      // can only be SEALED from the pending value cycle 1 persisted; had that write been skipped,
      // this seal would be lost forever and the denied volume would ship in the rollup.
      await runConnectionCycle(connId, {
        readPreferences: fakeReadPreferences(conn),
        migrateTeamStateOnce: async () => {},
        ctx: makeCtx({ storedSessions: sessions, liveSessions: sessions, index, realStatsCache: fakeStatsCache('2026-07-21') }),
      })
      const afterSecond = await loadRulesState(connId)
      expect(afterSecond.sealed['2026-07-20']?.sessionCount).toBe(1)
      // Still no removal, so still no hash — the two halves of the state are genuinely independent.
      expect(afterSecond.rulesHash).toBe('')
      expect(central.forgetBodies).toEqual([])
    } finally {
      __teardownConnectionForTests(connId)
      await central.stop()
    }
  }, 10_000)
})

// ---------------------------------------------------------------------------
// Important 2: a plan naming only workflow runs cannot delete anything (the wire carries
// `sessionIds`, and the central deletes runs by session), so it must not report success.
// ---------------------------------------------------------------------------

describe('a runs-only plan never reports success', () => {
  it('issues no forget, emits no resync_done, does not persist the hash and keeps the runs named', async () => {
    const connId = randomConnId()
    const central = mockCentral()
    central.watch(connId)
    const codes: string[] = []
    __setNotifierForTests(n => { if (n.code) codes.push(n.code) })
    try {
      const conn = fakeConn(connId, central.server.port!, { deniedRepos: ['github.com/o/secret'] })
      const pub = makeSession('pub-6', { git_remote: 'github.com/o/pub' })
      // Denied and present in the store, but NEVER pushed as a session — so `forgetIds` is empty
      // while its already-pushed workflow run is in `forgetRuns`.
      const denied = makeSession('denied-6', { git_remote: 'github.com/o/secret' })
      const run: WorkflowRun = {
        runId: 'r-6', name: 'audit', sessionId: 'denied-6', status: 'completed',
        startedAt: '2026-07-20T10:00:00.000Z', durationMs: 0, phases: [], agents: [],
        totals: { agentCount: 0, tokensIn: 0, tokensOut: 0, costUSD: 0, durationMs: 0, toolUses: 0 },
      }
      const sessions = [pub, denied]
      await writeFile(teamSentFile(connId), JSON.stringify({ version: 2, hashes: {}, runIds: ['r-6'] }), 'utf-8')

      await runConnectionCycle(connId, {
        readPreferences: fakeReadPreferences(conn),
        migrateTeamStateOnce: async () => {},
        ctx: makeCtx({
          storedSessions: sessions, liveSessions: sessions, workflows: [run],
          index: buildPathRepoIndex(sessions),
        }),
      })

      // Nothing was asked of the central…
      expect(central.forgetBodies).toEqual([])
      // …nothing was announced as done (and nothing was announced as started either, since the
      // removal could never have been performed)…
      expect(codes).not.toContain('member.resync_done')
      expect(codes).not.toContain('member.resync_started')
      // …the hash is unwritten, so the machine keeps asking…
      expect((await loadRulesState(connId)).rulesHash).toBe('')
      // …and the run is still NAMED locally, which is the only thing that can ever withdraw it.
      const raw = JSON.parse(readFileSync(teamSentFile(connId), 'utf-8')) as { runIds: string[] }
      expect(raw.runIds).toEqual(['r-6'])
    } finally {
      __setNotifierForTests(() => {})
      __teardownConnectionForTests(connId)
      await central.stop()
    }
  }, 10_000)
})

// ---------------------------------------------------------------------------
// Critical 1: the seal ledger must reach the thing that CONSUMES it — the pushed cache.
//
// `planRulesReconcile` measured the denied delta into `pending` and `advanceSeal` moved it into
// `sealed` as Claude's watermark crossed the day, and then the push built its split cache with
// `sealed: {}` — so that day's rollup row went out VERBATIM: the blocked repository's sessions,
// messages, tokens and hour buckets, permanently (a sealed day cannot be re-derived once its
// sessions age out) and one day at a time. These tests assert on what crossed the WIRE, not on
// the ledger file: a test that exercises `advanceSeal` or `buildSplitStatsCache` in isolation is
// exactly what let this survive.
// ---------------------------------------------------------------------------

/** A `real` StatsCache that genuinely was supplemented from `sessions` — which is
 *  `buildSplitStatsCache`'s CHECKED precondition, so a hand-written cache would simply make the
 *  split refuse and the assertions below vacuous. */
function realCacheFrom(sessions: readonly SessionMeta[], lastComputedDate: string): StatsCache {
  return { ...buildSharedStatsCache(sessions), lastComputedDate }
}

describe('the seal ledger reaches the PUSHED cache', () => {
  it("reduces a sealed day's rollup row on the wire once the watermark crosses it", async () => {
    const connId = randomConnId()
    const central = mockCentral()
    central.watch(connId)
    try {
      const conn = fakeConn(connId, central.server.port!, { deniedRepos: ['github.com/o/secret'] })
      const pub = makeSession('pub-7', { git_remote: 'github.com/o/pub', start_time: '2026-07-20T09:00:00.000Z' })
      const denied = makeSession('denied-7', { git_remote: 'github.com/o/secret', start_time: '2026-07-20T10:00:00.000Z' })
      const sessions = [pub, denied]
      const index = buildPathRepoIndex(sessions)
      const deps = { readPreferences: fakeReadPreferences(conn), migrateTeamStateOnce: async () => {} }

      // Cycle 1 — watermark 2026-07-01, so the boundary is 07-02 and 07-20 is still DECOMPOSABLE:
      // the day is rebuilt from the shared set on the wire, and the denied delta is measured into
      // `pending`.
      await runConnectionCycle(connId, {
        ...deps,
        ctx: makeCtx({ storedSessions: sessions, liveSessions: sessions, index, realStatsCache: realCacheFrom(sessions, '2026-07-01') }),
      })
      // Cycle 2 — the watermark MOVES past 07-20. The day is now undecomposable rollup, and the
      // only thing that can still reduce its row is the seal taken while it was measurable.
      await runConnectionCycle(connId, {
        ...deps,
        ctx: makeCtx({ storedSessions: sessions, liveSessions: sessions, index, realStatsCache: realCacheFrom(sessions, '2026-07-21') }),
      })

      const pushedCaches = central.ingests
        .map(b => b.statsCache)
        .filter((c): c is StatsCache => !!c)
      // Both cycles pushed a cache — otherwise every assertion below would be vacuous.
      expect(pushedCaches.length).toBe(2)
      const sealedCycle = pushedCaches[1]!
      expect(sealedCycle.lastComputedDate).toBe('2026-07-21') // this really is cycle 2's cache

      // The machine's REAL rollup row for that day counts both sessions…
      const realRow = realCacheFrom(sessions, '2026-07-21').dailyActivity.find(d => d.date === '2026-07-20')
      expect(realRow?.sessionCount).toBe(2)
      expect(realRow?.messageCount).toBe(36)
      // …and what crossed the wire counts only the shared one.
      const row = sealedCycle.dailyActivity.find(d => d.date === '2026-07-20')
      expect(row).toBeDefined()
      expect(row!.sessionCount).toBe(1)
      expect(row!.messageCount).toBe(18)
      // The per-day token row, the rollup-only scalars and modelUsage are reduced by the same seal.
      const tokenRow = sealedCycle.dailyModelTokens.find(d => d.date === '2026-07-20')
      expect(tokenRow?.tokensByModel['claude-sonnet-4-6']).toBe(1000)
      expect(sealedCycle.totalSessions).toBe(1)
      expect(sealedCycle.totalMessages).toBe(18)
      expect(sealedCycle.modelUsage['claude-sonnet-4-6']?.inputTokens).toBe(600)
      expect(sealedCycle.modelUsage['claude-sonnet-4-6']?.outputTokens).toBe(400)
      // Σ hourCounts === totalSessions on a real cache; the seal keeps that invariant (and this
      // asserts the hour buckets were reduced without depending on the developer's timezone).
      expect(Object.values(sealedCycle.hourCounts).reduce((a, b) => a + b, 0)).toBe(1)
    } finally {
      __teardownConnectionForTests(connId)
      await central.stop()
    }
  }, 10_000)

  it('an explicit push-now uses the persisted seal too, instead of an empty ledger', async () => {
    const connId = randomConnId()
    const central = mockCentral()
    central.watch(connId)
    try {
      const conn = fakeConn(connId, central.server.port!, { deniedRepos: ['github.com/o/secret'] })
      const pub = makeSession('pub-10', { git_remote: 'github.com/o/pub', start_time: '2026-07-20T09:00:00.000Z' })
      const denied = makeSession('denied-10', { git_remote: 'github.com/o/secret', start_time: '2026-07-20T10:00:00.000Z' })
      const sessions = [pub, denied]

      // The seal the periodic cycle would have persisted by the time the day became prehistory.
      await saveRulesState(connId, {
        ...emptyRulesState(),
        boundary: '2026-07-22',
        sealed: {
          '2026-07-20': {
            sessionCount: 1, messageCount: 18, toolCallCount: 0,
            tokensByModel: { 'claude-sonnet-4-6': 1000 },
            usageByModel: { 'claude-sonnet-4-6': { input: 600, output: 400, cacheRead: 0, cacheWrite: 0 } },
            hourCounts: {},
          },
        },
      })

      await guardedManualPush({ ...conn }, makeCtx({
        storedSessions: sessions, liveSessions: sessions,
        index: buildPathRepoIndex(sessions),
        realStatsCache: realCacheFrom(sessions, '2026-07-21'),
      }))

      const pushed = central.ingests.map(b => b.statsCache).filter((c): c is StatsCache => !!c)
      expect(pushed.length).toBe(1)
      expect(pushed[0]!.dailyActivity.find(d => d.date === '2026-07-20')?.sessionCount).toBe(1)
      expect(pushed[0]!.totalSessions).toBe(1)
    } finally {
      __teardownConnectionForTests(connId)
      await central.stop()
    }
  }, 10_000)
})

// ---------------------------------------------------------------------------
// Important 3: `sent.runIds` had no writer, so the whole run-withdrawal path was inert —
// `sentRunIds` was always [], `forgetRuns` always [], and the journal's `runIds`, the runs-only
// refusal and the per-ack drop were all unreachable. A run pushed for a session that was never
// pushed as a session document is then unwithdrawable, and nothing would ever notice.
// ---------------------------------------------------------------------------

function fakeRun(runId: string, sessionId: string): WorkflowRun {
  return {
    runId, name: 'audit', sessionId, status: 'completed',
    startedAt: '2026-07-20T10:00:00.000Z', durationMs: 0, phases: [], agents: [],
    totals: { agentCount: 0, tokensIn: 0, tokensOut: 0, costUSD: 0, durationMs: 0, toolUses: 0 },
  }
}

function sentRunIdsOf(connId: string): string[] {
  return (JSON.parse(readFileSync(teamSentFile(connId), 'utf-8')) as { runIds: string[] }).runIds
}

describe('pushed workflow runs are recorded in the sent-state', () => {
  it('records a run id the central accepted', async () => {
    const connId = randomConnId()
    await using server = Bun.serve({ port: 0, fetch: () => Response.json({ ok: true }) })
    try {
      await saveSentState(connId, {})
      const res = await pushOnceDetailed(fakeConn(connId, server.port!), makeCtx({ workflows: [fakeRun('r-8', 'pub-8')] }))
      expect(res.error).toBeUndefined()
      expect(sentRunIdsOf(connId)).toEqual(['r-8'])
    } finally {
      __teardownConnectionForTests(connId)
    }
  })

  it('does NOT record a run the central never accepted', async () => {
    const connId = randomConnId()
    await using server = Bun.serve({ port: 0, fetch: () => new Response('boom', { status: 500 }) })
    try {
      await saveSentState(connId, {})
      await pushOnceDetailed(fakeConn(connId, server.port!), makeCtx({ workflows: [fakeRun('r-8b', 'pub-8b')] }))
      // Same rule the payload memo already follows: never memoize before the response.
      expect(sentRunIdsOf(connId)).toEqual([])
    } finally {
      __teardownConnectionForTests(connId)
    }
  })

  it('a run pushed today is actually named for withdrawal when its repo is blocked tomorrow', async () => {
    const connId = randomConnId()
    const central = mockCentral()
    central.watch(connId)
    try {
      const pub = makeSession('pub-9', { git_remote: 'github.com/o/pub' })
      const secret = makeSession('secret-9', { git_remote: 'github.com/o/secret' })
      const sessions = [pub, secret]
      const ctx = makeCtx({
        storedSessions: sessions, liveSessions: sessions,
        workflows: [fakeRun('r-9', 'secret-9')],
        index: buildPathRepoIndex(sessions),
      })

      // Day 1 — no denylist: both sessions and the run go to the central.
      const open = fakeConn(connId, central.server.port!)
      await runConnectionCycle(connId, {
        readPreferences: fakeReadPreferences(open), migrateTeamStateOnce: async () => {}, ctx,
      })
      expect(Object.keys(await loadSentState(connId)).sort()).toEqual(['pub-9', 'secret-9'])
      // The writer this finding is about: without it the list below stays empty forever.
      expect(sentRunIdsOf(connId)).toEqual(['r-9'])

      // Day 2 — the repo is blocked. The session is named for deletion AND so is its run.
      const blocked = fakeConn(connId, central.server.port!, { deniedRepos: ['github.com/o/secret'] })
      await runConnectionCycle(connId, {
        readPreferences: fakeReadPreferences(blocked), migrateTeamStateOnce: async () => {}, ctx,
      })
      expect(central.forgetBodies).toEqual([['secret-9']])
      // Every batch acked → the run ids may finally leave the sent-state (team-forget-client.ts).
      // This drop is only reachable because the list was non-empty above.
      expect(sentRunIdsOf(connId)).toEqual([])
      expect(Object.keys(await loadSentState(connId))).toEqual(['pub-9'])
    } finally {
      __teardownConnectionForTests(connId)
      await central.stop()
    }
  }, 10_000)
})

// ---------------------------------------------------------------------------
// Important 4: GET /api/team/status must not force a full context rebuild. The browser polls it
// every 5s and `notifyDataChanged()` invalidates the context unconditionally, so during active
// coding the TTL protects nothing: every poll ran `buildApiResponse()` (which also WRITES the
// consolidate store) plus `loadConsolidated()`. `boundary`/`prehistorySessions` are display-only
// honesty markers — serve them from the last-built context, and report `null` (never 0, which
// means something else on that route) when there is none.
//
// This lives here rather than in team-connections.test.ts because the route reads per-connection
// rules state, and this file is the one that redirects TEAM_CONN_DIR away from ~/.agentistics.
// ---------------------------------------------------------------------------

describe('GET /api/team/status does not build a push context', () => {
  it('reports the markers as unknowable and leaves the context uncached', async () => {
    const connId = randomConnId()
    try {
      invalidatePushContext()
      expect(peekPushContext()).toBeNull()

      const conn = fakeConn(connId, 1)
      const res = await handleTeamStatus(new Request('http://127.0.0.1/api/team/status'), {
        readPreferences: fakeReadPreferences(conn),
      })
      const body = await res.json() as { connections: Array<{ boundary: string | null; prehistorySessions: number | null }> }
      expect(body.connections).toHaveLength(1)
      // `null` means "unknowable", which is a different fact from `0` — never coerced.
      expect(body.connections[0]!.boundary).toBeNull()
      expect(body.connections[0]!.prehistorySessions).toBeNull()
      // The proof: had the route built one, it would now be sitting in the module cache.
      expect(peekPushContext()).toBeNull()
    } finally {
      __teardownConnectionForTests(connId)
    }
  })

  it('serves the markers from an already-built context when one exists', async () => {
    const connId = randomConnId()
    try {
      const sessions = [makeSession('pub-11', { start_time: '2026-07-20T09:00:00.000Z' })]
      invalidatePushContext()
      // `getPushContext` is what the PUSH cycle calls; it caches, which is the state the route is
      // supposed to read from without ever building one itself.
      await getPushContext({
        buildApiResponse: async () => ({
          sessions, statsCache: realCacheFrom(sessions, '2026-07-21'), projects: [], workflows: [],
        }),
        loadConsolidated: async () => new Map(),
        readMemberWorkflows: async () => [],
      })

      const conn = fakeConn(connId, 1)
      const res = await handleTeamStatus(new Request('http://127.0.0.1/api/team/status'), {
        readPreferences: fakeReadPreferences(conn),
      })
      const body = await res.json() as { connections: Array<{ boundary: string | null; prehistorySessions: number | null }> }
      expect(body.connections[0]!.boundary).toBe('2026-07-22')
      expect(body.connections[0]!.prehistorySessions).toBe(1)
    } finally {
      invalidatePushContext()
      __teardownConnectionForTests(connId)
    }
  })
})

// ---------------------------------------------------------------------------
// The manual-push window: `guardedManualPush` reducing only days already in `sealed` leaves one
// interval-wide hole. A day that crossed Claude's watermark AFTER the last periodic cycle is
// still in `pending`, so a "Push now" landing in that window emits that day's rollup row
// unreduced — the blocked repository's volume, on the wire. Bounded by one push interval and far
// narrower than the pre-fix behaviour, but a real leak in a privacy control.
//
// The seal is therefore DERIVED read-only on this path (the same pure `computeLedger` the
// periodic cycle uses) and never persisted: persistence stays on the periodic cycle, or
// `advanceSeal`'s ledger becomes a function of how often a human clicks.
// ---------------------------------------------------------------------------

describe('an explicit push-now closes the window between two periodic cycles', () => {
  it('reduces a day that crossed the watermark since the last cycle, and persists nothing', async () => {
    const connId = randomConnId()
    const central = mockCentral()
    central.watch(connId)
    try {
      const conn = fakeConn(connId, central.server.port!, { deniedRepos: ['github.com/o/secret'] })
      const pub = makeSession('pub-12', { git_remote: 'github.com/o/pub', start_time: '2026-07-20T09:00:00.000Z' })
      const denied = makeSession('denied-12', { git_remote: 'github.com/o/secret', start_time: '2026-07-20T10:00:00.000Z' })
      const sessions = [pub, denied]
      const deniedKeys = normalizeDenied(['github.com/o/secret'])

      // Exactly what the LAST PERIODIC CYCLE persisted: watermark 2026-07-01 → boundary 07-02, so
      // 07-20 was still decomposable and got MEASURED into `pending`. Nothing is sealed yet.
      const persisted = {
        ...emptyRulesState(),
        boundary: '2026-07-02',
        pending: deniedDeltaByDay(sessions, filterShared(sessions, deniedKeys), '2026-07-02'),
      }
      expect(persisted.pending['2026-07-20']?.sessionCount).toBe(1) // the fixture is real
      await saveRulesState(connId, persisted)

      // The watermark has since moved past 07-20 — but no periodic cycle has run, so `sealed` on
      // disk is still empty. THIS is the window, and this is a user pressing "Push now" inside it.
      await guardedManualPush(conn, makeCtx({
        storedSessions: sessions, liveSessions: sessions,
        index: buildPathRepoIndex(sessions),
        realStatsCache: realCacheFrom(sessions, '2026-07-21'),
      }))

      const pushed = central.ingests.map(b => b.statsCache).filter((c): c is StatsCache => !!c)
      expect(pushed.length).toBe(1)
      const row = pushed[0]!.dailyActivity.find(d => d.date === '2026-07-20')
      expect(row?.sessionCount).toBe(1) // the real rollup row counts 2
      expect(row?.messageCount).toBe(18)
      expect(pushed[0]!.totalSessions).toBe(1)
      expect(pushed[0]!.modelUsage['claude-sonnet-4-6']?.inputTokens).toBe(600)
      expect(Object.values(pushed[0]!.hourCounts).reduce((a, b) => a + b, 0)).toBe(1)

      // READ-ONLY. This assertion is the point: it pins the derivation as non-persisting, so a
      // later reader cannot "simplify" it into a call that advances the ledger off the cycle.
      expect(await loadRulesState(connId)).toEqual(persisted)
    } finally {
      __teardownConnectionForTests(connId)
      await central.stop()
    }
  }, 10_000)
})
